---
name: Confusion matrix pilot — 18 patterns
description: Результаты честной confusion matrix по 18 паттернам (n=12,057, 77 символов, 30д, лейбл +20% за 12ч)
---

## Датасет
- **confirmed_pump**: 767 строк из `retro_pre_growth` (hours_before=4, T-4h snapshot, label_win=1)
- **full_scan**: 11,290 строк (77 символов prescan_tracker, 4h интервал, 30 дней, label_win от CoinGlass OHLCV)
- **Итого**: 12,057 снапшотов, 1,198 wins (9.9%)
- **DuckDB**: `artifacts/archetype-detector/crypto_data.duckdb` → таблица `market_snapshots`
- **CSV**: `artifacts/archetype-detector/pipeline/confusion_matrix_results.csv`

## Результаты (sorted by EV)

| Pattern | Trig | Prec% | EV | Статус |
|---------|------|-------|-----|--------|
| whale_futures | 144 | 86% | +7.22 | ⭐ STAR |
| flush_reversal | 59 | 73% | +5.12 | ⭐ сильный |
| trend_accumulation | 19 | 74% | +4.74 | ⭐ мало данных |
| 4h_pullback_continuation | 553 | 50% | +0.05 | ✓ маржинальный |
| whale_watch | 83 | 45% | +0.02 | ✓ маржинальный |
| quiet_trend_rider | 506 | 45% | −0.99 | ✗ |
| oi4h_silent_accum | 673 | 44% | −1.23 | ✗ |
| bid_wall_absorption | 740 | 28% | −3.01 | ✗ проблемный |
| 4h_momentum | 691 | 33% | −3.40 | ✗ проблемный |
| spot_vol_accumulation | 1074 | 10% | −3.55 | ✗ проблемный |
| oi1h_breakout | 377 | 32% | −3.63 | ✗ проблемный |
| smart_money_divergence | 751 | 29% | −4.14 | ✗ проблемный |
| oversold_reversal | 1409 | 5% | −4.21 | ✗ критично |
| bullish_accumulation | 46 | 26% | −4.78 | ✗ |
| bingx_exclusive | 2826 | 24% | −5.15 | ✗ критично |
| liquidation_cascade | 456 | 10% | −6.18 | ✗ критично |
| liq_magnet_squeeze | 0 | n/a | n/a | ❌ никогда не стреляет |
| exchange_outflow_accum | 3 | 100% | +10.00 | ⚠️ мало данных |

## Методологические ограничения (важно!)
1. **Bias символов**: 77 символов из prescan_tracker — уже замеченные сканером, не случайная выборка
2. **cvd=None**: cvd_1h/cvd_30m=None в full_scan → CVD-зависимые паттерны работают fail-open (завышает их precision)
3. **Лейбл**: +20% за 12ч vs продакшн +10% (другой threshold → разные TP/FP)
4. **Цены Binance**: BingX-exclusive токены (LONGXIA, BITLIGHT, BLEND) пропущены в full_scan
5. **exchange_outflow, trend_accum**: малая выборка (3 и 19 trig) → ненадёжные оценки

## Технические детали пайплайна
- `hours_before = 4` (не -4 и не -4 в ретро-данных — значения положительные!)
- Дубли в retro_pre_growth: DISTINCT ON (g.id) + одна строка WHERE hours_before=4
- OI Coinalyze: батч 8 символов, format {t: unix_s, c: oi_usd}; symbol=BTCUSDT_PERP.A
- CoinGlass OHLCV: {time: ms, open/high/low/close: str, volume_usd: str} — все строки!
- None-safety: oi/price/vol/spot_net_pct/funding → 0.0 перед check_patterns; cvd=None → fail-open
- upsert_snapshot_batch: pandas+staging table (не 19-placeholder INSERT OR REPLACE)

## liq_magnet_squeeze — почему 0 тригов
Требует `getLiqMapClusters` — данные кластеров ликвидаций недоступны в статическом снапшоте.
`check_patterns` в retro_analysis.py, вероятно, пропускает эту проверку или возвращает False без данных.
