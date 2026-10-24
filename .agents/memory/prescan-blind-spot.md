---
name: Prescan blind spot — slow OI accumulators
description: Tokens that accumulate OI slowly (+1-2%/30min) and have low price24h miss all prescan layers; three fixes deployed June 2026.
---

## The blind spot

A token growing OI +1.5%/30min for 3 hours accumulates +9% total OI but never triggers any individual TF threshold:
- oi5m ≈ 0.3% (< OI_THRESH_5M=5%)
- oi30m = 1.5% (< OI_THRESH_30M=4%)
- oi1h = 3.0% — only opens after 60 min of sustained growth
- tSteady (old): required oi5m ≥ 3% AND oi30m ≥ 4% — too high
- cg_building: requires 2+ TFs with ≥ 2% AND symbol in Layer 1 — double gating

Compound problem: low price24h → low activity score → not in Layer 1 → cg_building/tSteady both gated behind Layer 1 check.

## Fixes deployed (June 14, 2026)

### 1. Layer 4: Volume Awakening (prescan, scanner.ts)
New module-level `prevQuoteVolCache = Map<string, number>()`.
After OI Movers block, before `usdtTickers = [...]`:
- For each scored symbol NOT in Layer 1/2/3
- price24h in [3%, 15%]
- `deltaVol = curQuoteVol - prevQuoteVol`; `avgCandle = prevQuoteVol / 144`
- If `deltaVol / avgCandle >= 2.5` → add to scan pool
- Log: `📊 Layer 4 Volume Awakening`
- First cycle: cache cold, no effect (primes on first run)

**Why:** quoteVolume delta between 10-min scan cycles ≈ current interval volume for tokens with flat 24h history (like BANANAS31 at 06:00 UTC). Avoids klines fetch at prescan stage.

### 2. tSteady thresholds lowered (scanner.ts line ~1839)
- oi5m: 3.0% → **1.0%**
- oi30m: 4.0% → **2.0%**
- Added: `prescanTracker.get(symbol)?.cycleCount ?? 0) >= 3` — compensates lower thresholds; token must be 3+ cycles in prescan (≈15 min) to avoid noise spikes.

**Why:** slow accumulators stay below old thresholds indefinitely. cycleCount gate ensures sustained presence, not a one-off blip.

### 3. Layer 3 OI Movers oi24h threshold (scanner.ts)
- oi24h: `>= 20.0` → **>= 10.0**
- Catches tokens with 10-19% daily OI growth that were invisible to Layer 3.

### 4. Prescan score — volume acceleration bonus
New field `prevVolMult` in PrescanEntry (saved before overwriting `lastVolMult` in deep scan).
Applied to activity score at prescan stage:
```
volAccel = lastVolMult / prevVolMult
accelBonus = volAccel >= 2.0 ? 2.0 : volAccel >= 1.5 ? 1.5 : 1.0
score = baseScore * accelBonus
```
Tokens that were in Layer 1 previously and whose volMult doubled get 2x score boost → more likely to stay in Layer 1.

## Remaining limitation
tSteady and cg_building are still gated by `activeSymbols.has(symbol)` (Layer 1 only). A token that has never reached Layer 1 still won't trigger these paths. Layer 4 is the only path for those.
