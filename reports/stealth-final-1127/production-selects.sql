-- All database statements for this report were SELECTs against production.
-- tracked_signals parameters: $1 = start, $2 = snapshot cutoff,
-- $3 = last seen row id (initially 0), $4 = page size.
-- Related-table and hourly-snapshot parameters: $1 = last seen id,
-- $2 = start, $3 = snapshot cutoff, $4 = page size.
-- queue parameters: $1 = last seen id, $2 = start, $3 = snapshot cutoff,
-- $4 = page size. Rejection-log parameters: $1 = last seen id,
-- $2 = snapshot cutoff, $3 = page size.

-- Fired Stealth signals
SELECT encode(convert_to(row_to_json(t)::text, 'UTF8'), 'base64') AS b64
FROM tracked_signals t
WHERE t.sentiment_key = 'stealth_breakout'
  AND t.detected_at >= $1::timestamptz
  AND t.detected_at <= $2::timestamptz
  AND t.id > $3
ORDER BY t.id
LIMIT $4;

-- Per-signal recorded entry metrics; run once per table with the table name
-- and foreign key shown in each comment.
SELECT encode(convert_to(row_to_json(x)::text, 'UTF8'), 'base64') AS b64
FROM signal_entry_extras x
WHERE x.id > $1
  AND EXISTS (
    SELECT 1 FROM tracked_signals t
    WHERE t.id = x.tracked_signal_id
      AND t.sentiment_key = 'stealth_breakout'
      AND t.detected_at >= $2::timestamptz
      AND t.detected_at <= $3::timestamptz
  )
ORDER BY x.id
LIMIT $4;

SELECT encode(convert_to(row_to_json(x)::text, 'UTF8'), 'base64') AS b64
FROM vsa_entry_metrics x
WHERE x.id > $1
  AND EXISTS (
    SELECT 1 FROM tracked_signals t
    WHERE t.id = x.tracked_signal_id
      AND t.sentiment_key = 'stealth_breakout'
      AND t.detected_at >= $2::timestamptz
      AND t.detected_at <= $3::timestamptz
  )
ORDER BY x.id
LIMIT $4;

SELECT encode(convert_to(row_to_json(x)::text, 'UTF8'), 'base64') AS b64
FROM wyckoff_entry_metrics x
WHERE x.id > $1
  AND EXISTS (
    SELECT 1 FROM tracked_signals t
    WHERE t.id = x.tracked_signal_id
      AND t.sentiment_key = 'stealth_breakout'
      AND t.detected_at >= $2::timestamptz
      AND t.detected_at <= $3::timestamptz
  )
ORDER BY x.id
LIMIT $4;

SELECT encode(convert_to(row_to_json(x)::text, 'UTF8'), 'base64') AS b64
FROM signal_volume_colors x
WHERE x.id > $1
  AND EXISTS (
    SELECT 1 FROM tracked_signals t
    WHERE t.id = x.tracked_signal_id
      AND t.sentiment_key = 'stealth_breakout'
      AND t.detected_at >= $2::timestamptz
      AND t.detected_at <= $3::timestamptz
  )
ORDER BY x.id
LIMIT $4;

-- ABNeon durable queue rows
SELECT encode(convert_to(row_to_json(q)::text, 'UTF8'), 'base64') AS b64
FROM stealth_abneon_shadow_candidates q
WHERE q.id > $1
  AND q.detection_method IN ('neon_level_4h_breakout', 'neon_level_1d_breakout')
  AND coalesce(q.trigger_candle_at, q.created_at) >= $2::timestamptz
  AND coalesce(q.trigger_candle_at, q.created_at) <= $3::timestamptz
ORDER BY q.id
LIMIT $4;

-- Pattern decisions. The existing export included these scalar decision fields;
-- entry_metrics was not in that export.
SELECT encode(
  convert_to(
    json_build_object(
      'id', s.id,
      'symbol', s.symbol,
      'decision_at', s.decision_at,
      'decision_kind', s.decision_kind,
      'decision_reason', s.decision_reason,
      'entry_price', s.entry_price,
      'tracked_signal_id', s.tracked_signal_id,
      'missed_signal_id', s.missed_signal_id,
      'source', s.source
    )::text,
    'UTF8'
  ),
  'base64'
) AS b64
FROM pattern_decision_snapshots s
WHERE s.id > $1
  AND s.pattern_key = 'stealth_breakout'
  AND s.decision_at >= $2::timestamptz
  AND s.decision_at <= $3::timestamptz
  AND (
    s.decision_kind IN ('fired', 'blocked')
    OR s.decision_reason LIKE 'stealth_neon_level_%'
    OR (
      s.decision_kind = 'rejected'
      AND s.decision_reason = 'no_live_pattern_matched'
    )
  )
ORDER BY s.id
LIMIT $4;

