---
name: Archetype patterns — ОКНО ПОДТВЕРЖДЕНИЯ bypass
description: Почему архетипные паттерны давали 255 PDB проходов и 0 tracked_signals — root cause + fix.
---

## Проблема

Архетипные паттерны (price_led_momentum, stealth_breakout, balanced_grind, 4h_pullback_continuation) устанавливают `__isConfirmedFire = true` при детекции, но блок «ОКНО ПОДТВЕРЖДЕНИЯ» (`symbolBlock` в scanner.ts) перехватывал их:

```
} else {
  // confirmingEntry.length === 0 → первый раз
  INSERT oi_watch status='confirming'
  break symbolBlock   ← сигнал дропается, 2h ожидания
}
```

Токены уходили в `oi_watch` status=`confirming` с 2-часовым окном. За 2h цена откатывалась → early cancel → 0 сигналов.
255 проходов price_led_momentum за 99 циклов = полностью рабочее детектирование, но нулевые сигналы.

## Fix

Добавлена ветка `else if ((det as any).__isConfirmedFire === true)` **между** ветками confirming-exists и else-insert в ОКНЕ ПОДТВЕРЖДЕНИЯ:

```ts
} else if ((det as any).__isConfirmedFire === true) {
  // ARCHETYPE DIRECT FIRE: пропуск 2h очереди → fall-through к сборке сигнала
} else {
  // нормальный путь: INSERT oi_watch confirming + break
}
```

**Why:** архетипные паттерны рассчитаны на немедленный вход — у них нет 2h confirmation window по дизайну; они конкурируют за тикеры на 10-30 минутных форсайтах.

**Разделение безопасно:** нормальные паттерны (BA/TA/SVA) НЕ ставят `__isConfirmedFire` при детекции — только confirming path его выставляет (строка 5708 для OI Watch PATH A/B). Архетипные паттерны выставляют явно при детекции (строки 5067/5091/5115/5140).

## 4h_pullback_continuation v2 — смена условия OI4h

Старое: `prevOi4h < 0 AND lastOi4h >= 0` (crossover за 10 мин) — структурно невозможно для 4h-метрики → 0 проходов в 20K символо-сканов.

Новое:
- `lastOi4h < 0` — OI4h сейчас отрицательный (в откате)
- `lastOi4h > prevOi4h` — улучшается между циклами (не accelerate to positive, а improve)
- `oi30m >= 0` (fail-open) — короткий ТФ уже стабилен
- price24h расширен 5-20% → 3-25%

**How to apply:** для любого нового паттерна с 4h-метрикой: НИКОГДА не ожидать смены знака за один 10-минутный интервал — лишь тренд (улучшение/ухудшение). Crossover на 4h доступен только через positiveCandles / oiConsecutiveUp из OI OHLC история.
