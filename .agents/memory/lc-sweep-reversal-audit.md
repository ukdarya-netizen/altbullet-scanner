---
name: Liquidation Cascade sweep-reversal audit
description: Why the attached Sweep Reversal Map should not be used as a hard Liquidation Cascade entry gate.
---

Do not require a confirmed bullish Sweep Reversal Map setup at Liquidation Cascade entry on 15m, 30m, or 1h. A developing bullish sweep is not a substitute for confirmation and did not cleanly separate strong outcomes from stops. A fresh 15m bearish confirmation was rare and is not validated as a veto.

**Why:** A read-only production replay of the indicator's default settings on fully closed BingX futures candles found only a few pre-entry bullish confirmations across roughly 190 completed trades. Requiring one would exclude almost all realized ≥10% winners, including fast and slow winners. Separately, a 15m bullish confirmation *after* entry was associated with better outcomes in this fired-only historical cohort, but can reflect price recovery and survivor/selection bias rather than an actionable entry edge. Historical Pine pivot ties and incomplete/delisted market histories also limit exact parity.

**How to apply:** Keep the live LC gates unchanged. If revisiting the indicator, shadow-capture the 15m *post-entry* event with timestamp and matched at-risk controls; evaluate before/after price paths and genuinely new forward signals. Do not backdate an event that confirms after entry into a pre-entry filter, and evaluate missed/rejected candidate outcomes before promoting any gate.
## LC entry filter: detection-candle volume (2026-10-06)
Фитиль больше НЕ фильтр LC (владелица: 1% → 3% → 2% → убран). Фильтр: агрегированный ФЬЮЧЕРСНЫЙ объём (CoinGlass, мульти-биржа) закрытой 15m свечи детекции >= 5x от предыдущих 20; спот отдельно и не считается; нет данных = нет сигнала. Фитиль продолжает записываться как наблюдение. Гипотеза владелицы: вход от нижней границы 15m Range — наблюдается как rangeDeviation.tf15m (алгоритм 1H на 15m барах, не сверен с TradingView), не live-гейт.
**Why:** PONS отскочил с объёмом x5+ и фитилём 1.2%; фитиль его бы отрезал.
**How to apply:** не делать 15m Range live-гейтом без данных; BingX-объём не использовать (aggregated only).
