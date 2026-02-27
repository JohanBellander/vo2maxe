import { describe, expect, it } from "vitest";
import {
  acsmRunningCost,
  applyBiasCorrection,
  applyDecay,
  applyDurationCorrection,
  applyGapBoost,
  computeDecay,
  computeRawVo2Max,
  computeRunningEstimate,
  daysBetween,
  getAlpha,
  isQualityActivity,
  passesSanityFilters,
  pctVo2MaxFromPctHrMax,
  seedEma,
  updateEma,
} from "../src/running.js";
import { CONSTANTS } from "../src/constants.js";
import type { AthleteProfile, RunningActivity } from "../src/types.js";

const athleteA: AthleteProfile = { maxHr: 176, restingHr: 42, weightKg: 68 };

function makeRunningActivity(
  overrides: Partial<RunningActivity> = {},
): RunningActivity {
  return {
    sport: "running",
    date: new Date("2025-06-01"),
    durationSeconds: 2700, // 45 min
    avgHr: 150,
    avgSpeedMs: 2.7,
    ...overrides,
  };
}

// ── ACSM running cost ──────────────────────────────────────────────────

describe("acsmRunningCost", () => {
  it("should match the whitepaper worked example", () => {
    // v = 2.7 m/s => v_m/min = 162
    // VO2_exercise = 0.95 × (0.2 × 162 + 3.5) = 0.95 × 35.9 = 34.105
    const result = acsmRunningCost(2.7);
    expect(result).toBeCloseTo(34.105, 2);
  });

  it("should increase with speed", () => {
    expect(acsmRunningCost(3.0)).toBeGreaterThan(acsmRunningCost(2.5));
  });

  it("should return resting VO2 scaled by c_s at zero speed", () => {
    // 0.95 × (0.2 × 0 + 3.5) = 0.95 × 3.5 = 3.325
    expect(acsmRunningCost(0)).toBeCloseTo(3.325, 3);
  });
});

// ── %VO2max from %HRmax ────────────────────────────────────────────────

describe("pctVo2MaxFromPctHrMax", () => {
  it("should match the whitepaper worked example", () => {
    // %HRmax = 130/176 = 0.7386
    // %VO2max = 1.08 × 0.7386 - 0.15 = 0.6477
    const pctHrMax = 130 / 176;
    const result = pctVo2MaxFromPctHrMax(pctHrMax);
    expect(result).toBeCloseTo(0.648, 2);
  });

  it("should return ~0.93 at 100% HRmax", () => {
    // 1.08 × 1.0 - 0.15 = 0.93
    expect(pctVo2MaxFromPctHrMax(1.0)).toBeCloseTo(0.93, 2);
  });
});

// ── Sanity filters ─────────────────────────────────────────────────────

describe("passesSanityFilters", () => {
  it("should pass for normal values", () => {
    expect(passesSanityFilters(150, 2.7, 2700, 0.85, 0.77)).toBe(true);
  });

  it("should reject low avgHR", () => {
    expect(passesSanityFilters(90, 2.7, 2700, 0.85, 0.77)).toBe(false);
  });

  it("should reject low speed", () => {
    expect(passesSanityFilters(150, 0.5, 2700, 0.85, 0.77)).toBe(false);
  });

  it("should reject short duration (< 10 min)", () => {
    expect(passesSanityFilters(150, 2.7, 500, 0.85, 0.77)).toBe(false);
  });

  it("should reject %HRmax below 0.50", () => {
    expect(passesSanityFilters(150, 2.7, 2700, 0.45, 0.77)).toBe(false);
  });

  it("should reject %HRmax above 1.00", () => {
    expect(passesSanityFilters(150, 2.7, 2700, 1.05, 0.77)).toBe(false);
  });

  it("should reject %VO2max below 0.10", () => {
    expect(passesSanityFilters(150, 2.7, 2700, 0.85, 0.05)).toBe(false);
  });

  it("should reject %VO2max above 1.00", () => {
    expect(passesSanityFilters(150, 2.7, 2700, 0.85, 1.05)).toBe(false);
  });

  it("should accept boundary values (exactly at thresholds)", () => {
    expect(passesSanityFilters(100, 1.0, 600, 0.50, 0.10)).toBe(true);
    expect(passesSanityFilters(100, 1.0, 600, 1.00, 1.00)).toBe(true);
  });
});

// ── Raw VO2Max computation ─────────────────────────────────────────────

