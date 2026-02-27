/**
 * Main VO2Max estimator orchestrator.
 *
 * Implements the complete algorithm (whitepaper Section 6, Algorithm 1).
 * Processes a chronologically sorted list of activities and produces
 * a VO2Max estimate for each one.
 */

import { CONSTANTS } from "./constants.js";
import { estimateCyclingVo2Max } from "./cycling.js";
import {
  applyDecay,
  applyGapBoost,
  computeRunningEstimate,
  daysBetween,
  getAlpha,
  isQualityActivity,
  seedEma,
  updateEma,
} from "./running.js";
import type {
  Activity,
  AthleteProfile,
  CyclingActivity,
  EstimatorState,
  RunningActivity,
  VO2MaxResult,
} from "./types.js";
import { createInitialState } from "./types.js";

/**
 * Process a single cycling activity and update state.
 */
function processCycling(
  activity: CyclingActivity,
  profile: AthleteProfile,
  state: EstimatorState,
): VO2MaxResult {
  const fallbackState = {
    ewma: state.cyclingFallbackEwma,
    count: state.cyclingFallbackCount,
  };

  const result = estimateCyclingVo2Max(activity, profile, fallbackState);

  // Update cycling state for cross-sport transfer
  if (result) {
    state.lastCyclingVo2Max = result.vo2MaxContinuous;
    state.lastCyclingDate = activity.date;
  }

  // Persist fallback EWMA state
  state.cyclingFallbackEwma = fallbackState.ewma;
  state.cyclingFallbackCount = fallbackState.count;

  return {
    activity,
    vo2Max: result?.vo2Max ?? null,
    vo2MaxContinuous: result?.vo2MaxContinuous ?? null,
    sport: "cycling",
    isQuality: false,
    updatedEma: false,
    crossSportApplied: false,
  };
}

/**
 * Process a single running activity and update state.
 *
 * Implements the running branch of Algorithm 1:
 * 1. Compute raw estimate with corrections
 * 2. Check cross-sport transfer
 * 3. Apply detraining decay
 * 4. Update EMA if quality
 * 5. Report round(EMA)
 */
function processRunning(
  activity: RunningActivity,
  profile: AthleteProfile,
  state: EstimatorState,
): VO2MaxResult {
  // Step 1: Compute per-activity raw estimate
  const rawEstimate = computeRunningEstimate(activity, profile);
  const quality = isQualityActivity(activity, profile);

  let crossSportApplied = false;
  let updatedEma = false;

  // Step 2: Cross-sport transfer (Section 5.8)
  // Trigger: > 50 days since last quality running, cycling data exists, not yet applied
  if (
    state.runningEma != null &&
    state.lastQualityRunDate != null &&
    state.lastCyclingVo2Max != null &&
    !state.crossSportApplied &&
    daysBetween(activity.date, state.lastQualityRunDate) > CONSTANTS.CROSS_SPORT_GAP_DAYS
  ) {
    state.runningEma = state.lastCyclingVo2Max;
    state.crossSportApplied = true;
    state.lastEmaUpdateDate = activity.date;
    crossSportApplied = true;
  }

  // Step 3: Detraining decay (Section 5.8)
  if (state.runningEma != null && state.lastEmaUpdateDate != null) {
    const daysSinceUpdate = daysBetween(activity.date, state.lastEmaUpdateDate);
    if (daysSinceUpdate > CONSTANTS.DECAY_GRACE_DAYS) {
      state.runningEma = applyDecay(state.runningEma, daysSinceUpdate);
    }
  }

  // Step 4: EMA update (quality activities only)
  if (quality && rawEstimate != null) {
    if (state.runningEma == null) {
      // First quality activity: seed with damping (Eq. 13)
      state.runningEma = seedEma(rawEstimate);
      state.qualityRunCount = 1;
      updatedEma = true;
    } else {
      // Subsequent quality activities: EMA update
      let alpha = getAlpha(state.qualityRunCount);

      // Gap-aware alpha boosting (Section 5.6)
      const daysSinceLastQuality =
        state.lastQualityRunDate != null
          ? daysBetween(activity.date, state.lastQualityRunDate)
          : null;
      alpha = applyGapBoost(alpha, daysSinceLastQuality);

      state.runningEma = updateEma(state.runningEma, rawEstimate, alpha);
      state.qualityRunCount++;
      updatedEma = true;
    }

    state.lastQualityRunDate = activity.date;
    state.lastEmaUpdateDate = activity.date;
    // Reset cross-sport flag after a quality run
    state.crossSportApplied = false;
  }

  // Step 5: Report
  const vo2MaxContinuous = state.runningEma;
  const vo2Max = vo2MaxContinuous != null ? Math.round(vo2MaxContinuous) : null;

  return {
    activity,
    vo2Max,
    vo2MaxContinuous,
    sport: "running",
    isQuality: quality,
    updatedEma,
    crossSportApplied,
  };
}

// ── Public API ──────────────────────────────────────────────────────────

/**
 * VO2Max estimator that processes activities sequentially.
 *
 * Maintains internal state across activities. Create one instance per athlete.
 *
 * @example
 * ```typescript
 * import { VO2MaxEstimator } from "vo2maxe";
 *
 * const estimator = new VO2MaxEstimator({
 *   maxHr: 176,
 *   restingHr: 42,
 *   weightKg: 68,
 * });
 *
 * const results = estimator.processActivities(activities);
 * ```
 */
export class VO2MaxEstimator {
  private profile: AthleteProfile;
  private state: EstimatorState;

  constructor(profile: AthleteProfile, state?: EstimatorState) {
    this.profile = profile;
    this.state = state ?? createInitialState();
  }

  /**
   * Process a single activity and return the VO2Max result.
   * Updates internal state. Activities must be processed in chronological order.
   */
  processActivity(activity: Activity): VO2MaxResult {
    if (activity.sport === "cycling") {
      return processCycling(activity as CyclingActivity, this.profile, this.state);
    }
    return processRunning(activity as RunningActivity, this.profile, this.state);
  }

  /**
   * Process multiple activities in chronological order.
   * Returns a result for each activity.
   *
   * @param activities - Activities sorted by date (earliest first)
   */
  processActivities(activities: Activity[]): VO2MaxResult[] {
    return activities.map((a) => this.processActivity(a));
  }

  /**
   * Get a snapshot of the current internal state.
   * Useful for serialization and later resumption.
   */
  getState(): EstimatorState {
    return { ...this.state };
  }

  /**
   * Get the current athlete profile.
   */
  getProfile(): AthleteProfile {
    return { ...this.profile };
  }

  /**
   * Get the current running EMA value (continuous, unrounded).
   * Returns null if no quality running activity has been processed yet.
   */
  getCurrentRunningVo2Max(): number | null {
    return this.state.runningEma;
  }

  /**
   * Get the most recent cycling VO2Max (continuous, unrounded).
   * Returns null if no cycling activity has been processed yet.
   */
  getCurrentCyclingVo2Max(): number | null {
    return this.state.lastCyclingVo2Max;
  }

  /**
   * Reset the estimator to its initial state.
   */
  reset(): void {
    this.state = createInitialState();
  }
}
