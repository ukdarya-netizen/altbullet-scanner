# Workspace

## Overview

pnpm workspace monorepo using TypeScript. Contains BingX Alpha Scanner — a real-time crypto futures signal detection dashboard.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Database**: PostgreSQL + Drizzle ORM
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec)
- **Build**: esbuild (CJS bundle)
- **Frontend**: React + Vite + Tailwind CSS + shadcn/ui

## Architecture

- `artifacts/api-server` — Express backend with BingX API integration, scanner engine, and Telegram alerts
- `artifacts/alpha-scanner` — React frontend dashboard (dark terminal theme)
- `lib/db` — Drizzle ORM schema: `signals`, `settings` tables
- `lib/api-spec` — OpenAPI spec for all endpoints

## Key Features

BingX Futures market scanner — 500+ USDT perpetual pairs, скан каждые ~10 мин.

---

### 🔍 Слои прескана — как токен попадает в батч сканера

Каждый скан-цикл (~10 мин) формирует батч из 500+ токенов. Токен может попасть через несколько слоёв одновременно — теги аккумулируются.

⛔ **Единый фильтр:** price24h > +40% (перегрев) или < −40% (обвал) → вылетает из всех слоёв **кроме WL**.

#### Базовые слои (скоринг + объём)

| Тег    | Название   | Лимит      | Условие попадания                                                               |
| ------ | ---------- | ---------- | ------------------------------------------------------------------------------- |
| **WL** | Watchlist  | Без лимита | Ручной список в настройках — всегда в батче, единый фильтр не применяется       |
| **L1** | Hot Movers | Топ-50     | Activity score: объём 24h + OI change + движение цены; топ по совокупному баллу |
| **L2** | Volume     | Топ-200    | CoinGlass global vol (на первом цикле — BingX-объём как фолбэк)                 |
| **L3** | OI Movers  | Без лимита | CoinGlass OI спайк: 30m ≥6% / 1h ≥3% / 4h ≥8% / 24h ≥10%                        |
| **L4** | Vol Awaken | Без лимита | Дельта объёма ×2.5+ от 5-циклового среднего + price24h 3–15% («просыпающиеся»)  |
| **L5** | OI Accel   | Без лимита | OI30m ускоряется между циклами: lastOi30m > prevOi30m × 1.3 + оба >0            |

#### Специальные слои (сигналы + контекст)

| Тег     | Название         | Условие попадания                                                                    | Примечание                                                                          |
| ------- | ---------------- | ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| **L6c** | CG Blind Rescue  | CoinGlass timeout/отсутствие данных + Coinalyze OI 30m ≥1.5% → принудительный инжект | Спасение BingX-exclusive токенов от слепой зоны CG; OI Watch cg_timeout 6ч          |
| **L7**  | OI Watch Orphans | Активные записи `oi_watch` (watching/confirming) без текущего prescan-тега           | Каждый цикл добавляет к батчу — гарантирует продолжение сканирования до истечения   |
| **L8**  | Steady Climbers  | Поведенческий тег: growthCycles ≥2 + p24h 0–40% — устойчивый рост без откатов        | Навешивается поверх любого источника; scSet — discovery, steadyClimbMap — поведение |
| **L8b** | OI 24h Leaders   | Проактивный OI Watch: OI24h ≥8% + price −5..+35% + база OI ≥$1M                      | Инжектируется в OI Watch на 12ч не дожидаясь паттерна; Layer 7 подхватывает         |

#### Пулы — внешние источники (job-based)

| Тег     | Название                  | Job                            | Условие добавления в пул                                                                                                      | Окно                                                             |
| ------- | ------------------------- | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| **L9**  | Bid Walls                 | BidWallJob каждые 30 мин       | CoinGlass futures orderbook heatmap: стена ≥0.05% MCap + ratio ask/bid ≥2x                                                    | 24ч                                                              |
| **L10** | Liq Cascade Watch         | LiqCascadeWatcher каждые 3 мин | longLiq1h/longLiq24h ≥ 25% + longLiq1h ≥$50K + p24h ≤+5% (лонг-ликвидации спайк) **или** поток liq-ордеров (liq_order_stream) | В пуле `liq_cascade_watch` до подтверждения/истечения            |
| **L11** | Whale Alert (Hyperliquid) | WhaleAlertJob каждые 3 мин     | Кит открыл лонг ≥$500K на Hyperliquid (CoinGlass whale-alert API)                                                             | 24ч; HL Position Tracker 15 мин                                  |
| **L12** | On-Chain Transfers        | WhaleOnchainJob каждые 10 мин  | CoinGlass Whale Transfer ≥$10M: **withdrawal** с биржи = накопление → пул; deposit + активный сигнал = ⛔ алерт               | withdrawal 4ч дедуп / deposit-предупреждение 6ч дедуп            |
| **L13** | Whale Watch Spot          | Основной скан-цикл             | `whale_futures_watchlist` type=`spot` status=`watching` — токены под долгосрочным спот-мониторингом (≤50 записей)             | Пока статус `watching` (до 30 дн); бейдж «🌊 долг. накопл.» в UI |

