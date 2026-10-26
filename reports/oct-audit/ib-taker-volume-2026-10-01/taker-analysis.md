# Frozen-cohort taker net-buy analysis

**Scope:** frozen `.local/reports/ib-taker-volume-2026-10-01/cohort.json` plus its `metadata.json` only. All 188 canonical fires retained; no UI/status/policy/date filtering. No live data, DB, network, or other report files used.

**Taker definition:** net-buy % = `(buy volume − sell volume) / (buy volume + sell volume) × 100`; this is not buy-share %. Futures and spot are analyzed separately, plus the matched both-available subset. Missing metric/path observations remain unknown, never treated as zero or failure in association tables.

## Cohort and path coverage

Capture as of 2026-10-01T06:02:27.412957+00:00; dates 2026-06-18T14:48:16.594+00:00 through 2026-10-01T03:06:29.114+00:00. Statuses and legacy rows remain included. A strict horizon requires both `mature_at_capture=true` and `coverage_complete=true`; the flags are reported independently. Unknown / incomplete paths are not failures.
| Horizon | All fires | Mature | Gap-free | Both (strict) | Not strict / unknown |
| --- | --- | --- | --- | --- | --- |
| 1h | 188 | 188 | 185 | 185 | 3 |
| 3h | 188 | 187 | 185 | 185 | 3 |
| 6h | 188 | 187 | 185 | 185 | 3 |
| 12h | 188 | 187 | 185 | 185 | 3 |
| 24h | 188 | 182 | 180 | 180 | 8 |
| 72h | 188 | 180 | 178 | 178 | 10 |

Taker availability from the immutable entry snapshot: futures 148/188, spot 94/188, both 89/188. Legacy snapshot rows: 30/188. No August fires are implied by legacy records; actual detected-date coverage is shown below. These are fire-history records, not 188 executed fills; two rows are `reclassified`.

Included statuses: active 4, bu_stop 63, cancelled 55, expired 4, profit 28, reclassified 2, stop_loss 32. Actual detections by UTC month: 2026-06: 16, 2026-09: 171, 2026-10: 1. September has 171 fires and August has 0; the 30 snapshot-legacy rows are not August detections.

## Top factual readout (descriptive, not causal)

• Futures >=20% net-buy is sparse: 4/148 futures observations. On strict 6h paths, +10% was 0/4 in that band versus 20/83 (24.1%) at futures <=0. The predefined >=20% versus <20% symbol-cluster bootstrap difference was -26.6 percentage points (95% CI -34.7 to -18.4 pp); the high band contains only four rows.
• In the matched both-metrics-present subset (n=89), 6h +10 was futures <=0: 10/49 and >=20: 0/4; spot <=0: 1/12 and >=20: 8/35. For spot >=20 versus <20 the cluster-bootstrap contrast was 9.6 pp (95% CI -5.5 to 25.5 pp), including zero.
• Six-hour taker/peak Spearman associations are small and uncertain: futures ρ=0.055 (cluster CI -0.10 to 0.21); spot ρ=0.102 (-0.14 to 0.33).
• Retrospective accounting only: a futures >=20% cut with missing fail-open would remove 38/44 strict 6h +10 achievers (and 105 nonwinners); spot >=20% would remove 7/44 achievers (and 49 nonwinners), with 92 missing-spot rows retained. This is not a live-gate proposal.

## Main comparison: fixed +5% / +10% OHLC hits

Rates use strict mature + gap-free denominators within each known-taker band. Horizons 1/3/6h are primary; 24/72h are secondary. Counts in parentheses are hits / strict known-outcome rows. JSON separately counts unknown/incomplete rows within each band, rows outside the band or with missing metrics, and full-cohort horizon coverage.

### Futures taker net-buy

