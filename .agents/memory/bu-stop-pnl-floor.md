---
name: B.U. stop protected-exit semantics
description: Defines canonical price and raw-PnL treatment for ordinary BE and the universal +10% to +5% profit-stop promotion.
---

An ordinary `bu_stop` records its user-facing exit price as `entryPrice` and raw
PnL as `0%`. After a durable `+10%` peak, every active pattern promotes protection
to a PROFIT STOP at `entryPrice * 1.05` and raw PnL `+5%`. Patterns whose ordinary
BE begins at `+5%` still close at `0%` before reaching `+10%`; Bullish Accumulation
arms directly into the `+5%` profit stop at its `+10%` protection milestone. Do not
treat a sampled market price after a gap as an exit price or strategy PnL.

**Why:** The production shadow from 2026-08-25 had 63 completed virtual hits
across active patterns: the `+10% → +5%` rule helped 56, hurt 3, and added
189.96 percentage points versus actual closes. The signal system observes market
prices rather than a user's fills. It may see the market only after it has moved through entry, but the B.U. rule had
already protected the remaining position. Telegram guidance suggests partial
profit-taking, but does not provide a confirmed fill allocation, so a positive
partial-profit amount must not be invented.

**How to apply:** Normalize every protected closure and recovery path before
persisting or snapshotting. Once closed, Telegram, API, UI, trajectory snapshots,
and statistics must trust the persisted exit price and PnL; they must never infer
`+5%` merely from `sentimentKey=impulse_buy`. Startup correction must repair both
historical PnL and exit price, and API/UI boundaries need defensive normalization
for legacy rows. A `+5%` protected exit requires durable evidence that the
position reached `+10%`; pattern identity alone is insufficient.

When a B.U. STOP has a recorded milestone, present that level as “target
reached / partial fixation” alongside the protected `0%` remaining-position
PnL. For legacy rows without a milestone, say that the target level was not
recorded; never default them to `+5%`.

**Why:** The milestone makes the strategy event understandable without falsely
claiming a user-specific realized amount, while an assumed level would turn
missing telemetry into misleading performance data.

**How to apply:** Keep the milestone-based note separate from Raw/Net PnL and
WIN RATE on Tracker, Dashboard, history, and API consumers.

Impulse Buy follow-up messages must present its protection ladder in order. Before
the first milestone, show only “+5% not reached”; after +5%, show that BE is active
and +10% is next; only after +10% show the +5% profit stop. Never lead with “+10%
not reached” while +5% has not been reached.

**Why:** Showing the later promotion threshold first makes subscribers think the
earlier target was already completed, even when it was not.

**How to apply:** Any shared position-status formatter must resolve the next
Impulse Buy rung from durable milestone state rather than displaying its final
protection threshold by default.

Production may still record entry-price B.U. exits after a durable +10% milestone
across multiple active patterns, including closes attributed to the hard-protection
outbox branch. The cause is unresolved; the current source contract is not proof
of the code or the state seen by the worker at each historical close.

**Why:** Counting a recorded peak as either a realized >10% profit or an
automatic +5% protected fill would manufacture performance and obscure a
potential deployment or close-time race discrepancy.

**How to apply:** Compare the close-time milestone/peak, persisted exit price
and PnL, delivery branch, and actual deployed worker before changing exit rules
or repairing historical outcomes. Keep observed opportunities separate from
realized results.

Only an atomically captured prior row state can establish that +10% protection
was already durable when a B.U. close was claimed. A peak/milestone first written
by the closing update is a different observation; historical closes without
close-time evidence remain unknown, not retrospectively "verified."

**Why:** A later snapshot cannot distinguish a wrong protection calculation
from a concurrent or same-statement peak/milestone update. Reconstructing one
would make the planned forward comparison unreliable.

**How to apply:** Compare mismatches on the pre-close state and preserve the
post-close values separately. Include any subsequently reclassified rows in
anomaly review, while excluding them from normal trade-outcome statistics.