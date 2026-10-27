-- 1. Stealth auto_range_1h arms since 2026-10-01 (stealth_arms/arms.csv)
select id arm_id, symbol, level_source, armed_at, armed_after_1h_at,
       breakout_level range_upper_breakout_level,
       (structure_json->'autoRangeIdentity'->>'upper')::numeric range_upper_identity,
       (structure_json->'autoRangeIdentity'->>'lower')::numeric range_lower,
       touches, quiet_zone, status, terminal_reason, first_cross_at,
       trigger_candle_at, fired_at, fired_signal_id, decision_at
from stealth_breakout_armed_setups
where level_source='auto_range_1h' and armed_at>='2026-10-01' order by id;
-- verdict log (arm_verdicts.csv)
select * from stealth_arm_verdict_log where arm_id in
  (select id from stealth_breakout_armed_setups where level_source='auto_range_1h' and armed_at>='2026-10-01') order by id;
-- cutoff shadow (arm_cutoff_shadow.csv)
select * from stealth_cutoff_shadow where arm_id in
  (select id from stealth_breakout_armed_setups where level_source='auto_range_1h' and armed_at>='2026-10-01') order by id;
-- 2. candles: BingX GET /openApi/swap/v3/quote/klines?symbol=<sym>&interval=1h&startTime=<min armed_at - 1h>&limit=1000 (script: fetch_candles.py)
-- 3. BULLA-USDT (bulla_*.csv); arm ids 45928, 46156, 47510
select * from stealth_breakout_armed_setups where id in (45928,46156,47510) order by id;
select * from stealth_arm_verdict_log where arm_id in (45928,46156,47510) order by id;
select * from stealth_cutoff_shadow where arm_id in (45928,46156,47510) order by id;
select * from stealth_breakout_decision_metrics where arm_id in (45928,46156,47510) order by id;
select * from scan_reject_log where symbol='BULLA-USDT' and pattern='stealth_breakout' and cycle_at>='2026-10-24' and cycle_at<'2026-10-27' order by cycle_at;
select * from pattern_decision_snapshots where symbol='BULLA-USDT' and pattern_key='stealth_breakout' and decision_at>='2026-10-24' and decision_at<'2026-10-27' order by decision_at;
