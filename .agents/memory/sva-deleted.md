---
name: SVA deleted 2026-08-08
description: spot_vol_accumulation полностью удалён из кода — все файлы, роуты, UI; данные в DB сохранены.
---

## Решение
n=13 сигналов, win rate 7.7% (1 победитель ZBT +25.7%), avg_cycles=231 (поздний вход по определению). Удалён полностью — не отключён, а именно удалён.

## Что сделано
- scanner.ts: весь VBS блок (19 KB, Phase "Volume Breakout Spot")
- watcher.ts: SVA stale-hold (2ч/5ч OI-Check блок), SPT_PAT массив в stale-hint, pathB SVA ветка, fetchArchetype+collectSingleSignalPreGrowth удалены
- dead-patterns.ts: `"spot_vol_accumulation"` добавлен в группу 2026-08-08
- scanner-patterns.ts: удалён из SentimentKey union
- telegram.ts: PATTERN_SIGNAL_IMGS + patternRuName
- pattern-labels.ts (server + frontend): записи удалены
- watcher-config.ts: конфиг строка удалена
- sentiment-badge.tsx: цвет удалён
- candidates.tsx, pattern-reference.tsx: SVA упоминания убраны из UI-текстов
- index.ts: строка `'spot_vol_accumulation'` из NOT IN миграции liq-стопа

## DB
Таблицы и данные НЕ удалены. DEAD_PATTERN_KEYS обеспечит отмену зависших сигналов при следующем деплое.

**Why:** win rate 7.7% при n=13 — нет статистического основания держать паттерн; avg_cycles=231 означает что он стреляет поздно, когда движение уже произошло.
