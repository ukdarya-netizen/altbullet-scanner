# Impulse Buy trigger lateness and price chase

Frozen cohort: **188 canonical fires**, capture 2026-10-01T06:02:27.412957+00:00; input was not refreshed.

## What is measured

- Captured exact 30m trigger-close timestamp: **61/188**; remaining **127/188 are unknown and fail open**.
- Reconstructed exact trigger OHLC from **61** public BingX USDT-perpetual 30m bars, keyed to the frozen symbol and trigger close timestamp; no other symbol or exchange was substituted. DB snapshot has a captured trigger close/OHLC candidate for **0/188**. Existing local BingX cache artifacts were 1h, not the required 30m anchor, so they were not substituted.
- Trigger close timestamp is a close time, not open time: scanner source picks a bar only after `time + 30m <= now`, then persists `time + 30m` (scanner.ts:7165-7168, 7585-7589). All reconstructed anchor bars closed by detection; no future bars were used. No pivot is part of these features.
- Delay = detected time minus captured trigger close. Price chase = **(frozen basis entry / exact trigger close − 1) × 100**. Price chase uses frozen `original_entry_price` where present, otherwise the separately labeled `entry_price_fallback`; it is neither Price24 nor candle body size.

## Frozen final status baseline (all 188; no status excluded)

| Final status | Rows / 188 |
| --- | --- |
| stop_loss | 32/188 |
| bu_stop | 63/188 |
| profit | 28/188 |
| cancelled | 55/188 |
| expired | 4/188 |
| reclassified | 2/188 |
| active | 4/188 |

Entry price basis provenance: **93 original_entry_price**, **95 entry_price_fallback**, **0 unavailable**. Among the 61 exact trigger-price rows: original 53, fallback 8, unavailable 0.

## Fixed cut sensitivity: removal by final status and retained outcomes

All cuts were declared before counting results and use strict `>`: delay >5/>15/>30 minutes; price chase >1/>2/>3%. Missing values are not removed. The measured denominator is the feature-known subset; full denominator remains 188. Retained status counts include all fail-open unknowns.

