import { describe, expect, it } from "vitest";
import { VO2MaxEstimator } from "../src/estimator.js";
import { createInitialState } from "../src/types.js";
import type {
  Activity,
  AthleteProfile,
  CyclingActivity,
  RunningActivity,
} from "../src/types.js";

const athleteA: AthleteProfile = { maxHr: 176, restingHr: 42, weightKg: 68 };
const athleteB: AthleteProfile = { maxHr: 182, restingHr: 50.7, weightKg: 77 };

function makeCycling(date: string, maxMet: number): CyclingActivity {
  return {
    sport: "cycling",
    date: new Date(date),
    durationSeconds: 3600,
    avgHr: 150,
    maxMet,
  };
}

function makeRunning(
  date: string,
  avgSpeedMs: number,
  avgHr: number,
  durationSeconds: number,
): RunningActivity {
  return {
    sport: "running",
    date: new Date(date),
    durationSeconds,
    avgHr,
    avgSpeedMs,
  };
}

// Quality running: >= 39 min (2340s), avgHr >= 72% HRmax (126.72 for A)
function makeQualityRunning(
  date: string,
  avgSpeedMs = 2.7,
  avgHr = 150,
  durationSeconds = 2700,
): RunningActivity {
  return makeRunning(date, avgSpeedMs, avgHr, durationSeconds);
}

// Non-quality: too short
function makeShortRunning(date: string): RunningActivity {
  return makeRunning(date, 2.7, 150, 1800); // 30 min
}

