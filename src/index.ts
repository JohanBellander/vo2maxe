/**
 * vo2maxe - Reverse-engineered Garmin VO2Max estimation algorithm
 *
 * Implements both cycling and running VO2Max estimation pipelines
 * as described in the whitepaper.
 *
 * @packageDocumentation
 */

// Main estimator class
export { VO2MaxEstimator } from "./estimator.js";

// Types
export type {
  Activity,
  AthleteProfile,
  CyclingActivity,
  EstimatorState,
  RunningActivity,
  SportType,
  VO2MaxResult,
} from "./types.js";
export { createInitialState } from "./types.js";

// Constants (exposed for advanced usage / customization)
export { CONSTANTS } from "./constants.js";

// Cycling estimation functions (exposed for advanced usage)
export {
  clampMet,
  cyclingDynamicAlpha,
  estimateCyclingVo2Max,
  getMassFactor,
  percentHrr,
  rawMetSummary,
  rawMetWindowed,
} from "./cycling.js";

// Running estimation functions (exposed for advanced usage)
export {
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
} from "./running.js";
