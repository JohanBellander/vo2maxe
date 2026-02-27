# vo2maxe

A TypeScript implementation of the reverse-engineered Garmin VO2Max estimation algorithm, as described in the included whitepaper *"Reverse-Engineering Garmin's VO2Max Estimation Algorithm"*.

Supports both **cycling** and **running** estimation pipelines with full temporal smoothing, quality filtering, detraining decay, and cross-sport transfer.

## Installation

```bash
pnpm add vo2maxe
```

Or with npm/yarn:

```bash
npm install vo2maxe
yarn add vo2maxe
```

## Quick start

```typescript
import { VO2MaxEstimator } from "vo2maxe";
import type { CyclingActivity, RunningActivity } from "vo2maxe";

// 1. Create an estimator with the athlete's profile
const estimator = new VO2MaxEstimator({
  maxHr: 176,       // Firstbeat's internal HRmax estimate (bpm)
  restingHr: 42,    // Resting heart rate (bpm)
  weightKg: 68,     // Body weight (kg, used for cycling power normalization)
});

// 2. Process activities in chronological order
const cyclingResult = estimator.processActivity({
  sport: "cycling",
  date: new Date("2025-06-01"),
  durationSeconds: 3600,
  avgHr: 150,
  maxMet: 16.0,  // Firstbeat maxMet from activity data
});
console.log(cyclingResult.vo2Max); // 56

const runningResult = estimator.processActivity({
  sport: "running",
  date: new Date("2025-06-02"),
  durationSeconds: 2700,  // 45 minutes
  avgHr: 150,
  avgSpeedMs: 2.7,        // Grade-adjusted speed in m/s
});
console.log(runningResult.vo2Max); // Integer VO2Max estimate
```

## How it works

The algorithm maintains separate pipelines for cycling and running:

### Cycling

When the Firstbeat `maxMet` field is available (Zwift, gravel cycling):

```
VO2Max = round(maxMet * 3.5)
```

No temporal smoothing is applied -- each activity produces an independent estimate.

When `maxMet` is unavailable, a power-based fallback uses average power and heart rate with a dynamic-alpha EWMA.

### Running

Running estimation is more complex:

1. **Raw estimate** -- ACSM metabolic cost model combined with a %HRmax-to-%VO2max mapping
2. **Duration correction** -- Compensates for cardiac drift in long/short runs
3. **Bias correction** -- Small constant adjustment (-0.03)
4. **Quality filtering** -- Only activities >= 39 min with avgHR >= 72% HRmax update the rolling metric
5. **Two-phase EMA** -- Alpha = 0.07 for the first 18 quality updates, then 0.02 for stability
6. **Gap-aware alpha boosting** -- Alpha is boosted 8x after a > 28 day gap
7. **Detraining decay** -- Square root decay model when no quality activity occurs
8. **Cross-sport transfer** -- Cycling VO2Max replaces running EMA after a > 50 day running gap

## API reference

### `VO2MaxEstimator`

The main class. Create one instance per athlete.

```typescript
const estimator = new VO2MaxEstimator(profile, state?);
```

#### Constructor parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `profile` | `AthleteProfile` | Athlete's physiological parameters |
| `state` | `EstimatorState` | Optional pre-existing state (for resumption) |

#### Methods

| Method | Returns | Description |
|--------|---------|-------------|
| `processActivity(activity)` | `VO2MaxResult` | Process a single activity. Activities must be in chronological order. |
| `processActivities(activities)` | `VO2MaxResult[]` | Process a batch of activities in order. |
| `getState()` | `EstimatorState` | Get a snapshot of internal state for serialization. |
| `getProfile()` | `AthleteProfile` | Get the athlete profile. |
| `getCurrentRunningVo2Max()` | `number \| null` | Current running EMA (continuous, unrounded). |
| `getCurrentCyclingVo2Max()` | `number \| null` | Most recent cycling VO2Max (continuous). |
| `reset()` | `void` | Reset to initial state. |

### Types

#### `AthleteProfile`

```typescript
interface AthleteProfile {
  maxHr: number;      // Maximum heart rate (bpm) - Firstbeat's internal estimate
  restingHr: number;  // Resting heart rate (bpm)
  weightKg: number;   // Body weight (kg)
}
```

#### `CyclingActivity`

