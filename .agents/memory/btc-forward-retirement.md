---
name: BTC Forward retirement
description: BTC Forward outcome tracking is retired while BTC price observations remain
---

The separate BTC Forward view and its 1h/4h/24h outcome calculations are retired. Do not resume forward-return resolution, show forward summaries, or expose these summaries in the BTC-analysis response. Existing historical results need not be deleted.

**Why:** After retiring BTC Spot Net Flow and its correlation view, the user explicitly asked to remove BTC Forward as well.

**How to apply:** Continue the independent BTC price observations that supply market history, latest price, and daily market context. Do not treat this request as retiring BTC price, BTC.D, or other BTC-context features.