| Net-buy band | Horizon | +5 hit (n/N) | +10 hit (n/N) | Band metric n |
| --- | --- | --- | --- | --- |
| <=0 | 1h | 17/83 (20.5%) | 7/83 (8.4%) | 84 |
| <=0 | 3h | 28/83 (33.7%) | 14/83 (16.9%) | 84 |
| <=0 | 6h | 37/83 (44.6%) | 20/83 (24.1%) | 84 |
| <=0 | 24h | 44/80 (55.0%) | 28/80 (35.0%) | 84 |
| <=0 | 72h | 50/80 (62.5%) | 34/80 (42.5%) | 84 |
| (0,10) | 1h | 11/36 (30.6%) | 6/36 (16.7%) | 36 |
| (0,10) | 3h | 17/36 (47.2%) | 9/36 (25.0%) | 36 |
| (0,10) | 6h | 20/36 (55.6%) | 11/36 (30.6%) | 36 |
| (0,10) | 24h | 23/34 (67.6%) | 15/34 (44.1%) | 36 |
| (0,10) | 72h | 26/33 (78.8%) | 20/33 (60.6%) | 36 |
| [10,20) | 1h | 8/24 (33.3%) | 4/24 (16.7%) | 24 |
| [10,20) | 3h | 9/24 (37.5%) | 6/24 (25.0%) | 24 |
| [10,20) | 6h | 11/24 (45.8%) | 7/24 (29.2%) | 24 |
| [10,20) | 24h | 18/24 (75.0%) | 12/24 (50.0%) | 24 |
| [10,20) | 72h | 20/23 (87.0%) | 15/23 (65.2%) | 24 |
| >=20 | 1h | 0/4 (0.0%) | 0/4 (0.0%) | 4 |
| >=20 | 3h | 1/4 (25.0%) | 0/4 (0.0%) | 4 |
| >=20 | 6h | 1/4 (25.0%) | 0/4 (0.0%) | 4 |
| >=20 | 24h | 1/4 (25.0%) | 0/4 (0.0%) | 4 |
| >=20 | 72h | 2/4 (50.0%) | 0/4 (0.0%) | 4 |

The same band tables on the matched both-takers-present cohort (n=89) are in JSON at `matched_both_available`.

### Spot taker net-buy

| Net-buy band | Horizon | +5 hit (n/N) | +10 hit (n/N) | Band metric n |
| --- | --- | --- | --- | --- |
| <=0 | 1h | 1/12 (8.3%) | 0/12 (0.0%) | 12 |
| <=0 | 3h | 3/12 (25.0%) | 1/12 (8.3%) | 12 |
| <=0 | 6h | 5/12 (41.7%) | 1/12 (8.3%) | 12 |
| <=0 | 24h | 7/12 (58.3%) | 5/12 (41.7%) | 12 |
| <=0 | 72h | 8/12 (66.7%) | 7/12 (58.3%) | 12 |
| (0,10) | 1h | 2/21 (9.5%) | 1/21 (4.8%) | 22 |
| (0,10) | 3h | 3/21 (14.3%) | 1/21 (4.8%) | 22 |
| (0,10) | 6h | 5/21 (23.8%) | 2/21 (9.5%) | 22 |
| (0,10) | 24h | 8/19 (42.1%) | 4/19 (21.1%) | 22 |
| (0,10) | 72h | 9/18 (50.0%) | 8/18 (44.4%) | 22 |
| [10,20) | 1h | 2/23 (8.7%) | 1/23 (4.3%) | 23 |
| [10,20) | 3h | 4/23 (17.4%) | 1/23 (4.3%) | 23 |
| [10,20) | 6h | 6/23 (26.1%) | 4/23 (17.4%) | 23 |
| [10,20) | 24h | 11/22 (50.0%) | 4/22 (18.2%) | 23 |
| [10,20) | 72h | 16/21 (76.2%) | 7/21 (33.3%) | 23 |
| >=20 | 1h | 6/37 (16.2%) | 1/37 (2.7%) | 37 |
| >=20 | 3h | 13/37 (35.1%) | 6/37 (16.2%) | 37 |
| >=20 | 6h | 17/37 (45.9%) | 9/37 (24.3%) | 37 |
| >=20 | 24h | 19/35 (54.3%) | 12/35 (34.3%) | 37 |
| >=20 | 72h | 21/35 (60.0%) | 13/35 (37.1%) | 37 |

The same band tables on the matched both-takers-present cohort (n=89) are in JSON at `matched_both_available`.

### Predefined cuts and combined categories

Cuts are exactly 0%, 10%, and 20% (high side is `>= cut`, low side `< cut`); bins are `<=0`, `(0,10)`, `[10,20)`, and `>=20`. Both-positive means futures >0 AND spot >0; stronger-futures means futures >=20%. These are descriptive fixed cuts, not a search for an optimum. All cut-level results are in JSON.

