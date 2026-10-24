---
name: Pattern enhancement — Footprint/NetPosition/RSI gates
description: dip_accumulation RSI/LiqExhaustion gate; trend_accumulation/bullish_accumulation Footprint+NetPosition score modifiers; double-rejection guard pattern.
---

## What was done (Task #21)

Two new fail-open API clients:
- `coinglass_footprint.ts` — `/api/futures/footprint/history`, 5-min cache, tries multiple field name conventions
- `coinglass_net_position.ts` — `/api/futures/net-position-v2`, 10-min cache

5 pattern changes in `scanner.ts`/`watcher.ts`:

1. **dip_accumulation**: RSI 1h ≤38 OR liqExhaustion.exhausted=true gate; fail-open if both null
2. **trend_accumulation**: Footprint buyAtAskPct ≥55% → alphaScore +1
3. **bullish_accumulation**: Net Position netShortChangePct ≥0.65 → alphaScore -1
4. **silent_whale (bullish_accum proxy)**: OI≥15% + |price30m|≤1.5% → Footprint buyAtBidPct ≥55% → +0.5; <40% → -0.5
5. **oi24h_accumulation**: Exchange Balance 7d — log-only (not a gate)

## Double-rejection guard pattern

When adding a new gate BEFORE an existing `if (!condition)` block (both can null-out `det`), the existing `if (!condition)` must become `if (det && !condition)`. Otherwise: after new gate sets `det = null`, the old gate still runs and tries to log/reject a null det, double-firing `_pdbReject`.

**Why:** `det = null` does NOT exit the else-if block — code continues to the next statement.

## Fail-open rule for RSI+LiqExhaustion

Block only when BOTH sources are non-null AND both fail:
```typescript
if (_dipRsi1h !== null && _dipLiqResult !== null && !_dipLiqOk) {
  // block
}
```
NOT: "block if RSI fails OR liq fails" (that would make each source independently blocking).

## API field name uncertainty

Both new endpoints try multiple field name variants (camelCase + snake_case) via a helper. This hedges against CoinGlass API naming inconsistencies. If all variants extract 0, totalVol=0 → return null (fail-open).
