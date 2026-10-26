# Frozen ImpulseBuy volume analysis

**Frozen as of:** 2026-10-01T06:02:27.412957+00:00  
**Scope:** offline analysis of the frozen `cohort.json` and `metadata.json` only; no database/network/live changes.

## Executive readout

- Identity check: **188 rows / 188 unique IDs**, including every exported status; this is not evidence of 188 fills.
- Exact closed-trigger volume: **61/188** recorded; generic `entry_fut_vol_mult`: **172/188**. Their paired count is **61**; only **1** paired values agree within 0.01x. They are not interchangeable.
- Absolute closed-trigger and baseline USD volumes are both unavailable (**0** rows each); absolute futures 24h volume is not in this export.
- Outcome priority is frozen 15-minute forward maximum-high / +5% / +10% path hits on strict mature, gap-free windows—not PnL and not fills.
- The exact trigger is selected by a 1.5x fire gate: below-1.5 behavior is unidentifiable from fired rows. No causal claim or gate recommendation follows.
- Across all strict paths, median peak rose from **2.12% at 1h** to **4.80% at 6h**, **6.65% at 24h**, and **10.22% at 72h** (the longer maximum-high window naturally has more time to rise).
- Generic-volume ranked association is positive at 1/3/6h (Spearman **0.31/0.38/0.33**, symbol-cluster 95% intervals exclude zero); the exact closed trigger is essentially uncorrelated with peak over those windows (**0.01/-0.01/-0.01**, intervals cross zero). This is not a same-metric comparison and the generic series is secondary/semantically mixed.
- A predeclared exact-trigger >=3x split did not improve the observed +10% hit rate: **14.3% vs 19.6% by 6h (n=14 vs 46)** and **28.6% vs 61.5% by 72h (n=14 vs 39)**. Small bins and fired-cohort selection prevent threshold claims.
- At 6h, trigger >=3x also failed to improve +10 rates inside either available futures-taker sign stratum: **20.0% vs 21.7% for taker >0 (n=5 vs 23)** and **11.1% vs 18.2% for taker <0 (n=9 vs 22)**. The >=3x plus taker>=0 combination is only **n=5**; the >=20% net-buy combination has **n=0** in the strict matched data.

## Export integrity and coverage

- Export window: 2026-06-18T14:48:16.594+00:00 to 2026-10-01T03:06:29.114+00:00. Legacy rows: 30; reclassified status rows: 2. All statuses: `{"active": 4, "bu_stop": 63, "cancelled": 55, "expired": 4, "profit": 28, "reclassified": 2, "stop_loss": 32}`.
- Every horizon below uses an independent strict denominator. No assumption is made that all 188 paths are mature or gap-free.

| Horizon | Mature at capture | Strict mature + gap-free | Exact trigger metric | Generic futures metric | Futures taker |
|---:|---:|---:|---:|---:|---:|
| 1h | 188/188 | 185/188 | 60 | 171 | 147 |
| 3h | 187/188 | 185/188 | 60 | 171 | 147 |
| 6h | 187/188 | 185/188 | 60 | 171 | 147 |
| 12h | 187/188 | 185/188 | 60 | 171 | 147 |
| 24h | 182/188 | 180/188 | 55 | 166 | 142 |
| 72h | 180/188 | 178/188 | 53 | 164 | 140 |

## Horizon outcomes (primary exact trigger, generic metric secondary)

Each metric column has its own strict-window-and-metric-present denominator. +5/+10 denote forward high reached.

| Horizon | Strict cohort peak median / +5 / +10 | Closed trigger peak median / +5 / +10 | Generic futures peak median / +5 / +10 |
|---:|---|---|---|
| 1h | 2.12% / 46/185 (24.9%) / 18/185 (9.7%) | 1.28% / 12/60 (20.0%) / 7/60 (11.7%) | 2.24% / 44/171 (25.7%) / 17/171 (9.9%) |
| 3h | 3.51% / 72/185 (38.9%) / 33/185 (17.8%) | 2.62% / 17/60 (28.3%) / 9/60 (15.0%) | 3.64% / 67/171 (39.2%) / 30/171 (17.5%) |
| 6h | 4.80% / 90/185 (48.6%) / 44/185 (23.8%) | 3.27% / 21/60 (35.0%) / 11/60 (18.3%) | 4.80% / 83/171 (48.5%) / 40/171 (23.4%) |
| 24h | 6.65% / 112/180 (62.2%) / 68/180 (37.8%) | 6.35% / 33/55 (60.0%) / 22/55 (40.0%) | 6.25% / 101/166 (60.8%) / 61/166 (36.7%) |
| 72h | 10.22% / 127/178 (71.3%) / 91/178 (51.1%) | 10.79% / 39/53 (73.6%) / 28/53 (52.8%) | 10.01% / 115/164 (70.1%) / 82/164 (50.0%) |

