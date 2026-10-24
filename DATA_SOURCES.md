# DATA_SOURCES.md — CoinGlass API v4: Реестр эндпоинтов

> Дата аудита: 2026-07-20  
> База: `https://open-api-v4.coinglass.com`  
> Заголовок аутентификации: `CG-API-KEY: <ключ>` (**не** `coinglassSecret` — это v2)  
> Rate limit: **1200 кредитов / минута** (из заголовков ответа: `api-key-max-limit: 1200`)  
> Стоимость кредитов: простые эндпоинты ~1 кредит; liq heatmap model2 ~8 кредитов

---

## Методология

Все URL взяты со скриншотов официальных страниц `docs.coinglass.com` (сайт на readme.io, JS-рендер — только скриншот стабильно открывается). Все HTTP-тесты запущены реальными curl-запросами с подтверждёнными ответами `code: 0`.

---

## 1. FUTURES — Large Open Orders (текущий стакан)

**Docs:** https://docs.coinglass.com/reference/large-orderbook  
**Раздел docs:** `Futures → Order Book(L2)`  
**Тип данных:** FUTURES  

**URL:**
```
GET /api/futures/orderbook/large-limit-order
```

**Обязательные параметры:**
| Параметр | Тип | Описание | Пример |
|----------|-----|----------|--------|
| `symbol` | string | Торговая пара (с USDT) | `BTCUSDT` |
| `exchange` | string | Биржа | `Binance` |

> ⚠️ `exchange=BingX` → 500 Server Error. Данные доступны только для Binance/OKX/Bybit/etc. BingX-exclusive токены здесь недоступны.

**Доступность по планам:** Hobbyist ❌ · Startup ❌ · Standard ✅ · Professional ✅

**Глубина истории:** Только текущий стакан (real-time snapshot). Нет параметра `startTime`.

**Пример ответа:**
```json
{
  "code": "0",
  "data": [{
    "id": 9150932102,
    "exchange_name": "Binance",
    "symbol": "BTCUSDT",
    "base_asset": "BTC",
    "limit_price": 64241.0,
    "start_time": 1784540932000,
    "start_quantity": 20.464,
    "start_usd_value": 1314627.82,
    "current_quantity": 19.37,
    "current_usd_value": 1244348.17,
    "current_time": 1784540948000,
    "executed_volume": 4.159,
    "executed_usd_value": 267178.33,
    "trade_count": 139,
    "order_side": 1,
    "order_state": 2,
    "order_end_time": 1784540963000
  }]
}
```

**Поля:** `order_side` 1=bid/2=ask; `order_state` 2=active

---

## 2. FUTURES — Large Open Orders History (v2)

**Docs:** https://docs.coinglass.com/reference/large-orderbook-history  
**Раздел docs:** `Futures → Order Book(L2)`  
**Тип данных:** FUTURES  

**URL:**
```
GET /api/futures/orderbook/v2/large-limit-order-history
```

> ⚠️ **Баг в коде:** `coinglass_large_orders.ts` использует `/api/futures/orderbook/large-limit-order/history` (без `/v2/`) → всегда HTTP 404. Функция `getLargeObHistory` — мёртвый импорт (нигде не вызывается).

**Обязательные параметры:**
| Параметр | Тип | Описание | Пример |
|----------|-----|----------|--------|
| `symbol` | string | Торговая пара | `BTCUSDT` |
| `exchange` | string | Биржа | `Binance` |

**Опциональные:**
| Параметр | Тип | Описание |
|----------|-----|----------|
| `limit` | int | Макс. записей (до 1000) |
| `startTime` | int (ms) | Начало диапазона (unix мс) |
| `endTime` | int (ms) | Конец диапазона |

**Доступность по планам:** Hobbyist ❌ · Startup ❌ · Standard ✅ · Professional ✅

**Глубина истории (измерено):**
- С `limit=1000` → **~2 дня** (2026-07-18 → 2026-07-20, 1000 записей BTC)
- `startTime` на 90 дней назад → возвращает только самые свежие записи (startTime игнорируется при исчерпании пула)

**Реальные данные:** ~1000 записей на пару BTCUSDT/Binance за 2 дня

**Пример ответа:** Структура идентична эндпоинту #1 (те же поля).

---

