import { describe, expect, it } from "vitest";
import {
  cyclingDynamicAlpha,
  estimateCyclingVo2Max,
  massFactor,
  percentHrr,
  rawMetSummary,
  rawMetWindowed,
} from "../src/cycling.js";
import { CONSTANTS } from "../src/constants.js";
import type { AthleteProfile, CyclingActivity } from "../src/types.js";

// Athlete profiles from whitepaper Table 3
const athleteA: AthleteProfile = { maxHr: 176, restingHr: 42, weightKg: 68 };
const athleteB: AthleteProfile = { maxHr: 182, restingHr: 50.7, weightKg: 77 };

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

describe("massFactor", () => {
  it("should compute mass factor for Athlete A (68 kg)", () => {
    // mf = -0.034 * 68 + 4.85 = -2.312 + 4.85 = 2.538
    const mf = massFactor(68);
    expect(mf).toBeCloseTo(2.538, 3);
  });

  it("should compute mass factor for Athlete B (77 kg)", () => {
    // mf = -0.034 * 77 + 4.85 = -2.618 + 4.85 = 2.232
    const mf = massFactor(77);
    expect(mf).toBeCloseTo(2.232, 3);
  });

  it("should decrease with increasing weight", () => {
    expect(massFactor(60)).toBeGreaterThan(massFactor(80));
  });
});

describe("rawMetWindowed", () => {
  it("should compute raw MET from windowed data", () => {
    const mf = massFactor(68);
    const result = rawMetWindowed(200, 150, mf, 176, 42);
    // P_win * mf / %HRR(150) * k + d
    const pctHrr = (150 - 42) / (176 - 42);
    const expected = 0.6828 * ((200 * mf) / pctHrr) + -18.394;
    expect(result).toBeCloseTo(expected, 4);
  });
});

describe("rawMetSummary", () => {
  it("should compute raw MET from summary data", () => {
    const mf = massFactor(68);
    const result = rawMetSummary(180, 145, mf, 176, 42);
    const pctHrr = (145 - 42) / (176 - 42);
    const expected = 0.2982 * ((180 * mf) / pctHrr) + 0.819;
    expect(result).toBeCloseTo(expected, 4);
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

    it("should compute from summary avgPower when no windowed data", () => {
      const activity = makeCyclingActivity({ avgPower: 200 });
      const result = estimateCyclingVo2Max(activity, athleteA);
      expect(result).not.toBeNull();
      expect(result!.vo2Max).toBeGreaterThan(0);
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
      expect(r2!.vo2MaxContinuous).not.toBeCloseTo(rawR2!.vo2MaxContinuous, 1);
    });
  });
});
