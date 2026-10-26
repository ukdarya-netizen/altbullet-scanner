# Impulse Buy overhead-resistance analysis — 2026-10-01

Frozen cohort: 188 canonical fires; captured 2026-10-01T06:02:27.412957+00:00. Frozen status values were used; no cohort refresh.

Structure coverage: measured room 120/188; no known overhead resistance 60; unknown/fail-open 8; gap-free sufficient histories 180. Captured structure values 0; all measurable structure is historical reconstruction.

Frozen statuses: stop_loss=32; bu_stop=63; profit=28; cancelled=55; expired=4; reclassified=2; active=4.

Entry basis provenance: original_entry_price 93; entry_price fallback 95; unavailable 0.

## Fixed room cuts and exact frozen statuses

Removal requires a measured nearest intact overhead level with room strictly below the stated cut. Unknown histories and the distinct no-known-resistance category fail open. Denominators show measured feature rows and the full segment. Exact statuses are frozen labels, not inferred executions.

| Segment | N | Measured | Cut | Removed / measured | Removed / full | stop_loss | bu_stop | profit | cancelled | expired | reclassified | active | Retained stop_loss / bu_stop / profit / cancelled / expired / reclassified / active |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| full_188 | 188 | 120 | <3% | 50/120 | 50/188 | 5 | 14 | 9 | 17 | 3 | 1 | 1 | 27/49/19/38/1/1/3 |
| full_188 | 188 | 120 | <5% | 67/120 | 67/188 | 7 | 19 | 12 | 24 | 3 | 1 | 1 | 25/44/16/31/1/1/3 |
| full_188 | 188 | 120 | <10% | 93/120 | 93/188 | 11 | 29 | 16 | 29 | 4 | 2 | 2 | 21/34/12/26/0/0/2 |
| early_before_2026_09_20_utc | 153 | 99 | <3% | 38/99 | 38/153 | 2 | 12 | 7 | 14 | 2 | 1 | 0 | 23/40/18/32/1/1/0 |
| early_before_2026_09_20_utc | 153 | 99 | <5% | 52/99 | 52/153 | 4 | 16 | 10 | 19 | 2 | 1 | 0 | 21/36/15/27/1/1/0 |
| early_before_2026_09_20_utc | 153 | 99 | <10% | 74/99 | 74/153 | 7 | 25 | 14 | 23 | 3 | 2 | 0 | 18/27/11/23/0/0/0 |
| late_from_2026_09_20_utc | 35 | 21 | <3% | 12/21 | 12/35 | 3 | 2 | 2 | 3 | 1 | 0 | 1 | 4/9/1/6/0/0/3 |
| late_from_2026_09_20_utc | 35 | 21 | <5% | 15/21 | 15/35 | 3 | 3 | 2 | 5 | 1 | 0 | 1 | 4/8/1/4/0/0/3 |
| late_from_2026_09_20_utc | 35 | 21 | <10% | 19/21 | 19/35 | 4 | 4 | 2 | 6 | 1 | 0 | 2 | 3/7/1/3/0/0/2 |
| single_entry_v1 | 48 | 26 | <3% | 15/26 | 15/48 | 3 | 3 | 3 | 3 | 2 | 0 | 1 | 5/12/3/10/0/0/3 |
| single_entry_v1 | 48 | 26 | <5% | 19/26 | 19/48 | 3 | 5 | 3 | 5 | 2 | 0 | 1 | 5/10/3/8/0/0/3 |
| single_entry_v1 | 48 | 26 | <10% | 24/26 | 24/48 | 4 | 6 | 4 | 6 | 2 | 0 | 2 | 4/9/2/7/0/0/2 |

## Frozen +5/+10 path outcomes by horizon

Windows are counted only when frozen mature flag position 0 and gap-free coverage flag position 9 are both true. Peak highs and strict first-hit +5/+10 flags describe observed candle paths, not realized wins or executions.

| Horizon | Complete rows / 188 | Peak high ≥+5 | Peak high ≥+10 | Strict +5 flags | Strict +10 flags |
|---:|---:|---:|---:|---:|---:|
| 1h | 185/188 | 46 | 18 | 46 | 18 |
| 3h | 185/188 | 72 | 33 | 72 | 33 |
| 6h | 185/188 | 90 | 44 | 90 | 44 |

## Definition, coverage, and evidence boundary

Structure uses the last 168 closed 1h bars before detected_at, plus two older closed bars for left pivot context; all 170 required bars must be valid and gap-free. Swing highs must be strictly greater than each of two highs to the left and two to the right; ties are not pivots. The pivot is usable only after the second right bar closes. A later closed 1h close strictly above the pivot invalidates it; a wick alone does not. Select the nearest intact pivot strictly above original_entry_price, otherwise the frozen entry_price fallback. Room is ((level / basis) - 1) × 100. Valid history without an intact overhead pivot is no-known-resistance, not infinite upside.

No captured live overhead-room value exists in the frozen input. All structure feature values are historical reconstructions from exact-symbol BingX swap 1h OHLC. Every used candle close and pivot confirmation is checked at or before detected_at; future bars, tracker peaks, and forward bars are not feature inputs. No instrument or exchange substitution is permitted; missing, delisted, or gapped history is unknown and fails open.

Acquisition: 187 unique BingX symbol/UTC-date groups; 1 usable exact-symbol local 1h cache group(s); 186 public request attempts; 184 successful; 2 failed; 0 not attempted.

No thresholds were tuned. This is an observational fixed-cohort sensitivity, not evidence of exchange execution, prospective validated improvement, or an optimal gate. Early/late date split is pre-2026-09-20 UTC versus inclusive 2026-09-20 UTC onward. single_entry_v1 is a separate exact policy-version sensitivity.

## Reproducibility files

- .local/reports/ib-entry-structure-2026-10-01/frozen-cohort-ib-entry-structure-2026-10-01.json
- .local/reports/ib-entry-structure-2026-10-01/frozen-metadata-ib-entry-structure-2026-10-01.json
- .local/reports/ib-entry-structure-2026-10-01/bingx-swap-1h-acquisitions-ib-entry-structure-2026-10-01.jsonl
- .local/reports/ib-entry-structure-2026-10-01/bingx-swap-1h-acquisition-index-ib-entry-structure-2026-10-01.csv
- .local/reports/ib-entry-structure-2026-10-01/ib-entry-structure-rows-2026-10-01.csv
- .local/reports/ib-entry-structure-2026-10-01/ib-entry-structure-report-2026-10-01.json
- .local/reports/ib-entry-structure-2026-10-01/ib-entry-structure-report-2026-10-01.md
- .local/reports/ib-entry-structure-2026-10-01/ib-entry-structure-analysis-2026-10-01.mjs