---

### 👁 OI Watch — пути попадания

| Путь                           | Триггер                                                                                                       | Окно                     |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------- | ------------------------ |
| **PATH A** (confirmed)         | Сканер нашёл сигнал, цена ещё не подтвердила → payload сохранён, ждём +цена% (1.5–2%)                         | 6ч                       |
| **PATH B** (steady accum)      | OI накапливается, объём не пришёл → ждём turnover ≥15% ИЛИ спот vol ≥1.5x ИЛИ vol ×1.8 от входа **+** SpotCVD | 6ч                       |
| **Dark Flow / Activity Watch** | Топ-активный без OI данных (CoinGlass timeout / building)                                                     | dark*flow 6ч / cg*\* 12ч |

---

### 🎯 Паттерны

Бэктест 90д (production tracked_signals, 2026-07-18): EV = (hit_10% × 10) − (SL% × стоп) − прочие × 0.

**Активные паттерны для сигналов и пользовательской аналитики:** `stealth_breakout`, `neon_support_bounce`, `impulse_buy`, `liquidation_cascade`. `bullish_accumulation`, `balanced_grind`, `whale_watch` (Whale Futures) и `price_led_momentum` (PLM, снят с торговли; открытые позиции закрыты нейтрально при старте, в статистике строка с пометкой «архив») больше не создают новые сигналы и не участвуют в актуальной аналитике; их история и сопровождение ранее открытых позиций сохраняются.

#### Интрадей / накопление

| Паттерн                                                         | Условия                                                                                                                                                                                                                                                                                                                            | Выход сигнала                                           | Бэктест 90д                                                                                        |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| 📊 `bullish_accumulation` **Бычье накопление** _(fallback)_     | OI floor: cgOI ≥**3.5%** / OI1h ≥2% / OI4h ≥2.5% + prevOI30m ≥**−0.3%** (2 цикла) + SpotCVD1h (fail-open) + vol ≥**1.0x** (с OI) / **1.8x** (без) + **p24h ≤10%** _(19.07: ≤25%→≤10%; бэктест: win avg p24h=0.7%, stop avg=16.4%; 0 побед выше 5%)_ + **OI30m ≤2.5%** _(19.07: новый гейт; стопы avg=4.33%, победители avg=0.78%)_ | Прямой / OI Watch                                       | 18 сигн. · 33% hit+10% · 33% SL · avg*peak 9.7% · **EV +0.4** *(до фильтров 19.07)\_               |
| ⚡ `impulse_buy` **Импульсная покупка**                         | Последняя закрытая 30m свеча: бычье тело ≥2%, объём ≥1.5x среднего предыдущих 20 свечей, закрытие в верхних 35% диапазона; funding ≥−0.1%, OI1h ≤20% и Spot Volume ≥2x без верхнего предела (OI4h и CVD — только телеметрия с 2026-10-10); p24h ≥5% и <10% запрещает новые IB; missing telemetry fail-open                           | Прямой                                                  | p24h weak-band исключение согласовано владельцем; +10% разрешено, текущие позиции не затрагиваются |
| 🩷 `neon_support_bounce` **Neon Support — Отскок от поддержки** | Отдельный сетап отскока от зоны поддержки Neon Support; результаты учитываются независимо от Stealth Breakout и его provenance-методов                                                                                                                                                                                             | Прямой                                                  | В сборе                                                                                            |
| 📤 **Киты L12 (On-Chain)** _(не паттерн)_                       | Whale Transfer ≥$10M: withdrawal с биржи → пул `whale_onchain_pool` (24ч) + инжект в скан как L12; deposit + активный сигнал = ⛔ предупреждение в Telegram                                                                                                                                                                        | Инжект токенов в батч; стандартные паттерны применяются | —                                                                                                  |