describe("computeRawVo2Max", () => {
  it("should match the whitepaper worked example", () => {
    // v=2.7 m/s, avgHR=130, HRmax=176
    // VO2_exercise = 34.105, %VO2max = 0.648, raw = 34.105 / 0.648 = 52.63
    const activity = makeRunningActivity({ avgHr: 130 });
    const result = computeRawVo2Max(activity, athleteA);
    expect(result).not.toBeNull();
    expect(result).toBeCloseTo(52.6, 0);
  });

  it("should return null for low HR", () => {
    const activity = makeRunningActivity({ avgHr: 80 });
    const result = computeRawVo2Max(activity, athleteA);
    expect(result).toBeNull();
  });

  it("should return null for very low speed", () => {
    const activity = makeRunningActivity({ avgSpeedMs: 0.5 });
    const result = computeRawVo2Max(activity, athleteA);
    expect(result).toBeNull();
  });

  it("should return null for very short duration", () => {
    const activity = makeRunningActivity({ durationSeconds: 300 });
    const result = computeRawVo2Max(activity, athleteA);
    expect(result).toBeNull();
  });
});

// ── Duration correction ────────────────────────────────────────────────

describe("applyDurationCorrection", () => {
  it("should not change estimate at center point (45 min)", () => {
    const result = applyDurationCorrection(52.0, 45 * 60);
    expect(result).toBeCloseTo(52.0, 4);
  });

  it("should decrease for short runs (35 min)", () => {
    // 0.04 × (35 - 45) = -0.4
    const result = applyDurationCorrection(52.0, 35 * 60);
    expect(result).toBeCloseTo(51.6, 4);
  });

  it("should increase for long runs (55 min)", () => {
    // 0.04 × (55 - 45) = +0.4
    const result = applyDurationCorrection(52.0, 55 * 60);
    expect(result).toBeCloseTo(52.4, 4);
  });
});

// ── Bias correction ────────────────────────────────────────────────────

describe("applyBiasCorrection", () => {
  it("should subtract 0.03", () => {
    expect(applyBiasCorrection(52.0)).toBeCloseTo(51.97, 4);
  });
});

// ── Full running estimate ──────────────────────────────────────────────

describe("computeRunningEstimate", () => {
  it("should apply raw + duration correction + bias correction", () => {
    const activity = makeRunningActivity({ avgHr: 130, durationSeconds: 45 * 60 });
    const raw = computeRawVo2Max(activity, athleteA)!;
    const expected = raw + CONSTANTS.BIAS_CORRECTION; // duration correction = 0 at 45min
    const result = computeRunningEstimate(activity, athleteA);
    expect(result).toBeCloseTo(expected, 4);
  });

  it("should return null for invalid activities", () => {
    const activity = makeRunningActivity({ avgHr: 80 });
    expect(computeRunningEstimate(activity, athleteA)).toBeNull();
  });
});

// ── Quality filtering ──────────────────────────────────────────────────

describe("isQualityActivity", () => {
  it("should accept activity >= 39 min and >= 72% HRmax", () => {
    // 2340s = 39min, 0.72 * 176 = 126.72 bpm
    const activity = makeRunningActivity({
      durationSeconds: 2400,
      avgHr: 130,
    });
    expect(isQualityActivity(activity, athleteA)).toBe(true);
  });

  it("should reject activity < 39 min", () => {
    const activity = makeRunningActivity({
      durationSeconds: 2300,
      avgHr: 150,
    });
    expect(isQualityActivity(activity, athleteA)).toBe(false);
  });

  it("should reject activity with HR < 72% HRmax", () => {
    // 72% of 176 = 126.72
    const activity = makeRunningActivity({
      durationSeconds: 2400,
      avgHr: 120,
    });
    expect(isQualityActivity(activity, athleteA)).toBe(false);
  });

  it("should accept at exact boundary (39 min, 72% HRmax)", () => {
    const activity = makeRunningActivity({
      durationSeconds: 2340,
      avgHr: Math.ceil(0.72 * 176), // 127 bpm
    });
    expect(isQualityActivity(activity, athleteA)).toBe(true);
  });
});

// ── EMA alpha ──────────────────────────────────────────────────────────

describe("getAlpha", () => {
  it("should return 0.07 for phase 1 (n < 18)", () => {
    expect(getAlpha(0)).toBe(CONSTANTS.ALPHA_PHASE1);
    expect(getAlpha(17)).toBe(CONSTANTS.ALPHA_PHASE1);
  });

  it("should return 0.02 for phase 2 (n >= 18)", () => {
    expect(getAlpha(18)).toBe(CONSTANTS.ALPHA_PHASE2);
    expect(getAlpha(100)).toBe(CONSTANTS.ALPHA_PHASE2);
  });
});