| Fixed cut | Removed known / measured; full | Removed final statuses (exact counts) | Retained final statuses (exact counts) | Removed strict-path +5/+10 | Retained strict-path peak median and +5/+10 |
| --- | --- | --- | --- | --- | --- |
| delay_gt_5m | 60/61 measured; 60/188 full | stop_loss 11; bu_stop 16; profit 8; cancelled 19; expired 2; reclassified 0; active 4 | stop_loss 21; bu_stop 47; profit 20; cancelled 36; expired 2; reclassified 2; active 0 | 1h +5 11/59, +10 6/59; 3h +5 16/59, +10 8/59; 6h +5 20/59, +10 10/59 | 1h peak p50 2.32%, +5 35/126, +10 12/126; 3h peak p50 4.03%, +5 56/126, +10 25/126; 6h peak p50 5.53%, +5 70/126, +10 34/126 |
| delay_gt_15m | 1/61 measured; 1/188 full | stop_loss 0; bu_stop 0; profit 1; cancelled 0; expired 0; reclassified 0; active 0 | stop_loss 32; bu_stop 63; profit 27; cancelled 55; expired 4; reclassified 2; active 4 | 1h +5 0/1, +10 0/1; 3h +5 1/1, +10 0/1; 6h +5 1/1, +10 0/1 | 1h peak p50 2.14%, +5 46/184, +10 18/184; 3h peak p50 3.47%, +5 71/184, +10 33/184; 6h peak p50 4.66%, +5 89/184, +10 44/184 |
| delay_gt_30m | 0/61 measured; 0/188 full | stop_loss 0; bu_stop 0; profit 0; cancelled 0; expired 0; reclassified 0; active 0 | stop_loss 32; bu_stop 63; profit 28; cancelled 55; expired 4; reclassified 2; active 4 | 1h +5 0/0, +10 0/0; 3h +5 0/0, +10 0/0; 6h +5 0/0, +10 0/0 | 1h peak p50 2.12%, +5 46/185, +10 18/185; 3h peak p50 3.51%, +5 72/185, +10 33/185; 6h peak p50 4.80%, +5 90/185, +10 44/185 |
| chase_gt_1pct | 15/61 measured; 15/188 full | stop_loss 2; bu_stop 3; profit 6; cancelled 3; expired 0; reclassified 0; active 1 | stop_loss 30; bu_stop 60; profit 22; cancelled 52; expired 4; reclassified 2; active 3 | 1h +5 4/15, +10 3/15; 3h +5 7/15, +10 4/15; 6h +5 8/15, +10 5/15 | 1h peak p50 2.11%, +5 42/170, +10 15/170; 3h peak p50 3.29%, +5 65/170, +10 29/170; 6h peak p50 4.51%, +5 82/170, +10 39/170 |
| chase_gt_2pct | 5/61 measured; 5/188 full | stop_loss 1; bu_stop 1; profit 2; cancelled 1; expired 0; reclassified 0; active 0 | stop_loss 31; bu_stop 62; profit 26; cancelled 54; expired 4; reclassified 2; active 4 | 1h +5 2/5, +10 2/5; 3h +5 3/5, +10 2/5; 6h +5 4/5, +10 3/5 | 1h peak p50 2.11%, +5 44/180, +10 16/180; 3h peak p50 3.39%, +5 69/180, +10 31/180; 6h peak p50 4.51%, +5 86/180, +10 41/180 |
| chase_gt_3pct | 4/61 measured; 4/188 full | stop_loss 1; bu_stop 1; profit 2; cancelled 0; expired 0; reclassified 0; active 0 | stop_loss 31; bu_stop 62; profit 26; cancelled 55; expired 4; reclassified 2; active 4 | 1h +5 2/4, +10 2/4; 3h +5 2/4, +10 2/4; 6h +5 3/4, +10 3/4 | 1h peak p50 2.09%, +5 44/181, +10 16/181; 3h peak p50 3.43%, +5 70/181, +10 31/181; 6h peak p50 4.52%, +5 87/181, +10 41/181 |

Delay distribution over 61 known triggers: min 4.91997m, median 6.49m, max 25.61208m; >5m **60/61**, >15m **1/61**, >30m **0/61**. As a result, >5m is effectively a scanner scheduling delay proxy that would remove almost every measured fire; it is not evidence of a useful gate.

Price-chase distribution over 61 exact comparisons: min -5.73%, median 0.11%, max 9.97%. Each cut's exact stop-loss, break-even-stop, profit, cancellation, expired, reclassified, and active counts are enumerated above and in the status CSV.

## Frozen forward OHLC paths: 1/3/6h

Joined by frozen tracker ID and horizon from the cohort's captured windows. A row is counted only when frozen flags at array positions **0 (mature)** and **9 (complete coverage)** are both true; CSV flags were cross-checked against those positions.

| Horizon | Strict covered / 188 | Peak median | Peak max | +5 high hits / strict n | +10 high hits / strict n | Not strict |
| --- | --- | --- | --- | --- | --- | --- |
| 1h | 185/188 | 2.12% | 41.34% | 46/185 (24.9%) | 18/185 (9.7%) | 3 |
| 3h | 185/188 | 3.51% | 127.06% | 72/185 (38.9%) | 33/185 (17.8%) | 3 |
| 6h | 185/188 | 4.80% | 153.13% | 90/185 (48.6%) | 44/185 (23.8%) | 3 |

These are BingX 15m OHLC observations from the frozen report, not fills. They remain separate from the frozen tracked-status labels; a high crossing a target is not an exchange execution.

### Retained forward outcomes by final status

Per-cut, retained rows are grouped by each frozen status. Strict path denominator, peak median, and +5/+10 OHLC hits are reported by 1/3/6h; cells with `0/0` have no strictly covered rows for that status.