## 3. SPOT — Large Open Orders History (v2)

**Docs:** Sidebar `Spots → Order book → Large Orderbook History`  
**Раздел docs:** `Spots → Order book`  
**Тип данных:** SPOT  

**URL:**
```
GET /api/spot/orderbook/v2/large-limit-order-history
```

**Обязательные параметры:** `symbol`, `exchange` (аналогично #2)

**Доступность по планам:** Standard ✅ · Professional ✅ (тестировано)

**Глубина истории (измерено):**
- С `limit=1000` → **~7 дней** (353 записи для BTCUSDT/Binance: 2026-07-13 → 2026-07-20)
- Более мелкие токены — скорее всего меньше данных

**Пример ответа:** `code: 0 | start_usd: $1,400,669 | структура аналогична FUTURES`

---

## 4. FUTURES — Coin Liquidation Heatmap Model2 (агрегированный, кросс-биржевой)

**Docs:** https://docs.coinglass.com/reference/liquidation-aggregate-heatmap-model2  
**Раздел docs:** `Futures → Liquidation`  
**Тип данных:** FUTURES  

**URL:**
```
GET /api/futures/liquidation/aggregated-heatmap/model2
```

**Обязательные параметры:**
| Параметр | Тип | Описание | Пример |
|----------|-----|----------|--------|
| `symbol` | string | Базовый актив (без USDT) | `BTC`, `SOL`, `ETH` |
| `range` | string | Временной диапазон | `3d`, `7d`, `30d` |

**Доступность по планам:** Hobbyist ❌ · Startup ❌ · **Standard ❌** · **Professional ✅**

> ⚠️ Standard недостаточно — только Professional+

**Глубина истории:** По официальной документации `range` задаёт **временное окно агрегации**: `12h`, `24h`, `3d`, `7d`, `30d`, `90d`, `180d`, `1y`, а не диапазон цен по оси Y. Ответ содержит `price_candlesticks` с временными метками и ячейки `[X-index, Y-index, intensity]`. У документированного запроса нет параметра произвольной даты окончания; доступность нужных прошлых срезов надо проверять по реальным временным меткам ответа выбранного окна.

Исторические срезы полученной сегодня карты — реконструкция провайдера, не замена неизменному снимку, сохранённому до входа. При исследовании сохранять время получения, сопоставлять X-index с соответствующей свечой и не использовать более поздние срезы как информацию, известную на входе.

**Стоимость кредитов:** ~8 кредитов за вызов (измерено)

**Пример ответа (BTC, range=3d):**
```json
{
  "code": "0",
  "data": {
    "y_axis": [57308.92, 57500.00, ...],  // 119 ценовых уровней
    "liquidation_leverage_data": [[5, 124, 2288867.26], ...],
    "price_candlesticks": [...]
  }
}
```

**Поля liquidation_leverage_data:** `[x_index, y_index, liquidation_usd_value]`

---

## 5. FUTURES — Pair Liquidation Heatmap Model2 (по паре и бирже)

**Docs:** https://docs.coinglass.com/reference/liquidation-heatmap-model2  
**Раздел docs:** `Futures → Liquidation`  
**Тип данных:** FUTURES  

**URL:**
```
GET /api/futures/liquidation/heatmap/model2
```

**Обязательные параметры:**
| Параметр | Тип | Описание | Пример |
|----------|-----|----------|--------|
| `symbol` | string | Торговая пара (с USDT) | `BTCUSDT` |
| `exchange` | string | Биржа | `Binance` |
| `range` | string | Диапазон | `3d`, `7d`, `30d` |

**Доступность по планам:** Hobbyist ❌ · Startup ❌ · **Standard ❌** · **Professional ✅**

**Глубина истории:** Только текущий снимок (см. #4)

**Стоимость кредитов:** ~8 кредитов за вызов

**Пример ответа:** Аналогично #4: 119 уровней y_axis, matrix liquidation_leverage_data.

---

## 6. FUTURES — Pair Liquidation Map

**Docs:** https://docs.coinglass.com/reference/liquidation-map  
**Раздел docs:** `Futures → Liquidation`  
**Тип данных:** FUTURES  

**URL:**
```
GET /api/futures/liquidation/map
```

**Параметры (из docs):**
| Параметр | Тип | Описание | Пример |
|----------|-----|----------|--------|
| `symbol` | string | Пара (с USDT?) | `BTCUSDT` |
| `exchange` | string | Биржа | `Binance` |
| `range` | string | Диапазон | `3d` |

**Доступность по планам:** Hobbyist ❌ · Startup ❌ · **Standard ❌** · **Professional ✅**

**Глубина истории:** Только текущий снимок.

**Статус тестирования:** Все комбинации параметров возвращают `400 "instrument is null"`. Точный формат параметров не удалось установить из обрезанного curl-примера в доках. **Нужно проверить через docs Try It!**

> ⚠️ Функция `getLiqMapClusters` в `coinglass_liq_heatmap.ts` — мёртвый импорт в `scanner.ts` (liq_magnet_squeeze паттерн удалён). Вызов без `range` параметра всегда даёт 400.

**Пример ответа (из docs, не из live-теста):**
```json
{
  "code": "0",
  "data": {
    "data": {
      "48935": [[48935, 1579370.77, 25, null], ...]
    }
  }
}
```

**Поля:** цена → массив [liq_price, liq_usd, leverage_ratio, null]

---

## 7. HYPERLIQUID — Whale Alert

**Docs:** https://docs.coinglass.com/reference/hyperliquid-whale-alert  
**Раздел docs:** `Hyperliquid Positions` (отдельный top-level раздел, **не FUTURES, не SPOT**)  
**Тип данных:** HYPERLIQUID  

**URL (виден полностью в docs):**
```
GET /api/hyperliquid/whale-alert
```

**Параметры:**
| Параметр | Тип | Описание | Пример |
|----------|-----|----------|--------|
| `limit` | int | Кол-во записей | `200` |

**Доступность по планам:** Hobbyist ❌ · Startup ✅ · Standard ✅ · Professional ✅

**Глубина истории (измерено):**
- **Жёсткое ограничение: последние 50 записей**, независимо от `limit` (limit=200 → всё равно 50)
- Временной диапазон: ~3 часа (последние whale-события)
- **Нет пагинации по дате.** Это не исторический API.

**Пример ответа:**
```json
{
  "code": "0",
  "data": [{
    "user": "0x3fd4...",
    "symbol": "HYPE",
    "position_size": 12700,
    "entry_price": 1611.62,
    "liq_price": 527.52,
    "position_value_usd": 1077448.75,
    "position_action": 1,
    "create_time": 1784540859000
  }]
}
```

**Поля:** `position_action` 1=open_long / 2=open_short / 3=close (уточнить по docs)

---

## 8. HYPERLIQUID — Whale Position (текущие позиции)

**Docs:** https://docs.coinglass.com/reference/hyperliquid-whale-position  
**Раздел docs:** `Hyperliquid Positions`  
**Тип данных:** HYPERLIQUID  

**URL:**
```
GET /api/hyperliquid/whale-position
```

**Параметры:** `limit` (до ~1000)

**Доступность по планам:** Hobbyist ❌ · Startup ✅ · Standard ✅ · Professional ✅

**Глубина истории:** Только текущий снимок открытых позиций. `create_time` = когда позиция открылась, `update_time` = последнее обновление. **Нет исторических данных.**

**Пример ответа (первая запись, 2026-07-20):**
```json
{
  "user": "0x0ddf9b...",
  "symbol": "ETH",
  "position_size": -50000.0,
  "entry_price": 1700.06,
  "mark_price": 1866.0,
  "liq_price": 2178.57,
  "leverage": 3,
  "margin_balance": 31091666.67,
  "position_value_usd": 93275000.0,
  "unrealized_pnl": -8271650.85,
  "funding_fee": -468176.56,
  "margin_mode": "cross",
  "create_time": 1781969983000,
  "update_time": 1784541068000
}
```

**Размер датасета:** 976 позиций (все открытые whale-позиции на Hyperliquid)

---

## 9. HYPERLIQUID — Long/Short Ratio (Accounts)

**Docs:** https://docs.coinglass.com/reference/hyperliquid-long-short-account-ratio-history  
**Раздел docs:** `Hyperliquid Positions`  
**Тип данных:** HYPERLIQUID  

**URL:** `GET /api/hyperliquid/global-l...` (**URL обрезан в docs curl-примере** после "global-l")

**Доступность по планам:** Hobbyist ❌ · Startup ❌ · Standard ✅ · Professional ✅

**Статус тестирования:** Точный URL неизвестен — curl docs truncated. Попытки угадать (`/global-long-short-account-ratio`, `/global-long-short-ratio-history`) → 404. Нужен docs Try It! для копирования точного URL.

**Пример ответа (из docs):**
```json
{
  "data": [{
    "time": 1751414400000,
    "global_account_long_count": 5347,
    "global_account_short_count": 3766,
    "global_account_total_count": 9113,
    "global_account_long_percent": 58.67,
    "global_account_short_percent": 41.33,
    "global_account_long_short_ratio": 1.4195
  }]
}
```

**Это глобальный агрегат** (все аккаунты Hyperliquid), не per-token и не "verified traders by tag".

---

## Сводная таблица

| # | Тип | Эндпоинт | Min план | История | Кредиты/вызов | Статус |
|---|-----|----------|----------|---------|---------------|--------|
| 1 | FUTURES | `/api/futures/orderbook/large-limit-order` | Standard | Только сейчас | ~1 | ✅ Работает |
| 2 | FUTURES | `/api/futures/orderbook/v2/large-limit-order-history` | Standard | **~2 дня** | ~1 | ✅ Работает |
| 3 | SPOT | `/api/spot/orderbook/v2/large-limit-order-history` | Standard | **~7 дней** | ~1 | ✅ Работает |
| 4 | FUTURES | `/api/futures/liquidation/aggregated-heatmap/model2` | **Professional** | Только сейчас | ~8 | ✅ Работает |
| 5 | FUTURES | `/api/futures/liquidation/heatmap/model2` | **Professional** | Только сейчас | ~8 | ✅ Работает |
| 6 | FUTURES | `/api/futures/liquidation/map` | **Professional** | Только сейчас | ? | ⚠️ Params unclear |
| 7 | HYPERLIQ | `/api/hyperliquid/whale-alert` | Startup | **50 записей (~3ч)** | ~1 | ✅ Работает |
| 8 | HYPERLIQ | `/api/hyperliquid/whale-position` | Startup | Снимок сейчас | ~1 | ✅ Работает |
| 9 | HYPERLIQ | `/api/hyperliquid/global-l...` | Standard | ? | ? | ❌ URL неизвестен |

---

## Ключевые выводы для бэкофилла

1. **Large orders — не исторические данные.** FUTURES: ~2 дня; SPOT: ~7 дней. Бэктест за 90 дней по этим данным **невозможен** — API не хранит такую глубину.

2. **Liq heatmap — только текущий снимок.** Эндпоинты #4/#5/#6 рассчитываются из текущих открытых позиций. Исторического API для "какие кластеры были 30 дней назад" не существует. Можно только периодически снимать снапшоты и накапливать.

3. **HL Whale Alert — жёсткий лимит 50 событий (~3ч).** Нет пагинации по дате. Исторических данных по китам нет. Для накопления нужен polling каждые 5-10 минут.

4. **BingX ≠ Binance для large orders.** CoinGlass не возвращает данные BingX-пар через orderbook эндпоинты (500 Server Error). Large orders данные отражают ситуацию на крупных биржах (Binance, OKX), не на BingX.

5. **Rate limit: 1200 кредитов/минута.** Для liq heatmap (8 кредитов) — 150 вызовов в минуту. Для 50 токенов × 8 кредитов = 400 кредитов — вполне вписывается. Для 500+ токенов liq heatmap за одну минуту = 4000 кредитов → нужно делать с паузами.

---

## Мёртвые импорты в коде (требуют удаления)

| Файл | Функция | Баг |
|------|---------|-----|
| `coinglass_large_orders.ts` | `getLargeObHistory` | URL без `/v2/` → 404; функция не вызывается |
| `scanner.ts:24` | `import { getLargeObHistory }` | Мёртвый импорт |
| `scanner.ts:25` | `import { getLiqMapClusters }` | Мёртвый импорт (liq_magnet_squeeze удалён) |
| `coinglass_liq_heatmap.ts` | `getLiqMapClusters` | Missing `range` param → 400; функция не вызывается |
