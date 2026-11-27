# Stealth final study — 2026-11-01 to 2026-11-27

Run timestamp UTC: 2026-11-27T11:24:43.160Z. Production export cutoff: 2026-11-27T06:27:23.679Z.

## Scope and data boundaries
- A: all Stealth tracked signals in the export window; all signal metrics are from production bot tables only.
- B: every reconstructed 4H close above a computed 1D zone with the preceding 4H close at/below the zone; B metrics use BingX prices, production reasons, and Lucy volume only when already cached.
- Scan universe: 547 symbols from prior Stealth/ABNeon reports, production signal symbols, and D examples; unrelated cache symbols are excluded.
- C: B events reaching +10% before −8% within five days; CoinGlass was permitted only for these rejected champions.
- D: ERA, MAGMA, and symbols in her-coins.txt (ERA-USDT, MAGMA-USDT, OLAXBT-USDT, LYN-USDT, EVERLYN-USDT, BLESS-USDT); CoinGlass permitted only for these samples.
- No Auto Range calculations or fields were used. Absolute USD volume, liquidation, and market-cap values are omitted; derived metrics are percentages/ratios.
- Same-candle +10% and −8% touches are classified ambiguous. Events with less than five days of observed history remain open unless a threshold was reached.

## Production rows and coverage
- tracked_signals A: 496; signal_entry_extras: 496; vsa_entry_metrics: 482; wyckoff_entry_metrics: 492; signal_volume_colors: 492.
- stealth_abneon_shadow_candidates (neon-level): 175; selected pattern_decision_snapshots: 19472.
- scan_reject_log Stealth neon-level: 1757 rows, coverage 2026-11-24T07:34:02.539355Z to 2026-11-27T06:11:39.879712Z; this is not complete for Nov 1–23.
- Production logs: 313 lines, timestamp span 2026-11-27T08:01:46.190Z to 2026-11-27T08:11:57.671Z; matching symbol/candle evidence is included in reason_chain.
- Shared-key guard: fresh production-log windows checked at the start and through 2026-11-27T12:17Z; no scanner CoinGlass 429 appeared, so no five-minute production-429 pause was triggered.
- pattern_decision_snapshots.entry_metrics: not available in the existing export; a repeat read-only SELECT was canceled by the production replica ("canceling statement due to conflict with recovery"). Existing decision rows still include IDs, kinds, reasons, symbols and timestamps.
- stealth_hourly_snapshots: 12895 total, 2562 selected checkpoints; signal_trajectory_log 3437; signal_drawdown_extrema 496; signal_trailing_events 31; bu_stop_followup_snapshots 8965; signal_cancel_outcomes 0; missed_signals_log 0.
- Production export is fixed at the timestamp above; records written after that cutoff are not included.

## Cohorts
- A fired records: 496.
- B reconstructed events with no exact Neon-Level fired match: 1725 (pre-Nov15 984; Nov15 onward 741).
- B outcome over five days: champion 309, bad 1045, ambiguous 1, open 370.
- C rejected champions: 309. D breakout events: 15; examples.csv includes 18 rows including samples with no breakout.

## Comparison with the previous Stealth run
- The previous `stealth-tf-1118` run covered 2026-10-19 through 2026-11-18: 550 symbols, 2,441 4H intersections (239 bright M/W), and 10 live Stealth records matched to 4H events.
- In the overlapping 2026-11-01..2026-11-18 window, that file has 1,256 4H rows, 98 bright M/W. This run has 1,228 reconstructed 1D-zone B events: 188 champion, 855 bad, 184 open, and 1 ambiguous.
- This is not a like-for-like outcome comparison: the earlier run counted intersection/brightness and 24h/72h/7d paths; this run classifies five-day +10%-before−8% outcomes on reconstructed 1D-zone events. The new run adds a named outcome cohort; it does not establish that the earlier filter conclusion reversed.

## Data request counts
- BingX HTTP requests: 1833; HTTP/logical errors: 36; symbol-history failures: 36.
- BingX concurrency: peak 4, configured limit 4; klines reads reports/.cache first and requests only missing tails.
- CoinGlass HTTP attempts (including retries/429): 693; errors: 31; 429 responses: 0; successful responses: 662; empty responses: 22.
- CoinGlass scope: C + D only; 157 unique symbols considered; 662 missing series completed; 693 series were initially missing.

