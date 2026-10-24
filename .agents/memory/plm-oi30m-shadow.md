---
name: PLM OI30m shadow
description: Правила forward-проверки риска OI30m ≥2% для Price Led Momentum.
---

Для PLM OI30m классифицируется в момент fire как `<2%`, `≥2%` или `unavailable`. Класс сохраняется в primary signal и переносится в tracker/recovery без пересчёта из более позднего рынка.

**Why:** Holdout показал риск для OI30m ≥2%, но выборка была слишком мала для live-veto. Числовое entry enrichment и legacy NULL не доказывают, что значение было доступно в момент решения.

**How to apply:** Класс не участвует в fire, cancellation или exits. После минимум 20 завершённых сигналов именно в forward-когорте ≥2% сравнить PROFIT, BE STOP, STOP LOSS, EXPIRED и average raw PnL с `<2%`; любое live-изменение оформлять отдельно.