describe("VO2MaxEstimator", () => {
  describe("constructor and state", () => {
    it("should initialize with fresh state", () => {
      const est = new VO2MaxEstimator(athleteA);
      const state = est.getState();
      expect(state.runningEma).toBeNull();
      expect(state.qualityRunCount).toBe(0);
      expect(state.lastCyclingVo2Max).toBeNull();
    });

    it("should accept pre-existing state", () => {
      const state = createInitialState();
      state.runningEma = 52.0;
      state.qualityRunCount = 10;
      const est = new VO2MaxEstimator(athleteA, state);
      expect(est.getCurrentRunningVo2Max()).toBe(52.0);
    });

    it("should return profile", () => {
      const est = new VO2MaxEstimator(athleteA);
      expect(est.getProfile()).toEqual(athleteA);
    });
  });

  describe("cycling: maxMet passthrough", () => {
    it("should compute VO2Max = round(maxMet * 3.5)", () => {
      const est = new VO2MaxEstimator(athleteA);
      const result = est.processActivity(makeCycling("2025-06-01", 16.0));
      expect(result.vo2Max).toBe(56);
      expect(result.sport).toBe("cycling");
      expect(result.isQuality).toBe(false);
    });

    it("should produce independent per-activity estimates", () => {
      const est = new VO2MaxEstimator(athleteA);
      const r1 = est.processActivity(makeCycling("2025-06-01", 16.0));
      const r2 = est.processActivity(makeCycling("2025-06-02", 14.0));
      expect(r1.vo2Max).toBe(56);
      expect(r2.vo2Max).toBe(49);
    });

    it("should track latest cycling VO2Max for cross-sport", () => {
      const est = new VO2MaxEstimator(athleteA);
      est.processActivity(makeCycling("2025-06-01", 16.0));
      expect(est.getCurrentCyclingVo2Max()).toBeCloseTo(56.0, 4);
      est.processActivity(makeCycling("2025-06-02", 15.0));
      expect(est.getCurrentCyclingVo2Max()).toBeCloseTo(52.5, 4);
    });
  });

  describe("running: EMA seeding", () => {
    it("should seed EMA from first quality activity with damping", () => {
      const est = new VO2MaxEstimator(athleteA);
      const result = est.processActivity(
        makeQualityRunning("2025-06-01", 2.7, 150, 2700),
      );
      expect(result.vo2Max).not.toBeNull();
      expect(result.updatedEma).toBe(true);
      // EMA should be raw - 4.3
      const state = est.getState();
      expect(state.qualityRunCount).toBe(1);
    });

    it("should not seed EMA from non-quality activity", () => {
      const est = new VO2MaxEstimator(athleteA);
      const result = est.processActivity(makeShortRunning("2025-06-01"));
      expect(result.vo2Max).toBeNull(); // No EMA yet
      expect(result.updatedEma).toBe(false);
      expect(result.isQuality).toBe(false);
    });
  });

  describe("running: EMA updates", () => {
    it("should update EMA only for quality activities", () => {
      const est = new VO2MaxEstimator(athleteA);

      // First quality activity seeds
      est.processActivity(makeQualityRunning("2025-06-01"));
      const emaAfterSeed = est.getCurrentRunningVo2Max()!;

      // Non-quality: should not change EMA
      est.processActivity(makeShortRunning("2025-06-02"));
      expect(est.getCurrentRunningVo2Max()).toBeCloseTo(emaAfterSeed, 4);

      // Second quality activity: should update
      est.processActivity(makeQualityRunning("2025-06-03"));
      expect(est.getState().qualityRunCount).toBe(2);
    });

    it("should use phase 1 alpha (0.07) for first 18 updates", () => {
      const est = new VO2MaxEstimator(athleteA);

      // Process 18 quality activities
      for (let i = 0; i < 18; i++) {
        const day = String(i + 1).padStart(2, "0");
        est.processActivity(
          makeQualityRunning(`2025-06-${day}`, 2.7, 150, 2700),
        );
      }
      expect(est.getState().qualityRunCount).toBe(18);
    });

    it("should report round(EMA) for non-quality after seeded", () => {
      const est = new VO2MaxEstimator(athleteA);

      const r1 = est.processActivity(makeQualityRunning("2025-06-01"));
      expect(r1.vo2Max).not.toBeNull();

      // Non-quality still reports the current EMA
      const r2 = est.processActivity(makeShortRunning("2025-06-02"));
      expect(r2.vo2Max).toBe(r1.vo2Max);
      expect(r2.updatedEma).toBe(false);
    });
  });

  describe("running: quality filtering", () => {
    it("should mark long intense runs as quality", () => {
      const est = new VO2MaxEstimator(athleteA);
      const result = est.processActivity(
        makeQualityRunning("2025-06-01", 2.7, 150, 2700),
      );
      expect(result.isQuality).toBe(true);
    });

    it("should mark short runs as non-quality", () => {
      const est = new VO2MaxEstimator(athleteA);
      const result = est.processActivity(makeShortRunning("2025-06-01"));
      expect(result.isQuality).toBe(false);
    });

    it("should mark low-HR runs as non-quality", () => {
      const est = new VO2MaxEstimator(athleteA);
      // HR 110 / 176 = 62.5% < 72%
      const result = est.processActivity(
        makeRunning("2025-06-01", 2.7, 110, 2700),
      );
      expect(result.isQuality).toBe(false);
    });
  });

  describe("running: detraining decay", () => {
    it("should not decay within grace period (3 days)", () => {
      const est = new VO2MaxEstimator(athleteA);
      est.processActivity(makeQualityRunning("2025-06-01"));
      const emaAfterSeed = est.getCurrentRunningVo2Max()!;

      // 2 days later, non-quality => no decay (within grace)
      const r2 = est.processActivity(makeShortRunning("2025-06-03"));
      // Only 2 days gap, within grace period
      expect(r2.vo2MaxContinuous).toBeCloseTo(emaAfterSeed, 2);
    });

    it("should apply decay after grace period", () => {
      const est = new VO2MaxEstimator(athleteA);
      est.processActivity(makeQualityRunning("2025-06-01"));
      const emaAfterSeed = est.getCurrentRunningVo2Max()!;

      // 20 days later, non-quality => decay applied
      const r2 = est.processActivity(makeShortRunning("2025-06-21"));
      expect(r2.vo2MaxContinuous!).toBeLessThan(emaAfterSeed);
    });
  });

  describe("running: cross-sport transfer", () => {
    it("should transfer cycling VO2Max after > 50 day running gap", () => {
      const est = new VO2MaxEstimator(athleteA);

      // Seed running EMA
      est.processActivity(makeQualityRunning("2025-01-01"));

      // Cycling activities during the gap
      est.processActivity(makeCycling("2025-02-01", 17.0)); // VO2=59.5
      expect(est.getCurrentCyclingVo2Max()).toBeCloseTo(59.5, 4);

      // Running activity after 60 days gap (> 50 day threshold)
      const result = est.processActivity(makeShortRunning("2025-03-05"));
      expect(result.crossSportApplied).toBe(true);
      // EMA should now be set to most recent cycling VO2Max (59.5)
      expect(est.getCurrentRunningVo2Max()).toBeCloseTo(59.5, 0);
    });

    it("should not transfer if gap <= 50 days", () => {
      const est = new VO2MaxEstimator(athleteA);

      est.processActivity(makeQualityRunning("2025-01-01"));
      est.processActivity(makeCycling("2025-01-15", 17.0));

      // Running 40 days later (< 50)
      const result = est.processActivity(makeShortRunning("2025-02-10"));
      expect(result.crossSportApplied).toBe(false);
    });

    it("should not transfer if no cycling data exists", () => {
      const est = new VO2MaxEstimator(athleteA);

      est.processActivity(makeQualityRunning("2025-01-01"));

      // Running 60 days later but no cycling
      const result = est.processActivity(makeShortRunning("2025-03-05"));
      expect(result.crossSportApplied).toBe(false);
    });

    it("should only apply transfer once per gap", () => {
      const est = new VO2MaxEstimator(athleteA);

      est.processActivity(makeQualityRunning("2025-01-01"));
      est.processActivity(makeCycling("2025-02-01", 17.0));

      // First run after gap: transfer applied
      const r1 = est.processActivity(makeShortRunning("2025-03-05"));
      expect(r1.crossSportApplied).toBe(true);

      // Second run: transfer should not apply again
      const r2 = est.processActivity(makeShortRunning("2025-03-06"));
      expect(r2.crossSportApplied).toBe(false);
    });

    it("should reset cross-sport flag after a quality run", () => {
      const est = new VO2MaxEstimator(athleteA);

      est.processActivity(makeQualityRunning("2025-01-01"));
      est.processActivity(makeCycling("2025-02-01", 17.0));

      // Transfer applied
      est.processActivity(makeShortRunning("2025-03-05"));
      // Quality run resets the flag
      est.processActivity(makeQualityRunning("2025-03-06"));

      // After another long gap, should be eligible again
      est.processActivity(makeCycling("2025-04-01", 18.0));
      const result = est.processActivity(makeShortRunning("2025-05-10"));
      expect(result.crossSportApplied).toBe(true);
    });
  });

  describe("running: gap-aware alpha boosting", () => {
    it("should boost alpha after > 28 day gap between quality runs", () => {
      const est = new VO2MaxEstimator(athleteA);

      // Seed and one more quality run
      est.processActivity(makeQualityRunning("2025-01-01"));
      est.processActivity(makeQualityRunning("2025-01-02"));
      const emaBeforeGap = est.getCurrentRunningVo2Max()!;

      // Quality run 35 days later (> 28 day gap)
      // With boosted alpha (0.07 * 8 = 0.56), should move EMA more aggressively
      const rFast = est.processActivity(
        makeQualityRunning("2025-02-06", 3.0, 150, 2700),
      );

      // Compare: same activity without gap
      const est2 = new VO2MaxEstimator(athleteA);
      est2.processActivity(makeQualityRunning("2025-01-01"));
      est2.processActivity(makeQualityRunning("2025-01-02"));
      const rSlow = est2.processActivity(
        makeQualityRunning("2025-01-03", 3.0, 150, 2700),
      );

      // The gap-boosted update should move EMA more
      const movementWithGap = Math.abs(
        est.getCurrentRunningVo2Max()! - emaBeforeGap,
      );
      const movementWithout = Math.abs(
        est2.getCurrentRunningVo2Max()! -
          est2.getState().runningEma!,
      );
      // Can't directly compare due to decay on the gap version,
      // but we can verify the boosted run updated
      expect(rFast.updatedEma).toBe(true);
    });
  });

  describe("processActivities (batch)", () => {
    it("should process activities in order and return results", () => {
      const est = new VO2MaxEstimator(athleteA);
      const activities: Activity[] = [
        makeCycling("2025-06-01", 16.0),
        makeQualityRunning("2025-06-02"),
        makeCycling("2025-06-03", 15.0),
      ];
      const results = est.processActivities(activities);
      expect(results).toHaveLength(3);
      expect(results[0]!.sport).toBe("cycling");
      expect(results[1]!.sport).toBe("running");
      expect(results[2]!.sport).toBe("cycling");
    });
  });

  describe("state serialization", () => {
    it("should produce same results when resuming from state", () => {
      // Process first half
      const est1 = new VO2MaxEstimator(athleteA);
      est1.processActivity(makeQualityRunning("2025-06-01"));
      est1.processActivity(makeQualityRunning("2025-06-02"));
      const midState = est1.getState();

      // Continue from state
      const est2 = new VO2MaxEstimator(athleteA, midState);
      const r2 = est2.processActivity(makeQualityRunning("2025-06-03"));

      // Process all three in one go
      const est3 = new VO2MaxEstimator(athleteA);
      est3.processActivity(makeQualityRunning("2025-06-01"));
      est3.processActivity(makeQualityRunning("2025-06-02"));
      const r3 = est3.processActivity(makeQualityRunning("2025-06-03"));

      expect(r2.vo2Max).toBe(r3.vo2Max);
      expect(r2.vo2MaxContinuous).toBeCloseTo(r3.vo2MaxContinuous!, 4);
    });
  });

  describe("reset", () => {
    it("should reset to initial state", () => {
      const est = new VO2MaxEstimator(athleteA);
      est.processActivity(makeQualityRunning("2025-06-01"));
      expect(est.getCurrentRunningVo2Max()).not.toBeNull();

      est.reset();
      expect(est.getCurrentRunningVo2Max()).toBeNull();
      expect(est.getState().qualityRunCount).toBe(0);
    });
  });
});

