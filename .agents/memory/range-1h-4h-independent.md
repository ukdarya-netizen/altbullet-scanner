---
name: Range 1H and 4H are independent signals
description: Owner rule — 1H and 4H Range Breakout are two independent signals; a range may exist on one and not the other.
---
1H and 4H Range Breakout are separate signals, not dependent on each other. A range can exist on 1H without a 4H range and vice versa. 4H confirms with a 1H hold (two closed 1H candles); 1H confirms with a 30m hold (two closed 30m candles).

**Why:** the owner repeated this after I wrongly told her the 1H breakout needs a 4H range (stale policy note). Code has both paths live (AUTO_RANGE_1H_LIVE_ENABLED = true).

**How to apply:** never explain a missed 1H breakout by a missing 4H range; check the 1H arm (level_source auto_range_1h) separately. This supersedes the older "only 4H" notes in auto-range-1h-rollout-decision.md.

## Qualified breakouts do not expire (2026-10-06)
Подтверждённый Range-пробой не истекает по времени и проверяется каждый цикл. Лимит расстояния цены от уровня при выпуске — отложен: владелица добавит его позже, когда пойдут сигналы и будут реальные данные о задержке.
**Why:** прежний TTL 10 мин + постраничная очередь убивали подтверждённые пробои (за 03–05.10 ни один Range не дошёл до fired).
**How to apply:** не добавлять лимит расстояния самостоятельно; после первых сигналов предложить анализ задержки пробой→выпуск.