### Spearman rank correlations with forward peak

Cell is Spearman rho [symbol-cluster bootstrap 95% CI] (n). Binary +5/+10 correlations and CIs are included in JSON.

| Horizon | Closed trigger | Generic futures secondary | Generic excluding exact 1 |
|---:|---:|---:|---:|
| 1h | 0.01 [-0.24, 0.28] (n=60) | 0.31 [0.16, 0.44] (n=171) | 0.31 [0.15, 0.45] (n=162) |
| 3h | -0.01 [-0.26, 0.24] (n=60) | 0.38 [0.24, 0.51] (n=171) | 0.38 [0.22, 0.51] (n=162) |
| 6h | -0.01 [-0.26, 0.24] (n=60) | 0.33 [0.20, 0.45] (n=171) | 0.33 [0.18, 0.46] (n=162) |
| 24h | 0.03 [-0.25, 0.31] (n=55) | 0.28 [0.15, 0.41] (n=166) | 0.27 [0.13, 0.40] (n=157) |
| 72h | -0.15 [-0.41, 0.12] (n=53) | 0.20 [0.05, 0.32] (n=164) | 0.20 [0.04, 0.33] (n=155) |

## Predeclared volume bands

Cells are n / median forward peak / +5 count / +10 count. Bands are fixed in advance; fired-cohort trigger bands start at 1.5x by construction.

### Exact closed-trigger volume bands

| Horizon | Band | n | Median peak % | +5 hits | +10 hits |
|---:|---|---:|---:|---:|---:|
| 1h | [1.5,2)x | 31 | 1.39 | 7 | 3 |
| 1h | [2,3)x | 15 | 1.02 | 3 | 2 |
| 1h | [3,5)x | 7 | 2.76 | 1 | 1 |
| 1h | [5,+inf)x | 7 | 0.61 | 1 | 1 |
| 3h | [1.5,2)x | 31 | 2.61 | 10 | 5 |
| 3h | [2,3)x | 15 | 2.80 | 4 | 2 |
| 3h | [3,5)x | 7 | 3.90 | 1 | 1 |
| 3h | [5,+inf)x | 7 | 1.23 | 2 | 1 |
| 6h | [1.5,2)x | 31 | 3.33 | 13 | 5 |
| 6h | [2,3)x | 15 | 3.21 | 5 | 4 |
| 6h | [3,5)x | 7 | 4.34 | 1 | 1 |
| 6h | [5,+inf)x | 7 | 1.23 | 2 | 1 |
| 24h | [1.5,2)x | 28 | 7.13 | 19 | 12 |
| 24h | [2,3)x | 13 | 11.46 | 8 | 7 |
| 24h | [3,5)x | 7 | 4.93 | 2 | 1 |
| 24h | [5,+inf)x | 7 | 5.35 | 4 | 2 |
| 72h | [1.5,2)x | 27 | 14.46 | 23 | 17 |
| 72h | [2,3)x | 12 | 15.88 | 9 | 7 |
| 72h | [3,5)x | 7 | 4.93 | 2 | 2 |
| 72h | [5,+inf)x | 7 | 6.65 | 5 | 2 |

### Generic futures-volume bands (secondary)

