---
name: Path B migration — все 4 job-based паттерна
description: whale_alert/ob_stack/ob_smart/liquidation_cascade/whale_position — все fire из фоновых job'ов, не из основного скана
---

## Правило
Все паттерны на основе пулов (L10/L11/L14/L15) НЕ запускаются из основного скана (~10 мин).
Они живут целиком в watcher.ts как Path B функции.

## Архитектура Path B функций в watcher.ts
| Функция | Вызывается после | Частота |
|---------|-----------------|---------|
| `_runWhaleAlertFireCycle()` | runWhaleAlertJob | 3 мин |
| `_runLiqCascadeFireCycle()` | runLiqCascadeWatcherJob | 3 мин |
| `_runWhalePositionFireCycle()` | runWhalePositionJob | 15 мин |
| `runObPatternFireCycle()` | runSpotOrderbookJob (index.ts) | 30 мин |

## Ключевые детали
- ob/liqCascade: `tracked === "skip"` → НЕ broadcast (сигнал уже активен)
- whale_alert: broadcast всегда (dual-process dedup через trackSignal / DB)
- whale_position: при "skip" → markWhalePositionFired для очистки пула
- liqCascade: cleanup из пула автоматический — LiqCascadeWatcher ищет tracked_signals в следующем цикле
- `entryPrice` в `WhalePoolMirrorEntry` для whale_alert priceChange gate; whale_position использует price24h вместо cycle-priceChange
- liq-cascade-watcher.ts: getLiqCascadeLayer10Candidates() используется ТОЛЬКО для fire cycle теперь, не для инжекта в скан

## Из scanner.ts удалено (L10+L11+L14+L15)
- Импорты getWhalePositionEntry/getWhalePositionLayer15Candidates/markWhalePositionFired
- Импорты getLiqCascadeLayer10Candidates/LiqCascadeL10Entry
- L10 injection block + _l10Pool Map
- L15 injection block
- gate vars: _wpEntry/_wpConfirmed/isWhalePosition/_l10Entry/_l10AgeMin/isLiqCascade
- PDB блоки whale_position + liquidation_cascade
- noOiNoVol bypass entries !isWhalePosition && !isLiqCascade
- spot vol bypass && !isLiqCascade
- Signal creation blocks (строки ~5007-5061)
- markWhalePositionFired call в confirmed fire path

**Why:** Основной скан ~10 мин; каскад ликвидаций и whale alert time-sensitive; Path B: 3-15 мин.

**How to apply:** При добавлении новых паттернов «на основе job'а» — создавать Path B функцию в watcher.ts, NOT добавлять в scanner.ts основной цикл. Минимальный шаблон: getFutureTickers → per-entry OI/taker check → trackSignal → broadcastBatchAlert.