## Filter replay
- Recorded-vs-replayed mismatches: 558; unlogged rejections from replayed filters: 226. Full named rows are in filter_check.csv.
- Reason source window in production: scan_reject_log exists only from Nov24 07:34 UTC in this export; earlier rejection attribution relies on decision snapshots and durable queue records, and otherwise remains unrecorded.
- The detector was daily-zone based from Nov14; M/W Lucy gating from Nov15; durable 24h queue from Nov19; resistance-only zones from Nov21. Events before each date are not retroactively assigned that live filter.

## Samples and limitations
- D examples are in examples.csv. Any unsupported/missing BingX symbol is listed in errors.json and has no inferred candle outcome.
- Liq-%-of-market-cap remains blank when market cap is not present in the permitted bot/cache sources; missing_metrics.csv gives a row per metric and event.
- Zone age/touch readings are computed from daily price interaction with the selected zone; the bot does not persist a separate per-zone age counter.
- Selling-climax context uses the highest-volume bar in the 48 bars before the event; retest rows include depth and Lucy ratio/color when permitted aggregate data exists.
- BTC 4H EMA50 distance and same-UTC-day reconstructed breakout count are included in market context.
- 15m candles are used for passage and simulated exits; when both thresholds occur in one bar, passage is ambiguous. Exit variants are bar-based simulations, not a claim about exchange fill order.
- Deposit: [{"scenario":"B_current_filtered_full_period","trades_opened":32,"trades_skipped":1693,"final_balance_usd":86.75,"final_balance_pct":-91.325},{"scenario":"B_current_filtered_second_half","trades_opened":9,"trades_skipped":732,"final_balance_usd":902.73,"final_balance_pct":-9.727},{"scenario":"B_first_half_selected_out_of_sample:retest_zone_top_with_lucy_mw_volume__under_breakout_low__runner80_take10_trail30_30_5d","trades_opened":8,"trades_skipped":733,"final_balance_usd":1304.34,"final_balance_pct":30.434},{"scenario":"A_actual_bot_positions","trades_opened":10,"trades_skipped":486,"final_balance_usd":1000,"final_balance_pct":0}].
- First-half selected entry/stop/exit combo for second-half evaluation: {"entry":"retest_zone_top_with_lucy_mw_volume","stop":"under_breakout_low","exit":"runner80_take10_trail30_30_5d","training_period":"2026-11-01 through 2026-11-15 UTC","evaluation_period":"2026-11-15 through run UTC"}; components were selected independently, not as a joint optimization.
- Deposit uses $1,000 start, $100 isolated margin, 10x leverage, same-symbol exclusivity and available-margin accounting; fees/slippage are not modeled and this is not a signal-count limit.

## Recommendations supported by this run
- Review 558 mismatches and 226 unlogged replay failures by name in filter_check.csv before changing a live gate.
- The largest observed replayed failed-filter cohorts are listed in filters.csv; champion/bad/open membership is explicit there. No signal cap or time-based trade exit is proposed.

## Code references
- 1D zone implementation: artifacts/api-server/src/lib/stealth-abneon-detectors.ts:291–360.
- 4H crossing: artifacts/api-server/src/lib/stealth-neon-level-breakout.ts:215–247.
- Resistance requirement: artifacts/api-server/src/lib/scanner.ts:1106–1112.
- Lucy/Welkin M/W and 120-bar grey rule: artifacts/api-server/src/lib/abneon-volume-gate.ts:87–125; breakout colour: artifacts/api-server/src/lib/stealth-neon-level-breakout.ts:251–260.
- Durable queue, 24h TTL and volume rechecks: artifacts/api-server/src/lib/scanner.ts:611, 823–885, 1030–1073, 15682–15743.
- Entry window: the queue remains eligible until 24h after the breakout candle close (scanner.ts:611, 15720–15743); the 5/10/15-minute reads are separate.
- Same-symbol open-position guard: artifacts/api-server/src/lib/watcher.ts:2466–2481.
- Stealth stop −8%: artifacts/api-server/src/lib/watcher-config.ts:176–178.
- BE +8%, trailing profile and max watch: artifacts/api-server/src/lib/watcher-config.ts:232–249, 33; watcher.ts:8950–8952.