| Horizon | Band | n | Median peak % | +5 hits | +10 hits |
|---:|---|---:|---:|---:|---:|
| 1h | <1x | 124 | 1.85 | 23 | 8 |
| 1h | [1,2)x | 35 | 4.48 | 15 | 8 |
| 1h | [2,3)x | 8 | 3.84 | 4 | 1 |
| 1h | [3,5)x | 3 | 5.14 | 2 | 0 |
| 1h | [5,+inf)x | 1 | 0.07 | 0 | 0 |
| 3h | <1x | 124 | 2.72 | 38 | 16 |
| 3h | [1,2)x | 35 | 5.91 | 20 | 12 |
| 3h | [2,3)x | 8 | 6.57 | 6 | 2 |
| 3h | [3,5)x | 3 | 6.15 | 2 | 0 |
| 3h | [5,+inf)x | 1 | 6.04 | 1 | 0 |
| 6h | <1x | 124 | 3.28 | 49 | 21 |
| 6h | [1,2)x | 35 | 8.25 | 25 | 16 |
| 6h | [2,3)x | 8 | 7.45 | 6 | 3 |
| 6h | [3,5)x | 3 | 6.15 | 2 | 0 |
| 6h | [5,+inf)x | 1 | 6.04 | 1 | 0 |
| 24h | <1x | 119 | 5.42 | 64 | 37 |
| 24h | [1,2)x | 35 | 12.34 | 28 | 19 |
| 24h | [2,3)x | 8 | 7.45 | 6 | 3 |
| 24h | [3,5)x | 3 | 9.21 | 2 | 1 |
| 24h | [5,+inf)x | 1 | 28.40 | 1 | 1 |
| 72h | <1x | 117 | 9.11 | 77 | 55 |
| 72h | [1,2)x | 35 | 13.77 | 28 | 22 |
| 72h | [2,3)x | 8 | 7.45 | 7 | 3 |
| 72h | [3,5)x | 3 | 9.21 | 2 | 1 |
| 72h | [5,+inf)x | 1 | 28.85 | 1 | 1 |

Generic multiplier has **10 exact-1.0x rows**; treat this point cautiously as a possible default/placeholder. JSON gives full band and threshold results both with and without exact 1.0x.

## Predeclared threshold splits

These are unadjusted observational comparisons of +10% path-hit rates. Raw high/below denominators and complete hit/peak summaries for every horizon are in JSON.

| Metric | Horizon | Cut | >= cut +10 | Below cut +10 | Difference (pp) |
|---|---:|---:|---:|---:|---:|
| Closed trigger | 1h | 2.0x | 4/29 (13.8%) | 3/31 (9.7%) | 4.1 |
| Closed trigger | 1h | 3.0x | 2/14 (14.3%) | 5/46 (10.9%) | 3.4 |
| Closed trigger | 1h | 5.0x | 1/7 (14.3%) | 6/53 (11.3%) | 3.0 |
| Closed trigger | 3h | 2.0x | 4/29 (13.8%) | 5/31 (16.1%) | -2.3 |
| Closed trigger | 3h | 3.0x | 2/14 (14.3%) | 7/46 (15.2%) | -0.9 |
| Closed trigger | 3h | 5.0x | 1/7 (14.3%) | 8/53 (15.1%) | -0.8 |
| Closed trigger | 6h | 2.0x | 6/29 (20.7%) | 5/31 (16.1%) | 4.6 |
| Closed trigger | 6h | 3.0x | 2/14 (14.3%) | 9/46 (19.6%) | -5.3 |
| Closed trigger | 6h | 5.0x | 1/7 (14.3%) | 10/53 (18.9%) | -4.6 |
| Closed trigger | 24h | 2.0x | 10/27 (37.0%) | 12/28 (42.9%) | -5.8 |
| Closed trigger | 24h | 3.0x | 3/14 (21.4%) | 19/41 (46.3%) | -24.9 |
| Closed trigger | 24h | 5.0x | 2/7 (28.6%) | 20/48 (41.7%) | -13.1 |
| Closed trigger | 72h | 2.0x | 11/26 (42.3%) | 17/27 (63.0%) | -20.7 |
| Closed trigger | 72h | 3.0x | 4/14 (28.6%) | 24/39 (61.5%) | -33.0 |
| Closed trigger | 72h | 5.0x | 2/7 (28.6%) | 26/46 (56.5%) | -28.0 |
| Generic futures | 1h | 2.0x | 1/12 (8.3%) | 16/159 (10.1%) | -1.7 |
| Generic futures | 1h | 3.0x | 0/4 (0.0%) | 17/167 (10.2%) | -10.2 |
| Generic futures | 1h | 5.0x | 0/1 (0.0%) | 17/170 (10.0%) | -10.0 |
| Generic futures | 3h | 2.0x | 2/12 (16.7%) | 28/159 (17.6%) | -0.9 |
| Generic futures | 3h | 3.0x | 0/4 (0.0%) | 30/167 (18.0%) | -18.0 |
| Generic futures | 3h | 5.0x | 0/1 (0.0%) | 30/170 (17.6%) | -17.6 |
| Generic futures | 6h | 2.0x | 3/12 (25.0%) | 37/159 (23.3%) | 1.7 |
| Generic futures | 6h | 3.0x | 0/4 (0.0%) | 40/167 (24.0%) | -24.0 |
| Generic futures | 6h | 5.0x | 0/1 (0.0%) | 40/170 (23.5%) | -23.5 |
| Generic futures | 24h | 2.0x | 5/12 (41.7%) | 56/154 (36.4%) | 5.3 |
| Generic futures | 24h | 3.0x | 2/4 (50.0%) | 59/162 (36.4%) | 13.6 |
| Generic futures | 24h | 5.0x | 1/1 (100.0%) | 60/165 (36.4%) | 63.6 |
| Generic futures | 72h | 2.0x | 5/12 (41.7%) | 77/152 (50.7%) | -9.0 |
| Generic futures | 72h | 3.0x | 2/4 (50.0%) | 80/160 (50.0%) | 0.0 |
| Generic futures | 72h | 5.0x | 1/1 (100.0%) | 81/163 (49.7%) | 50.3 |

