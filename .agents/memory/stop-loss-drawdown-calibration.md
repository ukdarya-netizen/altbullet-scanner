---
name: Stop-loss drawdown calibration
description: Production-основание для решения между глобальным стопом 10% и более узким 8%.
---

Не сокращать стоп до 8% универсально. Для новых позиций утверждены: Impulse Buy 8%, Price-Led Momentum 10%, Balanced Grind 10%. Сохранённые стопы уже открытых позиций неизменны.

**Why:** Контрфакт по всем 422 завершённым позициям, где действовала split-policy, использовал полные свечи до закрытия и direction-aware extrema; no-limit stop replay покрывает 400 позиций. Без лимитки 10% дал +600.20 суммарных процентных пункта, 8% — +595.43. PLM потерял 44.66 и BG 15.92 при сужении: после касания −8…−10 часть позиций восстанавливалась. Impulse Buy, наоборот, выиграл 42.50: 24 позиции достигали −10%, а единственная позиция только в зоне −8…−10 завершилась −2.5%, не восстановившись в плюс. Малые плюсы LC и Stealth недостаточны для общего правила.

**How to apply:** новые позиции получают pattern-specific stop при создании; restart и liquidity-stop logic не должны поднимать Impulse Buy с 8% до 10%. Runner обязан различать новую entry-policy и legacy policy. Не менять уже открытые позиции ретроактивно. Любой повторный аудит показывает покрытие и не реконструирует отсутствующий путь из одного peak или итогового PnL.

Stealth Breakout must not narrow its stop to 4–6% from the mixed historical cohort. In the 66 reproducible non-reclassified paths, a 4% stop removed 2 PROFIT and 10 BE outcomes to catch 10 eventual stops; 5% removed 1 PROFIT and 7 BE; 6% removed no PROFIT but 6 BE while catching 9 stops.

**Why:** The saved stop amount is smaller, but recovered positions are converted into new losses; the current restored-detector cohort is still immature.

**How to apply:** Keep the current Stealth stop for new live positions until at least 20 completed restored-detector trades have direction-aware candle paths. Re-evaluate 6%, 8%, and 10% on that homogeneous cohort.