-- Impulse Buy immutable entry-metric + forward-path capture.
-- Production SELECT only; one statement snapshot gives one frozen as-of cohort.
-- No status/policy/UI cutoff is applied. Metrics come only from the linked
-- pattern_decision_snapshots.entry_metrics and its immutable provenance.
WITH
asof AS MATERIALIZED (
  SELECT statement_timestamp() AS asof_at
),
horizons(horizon_hours) AS (
  VALUES (1), (3), (6), (12), (24), (72)
),
cohort AS MATERIALIZED (
  SELECT
    d.id AS snapshot_id,
    d.tracked_signal_id AS tracker_id,
    d.symbol,
    d.decision_at AS detected_at,
    t.closed_at,
    t.status::text AS status,
    t.cancel_reason,
    t.entry_policy_version,
    t.policy_version AS exit_policy_version,
    t.split_filled_at,
    t.original_entry_price,
    t.entry_price AS current_entry_price,
    t.peak_price,
    t.pnl_percent,
    d.entry_price AS snapshot_entry_price,
    d.entry_metrics,
    d.source AS snapshot_source,
    d.provenance AS snapshot_provenance,
    d.completeness AS snapshot_completeness,
    d.created_at AS snapshot_created_at
  FROM pattern_decision_snapshots AS d
  JOIN tracked_signals AS t ON t.id = d.tracked_signal_id
  CROSS JOIN asof AS a
  WHERE d.tracked_signal_id IS NOT NULL
    AND d.event_key = 'tracked:' || d.tracked_signal_id::text
    AND d.pattern_key = 'impulse_buy'
    AND d.decision_kind = 'fired'
    AND d.decision_at <= a.asof_at
),
frozen_rows AS MATERIALIZED (
  SELECT
    c.*,
    CASE
      WHEN c.original_entry_price > 0 THEN c.original_entry_price
      WHEN c.current_entry_price > 0 THEN c.current_entry_price
      ELSE NULL
    END AS basis_entry_price,
    CASE
      WHEN c.original_entry_price > 0 THEN 'original_entry_price'
      WHEN c.current_entry_price > 0 THEN 'entry_price_fallback'
      ELSE 'unavailable'
    END AS basis_price_source,
    CASE WHEN jsonb_typeof(c.entry_metrics->'entry_spot_taker_net_buy') = 'number'
      THEN (c.entry_metrics->>'entry_spot_taker_net_buy')::numeric END
      AS entry_spot_taker_net_buy_pct,
    CASE WHEN jsonb_typeof(c.entry_metrics->'entry_fut_taker_net_buy') = 'number'
      THEN (c.entry_metrics->>'entry_fut_taker_net_buy')::numeric END
      AS entry_fut_taker_net_buy_pct,
    CASE WHEN jsonb_typeof(c.entry_metrics->'entry_fut_vol_mult') = 'number'
      THEN (c.entry_metrics->>'entry_fut_vol_mult')::numeric END
      AS entry_fut_vol_mult,
    CASE WHEN jsonb_typeof(c.entry_metrics->'entry_spot_vol_mult') = 'number'
      THEN (c.entry_metrics->>'entry_spot_vol_mult')::numeric END
      AS entry_spot_vol_mult,
    CASE WHEN jsonb_typeof(c.entry_metrics->'entry_spot_net_buy_1h') = 'number'
      THEN (c.entry_metrics->>'entry_spot_net_buy_1h')::numeric END
      AS entry_spot_net_buy_1h_pct,
    CASE
      WHEN jsonb_typeof(c.entry_metrics->'candleVolumeMult') = 'number'
        THEN (c.entry_metrics->>'candleVolumeMult')::numeric
      WHEN jsonb_typeof(c.entry_metrics->'decision_metrics'->'candleVolumeMult') = 'number'
        THEN (c.entry_metrics->'decision_metrics'->>'candleVolumeMult')::numeric
      WHEN jsonb_typeof(c.entry_metrics->'impulse_decision_metrics'->'candleVolumeMult') = 'number'
        THEN (c.entry_metrics->'impulse_decision_metrics'->>'candleVolumeMult')::numeric
    END AS trigger_candle_volume_mult,
    CASE
      WHEN jsonb_typeof(c.entry_metrics->'candleVolumeUsd') = 'number'
        THEN (c.entry_metrics->>'candleVolumeUsd')::numeric
      WHEN jsonb_typeof(c.entry_metrics->'decision_metrics'->'candleVolumeUsd') = 'number'
        THEN (c.entry_metrics->'decision_metrics'->>'candleVolumeUsd')::numeric
      WHEN jsonb_typeof(c.entry_metrics->'impulse_decision_metrics'->'candleVolumeUsd') = 'number'
        THEN (c.entry_metrics->'impulse_decision_metrics'->>'candleVolumeUsd')::numeric
    END AS trigger_candle_volume_usd,
    CASE
      WHEN jsonb_typeof(c.entry_metrics->'baselineVolumeUsd') = 'number'
        THEN (c.entry_metrics->>'baselineVolumeUsd')::numeric
      WHEN jsonb_typeof(c.entry_metrics->'decision_metrics'->'baselineVolumeUsd') = 'number'
        THEN (c.entry_metrics->'decision_metrics'->>'baselineVolumeUsd')::numeric
      WHEN jsonb_typeof(c.entry_metrics->'impulse_decision_metrics'->'baselineVolumeUsd') = 'number'
        THEN (c.entry_metrics->'impulse_decision_metrics'->>'baselineVolumeUsd')::numeric
    END AS trigger_baseline_volume_usd,
    COALESCE(
      c.entry_metrics->'candleClosedAt',
      c.entry_metrics->'decision_metrics'->'candleClosedAt',
      c.entry_metrics->'impulse_decision_metrics'->'candleClosedAt'
    ) AS trigger_candle_closed_at,
    CASE
      WHEN jsonb_typeof(c.entry_metrics->'candleBodyPct') = 'number'
        THEN (c.entry_metrics->>'candleBodyPct')::numeric
      WHEN jsonb_typeof(c.entry_metrics->'decision_metrics'->'candleBodyPct') = 'number'
        THEN (c.entry_metrics->'decision_metrics'->>'candleBodyPct')::numeric
      WHEN jsonb_typeof(c.entry_metrics->'impulse_decision_metrics'->'candleBodyPct') = 'number'
        THEN (c.entry_metrics->'impulse_decision_metrics'->>'candleBodyPct')::numeric
    END AS trigger_candle_body_pct,
    CASE
      WHEN jsonb_typeof(c.entry_metrics->'candleCloseStrength') = 'number'
        THEN (c.entry_metrics->>'candleCloseStrength')::numeric
      WHEN jsonb_typeof(c.entry_metrics->'decision_metrics'->'candleCloseStrength') = 'number'
        THEN (c.entry_metrics->'decision_metrics'->>'candleCloseStrength')::numeric
      WHEN jsonb_typeof(c.entry_metrics->'impulse_decision_metrics'->'candleCloseStrength') = 'number'
        THEN (c.entry_metrics->'impulse_decision_metrics'->>'candleCloseStrength')::numeric
    END AS trigger_candle_close_strength,
    CASE
      WHEN c.snapshot_completeness->>'legacy' = 'true'
        OR c.snapshot_source LIKE '%legacy%'
        OR c.snapshot_provenance->>'capture' = 'legacy_reconciliation'
      THEN TRUE ELSE FALSE
    END AS snapshot_is_legacy,
    jsonb_build_object(
      'entry_spot_taker_net_buy',
        COALESCE(c.snapshot_provenance#>'{entry_metrics_provenance,entrySpotTakerNetBuy}',
                 c.entry_metrics#>'{entry_metrics_provenance,entrySpotTakerNetBuy}'),
      'entry_fut_taker_net_buy',
        COALESCE(c.snapshot_provenance#>'{entry_metrics_provenance,entryFutTakerNetBuy}',
                 c.entry_metrics#>'{entry_metrics_provenance,entryFutTakerNetBuy}'),
      'entry_fut_vol_mult',
        COALESCE(c.snapshot_provenance#>'{entry_metrics_provenance,entryFutVolMult}',
                 c.entry_metrics#>'{entry_metrics_provenance,entryFutVolMult}'),
      'entry_spot_vol_mult',
        COALESCE(c.snapshot_provenance#>'{entry_metrics_provenance,entrySpotVolMult}',
                 c.entry_metrics#>'{entry_metrics_provenance,entrySpotVolMult}'),
      'entry_spot_net_buy_1h',
        COALESCE(c.snapshot_provenance#>'{entry_metrics_provenance,entrySpotNetBuy1h}',
                 c.entry_metrics#>'{entry_metrics_provenance,entrySpotNetBuy1h}')
    ) AS requested_metric_provenance
  FROM cohort AS c
),
path_candles AS MATERIALIZED (
  SELECT
    f.tracker_id,
    f.snapshot_id,
    c.candle_at,
    CASE
      WHEN c.open > 0 AND c.high > 0 AND c.low > 0 AND c.close > 0
        AND c.high >= GREATEST(c.open, c.close)
        AND c.low <= LEAST(c.open, c.close)
        AND c.low <= c.high
        AND mod(extract(epoch FROM c.candle_at)::numeric, 900) = 0
      THEN TRUE ELSE FALSE
    END AS is_valid,
    CASE WHEN f.basis_entry_price > 0 AND c.high > 0
      THEN (c.high / f.basis_entry_price - 1) * 100 END AS high_pct,
    CASE WHEN f.basis_entry_price > 0 AND c.low > 0
      THEN (c.low / f.basis_entry_price - 1) * 100 END AS low_pct,
    CASE WHEN f.basis_entry_price > 0 AND c.close > 0
      THEN (c.close / f.basis_entry_price - 1) * 100 END AS close_pct
  FROM frozen_rows AS f
  JOIN pattern_backfill_candles AS c
    ON c.decision_snapshot_id = f.snapshot_id
   AND c.interval = '15m'
   AND c.source = 'bingx_15m'
   AND c.candle_at >= f.detected_at
   AND c.candle_at + interval '15 minutes' <= f.detected_at + interval '72 hours'
  CROSS JOIN asof AS a
  WHERE c.candle_at + interval '15 minutes' <= a.asof_at
),
window_specs AS MATERIALIZED (
  SELECT
    f.tracker_id,
    f.snapshot_id,
    f.detected_at,
    f.closed_at,
    f.status,
    f.basis_entry_price,
    h.horizon_hours,
    a.asof_at,
    f.detected_at + h.horizon_hours * interval '1 hour' AS horizon_end_at,
    to_timestamp(ceil(extract(epoch FROM f.detected_at) / 900) * 900)
      AS first_expected_open_at,
    to_timestamp(
      floor(extract(epoch FROM (f.detected_at + h.horizon_hours * interval '1 hour')) / 900) * 900
    ) - interval '15 minutes' AS last_expected_open_at,
    a.asof_at >= f.detected_at + h.horizon_hours * interval '1 hour'
      AS horizon_mature,
    CASE
      WHEN f.status <> 'cancelled' AND f.closed_at IS NOT NULL
        THEN LEAST(f.detected_at + h.horizon_hours * interval '1 hour', f.closed_at)
      ELSE NULL
    END AS preclose_end_at
  FROM frozen_rows AS f
  CROSS JOIN horizons AS h
  CROSS JOIN asof AS a
),
window_specs_final AS MATERIALIZED (
  SELECT
    s.*,
    CASE
      WHEN s.last_expected_open_at >= s.first_expected_open_at
        THEN (extract(epoch FROM (s.last_expected_open_at - s.first_expected_open_at)) / 900)::integer + 1
      ELSE 0
    END AS expected_bar_count,
    CASE
      WHEN s.preclose_end_at IS NOT NULL AND s.preclose_end_at >= s.detected_at
        THEN to_timestamp(floor(extract(epoch FROM s.preclose_end_at) / 900) * 900)
             - interval '15 minutes'
      ELSE NULL
    END AS preclose_last_expected_open_at
  FROM window_specs AS s
),
window_specs_with_preclose AS MATERIALIZED (
  SELECT
    s.*,
    CASE
      WHEN s.preclose_last_expected_open_at >= s.first_expected_open_at
        THEN (extract(epoch FROM (s.preclose_last_expected_open_at - s.first_expected_open_at)) / 900)::integer + 1
      ELSE 0
    END AS preclose_expected_bar_count
  FROM window_specs_final AS s
),
window_aggregates AS MATERIALIZED (
  SELECT
    s.tracker_id,
    s.snapshot_id,
    s.horizon_hours,
    s.detected_at,
    s.closed_at,
    s.status,
    s.basis_entry_price,
    s.horizon_end_at,
    s.first_expected_open_at,
    s.last_expected_open_at,
    s.expected_bar_count,
    s.horizon_mature,
    s.preclose_end_at,
    s.preclose_last_expected_open_at,
    s.preclose_expected_bar_count,
    COUNT(pc.candle_at)::integer AS observed_bar_count,
    COUNT(DISTINCT pc.candle_at) FILTER (WHERE pc.is_valid)::integer AS valid_bucket_count,
    COUNT(*) FILTER (WHERE pc.candle_at IS NOT NULL AND NOT pc.is_valid)::integer
      AS invalid_bar_count,
    (COUNT(pc.candle_at) - COUNT(DISTINCT pc.candle_at))::integer AS duplicate_bar_count,
    MIN(pc.candle_at) FILTER (WHERE pc.is_valid) AS first_valid_open_at,
    MAX(pc.candle_at) FILTER (WHERE pc.is_valid) AS last_valid_open_at,
    MAX(pc.high_pct) FILTER (WHERE pc.is_valid) AS max_high_pct,
    MIN(pc.low_pct) FILTER (WHERE pc.is_valid) AS min_low_pct,
    MAX(pc.close_pct) FILTER (
      WHERE pc.is_valid AND pc.candle_at = s.last_expected_open_at
    ) AS endpoint_close_pct,
    MIN(pc.candle_at) FILTER (WHERE pc.is_valid AND pc.high_pct >= 5) AS first_plus5_open_at,
    MIN(pc.candle_at + interval '15 minutes') FILTER (WHERE pc.is_valid AND pc.high_pct >= 5)
      AS first_plus5_close_at,
    MIN(pc.candle_at) FILTER (WHERE pc.is_valid AND pc.high_pct >= 10) AS first_plus10_open_at,
    MIN(pc.candle_at + interval '15 minutes') FILTER (WHERE pc.is_valid AND pc.high_pct >= 10)
      AS first_plus10_close_at,
    MIN(pc.candle_at) FILTER (WHERE pc.is_valid AND pc.high_pct >= 20) AS first_plus20_open_at,
    MIN(pc.candle_at + interval '15 minutes') FILTER (WHERE pc.is_valid AND pc.high_pct >= 20)
      AS first_plus20_close_at,
    MIN(pc.candle_at) FILTER (WHERE pc.is_valid AND pc.low_pct <= -8) AS first_minus8_open_at,
    MIN(pc.candle_at + interval '15 minutes') FILTER (WHERE pc.is_valid AND pc.low_pct <= -8)
      AS first_minus8_close_at,
    MIN(pc.candle_at) FILTER (WHERE pc.is_valid AND pc.low_pct <= -10) AS first_minus10_open_at,
    MIN(pc.candle_at + interval '15 minutes') FILTER (WHERE pc.is_valid AND pc.low_pct <= -10)
      AS first_minus10_close_at,
    MAX(pc.high_pct) FILTER (
      WHERE pc.is_valid AND pc.candle_at = s.first_expected_open_at
    ) AS first_bar_high_pct,
    MIN(pc.low_pct) FILTER (
      WHERE pc.is_valid AND pc.candle_at = s.first_expected_open_at
    ) AS first_bar_low_pct,
    MAX(pc.close_pct) FILTER (
      WHERE pc.is_valid AND pc.candle_at = s.first_expected_open_at
    ) AS first_bar_close_pct,
    BOOL_OR(pc.is_valid AND pc.high_pct >= 5 AND pc.low_pct <= -8)
      AS same_bar_plus5_minus8,
    BOOL_OR(pc.is_valid AND pc.high_pct >= 10 AND pc.low_pct <= -8)
      AS same_bar_plus10_minus8,
    BOOL_OR(pc.is_valid AND pc.high_pct >= 10 AND pc.low_pct <= -10)
      AS same_bar_plus10_minus10,
    BOOL_OR(pc.is_valid AND pc.high_pct >= 20 AND pc.low_pct <= -10)
      AS same_bar_plus20_minus10,
    COUNT(pc.candle_at) FILTER (
      WHERE s.preclose_end_at IS NOT NULL
        AND pc.candle_at <= s.preclose_last_expected_open_at
    )::integer AS preclose_observed_bar_count,
    COUNT(DISTINCT pc.candle_at) FILTER (
      WHERE s.preclose_end_at IS NOT NULL
        AND pc.is_valid AND pc.candle_at <= s.preclose_last_expected_open_at
    )::integer AS preclose_valid_bucket_count,
    COUNT(*) FILTER (
      WHERE s.preclose_end_at IS NOT NULL
        AND pc.candle_at IS NOT NULL
        AND pc.candle_at <= s.preclose_last_expected_open_at
        AND NOT pc.is_valid
    )::integer AS preclose_invalid_bar_count,
    (COUNT(pc.candle_at) FILTER (
       WHERE s.preclose_end_at IS NOT NULL
         AND pc.candle_at <= s.preclose_last_expected_open_at
     ) - COUNT(DISTINCT pc.candle_at) FILTER (
       WHERE s.preclose_end_at IS NOT NULL
         AND pc.candle_at <= s.preclose_last_expected_open_at
     ))::integer AS preclose_duplicate_bar_count,
    MIN(pc.candle_at) FILTER (
      WHERE s.preclose_end_at IS NOT NULL
        AND pc.is_valid AND pc.candle_at <= s.preclose_last_expected_open_at
    ) AS preclose_first_valid_open_at,
    MAX(pc.candle_at) FILTER (
      WHERE s.preclose_end_at IS NOT NULL
        AND pc.is_valid AND pc.candle_at <= s.preclose_last_expected_open_at
    ) AS preclose_last_valid_open_at,
    MAX(pc.high_pct) FILTER (
      WHERE s.preclose_end_at IS NOT NULL
        AND pc.is_valid AND pc.candle_at <= s.preclose_last_expected_open_at
    ) AS preclose_max_high_pct,
    MIN(pc.low_pct) FILTER (
      WHERE s.preclose_end_at IS NOT NULL
        AND pc.is_valid AND pc.candle_at <= s.preclose_last_expected_open_at
    ) AS preclose_min_low_pct,
    MAX(pc.close_pct) FILTER (
      WHERE s.preclose_end_at IS NOT NULL
        AND pc.is_valid AND pc.candle_at = s.preclose_last_expected_open_at
    ) AS preclose_endpoint_close_pct
  FROM window_specs_with_preclose AS s
  LEFT JOIN path_candles AS pc
    ON pc.tracker_id = s.tracker_id
   AND pc.snapshot_id = s.snapshot_id
   AND pc.candle_at >= s.first_expected_open_at
   AND pc.candle_at <= s.last_expected_open_at
   AND pc.candle_at + interval '15 minutes' <= s.horizon_end_at
  GROUP BY
    s.tracker_id, s.snapshot_id, s.horizon_hours, s.detected_at, s.closed_at,
    s.status, s.basis_entry_price, s.horizon_end_at, s.first_expected_open_at,
    s.last_expected_open_at, s.expected_bar_count, s.horizon_mature,
    s.preclose_end_at, s.preclose_last_expected_open_at, s.preclose_expected_bar_count
),
window_rows AS MATERIALIZED (
  SELECT
    w.*,
    (w.expected_bar_count > 0
     AND w.valid_bucket_count = w.expected_bar_count
     AND w.invalid_bar_count = 0
     AND w.duplicate_bar_count = 0
     AND w.first_valid_open_at = w.first_expected_open_at
     AND w.last_valid_open_at = w.last_expected_open_at) AS coverage_complete,
    (w.preclose_end_at IS NOT NULL
     AND w.preclose_expected_bar_count > 0
     AND w.preclose_valid_bucket_count = w.preclose_expected_bar_count
     AND w.preclose_invalid_bar_count = 0
     AND w.preclose_duplicate_bar_count = 0
     AND w.preclose_first_valid_open_at = w.first_expected_open_at
     AND w.preclose_last_valid_open_at = w.preclose_last_expected_open_at)
      AS preclose_coverage_complete
  FROM window_aggregates AS w
),
window_json AS MATERIALIZED (
  SELECT
    w.tracker_id,
    w.horizon_hours,
    jsonb_build_array(
      w.horizon_mature,
      (ceil(extract(epoch FROM w.detected_at) / 900)
       - floor(extract(epoch FROM w.detected_at) / 900))::integer,
      (floor(extract(epoch FROM w.horizon_end_at) / 900) - 1
       - floor(extract(epoch FROM w.detected_at) / 900))::integer,
      w.expected_bar_count,
      w.valid_bucket_count,
      w.invalid_bar_count,
      w.duplicate_bar_count,
      (floor(extract(epoch FROM w.first_valid_open_at) / 900)
       - floor(extract(epoch FROM w.detected_at) / 900))::integer,
      (floor(extract(epoch FROM w.last_valid_open_at) / 900)
       - floor(extract(epoch FROM w.detected_at) / 900))::integer,
      w.coverage_complete,
      w.max_high_pct,
      w.min_low_pct,
      w.endpoint_close_pct,
      (floor(extract(epoch FROM w.first_plus5_open_at) / 900)
       - floor(extract(epoch FROM w.detected_at) / 900))::integer,
      (floor(extract(epoch FROM w.first_plus10_open_at) / 900)
       - floor(extract(epoch FROM w.detected_at) / 900))::integer,
      (floor(extract(epoch FROM w.first_plus20_open_at) / 900)
       - floor(extract(epoch FROM w.detected_at) / 900))::integer,
      (floor(extract(epoch FROM w.first_minus8_open_at) / 900)
       - floor(extract(epoch FROM w.detected_at) / 900))::integer,
      (floor(extract(epoch FROM w.first_minus10_open_at) / 900)
       - floor(extract(epoch FROM w.detected_at) / 900))::integer,
      w.first_bar_high_pct,
      w.first_bar_low_pct,
      w.first_bar_close_pct,
      (COALESCE(w.same_bar_plus5_minus8, FALSE)
       OR COALESCE(w.same_bar_plus10_minus8, FALSE)
       OR COALESCE(w.same_bar_plus10_minus10, FALSE)
       OR COALESCE(w.same_bar_plus20_minus10, FALSE)),
      jsonb_build_array(
        w.preclose_end_at IS NOT NULL,
        (floor(extract(epoch FROM w.preclose_end_at) / 900) - 1
         - floor(extract(epoch FROM w.detected_at) / 900))::integer,
        w.preclose_expected_bar_count,
        w.preclose_valid_bucket_count,
        w.preclose_invalid_bar_count,
        w.preclose_duplicate_bar_count,
        (floor(extract(epoch FROM w.preclose_first_valid_open_at) / 900)
         - floor(extract(epoch FROM w.detected_at) / 900))::integer,
        (floor(extract(epoch FROM w.preclose_last_valid_open_at) / 900)
         - floor(extract(epoch FROM w.detected_at) / 900))::integer,
        w.preclose_coverage_complete,
        w.preclose_max_high_pct,
        w.preclose_min_low_pct,
        w.preclose_endpoint_close_pct
      )
    ) AS window_payload
  FROM window_rows AS w
),
window_summary AS (
  SELECT
    horizon_hours,
    COUNT(*)::integer AS cohort_rows,
    COUNT(*) FILTER (WHERE horizon_mature)::integer AS mature_rows,
    COUNT(*) FILTER (WHERE coverage_complete)::integer AS complete_coverage_rows,
    COUNT(*) FILTER (WHERE horizon_mature AND coverage_complete)::integer
      AS mature_complete_rows
  FROM window_rows
  GROUP BY horizon_hours
),
metadata AS (
  SELECT jsonb_build_object(
    'capture_asof_utc', (SELECT asof_at FROM asof),
    'environment', 'production_read_only_replica',
    'statement_snapshot', 'single SQL statement; statement_timestamp() and MVCC snapshot',
    'scope', 'all canonical tracked:<id> fired impulse_buy snapshots matched to tracked_signals; no UI cutoff, status, policy, or entry-date exclusion',
    'cohort_rows', COUNT(*)::integer,
    'distinct_tracker_ids', COUNT(DISTINCT tracker_id)::integer,
    'duplicate_tracker_rows', (COUNT(*) - COUNT(DISTINCT tracker_id))::integer,
    'canonical_snapshot_rows', COUNT(DISTINCT snapshot_id)::integer,
    'first_detected_at_utc', MIN(detected_at),
    'last_detected_at_utc', MAX(detected_at),
    'snapshot_source_counts', (
      SELECT jsonb_object_agg(source_name, row_count)
      FROM (
        SELECT COALESCE(snapshot_source, '<SQL_NULL>') AS source_name,
               COUNT(*)::integer AS row_count
        FROM frozen_rows GROUP BY 1
      ) AS s
    ),
    'snapshot_legacy_rows', COUNT(*) FILTER (WHERE snapshot_is_legacy)::integer,
    'status_counts', (
      SELECT jsonb_object_agg(status_name, row_count)
      FROM (
        SELECT COALESCE(status, '<SQL_NULL>') AS status_name,
               COUNT(*)::integer AS row_count
        FROM frozen_rows GROUP BY 1
      ) AS s
    ),
    'entry_metric_presence_counts', jsonb_build_object(
      'spot_taker_net_buy_pct', COUNT(*) FILTER (WHERE entry_spot_taker_net_buy_pct IS NOT NULL)::integer,
      'futures_taker_net_buy_pct', COUNT(*) FILTER (WHERE entry_fut_taker_net_buy_pct IS NOT NULL)::integer,
      'tracker_futures_volume_multiplier', COUNT(*) FILTER (WHERE entry_fut_vol_mult IS NOT NULL)::integer,
      'tracker_spot_volume_multiplier', COUNT(*) FILTER (WHERE entry_spot_vol_mult IS NOT NULL)::integer,
      'spot_net_buy_1h_pct', COUNT(*) FILTER (WHERE entry_spot_net_buy_1h_pct IS NOT NULL)::integer,
      'trigger_candle_volume_multiplier', COUNT(*) FILTER (WHERE trigger_candle_volume_mult IS NOT NULL)::integer,
      'trigger_candle_volume_usd', COUNT(*) FILTER (WHERE trigger_candle_volume_usd IS NOT NULL)::integer,
      'trigger_baseline_volume_usd', COUNT(*) FILTER (WHERE trigger_baseline_volume_usd IS NOT NULL)::integer,
      'trigger_candle_closed_at', COUNT(*) FILTER (WHERE trigger_candle_closed_at IS NOT NULL)::integer,
      'trigger_candle_body_pct', COUNT(*) FILTER (WHERE trigger_candle_body_pct IS NOT NULL)::integer,
      'trigger_candle_close_strength', COUNT(*) FILTER (WHERE trigger_candle_close_strength IS NOT NULL)::integer
    ),
    'price_basis_counts', jsonb_build_object(
      'original_entry_price', COUNT(*) FILTER (WHERE basis_price_source = 'original_entry_price')::integer,
      'entry_price_fallback', COUNT(*) FILTER (WHERE basis_price_source = 'entry_price_fallback')::integer,
      'unavailable', COUNT(*) FILTER (WHERE basis_price_source = 'unavailable')::integer
    ),
    'no_immutable_entry_futures_24h_volume_field',
      'No absolute futures 24h volume field is exported or inferred.',
    'taker_metric_semantics',
      'Persisted spot/futures taker columns are net-buy percentages: (buy volume - sell volume) / (buy volume + sell volume) * 100; these are not buy-share percentages.',
    'horizon_coverage', (
      SELECT jsonb_object_agg(horizon_hours::text, jsonb_build_object(
        'cohort_rows', cohort_rows,
        'mature_rows', mature_rows,
        'rows_with_gap_free_coverage', complete_coverage_rows,
        'mature_gap_free_rows', mature_complete_rows
      ))
      FROM window_summary
    ),
    'quality_flags', jsonb_build_object(
      'entry_anchored_over_300pct_first_bar_or_path_rows',
        COUNT(DISTINCT tracker_id) FILTER (
          WHERE EXISTS (
            SELECT 1 FROM window_rows AS w
            WHERE w.tracker_id = frozen_rows.tracker_id
              AND (w.max_high_pct >= 300
                OR w.first_bar_high_pct >= 300
                OR w.first_bar_close_pct >= 300)
          )
        )::integer,
      'raw_values_retained', TRUE,
      'quality_flag_note',
        'Large entry-anchored candle moves (including symbol redenominations/discontinuities) are flagged, never silently dropped.'
    ),
    'path_notes', jsonb_build_object(
      'source', 'pattern_backfill_candles',
      'interval', '15m',
      'source_filter', 'bingx_15m',
      'candle_at_semantics', 'candle open time',
      'closed_bar_filter', 'open >= detected_at; open + 15m <= horizon endpoint and capture asof',
      'coverage_rule', 'all expected aligned buckets from ceil(entry,15m) through floor(entry+horizon,15m)-15m; valid OHLC; zero invalid or duplicate bars; exact endpoints',
      'preclose_rule', 'separate tracker closed_at-bounded path for non-cancelled closed rows; not evidence of a fill',
      'hit_times', '15m bar open and bar close are approximate threshold times; same-bar target/stop overlaps are explicitly flagged'
    )
    ,
    'window_array_schema', jsonb_build_object(
      'bar_index_anchor', 'Each index is the 15-minute open-time bucket offset from floor(detected_at UTC / 15m); close index = open index + 1. NULL means no observation.',
      'window_values', jsonb_build_array(
        'mature_at_capture', 'first_expected_open_index', 'last_expected_open_index',
        'expected_bar_count', 'valid_bucket_count', 'invalid_bar_count',
        'duplicate_bar_count', 'first_valid_open_index', 'last_valid_open_index',
        'coverage_complete', 'max_high_pct', 'min_low_pct', 'endpoint_close_pct',
        'first_plus5_open_index', 'first_plus10_open_index',
        'first_plus20_open_index', 'first_minus8_open_index',
        'first_minus10_open_index',
        'first_bar_high_pct', 'first_bar_low_pct', 'first_bar_close_pct',
        'same_bar_target_stop_ambiguous',
        'preclose_array'
      ),
      'preclose_values', jsonb_build_array(
        'applicable', 'last_expected_open_index', 'expected_bar_count',
        'valid_bucket_count', 'invalid_bar_count', 'duplicate_bar_count',
        'first_valid_open_index', 'last_valid_open_index', 'coverage_complete',
        'max_high_pct', 'min_low_pct', 'endpoint_close_pct'
      )
    )
  ) AS payload
  FROM frozen_rows
),
row_payloads AS (
  SELECT
    f.tracker_id,
    f.detected_at,
    jsonb_build_object(
      'id', f.tracker_id,
      'decision_snapshot_id', f.snapshot_id,
      'symbol', f.symbol,
      'detected_at_utc', f.detected_at,
      'closed_at_utc', f.closed_at,
      'status', f.status,
      'cancel_reason', f.cancel_reason,
      'entry_policy_version', f.entry_policy_version,
      'exit_policy_version', f.exit_policy_version,
      'split_filled_at_utc', f.split_filled_at,
      'original_entry_price', f.original_entry_price,
      'current_entry_price', f.current_entry_price,
      'basis_entry_price', f.basis_entry_price,
      'basis_price_source', f.basis_price_source,
      'snapshot_entry_price', f.snapshot_entry_price,
      'peak_price', f.peak_price,
      'pnl_percent', f.pnl_percent,
      'entry_spot_taker_net_buy_pct', f.entry_spot_taker_net_buy_pct,
      'entry_fut_taker_net_buy_pct', f.entry_fut_taker_net_buy_pct,
      'entry_fut_vol_mult', f.entry_fut_vol_mult,
      'entry_spot_vol_mult', f.entry_spot_vol_mult,
      'entry_spot_net_buy_1h_pct', f.entry_spot_net_buy_1h_pct,
      'trigger_candle_volume_mult', f.trigger_candle_volume_mult,
      'trigger_candle_volume_usd', f.trigger_candle_volume_usd,
      'trigger_baseline_volume_usd', f.trigger_baseline_volume_usd,
      'trigger_candle_closed_at', f.trigger_candle_closed_at,
      'trigger_candle_body_pct', f.trigger_candle_body_pct,
      'trigger_candle_close_strength', f.trigger_candle_close_strength,
      'snapshot_source', f.snapshot_source,
      'snapshot_created_at_utc', f.snapshot_created_at,
      'snapshot_is_legacy', f.snapshot_is_legacy,
      'snapshot_provenance_record', f.snapshot_provenance->'record',
      'snapshot_provenance_capture', f.snapshot_provenance->'capture',
      'snapshot_decision_metrics_capture', f.snapshot_provenance->'decision_metrics_capture',
      'snapshot_completeness', f.snapshot_completeness,
      'requested_metric_provenance', f.requested_metric_provenance,
      'windows', (
        SELECT jsonb_object_agg(wj.horizon_hours::text, wj.window_payload)
        FROM window_json AS wj
        WHERE wj.tracker_id = f.tracker_id
      )
    ) AS row_payload
  FROM frozen_rows AS f
),
final_payload AS (
  SELECT jsonb_build_object(
    'metadata', (SELECT payload FROM metadata),
    'rows', (
      SELECT jsonb_agg(row_payload ORDER BY detected_at, tracker_id)
      FROM row_payloads
    )
  ) AS payload
)
SELECT replace(
  encode(convert_to(payload::text, 'UTF8'), 'base64'),
  E'\n',
  ''
) AS payload_b64
FROM final_payload;