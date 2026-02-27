/**
 * Running VO2Max estimation.
 *
 * Implements whitepaper Section 5:
 * - ACSM running metabolic cost model (Eq. 4)
 * - %HRmax-to-%VO2max mapping (Eq. 5)
 * - Raw VO2Max computation (Eq. 6)
 * - Sanity filters (Section 5.1.4)
 * - Duration correction (Eq. 8)
 * - Bias correction (Eq. 9)
 * - Quality filtering (Section 5.4)
 * - Two-phase EMA smoothing (Section 5.5)
 * - Gap-aware alpha boosting (Section 5.6)
 * - EMA seeding (Section 5.7)
 * - Detraining decay (Section 5.8)
 */

import { CONSTANTS } from "./constants.js";
import type { AthleteProfile, RunningActivity } from "./types.js";

// ── Raw estimate computation ───────────────────────────────────────────

/**
 * Compute the ACSM running oxygen cost at a given speed.
 * Eq. 4: VO2_exercise = c_s × (0.2 × v × 60 + 3.5)
 *
 * @param speedMs - Speed in m/s (grade-adjusted when available)
 * @returns Oxygen cost in ml/kg/min
 */
export function acsmRunningCost(speedMs: number): number {
  const speedMMin = speedMs * 60;
  return CONSTANTS.ACSM_COST_SCALE * (0.2 * speedMMin + 3.5);
}

/**
 * Compute %VO2max from %HRmax.
 * Eq. 5: %VO2max = a × %HRmax + b
 *
 * @param pctHrMax - Fraction of maximum heart rate (avgHR / HRmax)
 * @returns Fraction of VO2max being utilized
 */
export function pctVo2MaxFromPctHrMax(pctHrMax: number): number {
  return CONSTANTS.HR_MAX_SLOPE * pctHrMax + CONSTANTS.HR_MAX_INTERCEPT;
}

/**
 * Check whether the raw estimate inputs pass sanity filters.
 * Section 5.1.4: rejects estimates with extreme or unreliable inputs.
 */
export function passesSanityFilters(
  avgHr: number,
  speedMs: number,
  durationSeconds: number,
  pctHrMax: number,
  pctVo2Max: number,
): boolean {
  if (avgHr < CONSTANTS.SANITY_MIN_AVG_HR) return false;
  if (speedMs < CONSTANTS.SANITY_MIN_SPEED_MS) return false;
  if (durationSeconds / 60 < CONSTANTS.SANITY_MIN_DURATION_MIN) return false;
  if (pctHrMax < CONSTANTS.SANITY_PCT_HR_MAX_MIN || pctHrMax > CONSTANTS.SANITY_PCT_HR_MAX_MAX)
    return false;
  if (pctVo2Max < CONSTANTS.SANITY_PCT_VO2_MAX_MIN || pctVo2Max > CONSTANTS.SANITY_PCT_VO2_MAX_MAX)
    return false;
  return true;
}

/**
 * Compute the raw (uncorrected) VO2Max estimate for a running activity.
 * Returns null if sanity filters reject the inputs.
 *
 * @param activity - Running activity data
 * @param profile - Athlete profile
 * @returns Raw VO2Max or null if inputs are invalid
 */
export function computeRawVo2Max(
  activity: RunningActivity,
  profile: AthleteProfile,
): number | null {
  const pctHrMax = activity.avgHr / profile.maxHr;
  const pctVo2Max = pctVo2MaxFromPctHrMax(pctHrMax);

  if (
    !passesSanityFilters(
      activity.avgHr,
      activity.avgSpeedMs,
      activity.durationSeconds,
      pctHrMax,
      pctVo2Max,
    )
  ) {
    return null;
  }

  const vo2Exercise = acsmRunningCost(activity.avgSpeedMs);
  return vo2Exercise / pctVo2Max;
}

// ── Corrections ────────────────────────────────────────────────────────

/**
 * Apply duration correction to compensate for cardiac drift.
 * Eq. 8: corrected = raw + 0.04 × (d_min - 45)
 *
 * @param rawVo2Max - Raw VO2Max estimate
 * @param durationSeconds - Activity duration in seconds
 * @returns Duration-corrected VO2Max
 */
export function applyDurationCorrection(
  rawVo2Max: number,
  durationSeconds: number,
): number {
  const durationMin = durationSeconds / 60;
  return rawVo2Max + CONSTANTS.DURATION_CORRECTION_SLOPE * (durationMin - CONSTANTS.DURATION_CORRECTION_CENTER);
}

