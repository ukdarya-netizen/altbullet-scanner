---
name: Entry gate calibration — data-driven findings 2026-08-02
description: Empirical findings from 639-signal analysis on what entry metrics actually predict outcomes; what gates to add and what NOT to add.
---

## Rule
Add `funding > -0.05%` and `OI4h ≤ 10%` to accumulation patterns. Do NOT add OB imbalance or WI gates — data shows they hurt or are neutral.

## Key findings (639 prod signals, 60-day window)

### Funding rate (counterintuitive)
- Winners avg funding = -0.015%, losers avg = -0.098% (6× more negative).
- Per pattern: stealth_breakout winners +0.024%, losers -0.423%. BA winners +0.003%, losers -0.148%.
- "Negative funding = squeeze potential" does NOT hold for altcoins. Very negative funding = "market is shorting a downtrending coin", not a buildup of shorts ready to squeeze.
- **Gate added**: `funding > -0.0005` (i.e. > -0.05%) for stealth_breakout, balanced_grind, bullish_accumulation.

### OI4h at entry (strongest monotonic signal)
| OI4h bucket | avg_pnl | n |
|---|---|---|
| no_data | +0.31% | 415 |
| 0–3% | -0.32% | 63 |
| 3–10% | -0.90% | 47 |
| <0% | -1.23% | 82 |
| >10% | -1.62% | 32 |
- 224 signals with data, clear monotonic degradation.
- **Gate added**: `OI4h ≤ 10%` for bullish_accumulation (B5). balanced_grind already had `≤ 10.0` baked in.

### OB ratio (DON'T add)
- strong_bid (>1.5) = avg_pnl -1.42% (WORST). Bid walls on alts are MM artefacts, get eaten.

### WI (DON'T add as gate)
- "no_data" (373 signals) outperforms all WI categories. mild_whale (0-50) is worst (-2.69%). Not a reliable predictor.

### CVD count (promising but small sample)
- 4/4: avg_pnl +2.70%, 0 stops — best. Only 37 signals with all 4 CVD fields populated.
- Already added cvd30m+cvd1h gate for demark. Revisit when sample grows.

## What was implemented (2026-08-02)
- **balanced_grind**: added `_bgFr >= -0.0005` to condition + pdb reject `funding_neg_Xpct`
- **stealth_breakout**: added `_sbFr >= -0.0005` to condition + pdb reject
- **bullish_accumulation B5**: `OI4h > 10%` → skip + pdb reject `oi4h_too_hot_Xpct`
- **bullish_accumulation B6**: `funding < -0.05%` → skip + pdb reject `funding_neg_Xpct`

**Why:** Empirical from 639-signal prod data. Both gates address "already hot at entry" problem — OI4h directly, funding indirectly (very negative = downtrending coin, not accumulation phase).

**How to apply:** Any new accumulation-type pattern (long, no OI bypass) should check both gates before fire. Patterns with OI bypass (demark, PLM, liq_cascade) — funding gate only (OI4h is part of their signal, not a blocker).
