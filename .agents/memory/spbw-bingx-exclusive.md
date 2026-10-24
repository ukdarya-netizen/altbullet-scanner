---
name: SpBW и BingX-exclusive — proactive whitelist
description: Как определяется, листингован ли токен на Binance spot / является ли BingX-exclusive; новый проактивный подход через CG exchange-pairs API.
---

## Новый подход (2026-08-01): coinglass_listings.ts

Модуль `artifacts/api-server/src/lib/coinglass_listings.ts` — единственный источник истины.

### Как работает

1. При старте (+ каждые 6ч) фетчит `/api/spot/supported-exchange-pairs` → `data.Binance[].base_asset` → `_binanceSpotSet` (480 токенов на момент внедрения)
2. `isBinanceSpotListed("BTW-USDT")` → true/false за O(1)
3. `isBingxExclusive("KOMA-USDT")` → !cgSupportedCoins(futures) AND !binanceSpotSet — оба источника нужны:
   - `getCgSupportedCoinsSet()` (futures/supported-coins) покрывает Binance+OKX+Bybit futures
   - `_binanceSpotSet` добавляет spot-листинг (токены без futures но с Binance spot)

### Fail-open семантика

- `isBinanceSpotListed()` → **true** если список ещё не загружен (не блокируем SpBW при старте)
- `isBingxExclusive()` → **false** если данные не загружены (не блокируем логику при старте)

### Где применяется

- `getSpotLargeBids()` в `coinglass_large_orders.ts` — первый же чек до HTTP-вызова
- `_sbCgNoData` в `scanner.ts` stealth_breakout блоке (~5293) — PRIMARY = isBingxExclusive, FALLBACK = cgNoDataCount>=3
- Старый code:500 neg-cache (BINGX_EXCLUSIVE_NEG_TTL=24h) остался как belt-and-suspenders

**Why:** Ленивое обнаружение через code:500 приводило к false-negative: token на Binance spot (BTW) не заполнял spotBidUsd, пользователь каждый раз вынужден был доказывать что токен не BingX-exclusive. Проактивный листинг убирает эту проблему полностью.
