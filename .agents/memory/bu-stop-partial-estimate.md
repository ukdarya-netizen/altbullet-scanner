---
name: B.U. stop partial estimate
description: Rules for displaying the modelled partial-take contribution of protected B.U. exits.
---

For a B.U. STOP with a recorded milestone, the optional estimate is `20% × last milestone + 80% × 0%`. If no milestone was recorded, the estimate is unavailable rather than zero.

**Why:** The system does not have real user fills or partial-close sizes. The estimate is useful as a separate scenario, but must never replace the factual protected exit of 0% on the remaining position.

**How to apply:** Treat the estimate as observational only. Never include it—or the underlying `bu_stop` row—in raw/net PnL, averages, profit, loss, calculator fees, quality statistics, or frozen monthly archives. Keep only the separate outcome count and established win-rate role.

For personal exit-strategy comparisons, a B.U. row's 0% protected remainder is not a 0%-return *whole trade*. A partial take at a reached milestone can make the whole trade profitable; model candidate strategies with explicit partial-fill fractions on B.U. rows and keep those hypothetical gains separate from recorded PnL. Actual personal profit remains unknown without execution records.

**Why:** Treating every B.U. row as economic zero understated repeated +5–10% moves and gave misleading advice about partial profit-taking.

**How to apply:** Show B.U. target reach and modeled partial proceeds alongside the cost of taking the same partials from larger winners. Never call the logged remainder-only 0% or an unverified estimate the user's actual whole-position return.