| Metric | Horizon | Cut | +5 high hits/N | +10 high hits/N | +10 low hits/N | +10 rate diff |
| --- | --- | --- | --- | --- | --- | --- |
| futures | 6h | >=0% | 32/64 | 18/64 | 20/83 | 4.0% |
| futures | 6h | >=10% | 12/28 | 7/28 | 31/119 | -1.1% |
| futures | 6h | >=20% | 1/4 | 0/4 | 38/143 | -26.6% |
| futures | 24h | >=0% | 42/62 | 27/62 | 28/80 | 8.5% |
| futures | 24h | >=10% | 19/28 | 12/28 | 43/114 | 5.1% |
| futures | 24h | >=20% | 1/4 | 0/4 | 55/138 | -39.9% |
| futures | 72h | >=0% | 48/60 | 35/60 | 34/80 | 15.8% |
| futures | 72h | >=10% | 22/27 | 15/27 | 54/113 | 7.8% |
| futures | 72h | >=20% | 2/4 | 0/4 | 69/136 | -50.7% |

| Horizon | Combined group | Group n | Strict n | +5 hit | +10 hit |
| --- | --- | --- | --- | --- | --- |
| 1h | both positive (>0 each) | 37 | 37 | 4/37 (10.8%) | 1/37 (2.7%) |
| 1h | futures >=20% | 4 | 4 | 0/4 (0.0%) | 0/4 (0.0%) |
| 3h | both positive (>0 each) | 37 | 37 | 10/37 (27.0%) | 4/37 (10.8%) |
| 3h | futures >=20% | 4 | 4 | 1/4 (25.0%) | 0/4 (0.0%) |
| 6h | both positive (>0 each) | 37 | 37 | 14/37 (37.8%) | 5/37 (13.5%) |
| 6h | futures >=20% | 4 | 4 | 1/4 (25.0%) | 0/4 (0.0%) |
| 24h | both positive (>0 each) | 37 | 35 | 19/35 (54.3%) | 9/35 (25.7%) |
| 24h | futures >=20% | 4 | 4 | 1/4 (25.0%) | 0/4 (0.0%) |
| 72h | both positive (>0 each) | 37 | 33 | 23/33 (69.7%) | 13/33 (39.4%) |
| 72h | futures >=20% | 4 | 4 | 2/4 (50.0%) | 0/4 (0.0%) |

## Peak opportunity and rank association

Peak opportunity is the maximum high-based return from entry over the interval, not realized PnL and not an executable/fill price. Spearman correlations use only known entry taker values and strict paths; cluster-bootstrap 95% intervals resample symbols, not individual rows.

| Taker | Horizon | Pairs | Spearman ρ | Cluster-bootstrap 95% CI | Symbols |
| --- | --- | --- | --- | --- | --- |
| futures | 1h | 147 | 0.081 | [-0.09, 0.24] | 92 |
| futures | 3h | 147 | 0.063 | [-0.10, 0.22] | 92 |
| futures | 6h | 147 | 0.055 | [-0.10, 0.21] | 92 |
| futures | 24h | 142 | 0.111 | [-0.04, 0.25] | 89 |
| futures | 72h | 140 | 0.163 | [-0.00, 0.32] | 88 |
| spot | 1h | 93 | 0.008 | [-0.19, 0.21] | 63 |
| spot | 3h | 93 | 0.121 | [-0.09, 0.33] | 63 |
| spot | 6h | 93 | 0.102 | [-0.14, 0.33] | 63 |
| spot | 24h | 88 | 0.016 | [-0.20, 0.23] | 61 |
| spot | 72h | 86 | -0.059 | [-0.28, 0.15] | 60 |

Full peak median, quartiles, and threshold opportunity counts by taker band/horizon are preserved in JSON. Do not interpret an extreme high as tradable profit.

## Robustness: extreme forward-peak price flags

All 188 remain in the main analysis. A separate conservative sensitivity removes the three metadata-flagged rows with any forward high above 300%; this is a proxy sensitivity, **not** a finding that all three are bad data. Metadata says none has a >300% first-candle discontinuity. First-candle OHLC summary values are shown per row. The export does not include a first-bar open or the full adjacent-candle sequence, so a first-bar entry-price mismatch or a large adjacent gap cannot be independently confirmed from these permitted files.

