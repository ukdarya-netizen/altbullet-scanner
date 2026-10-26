-- Read-only retrieval of immutable entry metrics for the frozen 188 snapshot IDs.
-- Bind $1 as bigint[] of decision_snapshot_id values from the frozen cohort.
-- Do not select current tracker status; statuses remain in the frozen input.
SELECT
  encode(
    convert_to(
      jsonb_agg(
        jsonb_build_object(
          'decision_snapshot_id', d.id,
          'tracked_signal_id', d.tracked_signal_id,
          'symbol', d.symbol,
          'decision_at_utc', d.decision_at,
          'source', d.source,
          'provenance_capture', d.provenance->>'capture',
          'decision_metrics_capture', d.provenance->>'decision_metrics_capture',
          'legacy', d.completeness->>'legacy',
          'trigger_candle_closed_at',
            COALESCE(
              d.entry_metrics->>'candleClosedAt',
              d.entry_metrics->'decision_metrics'->>'candleClosedAt',
              d.entry_metrics->'impulse_decision_metrics'->>'candleClosedAt'
            ),
          'top_level_close_candidates',
            jsonb_strip_nulls(
              jsonb_build_object(
                'candleClose', d.entry_metrics->'candleClose',
                'entryCandleClose', d.entry_metrics->'entryCandleClose',
                'triggerCandleClose', d.entry_metrics->'triggerCandleClose',
                'triggerCandleClosePrice', d.entry_metrics->'triggerCandleClosePrice',
                'candleClosePrice', d.entry_metrics->'candleClosePrice'
              )
            ),
          'top_level_ohlc',
            jsonb_strip_nulls(
              jsonb_build_object(
                'open', d.entry_metrics->'candleOpen',
                'high', d.entry_metrics->'candleHigh',
                'low', d.entry_metrics->'candleLow',
                'close', d.entry_metrics->'candleClose'
              )
            ),
          'decision_metrics_close_candidates',
            jsonb_strip_nulls(
              jsonb_build_object(
                'candleClose', d.entry_metrics#>'{decision_metrics,candleClose}',
                'close', d.entry_metrics#>'{decision_metrics,close}',
                'triggerCandleClose', d.entry_metrics#>'{decision_metrics,triggerCandleClose}'
              )
            ),
          'impulse_metrics_close_candidates',
            jsonb_strip_nulls(
              jsonb_build_object(
                'candleClose', d.entry_metrics#>'{impulse_decision_metrics,candleClose}',
                'close', d.entry_metrics#>'{impulse_decision_metrics,close}',
                'triggerCandleClose', d.entry_metrics#>'{impulse_decision_metrics,triggerCandleClose}'
              )
            ),
          'metric_shape_keys',
            jsonb_strip_nulls(
              jsonb_build_object(
                'has_candleClose', d.entry_metrics ? 'candleClose',
                'has_impulse_decision_metrics', d.entry_metrics ? 'impulse_decision_metrics',
                'has_decision_metrics', d.entry_metrics ? 'decision_metrics',
                'has_impulseBuyMetrics', d.entry_metrics ? 'impulseBuyMetrics'
              )
            )
        )
        ORDER BY d.id
      )::text,
      'UTF8'
    ),
    'base64'
  ) AS raw_b64
FROM pattern_decision_snapshots AS d
WHERE d.id = ANY($1::bigint[]);