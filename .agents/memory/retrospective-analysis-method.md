---
name: Retrospective multi-source analysis method
description: How to fetch and cross-reference historical data for specific tokens (BingX klines, Coinalyze OI, CoinGlass FutTkr) for missed-signal post-mortems.
---

## Setup

- Samara = UTC+4 (no DST). Samara 08:00 = UTC 04:00.
- Always define `fromMs` / `toMs` as `Date.UTC(...)` milliseconds.

## Data sources

| Source | API | Symbol format | Notes |
|--------|-----|--------------|-------|
| BingX klines | `/openApi/swap/v3/quote/klines` | `VELVET-USDT` | Returns newest-first; sort ascending. `startTime`/`endTime` work correctly here. |
| Coinalyze OI | `/v1/open-interest-history` | `VELVETUSDT_PERP.A` (remove hyphen, add `_PERP.A`) | `from`/`to` in seconds. Returns ascending. |
| CoinGlass FutTkr | `/api/futures/taker-buy-sell-volume/history` | Binance:`VELVETUSDT`, Bybit:`VELVETUSDT`, BingX:`VELVET-USDT` | **`startTime`/`endTime` params are broken** — return from current time. Use `limit=560+` and filter by `time >= fromMs && time <= toMs` after fetch. For 5-day-old data: 134h × 4 candles/h = 536 min limit. |
| BingX baseline vol | Same klines endpoint | 7d window ending at `fromMs`, `limit=336` | avgVol = mean of 336 candles. |

## FutTkr aggregation to 30min

```js
const slot = Math.floor(c.time / (30*60*1000)) * (30*60*1000);
// sum buy+sell across Binance+Bybit+BingX per slot
ftPct = (buy - sell) / (buy + sell) * 100
```

## Token behavior archetypes (from EVAA / JOTCHUA / VELVET analysis)

| Token | Archetype | Best early signal | Lead time | Key trap |
|-------|-----------|------------------|-----------|----------|
| EVAA | OI-slow, flat price | OI +0.23% reversal | −2h | OI too small (<0.5%) vs scanner thresholds |
| JOTCHUA | Taker-aggressive, BingX-exclusive | FutTkr +13.7% at falling price | −4h | No OI data at all |
| VELVET | Volume+taker from candle 1 | FutTkr ≥+8.8% + Vol ≥1.68x | 0 (simultaneous) | Shake-out −9.3% Vol 7.47x at t+2.5h wipes stops |
| AKE (Jul 15 2026) | Zero-footprint vertical launch | None exists — OI was FALLING pre-pump, vol flat, ignition candle +38.9%/15m at only 2.3x vol | none | OI follows price (16.5B→48B AFTER move); p24h >40% within 1 candle → overheat filter correctly bans entry; uncatchable by design |

## VELVET shake-out pattern (Jun 9 2026)

1. Early accumulation 08:00–10:00 Samara: Vol 1.25–2.63x, FutTkr +2–9%, OI +0.1–1.0%
2. Shake-out at 10:30 Samara: **Vol 7.47x, OI −2.28%, price −9.3%** — stop-loss trigger
3. Second dip 11:30: price hits absolute low (−16% from open)
4. Recovery bounce 12:00: FutTkr +8.1%, Vol 3.76x, price +14.7% single candle
5. 6h trend run: +58% total range

**Why:** Classic retail-stop hunt before main move. Entry at first signal (0.337) → stop −10% = 0.303; actual low = 0.290 → stop triggered. Real move (0.290→0.459) happens during symbol cooldown ban.

## What would help for shake-out tokens

- Wider initial stop (−15%) gated on Vol ≥5x shake-out candle detection
- Or: re-entry after shake-out if price recovers ≥5% within 2 candles and OI resumes positive
