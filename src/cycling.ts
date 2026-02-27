/**
 * Cycling VO2Max estimation.
 *
 * Implements whitepaper Section 4:
 * - Primary path: direct maxMet passthrough (Eq. 2)
 * - Fallback path: power-based estimation with %HRR model (Eqs. 3-7)
 *
 * The mass factor (mf) normalizes absolute power (watts) for body weight.
 * A linear model fitted to two athletes is used by default (Eq. 3):
 *   mf = -0.00131 × weight_kg + 0.299
 * An explicit override can be provided via AthleteProfile.massFactor.
 */

import { CONSTANTS } from "./constants.js";
import type { AthleteProfile, CyclingActivity } from "./types.js";

/**
 * Compute %Heart Rate Reserve.
 * Eq. 2 from the whitepaper: %HRR = max((HR - HRrest) / (HRmax - HRrest), 0.01)
 */
export function percentHrr(
  hr: number,
  hrMax: number,
  hrRest: number,
): number {
  return Math.max((hr - hrRest) / (hrMax - hrRest), 0.01);
}

/**
 * Get the mass factor for cycling power normalization.
 *
 * If the athlete profile includes an explicit massFactor, it is used directly.
 * Otherwise, the linear model from the whitepaper (Eq. 3) is applied:
 *   mf = -0.00131 × weight_kg + 0.299
 *
 * This formula is a two-point fit (68 kg → 0.210, 77 kg → 0.198).
 * Accuracy outside the 68-77 kg calibration range is uncertain.
 */
export function getMassFactor(profile: AthleteProfile): number {
  if (profile.massFactor != null) {
    return profile.massFactor;
  }
  return (
    CONSTANTS.MASS_FACTOR_SLOPE * profile.weightKg +
    CONSTANTS.MASS_FACTOR_INTERCEPT
  );
}

/**
 * Clamp raw MET to a physiologically valid range.
 *
 * Vigorous cycling typically produces 5-18 MET. Values outside 1-30 MET
 * are physically impossible and indicate a formula or input error.
 */
export function clampMet(rawMet: number): number {
  return Math.max(
    CONSTANTS.CYCLING_MET_CLAMP_MIN,
    Math.min(CONSTANTS.CYCLING_MET_CLAMP_MAX, rawMet),
  );
}

/**
 * Compute raw MET from windowed power/HR data (best 5-min window).
 * Eq. 6: raw_MET = 0.6828 × (P_win × mf / %HRR(HR_win)) - 18.394
 */
export function rawMetWindowed(
  windowPower: number,
  windowHr: number,
  mf: number,
  hrMax: number,
  hrRest: number,
): number {
  const pctHrr = percentHrr(windowHr, hrMax, hrRest);
  const raw =
    CONSTANTS.CYCLING_WINDOWED_K * ((windowPower * mf) / pctHrr) +
    CONSTANTS.CYCLING_WINDOWED_D;
  return clampMet(raw);
}

/**
 * Compute raw MET from summary-level averages.
 * Eq. 7: raw_MET = 0.2982 × (P_avg × mf / %HRR(HR_avg)) + 0.819
 */
export function rawMetSummary(
  avgPower: number,
  avgHr: number,
  mf: number,
  hrMax: number,
  hrRest: number,
): number {
  const pctHrr = percentHrr(avgHr, hrMax, hrRest);
  const raw =
    CONSTANTS.CYCLING_SUMMARY_K * ((avgPower * mf) / pctHrr) +
    CONSTANTS.CYCLING_SUMMARY_D;
  return clampMet(raw);
}

/**
 * Compute dynamic alpha for cycling fallback EWMA.
 * Eq. 8: α_t = α_end + (α_start - α_end) × exp(-α_decay × n)
 */
export function cyclingDynamicAlpha(n: number): number {
  return (
    CONSTANTS.CYCLING_ALPHA_END +
    (CONSTANTS.CYCLING_ALPHA_START - CONSTANTS.CYCLING_ALPHA_END) *
      Math.exp(-CONSTANTS.CYCLING_ALPHA_DECAY * n)
  );
}

/**
 * Estimate cycling VO2Max for a single activity.
 *
 * Returns the continuous (unrounded) VO2Max and the rounded integer.
 * Returns null if no estimate can be produced.
 *
 * @param activity - The cycling activity data
 * @param profile - The athlete profile (including optional massFactor)
 * @param fallbackState - Mutable state for the cycling fallback EWMA.
 *   Pass `{ ewma: number | null; count: number }` to maintain state across
 *   activities. Only used when maxMet is unavailable.
 */
export function estimateCyclingVo2Max(
  activity: CyclingActivity,
  profile: AthleteProfile,
  fallbackState?: { ewma: number | null; count: number },
): { vo2Max: number; vo2MaxContinuous: number } | null {
  // Primary path: direct maxMet passthrough (Section 4.1)
  if (activity.maxMet != null) {
    const continuous = activity.maxMet * CONSTANTS.MET_TO_VO2;
    return {
      vo2Max: Math.round(continuous),
      vo2MaxContinuous: continuous,
    };
  }

  // Fallback path: power-based estimation (Section 4.2)
  if (activity.avgPower == null) {
    return null;
  }

  const mf = getMassFactor(profile);
  let rawMet: number;

  if (activity.windowedData) {
    rawMet = rawMetWindowed(
      activity.windowedData.power,
      activity.windowedData.hr,
      mf,
      profile.maxHr,
      profile.restingHr,
    );
  } else {
    rawMet = rawMetSummary(
      activity.avgPower,
      activity.avgHr,
      mf,
      profile.maxHr,
      profile.restingHr,
    );
  }

  // Apply dynamic-alpha EWMA if state is provided
  if (fallbackState) {
    if (fallbackState.ewma == null) {
      fallbackState.ewma = rawMet;
    } else {
      const alpha = cyclingDynamicAlpha(fallbackState.count);
      fallbackState.ewma = alpha * rawMet + (1 - alpha) * fallbackState.ewma;
    }
    fallbackState.count++;
    rawMet = fallbackState.ewma;
  }

  const continuous = rawMet * CONSTANTS.MET_TO_VO2;
  return {
    vo2Max: Math.round(continuous),
    vo2MaxContinuous: continuous,
  };
}
