# PLM lifecycle audit — frozen cohort 2026-10-01

## Scope and reproducibility

- Read-only audit. No scanner, application, production data, workflow, or deployment changes were made.
- Frozen input: `.local/reports/plm-cohort-2026-10-01.csv` (168 rows), SHA-256 `bca5f118644f9f9b6484ff7a2530c7d792eb6f48dd148175ba60646d66e2e2c3`; cohort/status cut `2026-10-01 04:36:43.459443Z`.
- Every cohort row linked to one fired PLM snapshot. Persisted source split: 79 `tracked_signals_legacy`, 89 `tracked_signals`; 162 trajectories complete, 5 partial, 1 with no bars. Latest cohort candle: `2026-10-01 01:00Z`, before the frozen cut.
- Basis is `original_entry_price` when positive, otherwise the frozen CSV `entry_price` (65/103 rows). This intentionally does not use split-average or snapshot entry price; 31 snapshot basis values differ.
- Status, close time, recorded peak and PnL remain frozen CSV values. Separate forward 72h prices use persisted 15-minute OHLC including after-exit candles. Every incomplete path is censored: unobserved threshold is unknown, not a miss.
- First-hit timestamps have 15-minute candle resolution; OHLC cannot establish exact intrabar crossing time.

## Main findings — peak is the objective

- **Recorded cohort peak:** 60/168 (35.7%) reached at least +10% from selected entry basis; all 60 are closed (60/162, 37.0% of closed). They comprise 42 `profit`, 17 `bu_stop`, and 1 `expired`. No stop-loss or cancelled row recorded +10%. Strong entry remains strong regardless of later B.U., cancellation, or PnL.
- **Fixed 72h MFE:** among 162 complete 288-bar paths, +10% was touched by 81 (50.0%), +20% by 48 (29.6%), +30% by 31 (19.1%). Median MFE +10.09%; p10 +0.87%, p90 +47.86%. Median MAE -7.81%.
- Five paths are partial (144, 72, 48, 24 and 24 bars) and one active row has no bars. No partial path observed +10/20/30%; these are **unknown**, not failures. Complete paths include one row still active at the snapshot; its lifecycle label stays frozen.
- Among complete paths, median time from detection to first +10% was 13.21h (IQR 3.67–24.42h); +20% 22.03h; +30% 27.46h. These use candle timestamps, not exact intrabar times.

### Post-close movement (secondary lifecycle diagnostic)

138 closed rows had a complete entry+72h horizon and at least one 15m bar strictly after close. In those windows, 58/138 touched +10%, 37/138 +20%, and 29/138 +30% from the original chosen basis. Twenty of the +10% post-close rows had not reached +10% on their frozen recorded peak before closure: 2 stop-loss, 1 cancelled, 17 B.U. stop. This is a path diagnostic, not a claim of executable returns or evidence about the current policy.

| Frozen status | N | Recorded peak ≥10% | Complete 72h paths | Complete 72h MFE ≥10/20/30 | Post-close evaluable | Post-close MFE ≥10/20/30 | Median realized PnL |
|---|---:|---:|---:|---:|---:|---:|---:|
| Cancelled | 5 | 0 | 5 | 1/1/0 | 5 | 1/1/0 | -1.06% |
| Profit | 42 | 42 | 42 | 42/30/18 | 40 | 31/20/16 | 11.01% |
| Stop-loss | 33 | 0 | 33 | 2/1/1 | 28 | 2/1/1 | -8.31% |
| B.U. stop | 68 | 17 | 67 | 35/15/12 | 65 | 24/15/12 | 0.00% |
| Expired | 14 | 1 | 14 | 1/1/0 | 0 | 0/0/0 | 1.43% |
| Active | 6 | 0 | 1 | 0/0/0 | 0 | 0/0/0 | — |

- Post-close denominator: 138. Another 23 closed complete paths had no post-close bar within the entry+72h window; one closed partial path has no observed threshold and remains censored. Active rows have no close-based window.
- Two stop-losses later exceeded +10% after close: **ID 1056 ON-USDT** (post-close MFE +19.34%; first +10% bar `2026-07-29 13:00Z`) and **ID 1278 PORTAL-USDT** (+31.47%; first +10% bar `2026-08-26 05:00Z`). Both were below +10% on frozen recorded peak before close. These are lifecycle misses, not a retuning recommendation.
- One historical cancellation later exceeded +10%: **ID 1253 SEI-USDT** (recorded peak +0.62%, post-close MFE +20.68%). All five cohort cancellations have `stale_oi_vol`; current PLM automatic cancellation is disabled. Do not treat these as current-policy cancels.
- Of 68 B.U. stops, 17 were already recorded ≥10% strong before closure. Among 65 evaluable post-close windows, 24 touched +10%; 7 overlap previously recorded strong peaks and 17 were new +10% movers after close. One more B.U. path is partial and censored.

## Cohort and descriptive month split

| Close month (Dubai, UTC+04) | N | Recorded peak ≥10% | Stop-loss | B.U. stop | Cancelled | Expired | Profit |
|---|---:|---:|---:|---:|---:|---:|---:|
| 2026-07 Dubai | 3 | 1 (33.3%) | 1 | 0 | 1 | 0 | 1 |
| 2026-08 Dubai | 62 | 23 (37.1%) | 11 | 30 | 4 | 3 | 14 |
| 2026-09 Dubai | 97 | 36 (37.1%) | 21 | 38 | 0 | 11 | 27 |

