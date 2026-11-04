---
name: Growth Leader Retro Job
description: Ретроспективный сборщик growth_leader_log — 7 дней BingX klines + CoinGlass OI/taker
---

## Что делает

`growthLeaderRetro.ts` — ретроспективный сборщик данных для анализа паттернов.

**Алгоритм на один символ:**
1. BingX klines 1h × 168 свечей (7 дней)
2. Находит моменты price24h ≥ N% (только первую свечу каждого памп-периода)
3. CoinGlass parallel: OI aggregated-history (1h) + spot taker history (1h, Binance) + futures taker history (1h, Binance)
4. INSERT ON CONFLICT DO NOTHING (уникальный индекс symbol+10min bucket)

**Что заполняется у ретро-записей:**
- price, price24h, price1h, price3h, price4h ✅ из klines
- oi1h%, oi4h%, oiUsdAbs ✅ из CG OI aggregated-history
- oi30m% ⚠️ = oi1h/2 (аппроксимация — 30m истории нет)
- spotTakerBuyUsd, spotTakerSellUsd ✅ из CG spot/taker-buy-sell-volume/history
- cvd1h, cvd30m ✅ булев из spot taker (buy > sell за 1h окно; cvd30m = cvd1h)
- netBuyPct ✅ из CG futures/taker-buy-sell-volume/history ((buy-sell)/(buy+sell)*100)
- futVolUsd24h ✅ сумма kline volume × close за 24 свечи
- volMult ✅ текущий volUsd / средний за 7д
- fundingRate ⚠️ только для точек за последние 6ч (BingX не даёт историю)
- spotFpBuyPct ❌ footprint требует Professional план

**source='retrospective', retro=true** — отличает от real-time ('scan', 'bingx_only')

## Запуск

- Авто: через 25 мин после startup (после spot backfill @20min)
- Ручной: `POST /api/admin/rerun-growth-leader-retro?minPrice24h=30` + `X-Admin-Token: <ADMIN_TOKEN>`
- Лог завершения: `growthLeaderRetro: завершён` — ищи в деплой-логах

## Конфигурация

- `batchSize=6`, `batchDelayMs=800` — 6 символов параллельно, 800мс пауза
- CG семафор: 3 одновременных CG запроса (не считая BingX klines)
- 200-400мс задержки между endpoint'ами на один символ

## Новые колонки growth_leader_log (2026-07-17)

price_3h, price_4h, funding_rate, oi_usd_abs, fut_vol_usd_24h, retro
— добавлены через ALTER в runStartupMigration

**Why:** нужны 200+ примеров 30%+ муверов с полным набором данных для калибровки паттернов.
**How to apply:** при добавлении новых полей в growth_leader_log — добавлять ALTER в runStartupMigration, обновлять growthLeaderLogTable schema, обновлять growthLeaderRetro.ts.