## Closed-trigger volume within futures-taker strata

Both exact metrics must be present, and each horizon must pass strict path coverage. Futures taker values are net-buy percentages, not buy shares.

| Horizon | Taker stratum | Closed >=3: +10 / n | Closed <3: +10 / n | Rate difference (pp) |
|---:|---|---:|---:|---:|
| 1h | positive_gt0 | 1/5 (20.0%) | 3/23 (13.0%) | 7.0 |
| 1h | negative_lt0 | 1/9 (11.1%) | 2/22 (9.1%) | 2.0 |
| 1h | zero | 0/0 (—) | 0/0 (—) | — |
| 3h | positive_gt0 | 1/5 (20.0%) | 4/23 (17.4%) | 2.6 |
| 3h | negative_lt0 | 1/9 (11.1%) | 3/22 (13.6%) | -2.5 |
| 3h | zero | 0/0 (—) | 0/0 (—) | — |
| 6h | positive_gt0 | 1/5 (20.0%) | 5/23 (21.7%) | -1.7 |
| 6h | negative_lt0 | 1/9 (11.1%) | 4/22 (18.2%) | -7.1 |
| 6h | zero | 0/0 (—) | 0/0 (—) | — |
| 24h | positive_gt0 | 2/5 (40.0%) | 11/21 (52.4%) | -12.4 |
| 24h | negative_lt0 | 1/9 (11.1%) | 8/19 (42.1%) | -31.0 |
| 24h | zero | 0/0 (—) | 0/0 (—) | — |
| 72h | positive_gt0 | 2/5 (40.0%) | 15/19 (78.9%) | -38.9 |
| 72h | negative_lt0 | 2/9 (22.2%) | 9/19 (47.4%) | -25.1 |
| 72h | zero | 0/0 (—) | 0/0 (—) | — |

### Combined closed-volume and taker splits

| Horizon | Condition | Condition group n; +10 rate | Matched complement n; +10 rate |
|---:|---|---:|---:|
| 1h | closed_ge3_and_taker_ge0 | 5; 1/5 (20.0%) | 54; 6/54 (11.1%) |
| 1h | closed_ge3_and_taker_ge20 | 0; 0/0 (—) | 59; 7/59 (11.9%) |
| 3h | closed_ge3_and_taker_ge0 | 5; 1/5 (20.0%) | 54; 8/54 (14.8%) |
| 3h | closed_ge3_and_taker_ge20 | 0; 0/0 (—) | 59; 9/59 (15.3%) |
| 6h | closed_ge3_and_taker_ge0 | 5; 1/5 (20.0%) | 54; 10/54 (18.5%) |
| 6h | closed_ge3_and_taker_ge20 | 0; 0/0 (—) | 59; 11/59 (18.6%) |
| 24h | closed_ge3_and_taker_ge0 | 5; 2/5 (40.0%) | 49; 20/49 (40.8%) |
| 24h | closed_ge3_and_taker_ge20 | 0; 0/0 (—) | 54; 22/54 (40.7%) |
| 72h | closed_ge3_and_taker_ge0 | 5; 2/5 (40.0%) | 47; 26/47 (55.3%) |
| 72h | closed_ge3_and_taker_ge20 | 0; 0/0 (—) | 52; 28/52 (53.8%) |

## Missing-metric fail-open cost at closed-trigger >=3x

Winner means a strict forward +10% high by the stated horizon. Fail-open retains rows when the exact volume metric is missing; the second case below is strict fail-closed. “Upside” is a path-peak percentage-point proxy, not realized return or dollars.

