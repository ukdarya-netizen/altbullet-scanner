---
name: CoinGlass new patterns confusion matrix — 4-pattern research
description: Findings from confusion matrix analysis of 4 new CG-based patterns; reasons all 4 were rejected; Part 2 forward accumulation jobs written.
---

## Паттерны отклонены — не деплоить

Полный анализ (train=12,731 / test=4,866, excl. confirmed_pump, base_rate_test=3.0%).

| Паттерн | Данные | n_test | prec_test | verdict |
|---------|--------|--------|-----------|---------|
| LS Ratio (Sentiment Divergence) | ❌ API 404 | — | — | нет данных |
| CDRI (Extreme Risk Reversal) | ❌ API 404 | — | — | нет данных |
| funding<-0.001+price>0 | funding_rate_8h | 299 | 4.3% | -EV |
| CVD Absorption (cvd_1h<0) | cvd_1h | 0 | — | cvd=0 fires |
| CB Premium > 0 | coinbase_premium_rate | 0 | — | 0 test fires |

## Критические находки

1. **confirmed_pump rows всегда label_win=1** — любой паттерн, попадающий на исторические
   pumped-токены, получает ложно высокий precision. Всегда исключать из честного анализа.

2. **CB Premium 100% negative** в датасете May-Jul 2026. Положительный premium — 0 строк
   в test-сете. Не использовать CB>0 как сигнал в текущем режиме.

3. **cvd_1h в market_snapshots всегда ≥ 0** (186 строк, 0 с cvd<0). CVD Absorption
   не имеет данных для тестирования.

4. **LS Ratio и CDRI отсутствуют** в CoinGlass API v4 — 30+ попыток URL, docs: "Page Not Found".

5. **funding_rate_8h покрытие**: 13,019/17,597 (182 из 224 символов через Binance endpoint).
   Lift слабый (test: 4.3% vs base 3.0%), EV отрицательный.

## Правило: correct train/test cutoff

DuckDB `snapshot_ts_ms` — миллисекунды. Correct 70/30 cutoff = 1783497600000 ms
(= 2026-07-07 08:00 UTC). Значение 1751846400000 — это июль 2025 (train будет пустым).

**Why:** ms vs seconds путаница; числа 10^12 vs 10^9 — проверять через datetime.utcfromtimestamp(v/1000).

## Part 2 forward-accumulation jobs (written, prod-ready)

- `whale-event-tracking-job.ts`: T0/T+1h/T+4h/T+12h/T+24h/T+48h checkpoints из whale_alert_pool
- `heatmap-periodic-job.ts`: liq-кластеры для top-prescan символов каждые 4h
- `netflow-collection-job.ts`: taker netflow снапшот каждые 15 мин (100 CG символов)

Таблицы создаются в runStartupMigration: whale_event_tracking, periodic_collection_log,
cg_liq_heatmap_snapshot (UNIQUE +cluster_price!), cg_netflow_snapshot.

**Важно**: heatmap_snapshot UNIQUE = (symbol, range, snapshot_at, cluster_price) — 
не просто (symbol, range, snapshot_at), иначе INSERT 10 кластеров подряд конфликтует.