| Fixed cut | Final status | Removed status rows | Retained status rows | Retained strict-path outcomes |
| --- | --- | --- | --- | --- |
| delay_gt_5m | stop_loss | 11 | 21 | 1h: p50 0.88%; +5 1/19; +10 0/19 | 3h: p50 0.99%; +5 1/19; +10 1/19 | 6h: p50 1.28%; +5 1/19; +10 1/19 |
| delay_gt_5m | bu_stop | 16 | 47 | 1h: p50 4.88%; +5 23/47; +10 5/47 | 3h: p50 6.84%; +5 35/47; +10 12/47 | 6h: p50 7.91%; +5 42/47; +10 13/47 |
| delay_gt_5m | profit | 8 | 20 | 1h: p50 4.35%; +5 9/20; +10 7/20 | 3h: p50 11.34%; +5 16/20; +10 11/20 | 6h: p50 16.81%; +5 19/20; +10 17/20 |
| delay_gt_5m | cancelled | 19 | 36 | 1h: p50 0.84%; +5 2/36; +10 0/36 | 3h: p50 1.49%; +5 4/36; +10 1/36 | 6h: p50 1.91%; +5 8/36; +10 3/36 |
| delay_gt_5m | expired | 2 | 2 | 1h: p50 1.08%; +5 0/2; +10 0/2 | 3h: p50 1.39%; +5 0/2; +10 0/2 | 6h: p50 1.70%; +5 0/2; +10 0/2 |
| delay_gt_5m | reclassified | 0 | 2 | 1h: p50 2.80%; +5 0/2; +10 0/2 | 3h: p50 3.36%; +5 0/2; +10 0/2 | 6h: p50 3.36%; +5 0/2; +10 0/2 |
| delay_gt_5m | active | 4 | 0 | 1h: p50 n/a; +5 0/0; +10 0/0 | 3h: p50 n/a; +5 0/0; +10 0/0 | 6h: p50 n/a; +5 0/0; +10 0/0 |
| delay_gt_15m | stop_loss | 0 | 32 | 1h: p50 1.59%; +5 3/30; +10 0/30 | 3h: p50 2.63%; +5 3/30; +10 1/30 | 6h: p50 2.69%; +5 4/30; +10 2/30 |
| delay_gt_15m | bu_stop | 0 | 63 | 1h: p50 4.50%; +5 28/63; +10 7/63 | 3h: p50 6.16%; +5 41/63; +10 15/63 | 6h: p50 7.42%; +5 51/63; +10 17/63 |
| delay_gt_15m | profit | 1 | 27 | 1h: p50 4.97%; +5 13/27; +10 11/27 | 3h: p50 12.34%; +5 21/27; +10 16/27 | 6h: p50 16.82%; +5 24/27; +10 22/27 |
| delay_gt_15m | cancelled | 0 | 55 | 1h: p50 0.68%; +5 2/55; +10 0/55 | 3h: p50 1.23%; +5 5/55; +10 1/55 | 6h: p50 1.49%; +5 9/55; +10 3/55 |
| delay_gt_15m | expired | 0 | 4 | 1h: p50 1.08%; +5 0/4; +10 0/4 | 3h: p50 1.39%; +5 1/4; +10 0/4 | 6h: p50 1.70%; +5 1/4; +10 0/4 |
| delay_gt_15m | reclassified | 0 | 2 | 1h: p50 2.80%; +5 0/2; +10 0/2 | 3h: p50 3.36%; +5 0/2; +10 0/2 | 6h: p50 3.36%; +5 0/2; +10 0/2 |
| delay_gt_15m | active | 0 | 4 | 1h: p50 0.69%; +5 0/3; +10 0/3 | 3h: p50 2.19%; +5 0/3; +10 0/3 | 6h: p50 2.19%; +5 0/3; +10 0/3 |
| delay_gt_30m | stop_loss | 0 | 32 | 1h: p50 1.59%; +5 3/30; +10 0/30 | 3h: p50 2.63%; +5 3/30; +10 1/30 | 6h: p50 2.69%; +5 4/30; +10 2/30 |
| delay_gt_30m | bu_stop | 0 | 63 | 1h: p50 4.50%; +5 28/63; +10 7/63 | 3h: p50 6.16%; +5 41/63; +10 15/63 | 6h: p50 7.42%; +5 51/63; +10 17/63 |
| delay_gt_30m | profit | 0 | 28 | 1h: p50 4.70%; +5 13/28; +10 11/28 | 3h: p50 11.40%; +5 22/28; +10 16/28 | 6h: p50 16.81%; +5 25/28; +10 22/28 |
| delay_gt_30m | cancelled | 0 | 55 | 1h: p50 0.68%; +5 2/55; +10 0/55 | 3h: p50 1.23%; +5 5/55; +10 1/55 | 6h: p50 1.49%; +5 9/55; +10 3/55 |
| delay_gt_30m | expired | 0 | 4 | 1h: p50 1.08%; +5 0/4; +10 0/4 | 3h: p50 1.39%; +5 1/4; +10 0/4 | 6h: p50 1.70%; +5 1/4; +10 0/4 |
| delay_gt_30m | reclassified | 0 | 2 | 1h: p50 2.80%; +5 0/2; +10 0/2 | 3h: p50 3.36%; +5 0/2; +10 0/2 | 6h: p50 3.36%; +5 0/2; +10 0/2 |
| delay_gt_30m | active | 0 | 4 | 1h: p50 0.69%; +5 0/3; +10 0/3 | 3h: p50 2.19%; +5 0/3; +10 0/3 | 6h: p50 2.19%; +5 0/3; +10 0/3 |
| chase_gt_1pct | stop_loss | 2 | 30 | 1h: p50 1.59%; +5 3/28; +10 0/28 | 3h: p50 2.63%; +5 3/28; +10 1/28 | 6h: p50 2.69%; +5 3/28; +10 1/28 |
| chase_gt_1pct | bu_stop | 3 | 60 | 1h: p50 4.25%; +5 26/60; +10 6/60 | 3h: p50 6.22%; +5 39/60; +10 14/60 | 6h: p50 7.47%; +5 49/60; +10 16/60 |
| chase_gt_1pct | profit | 6 | 22 | 1h: p50 4.98%; +5 11/22; +10 9/22 | 3h: p50 14.21%; +5 18/22; +10 13/22 | 6h: p50 16.81%; +5 21/22; +10 19/22 |
| chase_gt_1pct | cancelled | 3 | 52 | 1h: p50 0.66%; +5 2/52; +10 0/52 | 3h: p50 1.22%; +5 4/52; +10 1/52 | 6h: p50 1.49%; +5 8/52; +10 3/52 |
| chase_gt_1pct | expired | 0 | 4 | 1h: p50 1.08%; +5 0/4; +10 0/4 | 3h: p50 1.39%; +5 1/4; +10 0/4 | 6h: p50 1.70%; +5 1/4; +10 0/4 |
| chase_gt_1pct | reclassified | 0 | 2 | 1h: p50 2.80%; +5 0/2; +10 0/2 | 3h: p50 3.36%; +5 0/2; +10 0/2 | 6h: p50 3.36%; +5 0/2; +10 0/2 |
| chase_gt_1pct | active | 1 | 3 | 1h: p50 0.68%; +5 0/2; +10 0/2 | 3h: p50 1.46%; +5 0/2; +10 0/2 | 6h: p50 1.46%; +5 0/2; +10 0/2 |
| chase_gt_2pct | stop_loss | 1 | 31 | 1h: p50 1.46%; +5 3/29; +10 0/29 | 3h: p50 2.61%; +5 3/29; +10 1/29 | 6h: p50 2.65%; +5 3/29; +10 1/29 |
| chase_gt_2pct | bu_stop | 1 | 62 | 1h: p50 4.51%; +5 28/62; +10 7/62 | 3h: p50 6.23%; +5 41/62; +10 15/62 | 6h: p50 7.47%; +5 51/62; +10 17/62 |
| chase_gt_2pct | profit | 2 | 26 | 1h: p50 4.35%; +5 11/26; +10 9/26 | 3h: p50 10.40%; +5 20/26; +10 14/26 | 6h: p50 16.67%; +5 23/26; +10 20/26 |
| chase_gt_2pct | cancelled | 1 | 54 | 1h: p50 0.66%; +5 2/54; +10 0/54 | 3h: p50 1.22%; +5 4/54; +10 1/54 | 6h: p50 1.49%; +5 8/54; +10 3/54 |
| chase_gt_2pct | expired | 0 | 4 | 1h: p50 1.08%; +5 0/4; +10 0/4 | 3h: p50 1.39%; +5 1/4; +10 0/4 | 6h: p50 1.70%; +5 1/4; +10 0/4 |
| chase_gt_2pct | reclassified | 0 | 2 | 1h: p50 2.80%; +5 0/2; +10 0/2 | 3h: p50 3.36%; +5 0/2; +10 0/2 | 6h: p50 3.36%; +5 0/2; +10 0/2 |
| chase_gt_2pct | active | 0 | 4 | 1h: p50 0.69%; +5 0/3; +10 0/3 | 3h: p50 2.19%; +5 0/3; +10 0/3 | 6h: p50 2.19%; +5 0/3; +10 0/3 |
| chase_gt_3pct | stop_loss | 1 | 31 | 1h: p50 1.46%; +5 3/29; +10 0/29 | 3h: p50 2.61%; +5 3/29; +10 1/29 | 6h: p50 2.65%; +5 3/29; +10 1/29 |
| chase_gt_3pct | bu_stop | 1 | 62 | 1h: p50 4.51%; +5 28/62; +10 7/62 | 3h: p50 6.23%; +5 41/62; +10 15/62 | 6h: p50 7.47%; +5 51/62; +10 17/62 |
| chase_gt_3pct | profit | 2 | 26 | 1h: p50 4.35%; +5 11/26; +10 9/26 | 3h: p50 10.40%; +5 20/26; +10 14/26 | 6h: p50 16.67%; +5 23/26; +10 20/26 |
| chase_gt_3pct | cancelled | 0 | 55 | 1h: p50 0.68%; +5 2/55; +10 0/55 | 3h: p50 1.23%; +5 5/55; +10 1/55 | 6h: p50 1.49%; +5 9/55; +10 3/55 |
| chase_gt_3pct | expired | 0 | 4 | 1h: p50 1.08%; +5 0/4; +10 0/4 | 3h: p50 1.39%; +5 1/4; +10 0/4 | 6h: p50 1.70%; +5 1/4; +10 0/4 |
| chase_gt_3pct | reclassified | 0 | 2 | 1h: p50 2.80%; +5 0/2; +10 0/2 | 3h: p50 3.36%; +5 0/2; +10 0/2 | 6h: p50 3.36%; +5 0/2; +10 0/2 |
| chase_gt_3pct | active | 0 | 4 | 1h: p50 0.69%; +5 0/3; +10 0/3 | 3h: p50 2.19%; +5 0/3; +10 0/3 | 6h: p50 2.19%; +5 0/3; +10 0/3 |