| Horizon | Strict denominator | +10 winners | Missing-metric winners | Fail-open retained winners | Fail-open lost winners | Strict fail-closed lost winners | Fail-open lost-winner peak-upside sum (pp) |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 6h | 185 | 44 | 33 | 35 | 9 | 42 | 394.46 |
| 24h | 180 | 68 | 46 | 49 | 19 | 65 | 674.12 |
| 72h | 178 | 91 | 63 | 67 | 24 | 87 | 1026.16 |

Secondary cost audit: metric-known below-cutoff non-winners numbered **37 / 22 / 15** at 6/24/72h; among rows with tracker PnL, negative-PnL counts were **21 / 16 / 11** and summed to **-108.1 / -85.3 / -69.8 percentage points**. These are status/PnL snapshot diagnostics—not verified fills, realized gate savings, or primary outcomes.

## Early vs late era (late begins 2026-09-20 00:00 UTC)

Entry policy is descriptive only—not a gate-version stratifier. The cohort has no entry-gate-version field.

| Era | Rows | Exact trigger metric | Generic volume metric | All three metrics | 6h strict n | 6h exact +10 | 24h strict n | 24h exact +10 | 72h strict n | 72h exact +10 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Before Sep 20 | 153 | 27 | 137 | 27 | 151 | 6/27 | 151 | 12/27 | 151 | 16/27 |
| Sep 20 onward | 35 | 34 | 35 | 33 | 34 | 5/33 | 29 | 10/28 | 27 | 12/26 |

Full six-horizon era outcomes, status counts, and entry-policy-version counts are in JSON. Small late-era counts are descriptive; not a policy comparison.

## Outlier-flag sensitivity and preclose separation

- Metadata identifies 3 large-path flagged rows: `1428, 1430, 1586`. They remain in the primary analysis. A later extreme occurring inside a 6h window is not automatically classified as erroneous.
- JSON gives the strict forward path and Spearman/cluster-CI sensitivity with those flagged rows omitted, for both volume metrics and every horizon.
- Preclose is strictly supplemental and comes only from applicable, complete, **non-cancelled closed-row** windows. The exporter excludes every `cancelled` status, not merely cancellations known to have no entry; this subset is not all actual entries. It is compared with full forward paths on its own matched subset and is never substituted for the primary symmetric cohort.

| Horizon | Applicable preclose rows also strict forward | Preclose +5 / +10 | Same rows full-forward +5 / +10 |
|---:|---:|---|---|
| 1h | 120 | 41/120 (34.2%) / 16/120 (13.3%) | 41/120 (34.2%) / 17/120 (14.2%) |
| 3h | 120 | 63/120 (52.5%) / 27/120 (22.5%) | 63/120 (52.5%) / 30/120 (25.0%) |
| 6h | 120 | 76/120 (63.3%) / 33/120 (27.5%) | 77/120 (64.2%) / 39/120 (32.5%) |
| 24h | 119 | 89/119 (74.8%) / 44/119 (37.0%) | 94/119 (79.0%) / 59/119 (49.6%) |
| 72h | 119 | 91/119 (76.5%) / 48/119 (40.3%) | 101/119 (84.9%) / 74/119 (62.2%) |

## Metric semantics, caveats, and decision boundary

- **Exact trigger volume is primary.** In the source inspection, the impulse path selects the last closed 30m candle, divides its quote-volume estimate by the mean quote volume of the 20 previous closed 30m candles, and requires >=1.5x. The frozen cohort recorded this multiplier for only 61/188; its absolute trigger/baseline USD fields are empty for all rows.
- **Generic `entry_fut_vol_mult` is secondary only.** The inspected scanner path persists a separate generic multiplier from current volume versus its historical average; that current 30m bar may still be forming, and code around the futures-volume calculation can apply cross-exchange confirmation/adjustment. This is not asserted to be a pure BingX observation for every historical row, and it is not identical to the closed 30m trigger ratio.
- Futures taker is net-buy percentage: `(buy - sell)/(buy + sell) * 100`; a value of 0 is neutral, not a 50% buy share.
- The source inspection explains metric semantics only; all calculations here come from the two frozen exports. The current source cannot establish every historical row's runtime branch.
- The analysis is exploratory, fired-only, coverage-conditioned, small-sample, non-causal, and does not justify a live gate edit. No threshold was selected by searching many cutoffs.

## Reproducibility

Run `python3 volume-analysis.py` from the workspace root. It reads only the two frozen JSON inputs and rewrites `volume-analysis.json` and `volume-analysis.md`. Bootstrap seed is fixed at 20261001.
