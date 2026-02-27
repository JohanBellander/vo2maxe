import { describe, expect, it } from "vitest";
import {
  clampMet,
  cyclingDynamicAlpha,
  estimateCyclingVo2Max,
  getMassFactor,
  percentHrr,
  rawMetSummary,
  rawMetWindowed,
} from "../src/cycling.js";
import { CONSTANTS } from "../src/constants.js";
import type { AthleteProfile, CyclingActivity } from "../src/types.js";

// Athlete profiles from whitepaper Table 3
// Rev2 provides calibrated mass factors: A → 0.210, B → 0.198
const athleteA: AthleteProfile = {
  maxHr: 176,
  restingHr: 42,
  weightKg: 68,
  massFactor: 0.21,
};
const athleteB: AthleteProfile = {
  maxHr: 182,
  restingHr: 50.7,
  weightKg: 77,
  massFactor: 0.198,
};

function makeCyclingActivity(
  overrides: Partial<CyclingActivity> = {},
): CyclingActivity {
  return {
    sport: "cycling",
    date: new Date("2025-06-01"),
    durationSeconds: 3600,
    avgHr: 150,
    ...overrides,
  };
}

describe("percentHrr", () => {
  it("should compute %HRR correctly", () => {
    // HR=130, HRmax=176, HRrest=42 => (130-42)/(176-42) = 88/134 ≈ 0.6567
    const result = percentHrr(130, 176, 42);
    expect(result).toBeCloseTo(88 / 134, 4);
  });

  it("should clamp to 0.01 minimum", () => {
    // HR below resting
    const result = percentHrr(40, 176, 42);
    expect(result).toBe(0.01);
  });

  it("should return 0.01 when HR equals resting", () => {
    const result = percentHrr(42, 176, 42);
    expect(result).toBe(0.01);
  });

  it("should return 1.0 when HR equals max", () => {
    const result = percentHrr(176, 176, 42);
    expect(result).toBeCloseTo(1.0, 4);
  });
});

describe("getMassFactor", () => {
  it("should match whitepaper Eq. 3 formula exactly", () => {
    // mf = -0.00131 × weight + 0.299
    const profileA: AthleteProfile = { maxHr: 176, restingHr: 42, weightKg: 68 };
    const profileB: AthleteProfile = { maxHr: 182, restingHr: 50.7, weightKg: 77 };
    expect(getMassFactor(profileA)).toBeCloseTo(-0.00131 * 68 + 0.299, 5);
    expect(getMassFactor(profileB)).toBeCloseTo(-0.00131 * 77 + 0.299, 5);
  });

  it("should return explicit massFactor when provided", () => {
    expect(getMassFactor(athleteA)).toBe(0.21);
    expect(getMassFactor(athleteB)).toBe(0.198);
  });

  it("should estimate mf from weight when not provided", () => {
    const profile: AthleteProfile = { maxHr: 176, restingHr: 42, weightKg: 68 };
    const mf = getMassFactor(profile);
    // Whitepaper Eq. 3: mf = -0.00131 × weight + 0.299
    // mf(68) = -0.00131 × 68 + 0.299 ≈ 0.210
    expect(mf).toBeCloseTo(0.21, 3);
  });

  it("should interpolate for Athlete B weight when not provided", () => {
    const profile: AthleteProfile = {
      maxHr: 182,
      restingHr: 50.7,
      weightKg: 77,
    };
    const mf = getMassFactor(profile);
    // mf(77) = -0.00131 × 77 + 0.299 ≈ 0.198
    expect(mf).toBeCloseTo(0.198, 3);
  });

  it("should extrapolate for other weights", () => {
    const profile: AthleteProfile = { maxHr: 190, restingHr: 50, weightKg: 75 };
    const mf = getMassFactor(profile);
    // mf(75) = -0.00131 × 75 + 0.299 ≈ 0.201
    expect(mf).toBeGreaterThan(0.19);
    expect(mf).toBeLessThan(0.22);
  });

  it("should decrease with increasing weight (default)", () => {
    const light: AthleteProfile = { maxHr: 190, restingHr: 50, weightKg: 60 };
    const heavy: AthleteProfile = { maxHr: 190, restingHr: 50, weightKg: 90 };
    expect(getMassFactor(light)).toBeGreaterThan(getMassFactor(heavy));
  });
});

describe("clampMet", () => {
  it("should not clamp values within range", () => {
    expect(clampMet(10)).toBe(10);
    expect(clampMet(1)).toBe(1);
    expect(clampMet(30)).toBe(30);
  });

  it("should clamp values below minimum to 1.0", () => {
    expect(clampMet(0.5)).toBe(1.0);
    expect(clampMet(-5)).toBe(1.0);
  });

  it("should clamp values above maximum to 30.0", () => {
    expect(clampMet(35)).toBe(30.0);
    expect(clampMet(200)).toBe(30.0);
  });
});