describe("applyGapBoost", () => {
  it("should not boost when gap is within threshold", () => {
    expect(applyGapBoost(0.07, 20)).toBe(0.07);
  });

  it("should boost when gap exceeds 28 days", () => {
    // 0.07 * 8 = 0.56
    expect(applyGapBoost(0.07, 35)).toBeCloseTo(0.56, 4);
  });

  it("should boost phase 2 alpha correctly", () => {
    // 0.02 * 8 = 0.16
    expect(applyGapBoost(0.02, 35)).toBeCloseTo(0.16, 4);
  });

  it("should cap at 1.0", () => {
    expect(applyGapBoost(0.2, 35)).toBe(1.0);
  });

  it("should not boost when daysSinceLastQuality is null", () => {
    expect(applyGapBoost(0.07, null)).toBe(0.07);
  });
});

// ── EMA seeding and update ─────────────────────────────────────────────

describe("seedEma", () => {
  it("should subtract seed damping (4.3) from first raw estimate", () => {
    expect(seedEma(55.0)).toBeCloseTo(50.7, 4);
  });
});

describe("updateEma", () => {
  it("should apply EMA formula correctly", () => {
    // EMA = 0.07 * 55 + 0.93 * 50 = 3.85 + 46.5 = 50.35
    const result = updateEma(50.0, 55.0, 0.07);
    expect(result).toBeCloseTo(50.35, 4);
  });

  it("should not change when raw equals EMA", () => {
    const result = updateEma(50.0, 50.0, 0.07);
    expect(result).toBeCloseTo(50.0, 4);
  });

  it("should converge faster with higher alpha", () => {
    const slow = updateEma(50.0, 60.0, 0.02);
    const fast = updateEma(50.0, 60.0, 0.07);
    expect(fast).toBeGreaterThan(slow);
  });
});

// ── Detraining decay ───────────────────────────────────────────────────

describe("computeDecay", () => {
  it("should be zero within grace period (<= 3 days)", () => {
    expect(computeDecay(0)).toBe(0);
    expect(computeDecay(1)).toBe(0);
    expect(computeDecay(3)).toBe(0);
  });

  it("should match whitepaper Table 6 values", () => {
    // 10 days: 0.01 * sqrt(10 - 3) = 0.01 * sqrt(7) ≈ 0.026
    expect(computeDecay(10)).toBeCloseTo(0.026, 2);
    // 21 days: 0.01 * sqrt(18) ≈ 0.042
    expect(computeDecay(21)).toBeCloseTo(0.042, 2);
    // 40 days: 0.01 * sqrt(37) ≈ 0.061
    expect(computeDecay(40)).toBeCloseTo(0.061, 2);
    // 60 days: 0.01 * sqrt(57) ≈ 0.075
    expect(computeDecay(60)).toBeCloseTo(0.075, 2);
  });

  it("should not exceed maximum decay (5.0)", () => {
    // Would need huge gap: 0.01 * sqrt(d) = 5 => d = 250000
    expect(computeDecay(300000)).toBe(5.0);
  });

  it("should increase with gap length (sublinearly)", () => {
    // sqrt is concave: doubling effective gap should less than double decay
    // effective gaps: 7 (gap=10), 37 (gap=40), 77 (gap=80)
    const d10 = computeDecay(10);  // 0.01 * sqrt(7)
    const d40 = computeDecay(40);  // 0.01 * sqrt(37)
    const d80 = computeDecay(80);  // 0.01 * sqrt(77)
    expect(d40).toBeGreaterThan(d10);
    expect(d80).toBeGreaterThan(d40);
    // Doubling total gap from 40 to 80 should produce less increase
    // than from 10 to 40 (concavity of sqrt with offset)
    expect(d80 / d40).toBeLessThan(d40 / d10);
  });
});

describe("applyDecay", () => {
  it("should reduce EMA by decay amount", () => {
    const ema = 55.0;
    const result = applyDecay(ema, 21);
    const decay = computeDecay(21);
    expect(result).toBeCloseTo(ema - decay, 4);
  });
});

// ── daysBetween ────────────────────────────────────────────────────────

describe("daysBetween", () => {
  it("should compute days between two dates", () => {
    const a = new Date("2025-01-01");
    const b = new Date("2025-01-11");
    expect(daysBetween(a, b)).toBeCloseTo(10, 1);
  });

  it("should return 0 for same date", () => {
    const a = new Date("2025-06-01");
    expect(daysBetween(a, a)).toBe(0);
  });

  it("should be symmetric", () => {
    const a = new Date("2025-01-01");
    const b = new Date("2025-02-15");
    expect(daysBetween(a, b)).toBeCloseTo(daysBetween(b, a), 4);
  });
});
