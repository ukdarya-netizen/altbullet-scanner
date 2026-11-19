-- CAB miss-1119 read-only production extracts.
-- Output files are JSONL arrays of individual SELECT rows; all timestamps are UTC.
-- No writes, schema changes, or dev-database queries were performed.

-- 1) Prescan observations in the requested interval.
SELECT symbol, cycle_at, p24h, p1h, price, oi30m, oi1h, oi4h, vol_mult,
       spot_vol_usd_24h, fut_spot_ratio, whale_index, snf_1h, funding_rate,
       ob_ratio, cvd_30m, cvd_1h, cvd_4h, cycles_in_pool
FROM prescan_snapshots
WHERE symbol = ANY(ARRAY[
  'FTR-USDT','IRYS-USDT','LUNC-USDT','PIPPIN-USDT','SENT-USDT','VELVET-USDT'
])
  AND cycle_at >= TIMESTAMPTZ '2026-11-14 00:00:00+00'
  AND cycle_at <= TIMESTAMPTZ '2026-11-19 12:00:00+00'
ORDER BY symbol, cycle_at;

-- 2) Prescan history for the same symbols/window.
SELECT symbol, ts, cycle_count, rank, score, price_24h, price_1h,
       oi_30m, oi_1h, oi_4h, oi_24h, vol_mult, cvd_1h, cvd_30m,
       net_buy_pct, spot_taker_net_buy, oi_accel_30m, fut_spot_ratio,
       whale_index, snf_1h, ob_ratio
FROM prescan_history
WHERE symbol = ANY(ARRAY[
  'FTR-USDT','IRYS-USDT','LUNC-USDT','PIPPIN-USDT','SENT-USDT','VELVET-USDT'
])
  AND ts >= TIMESTAMP '2026-11-14 00:00:00'
  AND ts <= TIMESTAMP '2026-11-19 12:00:00'
ORDER BY symbol, ts;

-- 3) Current prescan tracker row for each requested symbol.
SELECT symbol, cycle_count, first_seen_at, best_rank, updated_at, last_price,
       last_oi_30m, last_oi_1h, last_oi_4h, last_oi_24h, last_cg_timed_out,
       cvd_positive_cycles, taker_positive_cycles, layers, has_fired_before
FROM prescan_tracker
WHERE symbol = ANY(ARRAY[
  'FTR-USDT','IRYS-USDT','LUNC-USDT','PIPPIN-USDT','SENT-USDT','VELVET-USDT'
])
ORDER BY symbol;

-- 4) All shadow candidate rows for the six symbols in the analysis window.
SELECT id, symbol, detection_method, candidate_key, frozen_level, armed_at,
       trigger_candle_at, status, terminal_reason, live_eligible,
       volume_evidence, created_at, updated_at
FROM stealth_abneon_shadow_candidates
WHERE symbol = ANY(ARRAY[
  'FTR-USDT','IRYS-USDT','LUNC-USDT','PIPPIN-USDT','SENT-USDT','VELVET-USDT'
])
  AND armed_at >= TIMESTAMPTZ '2026-11-14 00:00:00+00'
  AND armed_at <= TIMESTAMPTZ '2026-11-19 12:00:00+00'
ORDER BY symbol, armed_at, id;

-- 5) Pattern decisions (all patterns) for the six symbols in the window.
SELECT id, symbol, pattern_key, decision_kind, decision_reason, decision_at,
       entry_price, tracked_signal_id, completeness, source, trajectory_status
FROM pattern_decision_snapshots
WHERE symbol = ANY(ARRAY[
  'FTR-USDT','IRYS-USDT','LUNC-USDT','PIPPIN-USDT','SENT-USDT','VELVET-USDT'
])
  AND decision_at >= TIMESTAMPTZ '2026-11-14 00:00:00+00'
  AND decision_at <= TIMESTAMPTZ '2026-11-19 12:00:00+00'
ORDER BY symbol, decision_at, id;

-- 6) All tracked signal records for these symbols; retained to check prior/open overlap.
SELECT id, signal_id, symbol, sentiment_key, detected_at, entry_price, exit_price,
       status::text AS status, pnl_percent, peak_price, closed_at, updated_at,
       cancel_reason, decision_metrics->'beforeNeutralClose' AS before_neutral_close,
       decision_metrics
FROM tracked_signals
WHERE symbol = ANY(ARRAY[
  'FTR-USDT','IRYS-USDT','LUNC-USDT','PIPPIN-USDT','SENT-USDT','VELVET-USDT'
])
ORDER BY symbol, detected_at, id;

-- 7) Scan-reject counts by reason, with first/last occurrence in the window.
SELECT symbol, pattern, reason, count(*) AS n, min(cycle_at) AS first_at,
       max(cycle_at) AS last_at
FROM scan_reject_log
WHERE symbol = ANY(ARRAY[
  'FTR-USDT','IRYS-USDT','LUNC-USDT','PIPPIN-USDT','SENT-USDT','VELVET-USDT'
])
  AND cycle_at >= TIMESTAMPTZ '2026-11-14 00:00:00+00'
  AND cycle_at <= TIMESTAMPTZ '2026-11-19 12:00:00+00'
GROUP BY symbol, pattern, reason
ORDER BY symbol, pattern, n DESC, reason;

-- 8) Full decision evidence retained separately for the key records referenced in summary.md.
SELECT id, symbol, pattern_key, decision_kind, decision_reason, decision_at,
       entry_price, tracked_signal_id, entry_metrics, completeness, source,
       trajectory_status
FROM pattern_decision_snapshots
WHERE id = ANY(ARRAY[43841571, 44022562, 44038506, 44052973, 46710550,
                     47267408, 47279944, 47279945]::bigint[])
ORDER BY id;

-- Deployment-log searches for these exact historical terms were requested, but
-- the available deployment-log query returned no matching retained lines.
