---
name: BW/SpBW/SW/SpSW retired
description: Колонки стен BW, SpBW, SW, SpSW и все запросы к ним удалены (2026-10-22)
---
Владелица: эти колонки больше не отслеживаем, нигде в интерфейсе быть не должно. Не возвращать UI, API-поля, CoinGlass large-order запросы, строки в Telegram.

**Why:** прямое решение владелицы.
**How to apply:** DB-колонки large_bid_*/spot_bid_*/large_ask_*/spot_ask_* и liq_cascade_watch.large_bid_usd оставлены (история, ALTER в index.ts), новые строки пишут null. Удалены также LC liquidity shelf отчёт/панель и bid-близость в lc-repeat-watch. OB ratio (bidAskRatio) не затронут.
