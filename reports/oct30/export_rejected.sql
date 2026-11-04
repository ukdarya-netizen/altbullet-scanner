-- Read-only (production). Rejected/blocked/missed candidates of the 5 patterns since 2026-09-01.
-- decision_kind 'blocked' = candidate stopped by a gate/guard with a recorded reason; 'missed' = missed-mover candidate (reason from missed_signals_log).
select p.id, p.pattern_key as pattern, p.symbol, p.decision_kind, p.decision_at, p.entry_price as price_at_decision,
 coalesce(p.decision_reason, m.reason) as reject_reason, p.source,
 p.signal_id, p.missed_signal_id,
 p.entry_metrics::text as entry_metrics_json, p.provenance::text as provenance_json, p.completeness::text as completeness_json,
 m.source as ms_source, m.price_24h_pct as ms_price_24h_pct, m.oi_30m_pct as ms_oi_30m_pct, m.oi_1h_pct as ms_oi_1h_pct, m.oi_4h_pct as ms_oi_4h_pct,
 m.vol_mult as ms_vol_mult, m.spot_vol_mult as ms_spot_vol_mult, m.cvd_30m as ms_cvd_30m, m.cvd_1h as ms_cvd_1h, m.cvd_4h as ms_cvd_4h,
 m.prescan_cycles as ms_prescan_cycles, m.price_6h_pct as ms_price_6h_pct, m.price_24h_pct_after as ms_price_24h_pct_after,
 m.decision_score as ms_decision_score, m.gap_details::text as ms_gap_details, m.decision_metrics_json::text as ms_decision_metrics_json
from pattern_decision_snapshots p left join missed_signals_log m on m.id = p.missed_signal_id
where p.pattern_key in ('neon_support_bounce','stealth_breakout','liquidation_cascade','price_led_momentum','impulse_buy')
 and p.decision_kind in ('blocked','missed') and p.decision_at >= '2026-09-01'
order by p.id