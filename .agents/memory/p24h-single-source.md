---
name: p24h единый источник (KOMA-фикс)
description: BingX priceChangePercent=0 при ресете окна ломал ВСЕ p24h-гейты; теперь kline-first fallback chain
---

**Правило:** любое чтение p24h в сканере обязано использовать цепочку fallback, а не сырой `parseFloat(ticker.priceChangePercent)`:
1. Собственный расчёт из 30m klines (48 свечей = 24ч) — только в deep scan, где klines уже есть
2. Сырой BingX (если ≠ 0)
3. `prescanTracker.get(sym)?.lastPrice24h` (kline-проверенное значение фидбечится туда из deep scan)

**Why:** KOMA +80% за 24ч прошла Demark-гейт p24h≤40, не попала в isExhaustedByTicker и в overheat_log — BingX вернул 0 при ресете 24h-окна. Защита `price24h || existing` стояла только в prescanTracker-апдейтах, а гейты паттернов читали сырое значение.

**How to apply:** защищённые места — deep scan `price24hChange` (единая точка, все паттерн-гейты внутри цикла её используют), `isExhaustedByTicker`, Layer 8 steady climber, `logOverheatedTokens` (свой effectiveP24h). При добавлении нового p24h-гейта ВНЕ deep-scan-цикла — обязателен fallback на lastPrice24h. Warn-лог "p24h mismatch" ловит расхождения >15пп для мониторинга.