## Fixed temporal and single-entry sensitivities

Date split is fixed at **2026-09-20T00:00:00.000Z**: before versus on/after 2026-09-20 00:00 UTC. This is descriptive sensitivity, not a selected cutoff.

| Period | Feature | Strict cut | Measured / rows | Unknown fail-open | Removed / period rows | Removed by frozen status |
| --- | --- | --- | --- | --- | --- | --- |
| before_2026-09-20_utc | trigger_delay_minutes | >5m | 27/153 | 126 | 27/153 | SL 4; BU 6; profit 6; cancel 10; expired 1; reclass 0; active 0 |
| before_2026-09-20_utc | trigger_delay_minutes | >15m | 27/153 | 126 | 1/153 | SL 0; BU 0; profit 1; cancel 0; expired 0; reclass 0; active 0 |
| before_2026-09-20_utc | trigger_delay_minutes | >30m | 27/153 | 126 | 0/153 | SL 0; BU 0; profit 0; cancel 0; expired 0; reclass 0; active 0 |
| before_2026-09-20_utc | price_chase_pct | >1% | 27/153 | 126 | 9/153 | SL 1; BU 1; profit 5; cancel 2; expired 0; reclass 0; active 0 |
| before_2026-09-20_utc | price_chase_pct | >2% | 27/153 | 126 | 4/153 | SL 1; BU 0; profit 2; cancel 1; expired 0; reclass 0; active 0 |
| before_2026-09-20_utc | price_chase_pct | >3% | 27/153 | 126 | 3/153 | SL 1; BU 0; profit 2; cancel 0; expired 0; reclass 0; active 0 |
| on_or_after_2026-09-20_utc | trigger_delay_minutes | >5m | 34/35 | 1 | 33/35 | SL 7; BU 10; profit 2; cancel 9; expired 1; reclass 0; active 4 |
| on_or_after_2026-09-20_utc | trigger_delay_minutes | >15m | 34/35 | 1 | 0/35 | SL 0; BU 0; profit 0; cancel 0; expired 0; reclass 0; active 0 |
| on_or_after_2026-09-20_utc | trigger_delay_minutes | >30m | 34/35 | 1 | 0/35 | SL 0; BU 0; profit 0; cancel 0; expired 0; reclass 0; active 0 |
| on_or_after_2026-09-20_utc | price_chase_pct | >1% | 34/35 | 1 | 6/35 | SL 1; BU 2; profit 1; cancel 1; expired 0; reclass 0; active 1 |
| on_or_after_2026-09-20_utc | price_chase_pct | >2% | 34/35 | 1 | 1/35 | SL 0; BU 1; profit 0; cancel 0; expired 0; reclass 0; active 0 |
| on_or_after_2026-09-20_utc | price_chase_pct | >3% | 34/35 | 1 | 1/35 | SL 0; BU 1; profit 0; cancel 0; expired 0; reclass 0; active 0 |

