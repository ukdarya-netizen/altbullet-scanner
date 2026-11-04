---
name: Trade exit policies
description: Index of protected-exit, trailing, legacy-runner and trade-outcome rules
---

Read the relevant topic before changing trade closure or reporting:

- [B.U. stop floor](bu-stop-pnl-floor.md) — durable +10% peak grants +5% protection.
- [Partial milestone estimate](bu-stop-partial-estimate.md) — estimate is separate from raw PnL and archives.
- [B.E. peak recovery](bu-stop-peak-recovery.md) — persisted peak protection precedes ordinary stop-loss.
- [Expired vs breakeven](expired-vs-breakeven.md) — lifetime close has its own outcome and actual PnL.
- [Status display names](trade-status-display-names.md) — user-facing protected exits and expiries have stable labels.
- [Trailing replay](trailing-replay-policy.md) — compare the full closed cohort and exclude ambiguous fills.
- [Trailing gap](trailing-gap-percentage-points.md) — subtract gap from peak in percentage points.
- [Profit-lock direction](profit-lock-shadow-directionality.md) — use direction-aware peaks and virtual locked fills.
- [Realtime trailing fence](realtime-trailing-lifecycle-fence.md) — generation-fence stale callbacks and finish claimed closures consistently.
- [BTC legacy runners](btc-exits-legacy-runners.md) — partially closed runners retain their previous contract.
- [Stop-loss calibration](stop-loss-drawdown-calibration.md) — do not globally reduce the stop on early extrema alone.
- [Impulse Buy runner](impulse-runner-exit-policy.md) — new core+runner positions do not retrofit legacy positions.

**Why:** New exit rules must not silently change historical positions, frozen results or the meaning of reported PnL.

**How to apply:** Follow the individual policy for the pattern and closure path being changed.