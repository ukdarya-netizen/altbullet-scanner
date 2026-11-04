# Аудит теневых сообщений сопровождения

Новые условия **ничего не отправляют в Telegram и не меняют торговые выходы**. Каждая плановая проверка открытой позиции записывает теневой ценовой результат (`delivery_status = 'shadow_price_v1'`) рядом со старым наблюдением. Начало forward-когорты — время фактического первого такого события после развёртывания, а не дата написания кода.

## Зафиксированная гипотеза

Сначала действующая классификация OI/оборота/CVD даёт исходное состояние. Новое условие требует цены, известной в момент проверки: текущая котировка против закрытий 30-минутных свечей примерно за 1 и 4 часа до проверки. Обе опорные свечи должны закрыться **не раньше открытия позиции**; открытые, отсутствующие и устаревшие свечи не подтверждают сигнал.

| Тип | Дополнительное подтверждение |
| --- | --- |
| ДЕРЖИ | изменение за 1 ч ≥ +0,5% и за 4 ч ≥ +0,5% |
| СЛЕДИ | за 1 ч ≤ −0,5% и за 4 ч ≤ 0% |
| РАССМОТРИ ВЫХОД | за 1 ч ≤ −1% и за 4 ч ≤ −1% |

Это **гипотеза**, а не доказанная точность и не паттерн-специфичная калибровка. Старый `baseline_state` фиксирует уже откалиброванное для паттерна состояние, а `raw_state` — исходное: можно увидеть и ранее подавленные `HOLD`. `shadow_reason` отличает нехватку цен от отказа по направлению. Старые события `shadow_only` не переписываются. Показатели +4/+8/+24 часа заполняются существующим наблюдателем только в допустимом временном окне; пропущенный слот остаётся NULL.

## Проверка спустя семь полных суток наблюдения

В production (read-only) сначала проверить реальное начало/охват:

```sql
SELECT sentiment_key, COUNT(*) checks, COUNT(DISTINCT signal_id) positions,
       COUNT(*) FILTER (WHERE shadow_reason IN ('missing_reference', 'reference_before_entry')) missing_or_pre_entry,
       COUNT(*) FILTER (WHERE shadow_reason = 'confirmed') price_confirmed,
       MIN(sent_at) first_at, MAX(sent_at) last_at
FROM signal_health_events
WHERE delivery_status = 'shadow_price_v1'
GROUP BY sentiment_key ORDER BY sentiment_key;
```

Следующий запрос сравнивает **первое подтверждённое событие каждого типа для каждой позиции**. Последовательность должна содержать две проверки того же типа с интервалом 3–6 часов; повторные проверки одной позиции не увеличивают N. Пропуски исходов не приравниваются к ошибке. Сравнивать новые правила со старой линией **на одной и той же forward-когорте**, а не с другим месяцем:

```sql
WITH checks AS (
  SELECT e.*,
    lag(message_type) OVER w AS prev_price_state,
    lag(baseline_state) OVER w AS prev_baseline_state,
    lag(sent_at) OVER w AS prev_at
  FROM signal_health_events e
  WHERE e.delivery_status = 'shadow_price_v1'
  WINDOW w AS (PARTITION BY signal_id ORDER BY sent_at, id)
), candidates AS (
  SELECT 'price_confirmed' AS policy, sentiment_key, signal_id,
         message_type AS advice, sent_at, price_4h_pct, price_8h_pct, price_24h_pct
  FROM checks
  WHERE message_type IN ('hold', 'follow', 'exit')
    AND message_type = prev_price_state
    AND sent_at - prev_at BETWEEN interval '3 hours' AND interval '6 hours'
  UNION ALL
  SELECT 'baseline', sentiment_key, signal_id, baseline_state,
         sent_at, price_4h_pct, price_8h_pct, price_24h_pct
  FROM checks
  WHERE baseline_state IN ('hold', 'follow', 'exit')
    AND baseline_state = prev_baseline_state
    AND sent_at - prev_at BETWEEN interval '3 hours' AND interval '6 hours'
), firsts AS (
  SELECT DISTINCT ON (policy, signal_id, advice) *
  FROM candidates
  ORDER BY policy, signal_id, advice, sent_at
)
SELECT policy, sentiment_key, advice, COUNT(*) positions,
       COUNT(price_4h_pct) n4,
       ROUND(AVG(price_4h_pct)::numeric, 2) avg4,
       COUNT(price_8h_pct) n8,
       ROUND(AVG(price_8h_pct)::numeric, 2) avg8,
       COUNT(price_24h_pct) n24,
       ROUND(AVG(price_24h_pct)::numeric, 2) avg24,
       COUNT(*) FILTER (WHERE price_8h_pct > 0) up8
FROM firsts
GROUP BY policy, sentiment_key, advice
ORDER BY sentiment_key, advice, policy;
```

Разделить паттерны, а также active/in_run и уже закрытые позиции. Для «ДЕРЖИ» проверять продолжение после сообщения, для «СЛЕДИ» — предупреждение о падении/защитном выходе, для «РАССМОТРИ ВЫХОД» — преимущество исполнимого раннего выхода, **не только знак цены через 8 часов**. Проверить, не произошёл ли реальный выход до горизонта. Семь дней могут дать недостаточно независимых событий; тогда честный вывод — «пока неизвестно», не настройка порога по той же неделе. Пороги этой недели не менять во время сбора.