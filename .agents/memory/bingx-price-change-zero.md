---
name: BingX priceChangePercent returns 0 for low-volume tokens
description: BingX futures ticker sometimes returns "0" for priceChangePercent, overwriting correct lastPrice24h in prescanTracker
---

**Rule:** Never unconditionally overwrite `lastPrice24h` from BingX `priceChangePercent`. Use `price24h || existing.lastPrice24h` to preserve the last non-zero value.

**Why:** BingX perpetual futures API (`/openApi/swap/v2/quote/ticker`) returns `priceChangePercent = "0"` for tokens with near-zero futures volume or during 24h window reset moments. `parseFloat("0") = 0`, which is falsy. The old code `existing.lastPrice24h = price24h` would overwrite a correct value (e.g., +15%) with 0, making the prescan table show "0.0%" forever until a non-zero tick arrived. This also broke `logOverheatedTokens` since tokens showing 0% wouldn't pass the `p24h > 40` gate.

**How to apply:**
- All 3 prescanTracker update loops (L1 at ~line 2551, L3/L4/L8 at ~line 2594, WL at ~line 2626) use:
  ```javascript
  existing.lastPrice24h = price24h || existing.lastPrice24h;
  ```
- `firstPrice24h` at initial `.set()` keeps the raw value (no previous to fall back to; gets corrected next cycle).
- JavaScript `-0` is also falsy, handled correctly by this pattern.
- Edge case: token genuinely flat for 24h (real 0%) will show stale value — acceptable vs. showing 0 when it shouldn't.
