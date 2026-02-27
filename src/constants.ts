/**
 * Algorithm parameters from the whitepaper (Table 5).
 *
 * All values are from "Reverse-Engineering Garmin's VO2Max Estimation Algorithm"
 * Section 6.1, Table 5.
 */
export const CONSTANTS = {
  /** Standard physiological conversion: 1 MET = 3.5 ml O2/kg/min */
  MET_TO_VO2: 3.5,

  // ── Running: ACSM model ──────────────────────────────────────────────
  /** %HRmax-to-%VO2max slope (Eq. 5) */
  HR_MAX_SLOPE: 1.08,
  /** %HRmax-to-%VO2max intercept (Eq. 5) */
  HR_MAX_INTERCEPT: -0.15,
  /** ACSM cost scaling factor (Eq. 4) */
  ACSM_COST_SCALE: 0.95,
  /** Duration correction slope (Eq. 8) */
  DURATION_CORRECTION_SLOPE: 0.04,
  /** Duration correction center in minutes (Eq. 8) */
  DURATION_CORRECTION_CENTER: 45.0,
  /** Bias correction constant (Eq. 9) */
  BIAS_CORRECTION: -0.03,

  // ── Running: EMA smoothing ───────────────────────────────────────────
  /** Phase 1 EMA alpha (Eq. 11) */
  ALPHA_PHASE1: 0.07,
  /** Phase 2 EMA alpha (Eq. 11) */
  ALPHA_PHASE2: 0.02,
  /** Quality update count at which alpha transitions (Eq. 11) */
  PHASE_SWITCH_N: 18,
  /** Gap threshold in days for alpha boosting (Section 5.6) */
  GAP_BOOST_THRESHOLD_DAYS: 28,
  /** Alpha multiplier after a gap (Eq. 12) */
  GAP_BOOST_MULTIPLIER: 8,

  // ── Running: quality filtering ───────────────────────────────────────
  /** Minimum duration in seconds for a quality activity (Section 5.4) */
  QUALITY_MIN_DURATION_S: 2340,
  /** Minimum %HRmax for a quality activity (Section 5.4) */
  QUALITY_MIN_PCT_HR_MAX: 0.72,

  // ── Running: sanity filters (Section 5.1.4) ──────────────────────────
  /** Minimum average HR for a valid raw estimate */
  SANITY_MIN_AVG_HR: 100,
  /** Minimum speed in m/s for a valid raw estimate */
  SANITY_MIN_SPEED_MS: 1.0,
  /** Minimum duration in minutes for a valid raw estimate */
  SANITY_MIN_DURATION_MIN: 10,
  /** Valid range for %HRmax */
  SANITY_PCT_HR_MAX_MIN: 0.5,
  SANITY_PCT_HR_MAX_MAX: 1.0,
  /** Valid range for %VO2max */
  SANITY_PCT_VO2_MAX_MIN: 0.1,
  SANITY_PCT_VO2_MAX_MAX: 1.0,

  // ── Running: temporal dynamics ───────────────────────────────────────
  /** EMA seed damping value (Eq. 13) */
  SEED_DAMPING: 4.3,
  /** Detraining decay rate (Eq. 14) */
  DECAY_RATE: 0.01,
  /** Detraining decay grace period in days (Eq. 14) */
  DECAY_GRACE_DAYS: 3,
  /** Maximum detraining decay (Eq. 14) */
  DECAY_MAX: 5.0,
  /** Cross-sport transfer gap threshold in days (Section 5.8) */
  CROSS_SPORT_GAP_DAYS: 50,

  // ── Cycling: fallback model (Section 4.2) ────────────────────────────
  /** Windowed model coefficient k (Eq. 6) */
  CYCLING_WINDOWED_K: 0.6828,
  /** Windowed model intercept d (Eq. 6) */
  CYCLING_WINDOWED_D: -18.394,
  /** Summary model coefficient k (Eq. 7) */
  CYCLING_SUMMARY_K: 0.2982,
  /** Summary model intercept d (Eq. 7) */
  CYCLING_SUMMARY_D: 0.819,
  /**
   * Default mass factor interpolation coefficients.
   *
   * The mass factor is per-athlete calibrated (whitepaper rev2, Eq. 3).
   * When not provided, we estimate from the two calibrated data points:
   *   Athlete A (68 kg) → mf = 0.210
   *   Athlete B (77 kg) → mf = 0.198
   *
   * Linear interpolation: mf ≈ slope × weight + intercept
   *   slope = (0.198 - 0.210) / (77 - 68) = -0.001333...
   *   intercept = 0.210 - (-0.001333... × 68) = 0.3007
   *
   * This default is approximate; for best results, calibrate mf per athlete.
   */
  DEFAULT_MF_WEIGHT_SLOPE: -0.012 / 9, // ≈ -0.001333
  DEFAULT_MF_INTERCEPT: 0.210 + (0.012 / 9) * 68, // ≈ 0.3007
  /** Minimum physiologically valid raw MET for cycling (safety clamp). */
  CYCLING_MET_CLAMP_MIN: 1.0,
  /** Maximum physiologically valid raw MET for cycling (safety clamp). */
  CYCLING_MET_CLAMP_MAX: 30.0,
  /** Dynamic alpha start for cycling fallback EWMA (Eq. 8) */
  CYCLING_ALPHA_START: 0.5,
  /** Dynamic alpha end for cycling fallback EWMA */
  CYCLING_ALPHA_END: 0.1,
  /** Dynamic alpha decay rate for cycling fallback EWMA */
  CYCLING_ALPHA_DECAY: 0.15,
} as const;

export type Constants = typeof CONSTANTS;