> **Удалены и сохранены только для истории в БД:**
>
> - `balanced_grind` — новые сигналы отключены; история и сопровождение уже открытых позиций сохранены.
> - `dip_accumulation`, `spot_trend_accumulation`, `spot_divergence`, `quiet_oi_accumulation`, `volume_taker`, `spot_absorption`, `spot_vol_breakout`, `spot_taker_lead`, `early_vol_oi`, `spot_oi4h_build`, `short_squeeze`, `accumulation_breakout`
> - `oi24h_accumulation` — удалён 2026-07-15 (море ложных сигналов)
> - `daily_oi_accum_experiment` (OI2д) — удалён 2026-07-18 (перенесён в отдельный трекер, сигналы не выдаёт)
> - `whale_watch`, `bid_wall_absorption`, `liq_magnet_squeeze`, `exchange_outflow_accum`, `oversold_reversal`, `smart_money_divergence`, `4h_momentum`, `oi1h_breakout`, `bingx_exclusive`, `oi4h_silent_accum`, `quiet_trend_rider` — удалены 2026-07-19 (чистка: отрицательный или незначимый EV по бэктесту 90д)
> - `ob_smart_accumulation` — удалён 2026-07-24 (паттерн L14/spot_ob_pool полностью удалён; бэктест не собран)

> **Примечание:** `liquidation_cascade` из этого списка НЕ удалён. Старая реализация (scanner.ts) удалена 2026-07-15, но паттерн был одновременно переработан в **L10 фоновый job** (`_runLiqCascadeFireCycle` в watcher.ts, каждые 3 мин). Job активен и выдаёт реальные сигналы.

---

### ⚙️ Прочее

- **📐 CG-латентность (2026-07-15):** строка «Scan complete» содержит телеметрию CoinGlass (cgReq/cgReqPerMin/cgTimeoutPct/cgP50/p95/max) + лаг event loop (elLagP50/p95/max) за окно цикла. Инструментированы только OI-батч и SpotCVD (горячие пути с circuit breaker) — cgReqPerMin занижает общий CG-трафик. Интерпретация: высокий elLagP95 (сотни мс) = инстанс захлёбывается; низкий elLag + высокий cgP95 = медленный CoinGlass. Решение по глобальному лимитеру (~4 req/s) и таймауту OI 5с→8с отложено до дня данных
- **🧪 Stealth Breakout — экспериментальная детекция (с 28.10.2026, live):** раз в час после закрытия 1H свечи сканируются все USDT-фьючерсы BingX (кроме BTC). Условия: закрытие выше максимума предыдущих 24 свечей; за предыдущие 24 свечи такого закрытия не было; диапазон предыдущих 72 свечей ≥16%; рост к закрытию 24 свечи назад ≥+4,36%; монете ≥800 ч; стоп = пробитый 24ч-максимум −1%, ниже входа больше чем на 0,3%. Сопровождение в трекере: при +1R стоп в Б/У, затем трейлинг 1R от пика, закрытие через 72 ч. Старая детекция (тихая зона / Range ARMED) не стреляет. Код: `stealth-fresh-high.ts`, `runStealthFreshHighProtection` в watcher. Бэктест: `reports/full/analysis/stealth_r_exits.py`.
- **🛡 Стопы:** стоп паттерна фиксирован (`PATTERN_MAX_STOP`): Impulse Buy и Stealth −8%, остальные (включая LC) −10% (BTC −1%); heatmap может только углубить, но кламп не даёт выйти за лимит. Закрытие по стопу пишется ровно по уровню (−стоп%, цена = вход × (1 − стоп%)), без перелёта опроса (`exactStopFill`).
- **📊 Метрики входа (2026-07-15):** trackSignal универсально обогащает ВСЕ сигналы: OI 30m/1h/4h + CVD 30m/1h/4h + futVolMult добираются из prescanTracker (params приоритет), плюс новые entryRsi1h (CoinGlass), entryFundingRate (BingX raw decimal), entryBtc24h (рыночный режим), entryWhaleIndex (пер-токенный Whale Index); всё fail-open с таймаутом 4с
- **🐳 Пер-токенный Whale Index (2026-07-15):** CoinGlass whale-index/history по токену (Binance-фьючерсы, 4h) — строка в алерте после BTC-строки (пороги ±10 условные, чисто инфо) + entryWhaleIndex в tracked_signals. Тянется только при выстреле сигнала (кэш 10 мин / null 60 мин, через cgTimedFetch). Покрытие неполное: BingX-эксклюзивы и часть мелочи (PEPE → 500) данных не имеют — fail-open. Статистика 2-3 недели прежде чем пускать в скоринг. Схема в прод: идемпотентные ALTER в runStartupMigration (entry_rsi_1h/funding/btc_24h/whale_index)
- **⚠️ HighRisk «свежий мувер» (2026-07-15):** сигнал по токену с <3 циклов в прескане + price24h ≥5% получает предупреждение в Telegram-алерте (не блокируется). Основание: 30д статистика — 43% отмен в этом сегменте; growth-leader анализ (1616 записей) — муверы без futures-истории дампят в 46% при p24h 10–20%, дальше растут только 11%
- **🔒 Unlock-фильтр:** CoinGlass `coin-unlock-list` (4h кэш) — блок сигнала если разлок ≤3 дн + ≥1% supply (не watchlist, не BTC/ETH); предупреждение в алерте при 4–7 дн; fail-open если CG недоступен
- **Stale cancel:** сигнал автоотменяется через 3ч если пик < 2%
- **entrySpotVolMult:** записывается универсально для всех сигналов confirmed-fire пути (мост из loop1), не только spot*vol*\* паттернов
- **🐋 Whale Tracker:** ежедневные OI-снимки, еженедельный отчёт (Сб 10:00 МСК)
- **Telegram:** уведомления на русском, метки скорости 🚀/⏳/⚠️, price confirmation
- **Дайджесты:** ежедневный / еженедельный / ежемесячный
- **UI:** настройка порогов через страницу Settings, авто-обновление 5–10с