Explicit frozen `entry_policy_version=single_entry_v1` rows: **48**; statuses: stop_loss 8; bu_stop 15; profit 6; cancelled 13; expired 2; reclassified 0; active 4. Policy-version and threshold sensitivity (including denominators) is in the JSON/CSV. Missing or older policy versions are not reclassified by date.

## Provenance and limits

- Statuses, entry values, cohort membership, and 15m forward-window summaries come only from the frozen 2026-10-01 06:02 UTC capture. No refresh was performed for statuses.
- Trigger close timestamp is immutable scanner-decision telemetry on 61 rows. Raw exact trigger OHLC was not persisted in those immutable entry snapshots; the existing local cache artifacts are 1h rather than 30m, so these 30m values are explicitly reconstructed from the public BingX historical candle endpoint after the event.
- The remaining 127 rows have no identifiable frozen trigger candle. Neither delay nor chase is guessed from a favorable or latest candle; they remain unknown and fail open in full-cohort retention counts.
- A fallback `entry_price` is kept distinct from `original_entry_price`; neither is labeled a verified exchange fill.
- No app code, live gate, schema, workflow, database state, or secret was changed. Production access was SELECT-only. This is retrospective sensitivity, not a claim of executable fills or prospective validated improvement.

## Reproduction inputs

- `trigger-chase-analysis-2026-10-01.mjs`
- `trigger-chase-immutable-snapshot-select-2026-10-01.sql`
- `trigger-chase-frozen-cohort-2026-10-01.json`
- `trigger-chase-frozen-metadata-2026-10-01.json`
- `trigger-chase-frozen-horizon-windows-2026-10-01.csv`
- `trigger-chase-retrieved-immutable-snapshot-metrics-2026-10-01.json`
- `trigger-chase-bingx-public-exact-30m-bars-2026-10-01.json`

Run `node .local/reports/ib-entry-structure-2026-10-01/trigger-chase-analysis-2026-10-01.mjs` to regenerate the report outputs from those saved inputs. The script itself does not call a database or the network.
