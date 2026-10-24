---
name: Layer 6b Slow Accum — TAC archetype
description: Tokens with slow OI accumulation below Layer 3 thresholds; how they're detected via Layer 6b using Coinalyze 1h OI.
---

## The TAC blind spot (17 June 2026)

TAC had a +23% move over 9h culminating in a $463k short squeeze. The scanner missed it.

TAC IS covered by CoinGlass (trades on 10+ exchanges). The issue was NOT CG coverage.
The real problem: OI was accumulating too slowly to hit Layer 3 thresholds:
- CoinGlass OI 5m was 0.01–0.05% during accumulation (Layer 3 needs ≥5%)
- CoinGlass OI 30m was ~0.28% at best (Layer 3 needs ≥6%)
- CoinGlass OI 1h never reached 3% until the explosion itself
- Volume was single-candle spikes (1x → 5x → 1x) — volAwaken never sustained

Only usable signal: **Coinalyze aggregate rolling 1h OI = +0.41%** at ~10:20 МСК, 2.5h before explosion.

## Fix: Layer 6b (Coinalyze Slow Accum Lane)

**Condition**: `Coinalyze oiChange1h ≥ 0.3%` + `price24h ≥ 8%` (not in any Layer 1–6a)

**Does NOT require**: `!cgData.available` — works for any token, CG-covered or not.

**Implementation** (scanner.ts):
1. **Batch expansion** (inside 90-min Coinalyze cooldown block): top-20 price movers (price24h ≥8%, not in Layer 3 oiMoverTickers) added to `prescanFor30m` (total up to 60). Pre-fetches their Coinalyze 1h data so next cycle has it cached.
2. **Layer 6b loop** (after Layer 6, before usdtTickers assembly): iterates ALL `scored` tickers (not just prescanTracker), checks `getCoinalyzeOI30mCached(sym)?.oiChange1h >= 0.3`, adds matches.
3. **currentTopSymbols**: includes Layer 6b tickers so they survive prescanTracker cleanup.
4. **prescanTracker update**: Layer 6b tickers added alongside Layer 3/4.
5. **usdtTickers**: `coinalyzeSlowAccumTickers` appended last.

**Log marker**: `🐢 Layer 6b Slow Accum: токены с тихим Coinalyze OI (1h≥0.3%) добавлены в батч`

## Chicken-and-egg

- First cycle a price mover is seen: Coinalyze data not yet cached → NOT added by 6b.
- After 90-min batch runs: data cached → next cycle catches it if oiChange1h ≥ 0.3%.
- Worst-case detection lag: up to 90 min after price24h first crosses 8%.

## Critical lesson

Do NOT add `!cgData?.available` as a condition — that was the original wrong version that would have excluded TAC (which IS on CoinGlass). Layer 6b targets slow-OI tokens regardless of CG coverage status.
