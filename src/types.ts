/**
 * Type definitions for the VO2Max estimation library.
 */

// ── Sport type ─────────────────────────────────────────────────────────

/** Supported sport categories. */
export type SportType = "cycling" | "running";

// ── Athlete profile ────────────────────────────────────────────────────

/**
 * Per-athlete physiological parameters required by the algorithm.
 * See whitepaper Section 3, Table 3.
 */
export interface AthleteProfile {
  /** Maximum heart rate from Firstbeat's internal estimate (bpm). */
  maxHr: number;
  /** Resting heart rate (bpm). */
  restingHr: number;
  /** Body weight in kg. Used for cycling power normalization. */
  weightKg: number;
}

// ── Activity data ──────────────────────────────────────────────────────

/** Common fields present on every activity. */
interface ActivityBase {
  /** Activity date (used for temporal ordering and gap calculations). */
  date: Date;
  /** Activity duration in seconds. */
  durationSeconds: number;
  /** Average heart rate in bpm. */
  avgHr: number;
}

/**
 * Cycling activity data.
 *
 * The primary path uses `maxMet` from Firstbeat. When unavailable,
 * the fallback path uses average power and optionally windowed power/HR data.
 */
export interface CyclingActivity extends ActivityBase {
  sport: "cycling";
  /**
   * Firstbeat maxMet value (MET).
   * Found in `summary.firstbeatData.results.maxMet` (Zwift) or
   * `vo2Max.dailyMaxMetSnapshots[].maxMet` (gravel).
   * When present, the direct passthrough path is used.
   */
  maxMet?: number;
  /** Average power in watts (used by fallback path). */
  avgPower?: number;
  /**
   * Best 5-minute sliding window data (used by fallback windowed path).
   * If provided, the windowed model is used instead of the summary model.
   */
  windowedData?: {
    /** Average power in the best 5-min window (watts). */
    power: number;
    /** Average HR in the best 5-min window (bpm). */
    hr: number;
  };
}

/**
 * Running activity data.
 *
 * Speed should be grade-adjusted when available.
 */
export interface RunningActivity extends ActivityBase {
  sport: "running";
  /**
   * Average speed in m/s.
   * Prefer grade-adjusted speed (GAS) when available:
   * `avgGradeAdjustedSpeed` from Garmin, converted from cm/ms by multiplying by 10.
   */
  avgSpeedMs: number;
}

/** Union type for all supported activity types. */
export type Activity = CyclingActivity | RunningActivity;

// ── Estimation results ─────────────────────────────────────────────────

/** Result of estimating VO2Max for a single activity. */
export interface VO2MaxResult {
  /** The activity that was processed. */
  activity: Activity;
  /** Final VO2Max estimate (integer, rounded). Null if no estimate could be produced. */
  vo2Max: number | null;
  /** Continuous (unrounded) VO2Max value. Null if no estimate could be produced. */
  vo2MaxContinuous: number | null;
  /** Sport type of the activity. */
  sport: SportType;
  /** Whether this activity met quality criteria (running only). */
  isQuality: boolean;
  /** Whether this activity updated the running EMA (running only). */
  updatedEma: boolean;
  /** Whether cross-sport transfer was applied (running only). */
  crossSportApplied: boolean;
}

// ── Estimator state ────────────────────────────────────────────────────

/**
 * Internal state maintained by the estimator across activities.
 * Exposed for serialization/deserialization so the estimator can be
 * paused and resumed (e.g., across server requests).
 */
export interface EstimatorState {
  /** Current running EMA value, or null if not yet seeded. */
  runningEma: number | null;
  /** Date of the last quality running activity. */
  lastQualityRunDate: Date | null;
  /** Date of the last EMA update (quality run or cross-sport transfer). */
  lastEmaUpdateDate: Date | null;
  /** Number of quality running EMA updates completed. */
  qualityRunCount: number;
  /** Whether cross-sport transfer has been applied for the current gap. */
  crossSportApplied: boolean;
  /** Most recent cycling VO2Max (continuous) for cross-sport transfer. */
  lastCyclingVo2Max: number | null;
  /** Date of the most recent cycling activity. */
  lastCyclingDate: Date | null;
  // Cycling fallback EWMA state
  /** Cycling fallback EWMA value. */
  cyclingFallbackEwma: number | null;
  /** Number of cycling fallback EWMA updates. */
  cyclingFallbackCount: number;
}

/**
 * Creates a fresh initial estimator state.
 */
export function createInitialState(): EstimatorState {
  return {
    runningEma: null,
    lastQualityRunDate: null,
    lastEmaUpdateDate: null,
    qualityRunCount: 0,
    crossSportApplied: false,
    lastCyclingVo2Max: null,
    lastCyclingDate: null,
    cyclingFallbackEwma: null,
    cyclingFallbackCount: 0,
  };
}