describe("rawMetWindowed", () => {
  it("should compute raw MET from windowed data with calibrated mf", () => {
    const mf = 0.21; // Athlete A calibrated
    const result = rawMetWindowed(200, 150, mf, 176, 42);
    const pctHrr = (150 - 42) / (176 - 42);
    const expected = 0.6828 * ((200 * mf) / pctHrr) + -18.394;
    expect(result).toBeCloseTo(expected, 4);
  });

  it("should produce physiologically realistic MET values", () => {
    const mf = 0.21;
    const result = rawMetWindowed(250, 160, mf, 176, 42);
    // 250W in a 5-min window should produce ~10-20 MET
    expect(result).toBeGreaterThan(5);
    expect(result).toBeLessThan(25);
  });
});

describe("rawMetSummary", () => {
  it("should match whitepaper rev2 worked example", () => {
    // Whitepaper worked example (summary model):
    // Athlete A (68kg, HRrest=42, HRmax=176)
    // mf = -0.00131 × 68 + 0.299 = 0.210
    // P_avg=180W, HR_avg=140bpm
    // %HRR = (140-42)/(176-42) = 0.731
    // inner = 180 × 0.210 / 0.731 = 51.71
    // raw_MET = 0.2982 × 51.71 + 0.819 = 16.24
    const mf = 0.21;
    const result = rawMetSummary(180, 140, mf, 176, 42);
    expect(result).toBeCloseTo(16.24, 1);
  });

  it("should compute raw MET from summary data with calibrated mf", () => {
    const mf = 0.21;
    const result = rawMetSummary(180, 145, mf, 176, 42);
    const pctHrr = (145 - 42) / (176 - 42);
    const expected = 0.2982 * ((180 * mf) / pctHrr) + 0.819;
    expect(result).toBeCloseTo(expected, 4);
  });

  it("should produce physiologically realistic MET values", () => {
    const mf = 0.21;
    const result = rawMetSummary(150, 140, mf, 176, 42);
    // 150W average should produce ~8-18 MET
    expect(result).toBeGreaterThan(5);
    expect(result).toBeLessThan(25);
  });
});

describe("cyclingDynamicAlpha", () => {
  it("should start near CYCLING_ALPHA_START at n=0", () => {
    const alpha = cyclingDynamicAlpha(0);
    expect(alpha).toBeCloseTo(CONSTANTS.CYCLING_ALPHA_START, 2);
  });

  it("should converge toward CYCLING_ALPHA_END for large n", () => {
    const alpha = cyclingDynamicAlpha(100);
    expect(alpha).toBeCloseTo(CONSTANTS.CYCLING_ALPHA_END, 2);
  });

  it("should decrease monotonically", () => {
    const alphas = [0, 5, 10, 20, 50].map(cyclingDynamicAlpha);
    for (let i = 1; i < alphas.length; i++) {
      expect(alphas[i]).toBeLessThanOrEqual(alphas[i - 1]!);
    }
  });
});

