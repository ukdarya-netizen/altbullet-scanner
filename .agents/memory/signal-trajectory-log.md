---
name: signal_trajectory_log
description: Trajectory snapshots per fired signal at fixed time intervals after entry — for pattern calibration
---

## Цель
Заменяет удалённый growth_leader_log. Даёт time-bucketed траекторию каждого сигнала для анализа entry conditions → outcome.

## Интервалы
15m / 30m / 1h / 2h / 4h / 8h / 24h / 48h / 72h

## Архитектура
- Таблица: `signal_trajectory_log` — одна строка на (signal_id, interval_label)
- UNIQUE INDEX (signal_id, interval_label) — ON CONFLICT DO NOTHING, идемпотентно при рестарте
- Пишется в FastCycle (каждые 2 мин), функция `maybeRecordTrajectory()` в watcher.ts
- Фильтр: в памяти `_trajectoryRecorded = new Set<string>()` — ключ `${signalId}:${label}`. После рестарта — empty; первый цикл вставляет все due-rows через ON CONFLICT DO NOTHING
- `peakPct` = max % с момента входа до момента снапшота (из `peakPnlNow` в FastCycle)
- Fail-open: обёрнут в try/catch + `void ... .catch(() => null)` — не блокирует FastCycle

## Поля
- signal_id, symbol, sentiment_key, interval_label
- snapshot_at, elapsed_ms (фактические мс от detectedAt)
- price_at, pct_from_entry, peak_pct, status

## DDL
- Startup migration Part 2b в artifacts/api-server/src/index.ts
- Dev DDL применён через psql на момент реализации

**Why:** growth_leader_log удалён 2026-08-08; trajectory data критична для калибровки паттернов; без неё только entry + final exit, без промежуточных точек.

**How to apply:** данные будут накапливаться после следующего деплоя в prod. Для анализа: JOIN на tracked_signals по signal_id, группировать по sentiment_key + interval_label.