| ID / symbol | Futures / spot net-buy | 6h peak high | 72h peak high | First-bar high / low / close | Quality detail |
| --- | --- | --- | --- | --- | --- |
| 1428 AKE-USDT | 11.34 / — | 78.0% | 303.2% | 5.5 / -19.6 / -18.4 | first-candle >300 flag=False; forward peak >300 flag=True |
| 1430 MARSCOIN-USDT | 0.92 / — | 15.1% | 335.0% | -1.6 / -4.7 / -4.3 | first-candle >300 flag=False; forward peak >300 flag=True |
| 1586 LSK-USDT | -10.90 / 29.57 | 11.7% | 1786.2% | -1.6 / -6.5 / -6.2 | first-candle >300 flag=False; forward peak >300 flag=True |

All-signal versus remove-all-three comparison, using strict-known outcomes and separately preserving unknown paths:

| Population | Taker | Band | Horizon | +10 hits / strict N (rate) | Band unknown/incomplete |
| --- | --- | --- | --- | --- | --- |
| all_signal_takers | futures | <=0 | 6h | 20/83 (24.1%) | 1 |
| all_signal_takers | futures | <=0 | 72h | 34/80 (42.5%) | 4 |
| all_signal_takers | futures | >=20 | 6h | 0/4 (0.0%) | 0 |
| all_signal_takers | futures | >=20 | 72h | 0/4 (0.0%) | 0 |
| all_signal_takers | spot | <=0 | 6h | 1/12 (8.3%) | 0 |
| all_signal_takers | spot | <=0 | 72h | 7/12 (58.3%) | 0 |
| all_signal_takers | spot | >=20 | 6h | 9/37 (24.3%) | 0 |
| all_signal_takers | spot | >=20 | 72h | 13/35 (37.1%) | 2 |
| remove_extreme_peak_candidates | futures | <=0 | 6h | 19/82 (23.2%) | 1 |
| remove_extreme_peak_candidates | futures | <=0 | 72h | 33/79 (41.8%) | 4 |
| remove_extreme_peak_candidates | futures | >=20 | 6h | 0/4 (0.0%) | 0 |
| remove_extreme_peak_candidates | futures | >=20 | 72h | 0/4 (0.0%) | 0 |
| remove_extreme_peak_candidates | spot | <=0 | 6h | 1/12 (8.3%) | 0 |
| remove_extreme_peak_candidates | spot | <=0 | 72h | 7/12 (58.3%) | 0 |
| remove_extreme_peak_candidates | spot | >=20 | 6h | 8/36 (22.2%) | 0 |
| remove_extreme_peak_candidates | spot | >=20 | 72h | 12/34 (35.3%) | 2 |

**LSK-USDT (id 1586):** entry basis 0.12582 (original_entry_price), futures net-buy -10.90%, spot 29.57%. Its strict 6h peak was 11.7% (first +5/+10 at 15m bucket indexes 14/15), versus a strict 72h peak of 1786.2%. First bar high/low/close were -1.6% / -6.5% / -6.2%, and metadata does not flag a >300% first-candle discontinuity; the extreme 72h high is therefore retained in the primary cohort and removed only in the conservative sensitivity. This summary cannot verify the intervening adjacent-bar path.

## Time-to-target, stop-path ambiguity, and bounded pre-close path

Conditional time-to-+5/+10 among rows that eventually hit is a 15-minute bar-index approximation; it is not exact elapsed time or a fill. The conditional winner-only timing tables include `hit_all_n` to make survivorship selection visible. The path begins at the first aligned candle bucket after the detected-at floor and omits any remainder of the entry-containing candle; OHLC cannot order two thresholds touched in the same candle.

First-target versus -8%/-10% stop counts for the full cohort are in JSON (`first_target_vs_stop_all_signal`) with explicit same-bar ambiguous and neither-observed categories. No ordering is imputed for ambiguous candles.

Primary forward paths are the symmetric detected-at-anchored post-entry hypothetical OHLC path for all fires, including cancelled rows and periods after a tracker exit/close; they are not actual fills or realized trade outcomes. Tracker-closed_at-bounded pre-close paths are a separate, partial sensitivity. The supplemental exporter excludes all `cancelled` status rows (not only no-entry cancellations), so this pre-close group must not represent all actual entered trades or drive final conclusions. It is not a fill history and must not be conflated with the primary forward opportunity.