describe("estimateCyclingVo2Max", () => {
  describe("primary path: maxMet passthrough", () => {
    it("should compute VO2Max = round(maxMet * 3.5)", () => {
      const activity = makeCyclingActivity({ maxMet: 16.0 });
      const result = estimateCyclingVo2Max(activity, athleteA);
      expect(result).not.toBeNull();
      expect(result!.vo2MaxContinuous).toBeCloseTo(56.0, 4);
      expect(result!.vo2Max).toBe(56);
    });

    it("should round correctly at boundaries", () => {
      // 15.8572 * 3.5 = 55.5002 => rounds to 56
      const activity = makeCyclingActivity({ maxMet: 15.8572 });
      const result = estimateCyclingVo2Max(activity, athleteA);
      expect(result!.vo2Max).toBe(56);

      // 15.857 * 3.5 = 55.4995 => rounds to 55
      const activity2 = makeCyclingActivity({ maxMet: 15.857 });
      const result2 = estimateCyclingVo2Max(activity2, athleteA);
      expect(result2!.vo2Max).toBe(55);
    });

    it("should handle fractional maxMet values", () => {
      // 14.3 * 3.5 = 50.05 => rounds to 50
      const activity = makeCyclingActivity({ maxMet: 14.3 });
      const result = estimateCyclingVo2Max(activity, athleteA);
      expect(result!.vo2MaxContinuous).toBeCloseTo(50.05, 4);
      expect(result!.vo2Max).toBe(50);
    });

    it("should not apply temporal smoothing", () => {
      // Each activity is independent when maxMet is available
      const a1 = makeCyclingActivity({ maxMet: 16.0 });
      const a2 = makeCyclingActivity({ maxMet: 14.0 });
      const r1 = estimateCyclingVo2Max(a1, athleteA);
      const r2 = estimateCyclingVo2Max(a2, athleteA);
      expect(r1!.vo2Max).toBe(56);
      expect(r2!.vo2Max).toBe(49);
    });
  });

  describe("fallback path: power-based estimation", () => {
    it("should return null when no maxMet and no avgPower", () => {
      const activity = makeCyclingActivity();
      const result = estimateCyclingVo2Max(activity, athleteA);
      expect(result).toBeNull();
    });

    it("should match whitepaper rev2 worked example", () => {
      // Athlete A: 180W avg, 140bpm avg, mf=0.210
      // Expected: raw_MET = 16.24, VO2Max = round(16.24 × 3.5) = round(56.8) = 57
      const activity = makeCyclingActivity({ avgPower: 180, avgHr: 140 });
      const result = estimateCyclingVo2Max(activity, athleteA);
      expect(result).not.toBeNull();
      expect(result!.vo2MaxContinuous).toBeCloseTo(56.8, 0);
      expect(result!.vo2Max).toBe(57);
    });

    it("should produce physiologically realistic VO2Max (40-70 range)", () => {
      const activity = makeCyclingActivity({ avgPower: 200, avgHr: 150 });
      const result = estimateCyclingVo2Max(activity, athleteA);
      expect(result).not.toBeNull();
      expect(result!.vo2Max).toBeGreaterThan(30);
      expect(result!.vo2Max).toBeLessThan(80);
    });

    it("should prefer windowed data when available", () => {
      const activitySummary = makeCyclingActivity({ avgPower: 200 });
      const activityWindowed = makeCyclingActivity({
        avgPower: 200,
        windowedData: { power: 250, hr: 160 },
      });
      const r1 = estimateCyclingVo2Max(activitySummary, athleteA);
      const r2 = estimateCyclingVo2Max(activityWindowed, athleteA);
      // Windowed and summary should produce different results
      expect(r1!.vo2MaxContinuous).not.toBeCloseTo(r2!.vo2MaxContinuous, 0);
    });

    it("should use default mf when massFactor not in profile", () => {
      const profileNoMf: AthleteProfile = {
        maxHr: 176,
        restingHr: 42,
        weightKg: 68,
      };
      const activity = makeCyclingActivity({ avgPower: 180, avgHr: 140 });
      const result = estimateCyclingVo2Max(activity, profileNoMf);
      expect(result).not.toBeNull();
      // Formula mf for 68kg ≈ 0.210 (same as calibrated), so result should match
      expect(result!.vo2Max).toBe(57);
    });

    it("should apply EWMA when fallback state is provided", () => {
      const state = { ewma: null as number | null, count: 0 };
      const a1 = makeCyclingActivity({ avgPower: 200 });
      const a2 = makeCyclingActivity({ avgPower: 250 });

      const r1 = estimateCyclingVo2Max(a1, athleteA, state);
      expect(state.count).toBe(1);

      const r2 = estimateCyclingVo2Max(a2, athleteA, state);
      expect(state.count).toBe(2);

      // Second result should be smoothed (not equal to raw)
      const rawR2 = estimateCyclingVo2Max(a2, athleteA);
      expect(r2!.vo2MaxContinuous).not.toBeCloseTo(
        rawR2!.vo2MaxContinuous,
        1,
      );
    });

    it("should produce realistic VO2Max for issue #1 scenario (was ~714, now ~65)", () => {
      // Regression test for GitHub issue #1:
      // With the old v1 mass factor formula, 146W/119bpm/75kg produced VO2Max ≈ 714.
      // With rev2 default interpolation (mf ≈ 0.201 for 75kg), it should be ~65.
      const issueProfile: AthleteProfile = {
        maxHr: 190,
        restingHr: 50,
        weightKg: 75,
      };
      const activity = makeCyclingActivity({ avgPower: 146, avgHr: 119 });
      const result = estimateCyclingVo2Max(activity, issueProfile);
      expect(result).not.toBeNull();
      // Should be in a realistic range, not hundreds
      expect(result!.vo2Max).toBeGreaterThan(40);
      expect(result!.vo2Max).toBeLessThan(80);
    });

    it("should clamp absurd MET values to safe range", () => {
      // A profile with absurdly high mf should still be clamped
      const badProfile: AthleteProfile = {
        maxHr: 190,
        restingHr: 50,
        weightKg: 75,
        massFactor: 5.0, // intentionally wrong
      };
      const activity = makeCyclingActivity({ avgPower: 200, avgHr: 130 });
      const result = estimateCyclingVo2Max(activity, badProfile);
      expect(result).not.toBeNull();
      // Raw MET would be enormous without clamp, but clamp limits to 30 MET max
      expect(result!.vo2MaxContinuous).toBeLessThanOrEqual(30 * 3.5);
    });
  });
});
