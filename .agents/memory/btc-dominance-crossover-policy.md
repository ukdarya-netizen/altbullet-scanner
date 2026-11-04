---
name: BTC price and dominance crossover policy
description: Rationale for comparing the two units and deciding when a crossing notification is trustworthy.
---

BTC price in dollars and BTC dominance in percent cannot be crossed numerically or by the pixels of a dual-axis chart: axis scaling changes the apparent intersection. Compare both as percent changes from one immutable shared observation baseline, and show them on the same percentage axis.

**Why:** A visual dual-axis intersection would produce or erase alerts when the chart window or screen changes, without a market change. Sparse historical dominance readings can also make a line appear to cross through unobserved days.

**How to apply:** Only treat opposite-side changes on adjacent, paired, completed Dubai days as a confirmed crossing. Do not backfill alerts from before monitoring began; reconsider recent completed days when late genuine observations arrive. Informational charts must still show independently observed BTC prices when BTC.D is sparse or missing; do not gate one line's visibility or daily change on the other's availability. A dashed connector between sparse dominance readings may aid viewing but never confirms a crossing in the intervening days. Keep the original dollar price, dominance percentage and observation provenance visible separately. Do not send these observational alerts to Telegram.