| Horizon | Applicable pre-close | Complete nonempty | Peak >=5% | Peak >=10% | Median max high |
| --- | --- | --- | --- | --- | --- |
| 1h | 127 | 120 | 41 | 16 | 2.9% |
| 3h | 127 | 120 | 63 | 27 | 5.2% |
| 6h | 127 | 120 | 76 | 33 | 5.9% |
| 24h | 127 | 120 | 90 | 45 | 7.9% |
| 72h | 127 | 120 | 92 | 49 | 8.0% |

### 6h first-hit timing (conditional on eventual target hit)

| Taker | Band | +5 hit / strict N | +5 median bucket offset | +10 hit / strict N | +10 median bucket offset |
| --- | --- | --- | --- | --- | --- |
| futures | <=0 | 37/83 | 60 min | 20/83 | 105 min |
| futures | (0,10) | 20/36 | 37.5 min | 11/36 | 30 min |
| futures | [10,20) | 11/24 | 30 min | 7/24 | 45 min |
| futures | >=20 | 1/4 | 135 min | 0/4 | — |
| spot | <=0 | 5/12 | 150 min | 1/12 | 90 min |
| spot | (0,10) | 5/21 | 120 min | 2/21 | 150 min |
| spot | [10,20) | 6/23 | 82.5 min | 4/23 | 292.5 min |
| spot | >=20 | 17/37 | 105 min | 9/37 | 150 min |

Winner-only timing is survivorship-selected: the hit / strict N column is essential. Bucket offsets are approximate, not exact elapsed time or fill.

### First target versus -8% / -10% stop (all fires, strict paths)

| Horizon | Pair | Strict N | Target first | Stop first | Same-bar ambiguous | Neither observed |
| --- | --- | --- | --- | --- | --- | --- |
| 1h | +5% vs -8% | 185 | 45 | 7 | 1 | 132 |
| 1h | +5% vs -10% | 185 | 45 | 4 | 1 | 135 |
| 1h | +10% vs -8% | 185 | 18 | 11 | 0 | 156 |
| 1h | +10% vs -10% | 185 | 18 | 6 | 0 | 161 |
| 3h | +5% vs -8% | 185 | 69 | 18 | 1 | 97 |
| 3h | +5% vs -10% | 185 | 70 | 11 | 2 | 102 |
| 3h | +10% vs -8% | 185 | 32 | 26 | 0 | 127 |
| 3h | +10% vs -10% | 185 | 32 | 17 | 0 | 136 |
| 6h | +5% vs -8% | 185 | 85 | 28 | 1 | 71 |
| 6h | +5% vs -10% | 185 | 87 | 18 | 2 | 78 |
| 6h | +10% vs -8% | 185 | 41 | 41 | 0 | 103 |
| 6h | +10% vs -10% | 185 | 42 | 28 | 0 | 115 |
| 24h | +5% vs -8% | 180 | 101 | 48 | 1 | 30 |
| 24h | +5% vs -10% | 180 | 104 | 32 | 2 | 42 |
| 24h | +10% vs -8% | 180 | 59 | 72 | 0 | 49 |
| 24h | +10% vs -10% | 180 | 62 | 57 | 0 | 61 |
| 72h | +5% vs -8% | 178 | 104 | 65 | 1 | 8 |
| 72h | +5% vs -10% | 178 | 111 | 52 | 2 | 13 |
| 72h | +10% vs -8% | 178 | 66 | 94 | 0 | 18 |
| 72h | +10% vs -10% | 178 | 72 | 80 | 0 | 26 |

First-hit classifications are candle-index order only. Same-bar target/stop touches are ambiguous; the first analyzed aligned candle excludes the entry-containing candle remainder.

## Fixed-cut gate-retention accounting (offline only)

For +10% hit achievers within 6/24/72h, missing taker values are fail-open (retained); only known values below the fixed 0/10/20 cut are removed. The table counts both winners lost and nonwinners removed, on strict-known path outcomes. This is retrospective sensitivity accounting, **not** a recommendation or proposed change to any live gate.