August and September each show 37.1% recorded ≥10% peaks (23/62 and 36/97). This is descriptive only, not a temporal holdout or evidence of stable/changed gate quality. Outcome mix and observation coverage are not randomized or matched.

### Policy-version and immutable-metric coverage

- Frozen CSV labels: 147 rows have no `entry_policy_version`; 21 are tagged `single_entry_v1` (15 closed, 6 active). `policy_version` is empty for all 168.
- Nested `decision_metrics` occurs in 38/168 fire snapshots: 21 tagged plus 17 unversioned. All 21 tagged rows include non-null p24h, p3h, Spot Volume, at least one Netflow and all four CVD fields. Of 17 unversioned captures, 14 include these values; 3 lack Spot Volume. 130 rows have no nested object.
- The 147 unlabeled rows span 79 `tracked_signals_legacy` and 68 `tracked_signals`. Snapshot source is not gate version. Do not reconstruct absent metrics or assign historical p24h reason strings to the present gate.
- Current PLM contract (`.agents/memory/price-led-momentum.md`): 24h change 5–15%; 3h 1.5–4%; decision-time Spot Volume ≥1.1x; positive Spot Netflow on 1h or 4h; at least two positive Spot CVD values among 15m/30m/1h/4h. OI, Futures Taker, Whale Index, OI/futures ratios and cycle count are telemetry only. The 21-row version-tagged sample is small and not a holdout; no threshold inference is warranted.
- Within the 21 `single_entry_v1` rows, 15 have complete 72h paths and 9/15 have 72h MFE ≥10%; six paths are incomplete (five partial, one no bars). This is descriptive, not a prospective test.

## Rejected/blocked inventory — not independent trades

Read-only production query captured around 2026-10-01 04:49Z returned 110525 raw events: 110435 rejected and 90 blocked. Raw events repeat symbols/reasons across 12h logging buckets and are not independent opportunities.

A separate PLM decision-inventory query around 04:51Z counted 171 fired rows (86 `tracked_signals` complete, 6 `tracked_signals` partial, 79 `tracked_signals_legacy` complete), 90 blocked rows, and 1 each `oi_watch_reconciliation` expired/watching row. Rejected trajectory status at that extraction was 24,615 complete, 1,909 partial, 83,911 unavailable; these status fields are asynchronously backfilled and can shift on rerun. The extraction is archived in [decision inventory CSV](./plm-lifecycle-decision-inventory-2026-10-01.csv).

| Normalized reason group | Raw events |
|---|---:|
| legacy_unstamped_p24h_range | 66647 |
| p24h_low | 10355 |
| p3h_low | 17536 |
| p3h_high | 2260 |
| p24h_high | 2378 |
| cvd_count_lt2 | 2503 |
| snf_negative_1h | 4997 |
| spot_vol_low | 854 |
| spot_vol_unavailable | 2891 |
| confirmed_fire_other | 104 |

The `p24h_range=...` class alone has 66647 records but no persisted live PLM p24h/p3h/Spot Volume/Netflow/CVD decision fields. Treat as legacy/unversioned, not a test of current thresholds. Per-reason metric-key and trajectory coverage is in [gate event CSV](./plm-lifecycle-gate-events-2026-10-01.csv). Live trajectory status can be asynchronously backfilled; the CSV archives this extraction.

### Symbol-day deduplication of rejected/blocked events

- Dedup key: `(symbol, UTC calendar day)`. Select the earliest event with positive `entry_price`; no-positive-price days remain unknown, not zero-price opportunities. Ties use `decision_at`, then snapshot ID.
- 110,525 raw events reduce to 11,238 symbol-UTC-days across 607 symbols: 10,527 have a positive entry price and 711 do not. Earliest priced rows have 2,604 complete, 243 partial and 7,680 unavailable trajectories at extraction. This is not 10,527 independent trades.
- Selecting earliest positive-price event avoids suppressing a later same-day price-valid event when an earlier record has no price. Reproducible SQL explicitly counts no-price-only days separately.
- The dominant unversioned reason group is not a gate-quality or missed-trade estimate.

## Interpretation and boundaries

- Lead objective is peak movement, not realized closing PnL. Recorded peaks and fixed 72h MFE are separate windows. PnL is secondary.
- MFE/MAE and post-close measures are 15m OHLC path statistics, not fills or executable returns; they do not reconstruct slippage, liquidity, or intrabar sequence.
- Historical stop/cancel crossings are outcomes only. Current PLM automatic cancellation is `false`; normal trading exits remain independent. Existing positions/outcomes remain unchanged.
- No gate sweep, optimization, or out-of-sample claim was performed. Historical rows are not an immutable current-gate cohort; even the 21 version-tagged rows are small and descriptive.

## Artifacts

- [Row-level 168-path CSV](./plm-lifecycle-cohort-paths-2026-10-01.csv)
- [Machine-readable JSON](./plm-lifecycle-audit-2026-10-01.json)
- [Raw reject/blocked event CSV](./plm-lifecycle-gate-events-2026-10-01.csv)
- [Global decision inventory CSV](./plm-lifecycle-decision-inventory-2026-10-01.csv)
- [Earliest priced symbol-UTC-day CSV](./plm-lifecycle-earliest-priced-symbol-days-2026-10-01.csv)
- [Reproducible read-only SQL](./plm-lifecycle-audit-queries-2026-10-01.sql)
- Production read-only inventory queries use `pattern_decision_snapshots`; path query uses `pattern_backfill_candles` (`interval=15m`). No database writes were run.