/**
 * Apply bias correction.
 * Eq. 9: adjusted = corrected + b_c
 *
 * @param correctedVo2Max - Duration-corrected VO2Max
 * @returns Bias-corrected VO2Max
 */
export function applyBiasCorrection(correctedVo2Max: number): number {
  return correctedVo2Max + CONSTANTS.BIAS_CORRECTION;
}

/**
 * Full per-activity running estimate: raw + duration correction + bias correction.
 * Returns null if sanity filters reject the inputs.
 */
export function computeRunningEstimate(
  activity: RunningActivity,
  profile: AthleteProfile,
): number | null {
  const raw = computeRawVo2Max(activity, profile);
  if (raw == null) return null;
  const corrected = applyDurationCorrection(raw, activity.durationSeconds);
  return applyBiasCorrection(corrected);
}

// ── Quality filtering ──────────────────────────────────────────────────

/**
 * Determine whether a running activity meets quality criteria.
 * Section 5.4: duration >= 39 min AND avgHR >= 72% HRmax.
 */
export function isQualityActivity(
  activity: RunningActivity,
  profile: AthleteProfile,
): boolean {
  if (activity.durationSeconds < CONSTANTS.QUALITY_MIN_DURATION_S) return false;
  if (activity.avgHr / profile.maxHr < CONSTANTS.QUALITY_MIN_PCT_HR_MAX) return false;
  return true;
}

// ── EMA smoothing ──────────────────────────────────────────────────────

/**
 * Get the EMA alpha based on the current phase.
 * Eq. 11: α = 0.07 if n < 18, else 0.02
 *
 * @param qualityCount - Number of quality EMA updates completed so far
 */
export function getAlpha(qualityCount: number): number {
  return qualityCount < CONSTANTS.PHASE_SWITCH_N
    ? CONSTANTS.ALPHA_PHASE1
    : CONSTANTS.ALPHA_PHASE2;
}

/**
 * Apply gap-aware alpha boosting.
 * Eq. 12: α_boosted = min(α × 8, 1.0)
 *
 * @param alpha - Base alpha value
 * @param daysSinceLastQuality - Days since the last quality running activity
 * @returns Boosted alpha if gap exceeds threshold, otherwise original alpha
 */
export function applyGapBoost(
  alpha: number,
  daysSinceLastQuality: number | null,
): number {
  if (daysSinceLastQuality != null && daysSinceLastQuality > CONSTANTS.GAP_BOOST_THRESHOLD_DAYS) {
    return Math.min(alpha * CONSTANTS.GAP_BOOST_MULTIPLIER, 1.0);
  }
  return alpha;
}

/**
 * Seed the EMA from the first quality activity.
 * Eq. 13: EMA_0 = raw_first - s_d
 */
export function seedEma(firstRaw: number): number {
  return firstRaw - CONSTANTS.SEED_DAMPING;
}

/**
 * Update the EMA with a new quality observation.
 * Eq. 10: EMA_t = α × raw_t + (1 - α) × EMA_{t-1}
 */
export function updateEma(
  currentEma: number,
  rawEstimate: number,
  alpha: number,
): number {
  return alpha * rawEstimate + (1 - alpha) * currentEma;
}

// ── Detraining decay ───────────────────────────────────────────────────

/**
 * Compute detraining decay based on days since last update.
 * Eq. 14: decay = min(r × sqrt(max(0, d_stale - g)), Δ_max)
 *
 * @param daysSinceLastUpdate - Days since the last EMA update
 * @returns Decay amount (always >= 0)
 */
export function computeDecay(daysSinceLastUpdate: number): number {
  const effective = Math.max(0, daysSinceLastUpdate - CONSTANTS.DECAY_GRACE_DAYS);
  return Math.min(CONSTANTS.DECAY_RATE * Math.sqrt(effective), CONSTANTS.DECAY_MAX);
}

/**
 * Apply detraining decay to the EMA.
 */
export function applyDecay(currentEma: number, daysSinceLastUpdate: number): number {
  return currentEma - computeDecay(daysSinceLastUpdate);
}

// ── Utility ────────────────────────────────────────────────────────────

/**
 * Calculate the number of days between two dates.
 */
export function daysBetween(a: Date, b: Date): number {
  const msPerDay = 24 * 60 * 60 * 1000;
  return Math.abs(b.getTime() - a.getTime()) / msPerDay;
}