| Population | Horizon | Metric | Cut | Base N | Removed | Missing retained | Winners lost | Nonwinners removed | Retained winners | Retained N |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| all_signal_takers | 6h | futures | >=0% | 185 | 83 | 38 | 20 | 63 | 24 | 102 |
| all_signal_takers | 6h | futures | >=10% | 185 | 119 | 38 | 31 | 88 | 13 | 66 |
| all_signal_takers | 6h | futures | >=20% | 185 | 143 | 38 | 38 | 105 | 6 | 42 |
| all_signal_takers | 6h | spot | >=0% | 185 | 12 | 92 | 1 | 11 | 43 | 173 |
| all_signal_takers | 6h | spot | >=10% | 185 | 33 | 92 | 3 | 30 | 41 | 152 |
| all_signal_takers | 6h | spot | >=20% | 185 | 56 | 92 | 7 | 49 | 37 | 129 |
| all_signal_takers | 24h | futures | >=0% | 180 | 80 | 38 | 28 | 52 | 40 | 100 |
| all_signal_takers | 24h | futures | >=10% | 180 | 114 | 38 | 43 | 71 | 25 | 66 |
| all_signal_takers | 24h | futures | >=20% | 180 | 138 | 38 | 55 | 83 | 13 | 42 |
| all_signal_takers | 24h | spot | >=0% | 180 | 12 | 92 | 5 | 7 | 63 | 168 |
| all_signal_takers | 24h | spot | >=10% | 180 | 31 | 92 | 9 | 22 | 59 | 149 |
| all_signal_takers | 24h | spot | >=20% | 180 | 53 | 92 | 13 | 40 | 55 | 127 |
| all_signal_takers | 72h | futures | >=0% | 178 | 80 | 38 | 34 | 46 | 57 | 98 |
| all_signal_takers | 72h | futures | >=10% | 178 | 113 | 38 | 54 | 59 | 37 | 65 |
| all_signal_takers | 72h | futures | >=20% | 178 | 136 | 38 | 69 | 67 | 22 | 42 |
| all_signal_takers | 72h | spot | >=0% | 178 | 12 | 92 | 7 | 5 | 84 | 166 |
| all_signal_takers | 72h | spot | >=10% | 178 | 30 | 92 | 15 | 15 | 76 | 148 |
| all_signal_takers | 72h | spot | >=20% | 178 | 51 | 92 | 22 | 29 | 69 | 127 |
| remove_extreme_peak_candidates | 6h | futures | >=0% | 182 | 82 | 38 | 19 | 63 | 22 | 100 |
| remove_extreme_peak_candidates | 6h | futures | >=10% | 182 | 117 | 38 | 29 | 88 | 12 | 65 |
| remove_extreme_peak_candidates | 6h | futures | >=20% | 182 | 140 | 38 | 35 | 105 | 6 | 42 |
| remove_extreme_peak_candidates | 6h | spot | >=0% | 182 | 12 | 90 | 1 | 11 | 40 | 170 |
| remove_extreme_peak_candidates | 6h | spot | >=10% | 182 | 33 | 90 | 3 | 30 | 38 | 149 |
| remove_extreme_peak_candidates | 6h | spot | >=20% | 182 | 56 | 90 | 7 | 49 | 34 | 126 |
| remove_extreme_peak_candidates | 24h | futures | >=0% | 177 | 79 | 38 | 27 | 52 | 38 | 98 |
| remove_extreme_peak_candidates | 24h | futures | >=10% | 177 | 112 | 38 | 41 | 71 | 24 | 65 |
| remove_extreme_peak_candidates | 24h | futures | >=20% | 177 | 135 | 38 | 52 | 83 | 13 | 42 |
| remove_extreme_peak_candidates | 24h | spot | >=0% | 177 | 12 | 90 | 5 | 7 | 60 | 165 |
| remove_extreme_peak_candidates | 24h | spot | >=10% | 177 | 31 | 90 | 9 | 22 | 56 | 146 |
| remove_extreme_peak_candidates | 24h | spot | >=20% | 177 | 53 | 90 | 13 | 40 | 52 | 124 |
| remove_extreme_peak_candidates | 72h | futures | >=0% | 175 | 79 | 38 | 33 | 46 | 55 | 96 |
| remove_extreme_peak_candidates | 72h | futures | >=10% | 175 | 111 | 38 | 52 | 59 | 36 | 64 |
| remove_extreme_peak_candidates | 72h | futures | >=20% | 175 | 133 | 38 | 66 | 67 | 22 | 42 |
| remove_extreme_peak_candidates | 72h | spot | >=0% | 175 | 12 | 90 | 7 | 5 | 81 | 163 |
| remove_extreme_peak_candidates | 72h | spot | >=10% | 175 | 30 | 90 | 15 | 15 | 73 | 145 |
| remove_extreme_peak_candidates | 72h | spot | >=20% | 175 | 51 | 90 | 22 | 29 | 66 | 124 |

