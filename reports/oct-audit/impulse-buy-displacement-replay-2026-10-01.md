# Impulse Buy 4h displacement replay — 2026-10-01

**Read-only production cohort:** 48 rows; exact `sentiment_key=impulse_buy`, `policy_version=impulse_runner_v1`, and `entry_policy_version=single_entry_v1`. Detection period: 2026-09-17T12:37:41.017Z to 2026-10-01T03:06:29.114Z.

**Candle acquisition:** 0 cached rows; 48 fetched from the public BingX endpoint; 0 rows lack a valid, fresh, sufficient, gap-free 4h history. No private endpoint, secret, DB write, app change, or trading-rule change.

## Fixed replay definition and evidence boundaries

The primary feature is exactly the archived `ict_imbalance_displacement_recent` predicate: `buildIctEvents` → any `imbalanceDisplacement` event among `ictRows.slice(-6)` (the last six closed 4h bars, nominally 24 hours). The unchanged event rule is a three-candle non-overlap plus absolute current candle body ≥ 0.2 Wilder ATR(14); the engine allows either bull or bear direction. No threshold or window was tuned. Displacement events are stamped at candle close.

Every bar passed to the engine closes at or before the stored detection time; minimum history is the same 18-bar ICT source minimum used by `run.mjs`; history must be contiguous and the latest close must be less than one 4h interval old. Excluded still-open/future-close bars are counted. A missing, stale, gapped, invalid, or short history is **unknown and fail-open**, never a negative.

Causal 4h conventional candle-shape snapshots: 48/48 (27 captured at signal, 21 historically reconstructed, 0 provenance unknown). Captured displacement-event flags: 0/48. Reconstructed, valid historical displacement replay: 48/48. Reconstructed values are not entry-known/captured facts: all rows explicitly carry entryKnownClaim=false.

## Fixed-cohort outcomes

| Measure | Result |
|---|---:|
| All comparable entries | 48 |
| Completed with actual recorded PnL (cancellations included) | 44 |
| Active, right-censored | 4 |
| Entered cancellations included in completion denominator | 13 |
| Actual realized PnL >10% | 6/44 (13.6%) |
| Peak ≥10% (secondary; valid peak basis) | 12/44 (27.3%) |
| Exact stop_loss | 8 |
| B.U. closures (actual PnL retained) | 15; PnL sum 5.000%, range 0.000% to 5.000% |
| B.U. with actual recorded PnL +5…<10 | 1 |
| B.U. that peaked +5…<10 | 11 |

All statuses: active=4; bu_stop=15; cancelled=13; expired=2; profit=6; stop_loss=8. Actual PnL is never forced to zero by status; nonzero B.U. PnL remains intact.

Data-quality caveat: the raw tracker-PnL >10% count includes AERO-USDT (expired, tracker +20.665%; runner state/exit/PnL unavailable). Keep it in the raw tracker count but do not call it a verified runner settlement.

## Feature coverage and group outcomes

History coverage: 48/48; missing: {}.

| Group | Rows | Completed with PnL | Realized >10 | Peak ≥10 | Stops | B.U. | B.U. peak +5…<10 |
|---|---:|---:|---:|---:|---:|---:|---:|
| Known positive (undirected) | 30 | 28 | 5 | 8 | 5 | 9 | 7 |
| Known negative (undirected) | 18 | 16 | 1 | 4 | 3 | 6 | 4 |
| Bullish event present (secondary) | 24 | 22 | 4 | 7 | 4 | 7 | 5 |
| Bearish event present (secondary) | 7 | 7 | 1 | 1 | 1 | 2 | 2 |

Known event-positive detections span 2026-09-17T12:37:41.017Z to 2026-09-30T12:07:06.051Z; known negatives span 2026-09-18T07:35:28.632Z to 2026-10-01T03:06:29.114Z. Both groups are compared inside the exact cohort dates, but are observational and not date-matched pairs; their time spans are included to expose temporal imbalance.

All undirected positive/negative groups are drawn from the same exact 48-entry matched production period above; each group’s own timestamp span is carried in JSON so clustering or calendar imbalance stays visible. The previous 45-row cohort cannot be date-matched because its archived summary has no member timestamps.

## Captured versus reconstructed snapshot provenance

| Existing conventional 4h shape provenance (not displacement capture) | Entries | Replay available | Undirected displacement positive | Realized >10 |
|---|---:|---:|---:|---:|
| Captured at signal | 27 | 27 | 13 | 1 |
| Historical reconstruction | 21 | 21 | 17 | 5 |
| Unknown / unavailable | 0 | 0 | 0 | 0 |

## Hypothetical fixed displacement gate (not a recommendation)

Retaining positive events plus unknown/fail-open rows removes 18/48 rows (37.5%). It retains 5/6 realized >10% outcomes (83.3%), and 8/12 peak-≥10% movers (66.7%). Removed outcomes include 3 exact stops, 6 B.U.s, 5 entered cancellations, and 4 B.U. positions whose *peak* reached +5…<10%.

A peak is unrealized opportunity, not a realized win. `B.U. peak +5…<10` is calculated from peak price/original entry; actual canonical B.U. PnL is kept separately above and in the row-level JSON/CSV.

## Chronological 70/30 split

Sorted by detected_at then tracked id; earlier split has 34 rows (2026-09-17T12:37:41.017Z to 2026-09-25T18:06:42.040Z), later holdout has 14 (2026-09-26T11:06:57.791Z to 2026-10-01T03:06:29.114Z).

| Split | N | Known | Unknown | Event-positive >10 | Event-negative >10 |
|---|---:|---:|---:|---:|---:|
| Earlier 70% | 34 | 34 | 0 | 5/23 | 0/11 |
| Later 30% | 14 | 14 | 0 | 0/5 | 1/5 |

This temporal split is descriptive, not an adequately powered independent validation. Training does not tune the event rule.

## Direction and archived-baseline comparison

In this replay: 30 signals have any event; 24 have bullish, 7 bearish, and 1 both directions in the six-bar window. Direction-specific outcome cells appear separately in the JSON and CSV; the primary predicate remains undirected.

The prior non-random 45-row baseline remains separate: undirected 4h event 10/29 >10% versus 2/16 without it (12 strong outcomes total). The archived report/CSV preserves only the binary event feature, not the 45 member rows, their dates, or event-direction ledger; it therefore cannot be matched on period or show whether bearish events occurred in that prior 29-row positive group. A bullish-only comparison to that baseline is not identifiable and is not made.

## Symbol and BR sensitivity

Completed outcomes contain 39 distinct symbols; the largest per-symbol completed count is 2. BR-USDT has 1 rows and 0 strict >10% rows. Excluding BR leaves 6 strict >10% outcomes (change −0) and 12 peak-≥10% outcomes (change −0); corresponding gate sensitivities are in JSON.

## Verdict

**No production gate change.** The result is observational and small, cohort selection is non-random, the event is reconstructed rather than captured, scanner gate revisions are not separately stamped by `single_entry_v1`, and no independent forward validation supports the user's >90% realized-strict->10% objective. The archived 45-row association is not randomized and has no recoverable member/direction ledger. Unknowns remain fail-open.

This audit executed 48 successful bounded public candle fetches, with an explicit cap of 48 HTTP attempts total (including retries). The output JSON embeds the immutable production-row export and all validated pre-detection OHLC candles used, so the replay can be rerun offline.

### Missing / invalid histories

None.
