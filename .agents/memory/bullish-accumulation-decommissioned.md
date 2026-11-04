---
name: Bullish Accumulation decommissioned
description: Durable retirement policy for Bullish Accumulation without deleting historical trades.
---

Bullish Accumulation полностью исключён из live-детекции, OI Watch fire, active pattern lists, пользовательской сортировки, справочника и обычной статистики. Открытые позиции административно переводятся в `reclassified`, а не закрываются как сделки.

**Why:** пользователь решил убрать паттерн и явно потребовал удалить оставшиеся открытые позиции без уведомлений и влияния на статистику. Физическое удаление старых строк уничтожило бы аудит, а `cancelled` попал бы в outcome/cancellation-метрики.

**How to apply:** `bullish_accumulation` не должен входить ни в active whitelist, ни в destructive dead-pattern cleanup. Новые сигналы блокируются до claim/insert/Telegram. Любые оставшиеся `active`/`in_run` строки переводятся в `reclassified` без PnL, close event, trajectory или Telegram. Источник сигнала сохраняется только для аудита/FK. Старые BA calibration notes считать историческими, не действующей стратегией.