### Fixed 6h early / late results by predefined band

| Taker | Period | Band | Metric-known N | Strict N | +5 hits / N (rate) | +10 hits / N (rate) |
| --- | --- | --- | --- | --- | --- | --- |
| futures | early | <=0 | 67 | 67 | 31/67 (46.3%) | 17/67 (25.4%) |
| futures | early | (0,10) | 26 | 26 | 17/26 (65.4%) | 9/26 (34.6%) |
| futures | early | [10,20) | 17 | 17 | 10/17 (58.8%) | 7/17 (41.2%) |
| futures | early | >=20 | 4 | 4 | 1/4 (25.0%) | 0/4 (0.0%) |
| futures | late | <=0 | 17 | 16 | 6/16 (37.5%) | 3/16 (18.8%) |
| futures | late | (0,10) | 10 | 10 | 3/10 (30.0%) | 2/10 (20.0%) |
| futures | late | [10,20) | 7 | 7 | 1/7 (14.3%) | 0/7 (0.0%) |
| futures | late | >=20 | 0 | 0 | 0/0 (—) | 0/0 (—) |
| spot | early | <=0 | 8 | 8 | 3/8 (37.5%) | 1/8 (12.5%) |
| spot | early | (0,10) | 14 | 14 | 4/14 (28.6%) | 2/14 (14.3%) |
| spot | early | [10,20) | 16 | 16 | 5/16 (31.2%) | 3/16 (18.8%) |
| spot | early | >=20 | 30 | 30 | 15/30 (50.0%) | 8/30 (26.7%) |
| spot | late | <=0 | 4 | 4 | 2/4 (50.0%) | 0/4 (0.0%) |
| spot | late | (0,10) | 8 | 7 | 1/7 (14.3%) | 0/7 (0.0%) |
| spot | late | [10,20) | 7 | 7 | 1/7 (14.3%) | 1/7 (14.3%) |
| spot | late | >=20 | 7 | 7 | 2/7 (28.6%) | 1/7 (14.3%) |


## Fixed early/late validation and policy/date context

Predefined split: detections before 2026-09-20 versus on/after 2026-09-20. The late cohort is small and not independent of symbol clustering; these are descriptive checks, not prospective validation.

Early / late rows: 153 / 35; no-August-signal coverage is not inferred from earlier Jun–Aug legacy reconciliation records. Snapshot legacy rows are 30 and actual detected dates span 2026-06-18T14:48:16.594+00:00 to 2026-10-01T03:06:29.114+00:00.

Entry policy counts: <null> 140, single_entry_v1 48 (one non-null version); exit policy counts: <null> 122, impulse_runner_v1 66. Policy versions were not used to gate the cohort; exit-policy version is not treated as a gate version. No row was excluded by policy or status.

## Uncertainty and interpretation

The JSON includes symbol-cluster bootstrap 95% intervals for predefined >=20% versus <20% hit-rate contrasts and for Spearman correlations. Intervals may be wide or undefined in small/sparse cells; repeated symbols are resampled together. No p-value fishing or threshold optimization was performed.

These observational comparisons do not establish causality. Entry metrics are sparse and date-varying; OHLC high-based opportunities are not realized PnL; selection, symbol dependence, missingness, capture maturity, candle-path ambiguity, and price discontinuities limit inference. No live gate change is proposed.

## Reproducibility

Script: `taker-analysis.py` (standard library only). Input SHA-256: cohort.json `9a140d4a4fa52bd294448dbc80242d866edb70a76b07bf7f9e01d09e781681b3`; metadata.json `97520d53f4e2bd5cbfd0d1e18a3dde462f83877995f9c2dcc6975b991780486a`. It writes only this JSON and Markdown report.
