WITH obs AS (
  SELECT o.* FROM liq_cascade_candidate_observations o WHERE o.watch_id IN (SELECT id FROM liq_cascade_watch WHERE detected_at >= '2026-09-01')
), cnt AS (SELECT watch_id, count(*) n FROM obs GROUP BY watch_id),
gate AS (
  SELECT DISTINCT ON (watch_id) watch_id, stage, reason, observed_at, price, metrics FROM obs
  WHERE reason LIKE 'detection_candle%' OR reason IN ('no_lower_wick_reaction','wick_data_unavailable')
  ORDER BY watch_id, observed_at DESC),
lastobs AS (SELECT DISTINCT ON (watch_id) watch_id, stage, reason, observed_at FROM obs ORDER BY watch_id, observed_at DESC)
SELECT w.*,
  t.id AS tracked_signal_id, t.signal_id AS signals_table_id, t.signal_type AS tracked_signal_type, t.status AS tracked_status,
  t.detected_at AS entry_time, t.entry_price,
  cnt.n AS observations_count,
  g.stage AS gate_stage, g.reason AS gate_reason, g.observed_at AS gate_observed_at, g.price AS gate_obs_price,
  g.metrics->>'detectionCandleRangePct' AS gate_candle_range_pct,
  g.metrics->>'detectionCandleLowerWickPct' AS gate_candle_lower_wick_pct,
  g.metrics->>'minRangePct' AS gate_min_range_pct,
  g.metrics::text AS gate_metrics_json,
  l.stage AS last_obs_stage, l.reason AS last_obs_reason, l.observed_at AS last_obs_at
FROM liq_cascade_watch w
LEFT JOIN tracked_signals t ON t.id = w.signal_id
LEFT JOIN cnt ON cnt.watch_id = w.id
LEFT JOIN gate g ON g.watch_id = w.id
LEFT JOIN lastobs l ON l.watch_id = w.id
WHERE w.detected_at >= '2026-09-01'
ORDER BY w.detected_at, w.id;
