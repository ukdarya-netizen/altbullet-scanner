# Impulse Buy — lifecycle and evidence audit

Production read-only snapshot: 2026-10-01, approximately 03:46–04:00 UTC. Trade timestamps are stored without timezone and interpreted as UTC; monthly reports use Asia/Dubai. No live rules or database records changed.

## Outcome definitions

- Primary quality target: canonical recorded realized PnL strictly greater than +10%; a +10% peak is not a successful realized exit.
- Neutral `reclassified` records are excluded; active/in_run records are censored, not losses.
- Canonical stamped runner PnL is runner-only, not 80/20 allocation-weighted portfolio return. This audit does not claim actual exchange fills, fees, slippage, or a deposit return.
- Runner breakeven emergency protection applies after core close. It is not a zero-loss stop for the whole original trade.
- Old generic cancellations, current impulse-specific cancellations, legacy entry policies and single-entry runner positions are separate cohorts.

## Matured entries after 2026-09-11 14:50:31 UTC

| Entry/exit cohort | Completed | Realized >10% | Sum of individual PnL percentages | Mean | Median | Peak >=10% | Peak >=10%, realized <=10% |
|---|---:|---:|---:|---:|---:|---:|---:|
| Unstamped legacy | 3 | 0 | -1.534 | -0.511 | 0 | 1 | 1 |
| Runner, older entry model | 18 | 1 | +98.122 | +5.451 | -1.025 | 5 | 4 |
| Runner, single_entry_v1 | 44 | 6 | +91.462 | +2.079 | 0 | 12 | 6 |

The older-entry runner cohort's mean falls to -2.705% excluding BR. The single-entry cohort's mean excluding both BR entries is +2.333%. This is evidence that an average dominated by one earlier large winner must not justify additional entry gates.

The single-entry cohort has 6 PROFIT, 2 EXPIRED, 15 B.U., 8 STOP LOSS and 13 CANCELLED. Six completed positions realized >10%: ONE, PTB, UNI, PENGU, AERO and ARK. A further four positions were active at the first snapshot. Two EXPIRED outcomes exceed +10%, so counting only status PROFIT would miss them.

## Current impulse-specific smart cancellation

Thirteen current `impulse_smart_cancel_cvd` closures averaged -2.88% recorded PnL, with a mean closure age of 15.79h. Ten had a populated approximately 24h point follow-up, and eight had a 72h point follow-up at query time. Those sparse endpoint observations alone cannot establish TP-before-SL or executable returns.

For each cancelled position, select its most-covered fired decision snapshot and use stored 15m candles whose open is at/after cancellation and before cancellation +24h. Compare high >= original single-entry price *1.10 and low <= entry price *(1 - persisted stop_loss_pct/100). All listed persisted stop distances were 8%.

Nine positions have 96 consecutive 15m candles in that post-cancel window:

| Position | First +10% bar (UTC) | First -8% bar (UTC) | Maximum from entry | Minimum from entry |
|---|---|---|---:|---:|
| DASH | Not seen | Not seen | +4.87% | -7.34% |
| PUMP, September 18 | Not seen | Not seen | +4.29% | -5.11% |
| ENA, September 18 | September 19 08:15 | Not seen | +20.46% | -2.76% |
| VTHO | Not seen | September 19 03:45 | +2.87% | -8.22% |
| ENA, September 20 | Not seen | Not seen | +4.23% | -5.71% |
| FET | September 21 12:45 | Not seen | +16.18% | -2.22% |
| FARTCOIN | Not seen | Not seen | +0.45% | -6.15% |
| FLOW | Not seen | Not seen | +1.60% | -3.45% |
| SYN | Not seen | September 28 05:30 | -0.98% | -8.77% |

Thus this bounded replay finds two later +10% opportunities and two later -8% touches among nine adequately covered post-cancel windows. Neither is proof of the final outcome of keeping the position: existing breakeven, protection, runner and cancellation rules have not been fully replayed. The candle straddling cancellation is intentionally excluded, leaving an initial gap of at most 15 minutes. No exact exchange fill is inferred.

WIF has only 32 candles before the original decision's 72h horizon ends. Newer PUMP, ARB and MARSCOIN have 89, 24 and 21 candles respectively and are incomplete. They are not included in the nine-window denominator.

Do not remove smart cancellation globally from this sample. Its recovery cost deserves a separate fixed-policy shadow comparison; it also prevented exposure to continued downside in some cases.

## Backfill readiness at the first snapshot

- Current-source fired: 150 complete, 8 partial; legacy-source fired: 28 complete, 2 unavailable; one OI-Watch fired row unavailable.
- Rejected scanner decisions: 12,662 complete, 2,929 partial, 123,626 unavailable.
- Missed decisions: 1,612 complete, 153 partial, 35 unavailable.
- Complete fired trajectories contain 288 15m candles, i.e. 72h.

These are decision-row counts, not unique trades or independent market events. Repeated symbol/bar decisions and multiple fired identities must be deduplicated before inference. “Complete” means completion of the collection horizon, not coverage of a later cancellation +24h window. The normal runner lifetime can exceed the 72h trajectory horizon.

Post-decision OHLC supports path analysis, not reconstruction of unknown entry-known funding, volume baseline, CVD, or ICT structure. Final retained-entry comparisons require immutable feature parity, chronological validation, unknown handling, and policy strata.