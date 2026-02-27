# Whitepaper Errata: Cycling Fallback Formulas (Section 4.2)

**Paper:** "Reverse-Engineering Garmin's VO2Max Estimation Algorithm"
**Affected sections:** Section 4.2 (Fallback Path: Power-Based Estimation), Table 5 (cycling fallback model)
**Affected equations:** Eq. 3 (mass factor), Eq. 6 (windowed model), Eq. 7 (summary model)
**Severity:** The formulas produce physically impossible results (~12-15x overscale)
**Status:** **RESOLVED** in whitepaper rev2. See [Section 9](#9-resolution-whitepaper-rev2) below.

---

## 1. Problem Summary

The cycling fallback formulas (Eqs. 6-7) produce raw MET values of 120-230 for
typical cycling activities. Physiologically valid cycling MET values are 5-18.
The resulting VO2Max estimates are ~400-800 ml/kg/min instead of the expected
~35-65 ml/kg/min.

The paper acknowledges this path was "never exercised in our dataset" (line 221),
but the formulas as published cannot produce valid results for any realistic input.

## 2. Reproduction

Using the summary-level formula (Eq. 7) with a typical gravel ride:

```
Input: avgPower = 146 W, avgHR = 119 bpm, weight = 75 kg, HRmax = 190, HRrest = 50

Step 1: Mass factor (Eq. 3)
  mf = -0.034 x 75 + 4.85 = 2.3

Step 2: %HRR (Eq. 2)
  %HRR = (119 - 50) / (190 - 50) = 0.493

Step 3: Inner term
  P x mf / %HRR = 146 x 2.3 / 0.493 = 681.3

Step 4: Raw MET (Eq. 7)
  raw_MET = 0.2982 x 681.3 + 0.819 = 204.0

Step 5: VO2Max
  VO2Max = 204.0 x 3.5 = 714.0 ml/kg/min
```

Expected VO2Max for this scenario: approximately 50-55 ml/kg/min (confirmed by
ACSM leg ergometry equation: VO2 = 28.4 ml/kg/min at workload, VO2Max ~54
estimated via %HRR-to-%VO2R relationship).

## 3. Systematic Analysis Across Scenarios

| Scenario | Watts | HR | Weight | Whitepaper VO2Max | ACSM-derived VO2Max | Overscale |
|---|---|---|---|---|---|---|
| Gravel ride (issue case) | 146W | 119 | 75 kg | 714 | ~54 | 13.2x |
| Recreational cyclist | 120W | 135 | 80 kg | 436 | ~36 | 12.1x |
| Strong cyclist | 250W | 160 | 72 kg | 793 | ~56 | 14.2x |
| Light easy ride | 100W | 110 | 70 kg | 552 | ~45 | 12.4x |
| Athlete A (paper, 68 kg) | 200W | 150 | 68 kg | 660 | ~48 | 13.7x |
| Athlete B (paper, 77 kg) | 180W | 145 | 77 kg | 587 | ~44 | 13.3x |

The overscale is consistently 12-15x across all tested scenarios.

## 4. Root Cause Analysis

### 4.1 The Mass Factor Amplifies Instead of Normalizing

The paper states (line 194): "A per-athlete mass factor normalizes for body
weight, since cycling power is absolute (watts) while VO2Max is per-kilogram."

However, the mass factor `mf = -0.034 x weight + 4.85` produces values of
**2.0-3.0** across the typical weight range (55-100 kg). This **amplifies**
power rather than normalizing it to body weight.

For a true normalization to W/kg, the factor would need to be approximately
`1/weight`, producing values of **0.01-0.02** -- roughly 150-200x smaller.

| Weight (kg) | mf (paper) | 1/weight | Ratio (mf to 1/W) |
|---|---|---|---|
| 55 | 2.980 | 0.0182 | 164x |
| 68 | 2.538 | 0.0147 | 173x |
| 75 | 2.300 | 0.0133 | 173x |
| 77 | 2.232 | 0.0130 | 172x |
| 90 | 1.790 | 0.0111 | 161x |

### 4.2 The Inner Term is Too Large by ~15x

The inner term `P x mf / %HRR` produces values of 400-750 for typical cycling
data. For the coefficients k=0.2982 and d=0.819 to produce valid MET (10-16),
the inner term would need to be approximately 30-50.

Back-solving: for raw_MET = 14 in the issue scenario:
```
14 = 0.2982 x (146 x mf / 0.493) + 0.819
Required mf = 0.149
Actual mf = 2.300
Ratio: 15.4x too large
```

### 4.3 The Windowed Formula Has the Same Problem

The windowed formula (Eq. 6) with k=0.6828, d=-18.394 has the identical
structural issue. For a 5-minute window of 200W at HR 150 (75 kg rider):
```
inner = 200 x 2.3 / 0.714 = 644.0
raw_MET = 0.6828 x 644.0 - 18.394 = 421.3
VO2Max = 421.3 x 3.5 = 1474.7
```

## 5. Hypotheses Tested and Rejected

| Hypothesis | Result |
|---|---|
| Output is VO2 (ml/kg/min) not MET, so x3.5 shouldn't apply | Still ~200 ml/kg/min -- too high by 4x |
| Formula should use P/mf instead of P x mf | Produces 137 VO2Max -- still 2.5x too high |
| P should be in W/kg (P/weight) with original mf | Produces 12.3 VO2Max -- too low |
| P should be in W/kg without mf | Produces 7.0 VO2Max -- too low |
| mf coefficients are 10x too large (-0.0034, 0.485) | Produces 74 VO2Max -- closer but still 40% high |
| mf should be mf/weight (compound normalization) | Produces 12.3 VO2Max -- too low |

None of the simple transformations of the published formula produce valid results.
The coefficients k, d and the mass factor mf appear to be internally inconsistent.

## 6. Possible Explanations

1. **The coefficients were fitted to different input units.** The linear
   regression that produced k=0.2982 and k=0.6828 may have been fitted to data
   where power was already normalized (e.g., W/kg, kJ, or some internal
   Firstbeat unit) rather than raw watts. If so, the mass factor's role in the
   formula chain may be different than described.

2. **The mass factor belongs elsewhere in the computation.** In the actual
   Garmin/Firstbeat code, the mass factor may be applied at a different stage
   (e.g., to the output MET rather than the input power), or it may be part of
   a multi-step computation that was collapsed into a single formula during
   reverse engineering.

3. **The formula structure was misidentified.** The relationship between power,
   heart rate, weight, and MET may not be the simple linear form
   `k x (P x mf / %HRR) + d`. The actual computation may involve additional
   terms, divisions, or a different functional form entirely.

4. **The mass factor formula is correct but serves a different purpose.** The
   linear model `mf = -0.034W + 4.85` was presumably fitted to observed data
   points from two athletes (68 kg and 77 kg). With only two data points, any
   linear fit is exact but may not reflect the actual role of weight in the
   formula.

## 7. Recommendations for the Author

1. **Verify the formula derivation.** Re-examine the reverse-engineering process
   for Eqs. 3, 6, and 7. Specifically check whether the original data analysis
   used raw watts or a normalized power value.

2. **Check intermediate values.** If access to the original analysis data/code
   is available, print the intermediate values (mass factor, inner term, raw MET)
   and compare them to the formulas as published.

3. **Test against ground truth.** If any cycling activities without `maxMet` are
   available (or can be simulated by using activities that DO have `maxMet` and
   comparing), validate that the fallback produces values close to the
   `maxMet x 3.5` ground truth.

4. **Consider the ACSM reference.** The standard ACSM leg ergometry equation
   provides a well-validated baseline for cycling VO2 estimation:
   ```
   VO2 = 1.8 x (watts x 6.12 / weight_kg) + 3.5 + 3.5  [ml/kg/min]
   ```
   Combined with the %HRR ~ %VO2R relationship (Swain & Leutholtz, 1997):
   ```
   VO2Max = (VO2_workload - 3.5) / %HRR + 3.5
   ```
   This produces physiologically realistic estimates for all tested scenarios.

5. **Add a worked example.** Including a complete numerical example in the paper
   would make the issue immediately visible and help future implementers verify
   their code.

6. **Consider adding a note.** If the formula cannot be corrected, consider
   adding a stronger caveat than the current "never exercised in our dataset"
   note, explicitly warning that the fallback coefficients are unvalidated and
   may produce incorrect results.

## 8. ACSM Reference Values for Validation

For the scenarios above, the ACSM leg ergometry equation produces:

| Watts | Weight | Steady-state VO2 | MET | VO2Max (via %HRR) |
|---|---|---|---|---|
| 100W | 70 kg | 22.7 ml/kg/min | 6.5 | ~45 |
| 120W | 75 kg | 24.6 ml/kg/min | 7.0 | ~36 |
| 146W | 75 kg | 28.4 ml/kg/min | 8.1 | ~54 |
| 150W | 68 kg | 31.3 ml/kg/min | 8.9 | ~48* |
| 180W | 77 kg | 32.8 ml/kg/min | 9.4 | ~44 |
| 200W | 72 kg | 37.6 ml/kg/min | 10.7 | ~56* |
| 250W | 72 kg | 45.3 ml/kg/min | 12.9 | ~56 |
| 300W | 80 kg | 48.3 ml/kg/min | 13.8 | ~60* |

*VO2Max varies with %HRR for each scenario; values shown assume typical %HRR for the HR/profile.

---

*Analysis performed during implementation of the vo2maxe library
(https://github.com/JohanBellander/vo2maxe). See GitHub issue #1 for the
original bug report.*

## 9. Resolution (Whitepaper Rev2 and Rev3)

The whitepaper author released revised versions that address this issue.

### Rev2

Rev2 replaced the broken formula with per-athlete calibrated constants
(`mf = 0.210` for Athlete A, `mf = 0.198` for Athlete B), stating the mass
factor "cannot be derived from a simple formula."

### Rev3 (current)

Rev3 provides an explicit linear model fitted to the two athletes:

```
mf = -0.00131 × weight_kg + 0.299
```

This produces `mf = 0.210` for 68 kg and `mf = 0.198` for 77 kg — the same
calibrated values, now expressed as a formula. The paper includes a caveat
that this is a two-point fit and accuracy outside the 68-77 kg calibration
range is uncertain.

A worked example is included confirming the corrected math:
- Input: Athlete A (68kg, HRrest=42, HRmax=176), P_avg=180W, HR_avg=140bpm
- mf = -0.00131 × 68 + 0.299 = 0.210
- %HRR = (140-42)/(176-42) = 0.731
- inner = 180 × 0.210 / 0.731 = 51.71
- raw_MET = 0.2982 × 51.71 + 0.819 = 16.24
- VO2Max = round(16.24 × 3.5) = round(56.8) = **57**

The linear coefficients k and d are **unchanged** across all revisions.

### Impact on the library

The vo2maxe library implements the rev3 formula:
- `getMassFactor()` applies `mf = -0.00131 × weight + 0.299` by default.
- `AthleteProfile` accepts an optional `massFactor` field to override the formula.
- A MET clamp (1-30) is applied as a safety net.
- The issue #1 scenario (146W, 119bpm, 75kg) now produces VO2Max ≈ 65 instead of ~714.
