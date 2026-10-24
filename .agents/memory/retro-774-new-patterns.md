---
name: Retro-774 new patterns and CVD kill
description: 2 new patterns from 774-token retro + trend_accumulation CVD gate removal; key lessons about SentimentKey and watcher-config.
---

## What changed (2026-07-18)

### New patterns added
- `oi4h_silent_accum` — OI4h ≥4% при OI30m <1% и OI1h <2% (26% пампов в этой зоне); выход OI Watch PATH B; нет `__isConfirmedFire`
- `4h_pullback_continuation` — p24h 5-20% + p4h ≤-1.5% + prevOI4h <0 + OI4h ≥0 (разворот); выход прямой сигнал; стоп -6%

### trend_accumulation CVD gate removed
CVD (SpotCVD) был доступен только в 12.8% реальных пампов — убран из trend_accumulation и oi1h_breakout (4h_momentum тоже). Паттерн не терял precision — просто молчал 87% времени.

## Durable lessons

### ALWAYS update both after adding a pattern
1. **`SentimentKey` type in `scanner-patterns.ts`** — новый литерал нужно добавить в union; без этого scanner.ts не компилируется (TS2322).
2. **`PATTERN_MAX_STOP` in `watcher-config.ts`** — если паттерн имеет нестандартный стоп (не 10%), добавить запись; без этого будет применён глобальный STOP_LOSS=10%.

### OI4h zone 4-5% is a blind spot
Стандартный `anyOiPass` включает `t4h` (OI4h ≥5%). Токены с OI4h 4-5% не попадают в anyOiPass → уходят через break symbolBlock раньше. Оба новых паттерна добавлены в `noOiNoVol` bypass.

### bullish_accumulation cgOI floor
Справочник временно показывал 2.0% — это была bETA-попытка. Бэктест 90д: cgOI 2-3.5% = 50% SL (уже памп). Код был revert к 3.5% ранее; справочник исправлен 2026-07-18.

**Why:** Каждый раз когда справочник и код расходятся — это источник ложных ожиданий по fire-rate.
**How to apply:** При любом изменении порогов правь и код и PATTERNS_REFERENCE.md одновременно в одном коммите.