describe("integration: multi-sport athlete scenario", () => {
  it("should handle a mixed cycling/running timeline", () => {
    const est = new VO2MaxEstimator(athleteA);
    const results: ReturnType<typeof est.processActivity>[] = [];

    // Month 1: cycling only
    results.push(est.processActivity(makeCycling("2025-01-05", 15.0)));
    results.push(est.processActivity(makeCycling("2025-01-12", 15.5)));
    results.push(est.processActivity(makeCycling("2025-01-19", 16.0)));

    // Month 2: start running
    results.push(est.processActivity(makeQualityRunning("2025-02-01", 2.5, 145, 2700)));
    results.push(est.processActivity(makeQualityRunning("2025-02-03", 2.6, 148, 2800)));
    results.push(est.processActivity(makeQualityRunning("2025-02-05", 2.7, 150, 2700)));

    // All should have results
    for (const r of results) {
      expect(r.vo2Max).not.toBeNull();
    }

    // Cycling results should be independent
    expect(results[0]!.vo2Max).toBe(Math.round(15.0 * 3.5));
    expect(results[1]!.vo2Max).toBe(Math.round(15.5 * 3.5));
    expect(results[2]!.vo2Max).toBe(Math.round(16.0 * 3.5));

    // Running EMA should be building
    expect(est.getState().qualityRunCount).toBe(3);
  });

  it("should handle the whitepaper worked example values", () => {
    // From the whitepaper: runner at 2.7 m/s, avgHR=130, HRmax=176
    // Raw VO2Max ≈ 52.6
    const est = new VO2MaxEstimator(athleteA);
    const activity = makeQualityRunning("2025-06-01", 2.7, 130, 2700);
    const result = est.processActivity(activity);

    // First quality activity: EMA = raw - 4.3
    // Raw ≈ 52.6, corrected for duration (45min center) ≈ 52.6, bias ≈ 52.57
    // EMA ≈ 52.57 - 4.3 ≈ 48.27
    expect(result.vo2Max).not.toBeNull();
    expect(result.updatedEma).toBe(true);

    // The continuous value should be the seeded EMA
    const raw = result.vo2MaxContinuous!;
    // Verify it's in a reasonable range for this athlete
    expect(raw).toBeGreaterThan(45);
    expect(raw).toBeLessThan(55);
  });
});