```typescript
interface CyclingActivity {
  sport: "cycling";
  date: Date;
  durationSeconds: number;
  avgHr: number;                          // Average HR (bpm)
  maxMet?: number;                        // Firstbeat maxMet (primary path)
  avgPower?: number;                      // Average power in watts (fallback)
  windowedData?: { power: number; hr: number };  // Best 5-min window (fallback)
}
```

#### `RunningActivity`

```typescript
interface RunningActivity {
  sport: "running";
  date: Date;
  durationSeconds: number;
  avgHr: number;       // Average HR (bpm)
  avgSpeedMs: number;  // Average speed in m/s (prefer grade-adjusted)
}
```

#### `VO2MaxResult`

```typescript
interface VO2MaxResult {
  activity: Activity;
  vo2Max: number | null;            // Final integer estimate (rounded)
  vo2MaxContinuous: number | null;  // Continuous (unrounded) value
  sport: SportType;
  isQuality: boolean;               // Met quality criteria (running only)
  updatedEma: boolean;              // Updated the running EMA
  crossSportApplied: boolean;       // Cross-sport transfer was applied
}
```

### State serialization

The estimator state can be serialized and restored, allowing the estimator to be paused and resumed across server requests:

```typescript
// Save state
const state = estimator.getState();
const json = JSON.stringify(state);

// Restore later (note: Date fields need revival)
const restored = JSON.parse(json, (key, value) => {
  if (key.endsWith("Date") && value != null) return new Date(value);
  return value;
});
const resumedEstimator = new VO2MaxEstimator(profile, restored);
```

### Advanced usage

All individual computation functions are exported for advanced use cases:

```typescript
import {
  // Running pipeline
  acsmRunningCost,
  computeRawVo2Max,
  applyDurationCorrection,
  applyBiasCorrection,
  isQualityActivity,
  getAlpha,
  applyGapBoost,
  seedEma,
  updateEma,
  computeDecay,

  // Cycling pipeline
  estimateCyclingVo2Max,
  percentHrr,
  massFactor,

  // Constants
  CONSTANTS,
} from "vo2maxe";
```

## Garmin activity data mapping

When using data exported from Garmin Connect, map fields as follows:

| Garmin field | Library field | Notes |
|---|---|---|
| `activityType` | `sport` | Map to `"cycling"` or `"running"` |
| `summary.avgHr` | `avgHr` | Direct (bpm) |
| `summary.avgGradeAdjustedSpeed` | `avgSpeedMs` | Multiply by 10 (Garmin uses cm/ms) |
| `summary.avgSpeed` | `avgSpeedMs` | Multiply by 10; use only if GAS unavailable |
| `summary.duration` | `durationSeconds` | Divide by 1000 (Garmin uses ms) |
| `summary.firstbeatData.results.maxMet` | `maxMet` | Direct (Zwift/virtual rides) |
| `vo2Max.dailyMaxMetSnapshots[].maxMet` | `maxMet` | Direct (gravel/outdoor cycling) |
| `summary.avgPower` | `avgPower` | Direct (watts, cycling fallback) |
| `summary.firstbeatData.results.maximalHr` | `AthleteProfile.maxHr` | Firstbeat's HRmax estimate |

## Algorithm parameters

All algorithm parameters from the whitepaper are exposed via the `CONSTANTS` object. See `src/constants.ts` for the full list with whitepaper references.

Key parameters:

| Parameter | Value | Description |
|-----------|-------|-------------|
| ACSM cost scale | 0.95 | 5% below standard ACSM |
| HRmax slope/intercept | 1.08 / -0.15 | %HRmax to %VO2max mapping |
| Phase 1 alpha | 0.07 | EMA alpha for first 18 quality updates |
| Phase 2 alpha | 0.02 | EMA alpha after 18 quality updates |
| Quality min duration | 2340s (39 min) | Minimum duration for quality activity |
| Quality min %HRmax | 0.72 | Minimum intensity for quality activity |
| Seed damping | 4.3 | Subtracted from first raw estimate |
| Decay rate | 0.01 | Detraining decay rate |
| Cross-sport gap | 50 days | Trigger for cycling-to-running transfer |

## Development

```bash
# Install dependencies
pnpm install

# Run tests
pnpm test

# Run tests in watch mode
pnpm test:watch

# Type check
pnpm typecheck

# Build
pnpm build
```

## License

MIT