## Key Commands

- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- `pnpm --filter @workspace/api-server run dev` — run API server locally

## Required Secrets

- `BINGX_API_KEY` — BingX API key
- `BINGX_API_SECRET` — BingX API secret
- `TELEGRAM_BOT_TOKEN` — Telegram bot token
- `TELEGRAM_CHAT_ID` — Telegram chat ID for alerts

## Правило данных

Анализ и все фильтры используют ТОЛЬКО агрегированные данные (CoinGlass, мульти-биржа). Никаких запасных источников BingX/одной биржи; нет данных — нет сигнала.

## Правила проекта

- Все данные, логи и проверки — только по PRODUCTION-базе (executeSql с environment:"production"). Dev-базу не использовать никогда. Нет доступа к prod — так и написать, не подменять dev.
- Данные только агрегированные CoinGlass. Нет данных — нет сигнала. Никаких фоллбэков.
- Длительность цикла скана не увеличивать.
- Причину называть только после того, как найдена конкретная строка в БД по этому символу и времени. Нет строки — писать «не знаю».
- Не писать «опубликовано», «работает», «исправлено» без проверки на проде.
- Любую правку доказывать на том самом случае, из-за которого она делалась.
- Не выдумывать правила выхода, пороги и причины — только из кода и данных, со ссылкой файл:строка или SQL.
- Делать только то, что попросили. Без лишних анализов, таблиц и предложений.

## Состояние на 20.10

Изменено 18–20.10:

- Stealth/PAID: 1H-история 100–199 баров — ослабление ATR; 48 ч ожидания для взведённых Auto Range, пропавших из universe.
- Neon: при закрытой 4H ниже низа зоны −1% мёртвое qualified-событие освобождается, детектор берёт зону ниже.
- Neon: в `scan_reject_log` колонки `zone_bottom`/`zone_top` (обязательный startup-gate).
- Impulse Buy: запасной per-symbol taker/CVD.
- PLM: p24h ≥ 5; 4 позиции PLM закрыты нейтрально.
- CoinGlass: склейка одновременных запросов уже есть (`inflight` в governor); `duplicateRequests` считает повторы друг за другом, ключ без `page`/`exchange`.
- Память процесса: RSS 387→720 и 671→781 МБ за циклы 46–47, плато не достигнуто.

Сделано, не опубликовано (после деплоя 12:24 UTC):

- Neon: зона события берётся через `resolveFrozenZone`, освобождение не зависит от текущей цены.
- `computeSupportZones` и `ABNeon_SR_tf_independent.pine`: соседние кластеры с равным числом пивотов в зоне подавления объединяются; тест на реальных 4H JCT до 18.10 20:00.
- Neon: `qualified` без входа закрывается через 72 ч (`qualified_no_entry_72h`).
- Pine нужно загрузить в TradingView вручную.

Ждёт проверки после публикации:

- JCT: событие 401292 стало `terminal`; зона 18.10 20:00 = 0,001606–0,0018.
- Заполнение `zone_bottom`/`zone_top` в `scan_reject_log`.
- Влияние объединения кластеров на зоны других символов.
- Объём ≥1,5× на 1H 21:00 18.10 по JCT: исторические данные недоступны.
- IB: `fut_taker_unavailable` (229/243 из 501/509) и `cvd_unavailable` (186/189) — цель ~0 не достигнута; входил ли fallback в опубликованную сборку, неизвестно.
- RSS процесса: плато не подтверждено.
- Причина недоступности списка разлоков 18.10 18:46 – 19.10 11:09 UTC не разобрана.
