# Active pattern gate trajectory audit — 2026-09-13

## Decision

Do not change any live trading gate from this audit.

Production does not yet have representative 24h/72h trajectory coverage for
the fired and final-gate near-miss cohorts of every active pattern. The review
therefore stops at the evidence boundary: it records current coverage and the
next decision criteria, but does not tune gates automatically.

## Evidence contract

- Active pattern keys come from the canonical analytics allowlist:
  `liquidation_cascade`, `whale_watch`, `balanced_grind`,
  `stealth_breakout`, `neon_support_bounce`, `price_led_momentum`,
  and `impulse_buy`.
- Cohorts use immutable rows in `pattern_decision_snapshots`.
- Paths use post-decision 15-minute OHLC rows in
  `pattern_backfill_candles`.
- Repeated reject checks are deduplicated by pattern, symbol, decision kind,
  normalized reason, and 12-hour opportunity bucket.
- A path counts as covered at 24h or 72h only when its final candle reaches
  the corresponding decision-time horizon.
- TP/SL ordering uses first candle touching +10% or -10%. A same-candle touch
  is ambiguous and must not be forced into either outcome.
- Missing immutable entry prices are unknown, not reconstructed.

## Production coverage

Snapshot taken at approximately 2026-09-13 18:00 UTC.

Production contained 1,492,950 decision snapshots, but only 56,094 backfill
candles covering 242 distinct snapshots. The candle range was
2026-07-14 16:30 UTC through 2026-09-13 07:00 UTC.

| Pattern | Cohort | Independent opportunities | 24h covered | 72h covered |
|---|---:|---:|---:|---:|
| Balanced Grind | fired | 6 | 0 | 0 |
| Balanced Grind | final-gate near miss | 593 | 0 | 0 |
| Impulse Buy | fired | 105 | 25 | 3 |
| Impulse Buy | final-gate near miss | 58 | 0 | 0 |
| Liquidation Cascade | fired | 28 | 0 | 0 |
| Liquidation Cascade | final-gate near miss | 42 | 16 | 13 |
| Neon Support Bounce | fired | 3 | 0 | 0 |
| Neon Support Bounce | final-gate near miss | 0 captured | 0 | 0 |
| Price-Led Momentum | fired | 53 | 6 | 0 |
| Price-Led Momentum | final-gate near miss | 6,149 | 14 | 6 |
| Stealth Breakout | fired | 15 | 1 | 0 |
| Stealth Breakout | final-gate near miss | 4,678 | 4 | 3 |
| Whale Watch | fired | 22 | 0 | 0 |
| Whale Watch | final-gate near miss | 110 | 0 | 0 |

The largest decision-grade 72h near-miss cohort is Liquidation Cascade with
13 paths. No active pattern has both a representative fired cohort and a
representative near-miss cohort at 72h. Most apparent completed reject
coverage belongs to sampled lower-value rejects, which cannot substitute for
the final-gate cohort being evaluated.

## Preliminary outcomes are not gate decisions

The small completed cohorts show why waiting matters:

- Liquidation Cascade near misses: 13 covered at 72h; 5 reached +10% before
  -10%, and 4 reached -10% before +10%. Average 72h MFE was +10.04% and
  average 72h MAE was -10.49%.
- Price-Led Momentum near misses: 6 covered at 72h; 5 reached +10% first and
  1 reached -10% first. This is directionally interesting but too small and
  too selected to relax a gate.
- Stealth Breakout near misses: 3 covered at 72h; 2 reached +10% first and
  none reached -10% first. This is not enough to reverse the existing
  frozen-level replay decision.
- Impulse Buy fired: only 3 covered at 72h, all touching -10% before +10%.
  The cohort is too small and is dominated by older decisions.

These numbers are observational. They do not justify gate changes.

## Balanced Grind and Liquidation Cascade

### Balanced Grind

- Only 6 immutable fired opportunities exist in the current trajectory
  system, with no complete 24h or 72h path.
- The 593 p24h final-gate near misses also have no complete 24h or 72h path.
- September frequency is therefore measurable, but the quality of candidates
  removed by the p24h gates is not.
- Keep the current p24h and OI gates unchanged. The prior attribution remains
  the working explanation: the frequency collapse is mainly associated with
  the early OI30m regime, while p24h reject replay is still non-decision-grade.

### Liquidation Cascade

- September has 28 immutable fired opportunities, but none has a complete
  24h or 72h trajectory in the universal backfill yet.
- The linked September tracked cohort currently has 28 signals: 5 PROFIT,
  3 STOP LOSS, 5 EXPIRED, 1 CANCELLED, and 6 still open. Closed average PnL is
  +5.88%; average PROFIT size is +15.67%.
- This is consistent with the earlier finding that September weakness is
  more about smaller winners than a major frequency collapse.
- The 13 completed 72h near-miss paths are mixed, so they do not support
  removing the negative spot-taker gate or adding another gate.

The universal immutable system has no comparable August fired linkage for BG
or LC. An August-versus-September gate-quality claim from these tables would
therefore mix provenance and introduce survivorship bias. Historical tracked
results may describe realized performance, but they cannot replace immutable
decision-time reject trajectories.

## Readiness rule for the next review

Re-run the gate decision only when every active pattern being changed has:

1. a meaningful 72h fired cohort and a meaningful 72h final-gate near-miss
   cohort (use 20 as the minimum review floor, not an automatic significance
   claim);
2. high coverage within the eligible, old-enough cohort, rather than a small
   completed convenience sample;
3. exact decision-time entry price and required gate metrics;
4. TP-before-SL, MFE, and MAE reported separately;
5. BG and LC compared on equal calendar windows for frequency, winner size,
   and outcome mix.

Any eventual gate change must be opened as a separate data-driven decision.
This audit does not authorize automatic threshold adjustment.