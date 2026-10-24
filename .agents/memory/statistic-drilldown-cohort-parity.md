---
name: Statistic drill-down cohort parity
description: Durable rules for linking dashboard aggregates to signal-history detail safely and exactly.
---

Каждая статистическая расшифровка должна повторять предикат агрегата: допустимые статусы, нормализацию PnL, date basis, сортировку и полуинтервал периода `[from, to)`. Для составных показателей используйте именованные metric cohorts, а не приблизительные status-фильтры.

**Why:** Визуально рабочая ссылка может показать другую выборку, если агрегат считается по `detected_at`, а история фильтруется по `closed_at`, либо если среднее и список используют разные наборы статусов.

**How to apply:** Для Dubai-дней и месяцев передавайте точные границы `[start, nextStart)`. Archive drill-down использует архивный whitelist только после серверной проверки защищённых месяцев; клиентский `scope` не является границей безопасности. URL фильтров должен оставаться источником истины для refresh/share/Back.