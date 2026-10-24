---
name: Bullish Accumulation p24h calibration
description: Evidence and telemetry policy for the bullish_accumulation p24h entry gate.
---

Do not add another Bullish Accumulation hard gate or tighten its exits from the
current outcome sample. The p24h > 5% entry cap now records one rejected
near-miss per symbol and 12-hour window, with forward-price observations after
6 and 24 hours.

**Why:** The current post-gate cohort is too small for reliable threshold
changes. Historical high spot volume and bearish CVD slices have no profit
outcome but each has only five or six cases. Smart-cancelled BA positions also
showed meaningful later recoveries, so tightening exits would risk cutting
valid moves.

**How to apply:** Reassess the p24h cap after a sufficiently large measured
near-miss cohort. Keep the new telemetry idempotent across workers and treat
the observations as missed opportunities, not traded P&L. Do not infer a
spot-taker gate for BA from the present small, counterintuitive sample.

## Confirmation-route parity

The OI Watch confirmed-fire route must enforce the same BA p24h cap as the
ordinary scan route. It can otherwise broadcast a confirmed candidate directly
after its waiting window while bypassing the main calibration gates.

**Why:** Production can then simultaneously record high-p24h candidates as
rejected telemetry and create real BA positions with the same disallowed
market condition, making outcome statistics and live risk control unreliable.

**How to apply:** Before changing any BA threshold, compare every creation
route against the canonical gate set and repair route parity first; analyse
only signals that were subject to the same rule.

## Cancellation policy

BA must not use the generic smart-cancel path based on temporary negative spot
CVD. Its historic smart-cancel cohort had materially positive later movement,
while the stricter stale path is the only cancellation route retained alongside
the normal stop-loss and max-age safeguards.

**Why:** The generic smart-cancel exited early accumulation candidates on
transient spot weakness and repeatedly missed later continuations. The
BA-specific stale path requires a longer grace period and complete CVD/OI
evidence before it can close a signal.

**How to apply:** Do not re-enable BA smart-cancel without a new replay that
shows the trade-off against the retained stale policy. When analysing a
post-cancellation result, only treat a 72-hour snapshot as exact when its
observation timestamp is close to 72 hours after closure; older backfilled
rows are later observations, not historical 72-hour prices.