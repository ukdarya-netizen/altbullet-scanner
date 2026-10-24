---
name: New patterns batch — exchange_outflow_accum / oversold_reversal / smart_money_divergence
description: Implementation notes for Task 19 three-pattern batch added 2026-07-14.
---

## Critical pitfall: telegram.ts has its own LOCAL AlphaResult type

`telegram.ts` defines its own `AlphaResult` interface (large interface, ends around line 452) **separate** from the exported one in `scanner-patterns.ts`. Any new fields added to `scanner-patterns.ts:AlphaResult` must ALSO be added to the local type in `telegram.ts`, otherwise typecheck fails with "Property X does not exist on type AlphaResult" even though the field IS in scanner-patterns.ts.

**Why:** The telegram.ts local type was probably copy-pasted at creation time and is not a re-export. grep for `bidWallAbsorbed` in telegram.ts to find the end of the local type (line ~441).

## RSI batch maps (oversold_reversal)

- `loadRsiMap15m()` / `loadRsiMap1h()` load once per cycle (5-min internal cache).
- Pre-loaded in `performScan()` after the parallel prefetch block, stored as `rsiMap15m` / `rsiMap1h` in closure.
- `getRsiFromMap(symbol, map)` returns `number | null`.
- Maps are `Map<string, number>` keyed by base symbol (e.g. "BTC" not "BTC-USDT").

## Pattern routing

- `exchange_outflow_accum` → OI Watch 3h (added to `watchWindowMin` ternary chain).
- `oversold_reversal` → direct signal (`__isConfirmedFire = true`), stop -5%.
- `smart_money_divergence` → direct signal (`__isConfirmedFire = true`), alphaScore 7-8 override.

## AlphaResult extra fields in scanner.ts

Three maps bridging pattern detection → `alphaResults.push`:
- `_exchangeOutflowMap: Map<string, number>` — netflow7dPct
- `_rsiSigMap: Map<string, { rsi1h, rsi15m }>` — RSI values at signal time
- `_smartMoneyMap: Map<string, { smartMoneyLongPct, retailShortPct }>` — HL tag ratios

## alphaScore override for smart_money_divergence

Added after the `whale_alert` else-if block in loop2 (STEP 4):
```typescript
} else if (finalSentiment.key === "smart_money_divergence") {
  const _smdLong = _smartMoneyMap.get(base.symbol)?.smartMoneyLongPct ?? 0;
  alphaScore = Math.min(8, 7 + (_smdLong >= 70 ? 1 : 0));
}
```