-- Rejection reason logs
SELECT encode(convert_to(row_to_json(r)::text, 'UTF8'), 'base64') AS b64
FROM scan_reject_log r
WHERE r.id > $1
  AND r.pattern = 'stealth_breakout'
  AND r.reason LIKE 'stealth_neon_level_%'
  AND r.cycle_at >= '2026-11-01 00:00:00+00'::timestamptz
  AND r.cycle_at <= $2::timestamptz
ORDER BY r.id
LIMIT $3;

-- Hourly post-entry snapshots. The export retains fixed checkpoints and each
-- signal's latest checkpoint, with scalar metric fields only.
WITH sig AS (
  SELECT id FROM tracked_signals
  WHERE sentiment_key = 'stealth_breakout'
    AND detected_at >= $2::timestamptz
    AND detected_at <= $3::timestamptz
),
mx AS (
  SELECT s.tracked_signal_id, max(s.hour_index) AS h
  FROM stealth_hourly_snapshots s
  JOIN sig ON sig.id = s.tracked_signal_id
  GROUP BY s.tracked_signal_id
),
ss AS (
  SELECT s.*
  FROM stealth_hourly_snapshots s
  JOIN mx m ON m.tracked_signal_id = s.tracked_signal_id
  WHERE s.hour_index IN (0, 1, 4, 8, 24, 48, 72)
     OR s.hour_index = m.h
)
SELECT encode(
  convert_to(
    jsonb_build_object(
      'id', ss.tracked_signal_id,
      'tracked_signal_id', ss.tracked_signal_id,
      'snapshots',
      jsonb_agg(
        jsonb_build_object(
          'id', ss.id,
          'tracked_signal_id', ss.tracked_signal_id,
          'symbol', ss.symbol,
          'hour_index', ss.hour_index,
          'snapshot_at', ss.snapshot_at,
          'elapsed_ms', ss.elapsed_ms,
          'price_at', ss.price_at,
          'pct_from_entry', ss.pct_from_entry,
          'peak_pct', ss.peak_pct,
          'status', ss.status,
          'metrics', jsonb_build_object(
            'oiChange30mPct', ss.metrics->'oiChange30mPct',
            'oiChange1hPct', ss.metrics->'oiChange1hPct',
            'oiChange4hPct', ss.metrics->'oiChange4hPct',
            'oiChange24hPct', ss.metrics->'oiChange24hPct',
            'futuresTakerNetBuyPct15m', ss.metrics->'futuresTakerNetBuyPct15m',
            'spotCvd1h', ss.metrics->'spotCvd1h',
            'spotCvd4h', ss.metrics->'spotCvd4h',
            'spotCvdStrength1h', ss.metrics->'spotCvdStrength1h',
            'spotNetBuyPct1h', ss.metrics->'spotNetBuyPct1h',
            'source', ss.metrics->'source',
            'slotMinutes', ss.metrics->'slotMinutes'
          )
        )
        ORDER BY ss.hour_index
      )
    )::text,
    'UTF8'
  ),
  'base64'
) AS b64
FROM ss
WHERE ss.tracked_signal_id > $1
GROUP BY ss.tracked_signal_id
ORDER BY ss.tracked_signal_id
LIMIT $4;

-- Post-close tracking and guard checks.
SELECT encode(convert_to(row_to_json(x)::text, 'UTF8'), 'base64') AS b64
FROM signal_trajectory_log x
WHERE x.id > $1
  AND EXISTS (
    SELECT 1 FROM tracked_signals t
    WHERE t.id = x.signal_id
      AND t.sentiment_key = 'stealth_breakout'
      AND t.detected_at >= $2::timestamptz
      AND t.detected_at <= $3::timestamptz
  )
ORDER BY x.id LIMIT $4;

SELECT encode(convert_to(row_to_json(x)::text, 'UTF8'), 'base64') AS b64
FROM signal_drawdown_extrema x
WHERE x.id > $1
  AND EXISTS (
    SELECT 1 FROM tracked_signals t
    WHERE t.id = x.signal_id
      AND t.sentiment_key = 'stealth_breakout'
      AND t.detected_at >= $2::timestamptz
      AND t.detected_at <= $3::timestamptz
  )
ORDER BY x.id LIMIT $4;

SELECT encode(convert_to(row_to_json(x)::text, 'UTF8'), 'base64') AS b64
FROM signal_trailing_events x
WHERE x.id > $1
  AND EXISTS (
    SELECT 1 FROM tracked_signals t
    WHERE t.id = x.signal_id
      AND t.sentiment_key = 'stealth_breakout'
      AND t.detected_at >= $2::timestamptz
      AND t.detected_at <= $3::timestamptz
  )
ORDER BY x.id LIMIT $4;

SELECT encode(convert_to(row_to_json(x)::text, 'UTF8'), 'base64') AS b64
FROM bu_stop_followup_snapshots x
WHERE x.id > $1
  AND EXISTS (
    SELECT 1 FROM tracked_signals t
    WHERE t.id = x.tracked_signal_id
      AND t.sentiment_key = 'stealth_breakout'
      AND t.detected_at >= $2::timestamptz
      AND t.detected_at <= $3::timestamptz
  )
ORDER BY x.id LIMIT $4;
