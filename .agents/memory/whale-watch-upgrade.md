---
name: Whale Watch tightening 2026-07-15
description: whale_watch burst-fix — OI 1.5%→3%, blacklist, CVD/OI1h gates, spot vol 0.5%→1%; справочник обновлён в обоих местах
---

## Проблема
Burst 28 мая: 15+ токенов за один день (LINK, APT, NEAR, TONCOIN, FARTCOIN, 1000PEPE, XMR и др.), всё cancelled.
82% cancellation rate за всю историю (28/34 сигналов).
Причина: OI≥1.5% при рыночном движении срабатывал на любой фоновый шум.

## Что изменено в scanner.ts

| Параметр | Было | Стало |
|----------|------|-------|
| OI порог на этап | ≥1.5% | ≥3.0% |
| Blacklist | BTC/ETH/SOL | + LINK/APT/NEAR/TONCOIN/FARTCOIN/1000PEPE/XMR |
| Sideways fallback | \|price\|≤1.0% | \|price\|≤0.5% + OI≥5.0% |
| OI нарастание | не проверялось | каждый стейдж ≥ предыдущего − 1% |
| CVD gate при fire | нет | cvd1h===false → блок (fail-open) |
| OI 1h gate при fire | нет | oi1h < 1.5% → блок (fail-open) |
| SpotVol MCap% | 0.5% | 1.0% |

## Где хранится OI стейджа
`whaleWatchStages[].buyPct` поле переиспользовано для хранения OI значения (а не taker%).
Настоящий taker доступен в `wwSpotTaker`.

## Справочник обновлён
1. `scanner-patterns.ts` — PATTERN REFERENCE comment (block 14) + SentimentKey строка `whale_watch`
2. `replit.md` — строка 19 таблицы паттернов

**Why:** синхронизация документации с кодом критична — старый справочник (OI≥1.5%, SpotVol≥0.15%) 
создавал расхождение с реальным поведением системы.
