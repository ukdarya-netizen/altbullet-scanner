# Liquidation Cascade final study — 26 Nov 2026

## Источники и ограничения

- Production-выгрузка: 17 A-сигналов; 4001 B-watch без связанного сигнала; 1809 C-champion episodes, найденных по BingX 15m.
- Прогон на 2026-11-26T10:30:00.000Z UTC; цены — только сохранённые BingX 15m свечи. Для будущих относительно последней закрытой свечи участков исходы помечены censored.
- C-champion: падение ≥8% от максимума предыдущих 16×15m свечей, затем +10% до −10% в следующие 72 часа; одинаковая 15m свеча с обоими барьерами помечалась бы ambiguous.
- Агрегаты CoinGlass запрашивались один раз на монету и временное окно, только для непокрытых интервалов; все exchange_list взяты из встроенного списка CAB (futures/spot). Успешно пустые диапазоны сохранены как no_data.
- CoinGlass: 3277 HTTP-попыток, 2 неуспешных диапазонов, 33 ответов 429; endpoint funding не поддержан / вернул ошибку.
- Возобновление из кэша: учтены 3276 попыток предыдущего процесса, 1 неуспешный диапазон и 33 ответов 429. Подробности предыдущей ошибки не были сохранены; в отчёте учтено только её количество.
- Отсутствующие показатели вынесены по каждой метрике в missing-metrics.csv; «not_recorded_by_bot» означает, что точное значение не было сохранено ботом, а не нулевое значение.
- В рабочем дереве не найден предыдущий reports/lc-final-1126 и на upstream cab-sync-fixes этой папки нет; поэтому сравнение «с первым прогоном» невозможно. Вместо этого сохранено прямое сравнение агрегата CoinGlass с BingX-объёмом в metrics-compare.csv.

## A/B/C: исходы 5 дней

| Cohort | Всего | Champion (+10 до −10) | Bad (−10 до +10) | Open | Ambiguous | Censored |
|---|---:|---:|---:|---:|---:|---:|
| A_signal | 17 | 5 | 9 | 2 | 0 | 1 |
| B_watch | 4001 | 862 | 1791 | 1125 | 4 | 218 |
| C_champion | 1809 | 1809 | 0 | 0 | 0 | 0 |

## Gate / причины B

- 4,018 production watches имеют 21 пар стадия/причина в наблюдаемой истории; полные цепочки лежат в events.csv.
- watching:liq_exhausted: 336564
- watching:liq_not_exhausted: 115347
- watching:liq_data_unavailable: 12087
- watching:liq_spike: 3984
- expired:no_signal_12h: 2099
- expired:no_signal_72h: 1597
- rejected:detection_candle_pending: 1399
- rejected:detection_candle_not_capitulation: 831
- rejected:detection_candle_too_small: 662
- rejected:detection_candle_unavailable: 40
- rejected:no_liquidations_at_detect: 36
- watching:liq_order_stream: 15
- rejected:detection_candle_entry_window_passed: 5
- rejected:spot_taker_negative: 4
- rejected:price24h_crash: 3
- rejected:btc_crowd_long: 3
- rejected:liquidation_cascade_spot_cvd+spot_cvd4h_unavailable: 2
- rejected:wi_neg_and_cvd4h_false: 1
- rejected:liquidation_cascade_whale_index_unavailable: 1
- rejected:liquidation_cascade_spot_cvd+spot_taker+spot_cvd4h_unavailable: 1
- C-champion с ближайшей записью watch/reject и без ближайшего signal: 1498; nearest-match window ±72 ч, причинность не доказана.
- Наиболее активный Dubai-день: 2026-11-09; полная разбивка в mass-days.csv.

## Сравнение агрегата с BingX

- Lucy 120: разные цвета на 2773 из 5313 событий, где оба значения доступны.
- Welkin 20: разные цвета на 3103 событиях с обоими значениями.
- Источники объёма выровнены с CAB: Lucy 120 использует futures+spot aggregate; Welkin 20 и Wyckoff используют агрегированный futures volume.
- MFI/CMF/OBV здесь рассчитаны на 15m OHLC с общим CoinGlass futures+spot volume; это исследовательские 15m значения, отдельно от записанных ботом 1H/4H money-flow метрик.
- BingX quote volume — приближение candle base-volume × close; это не агрегат и показано только для сравнения.
- Неполные метрики отдельно размечены, не трактованы как ноль; всего отсутствующих ячеек detection-anchor: 73173.

## Фактические исходы A и модельные стопы/выходы

- events.csv содержит фактический статус/PnL/пик сигнала и независимые 4h/24h/72h/120h price-path outcomes.
- stop-exits.csv сопоставляет −8%, −10%, −12%, BE после +8% и trailing 15/10, 20/20, 30/30. Внутрисвечные конфликты помечены ambiguous; частичный fill/биржевая ликвидация не моделировались.
- В entry-variants.csv для A показаны вход на детекции, T0, лимиты −3%/−5%, первая зелёная, close выше середины и 15m break предыдущих четырёх максимумов. Цена исполнения в тесте — заданный уровень для limit-варианта.
- account-scenarios.csv: $1,000 notional соответствует $100 initial margin при 10×; dollar PnL = return% × $10. Реальную ликвидацию/top-up не симулировал: исторические maintenance margin и автопополнения не записаны в production-источниках.

## Данные

- 59521 строк сравнения метрик; 73173 пропусков; 40789 stop/exit симуляций; 83 вариантов входа.
- Большие таблицы events.csv, metrics-compare.csv, missing-metrics.csv, path-outcomes.csv, stop-exits.csv и rejected-champions.csv упакованы в data-exports.tar.gz; распаковка: `tar -xzf data-exports.tar.gz`.
- Отдельные файлы: gate-attribution.csv, mass-days.csv, entry-variants.csv, account-scenarios.csv, errors.json, run.txt, summary.md, study.ts.
