---
name: BingX batch funding rate endpoint
description: /openApi/swap/v2/quote/premiumIndex without symbol returns ALL contracts' funding rates in one call.
---

## Rule
Call `/openApi/swap/v2/quote/premiumIndex` without a `symbol` parameter to get funding rates for **all** BingX futures contracts in a single response.

**Why:** Per-symbol `getFundingRate(sym)` calls are too expensive when you need rates for 100+ tokens (e.g. growth_leader_log scan batch). The no-symbol version returns `data: BingXFundingRate | BingXFundingRate[]` — handle both shapes (Array.isArray check).

**How to apply:** Use `getAllFundingRates()` in `bingx.ts` whenever you need funding rates for many symbols at once. Returns `Map<symbol, rawDecimalRate>`. Falls back to empty Map on error — never throws.
