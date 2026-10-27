-- scan_reject_log, impulse_buy, since 2026-10-01 (table holds rows only from 2026-10-24 06:30 UTC)
select r.id, to_char(r.cycle_at at time zone 'UTC','YYYY-MM-DD HH24:MI:SS.MS') cycle_at_utc, r.symbol, r.reason,
  (select p.entry_price from pattern_decision_snapshots p
    where p.symbol=r.symbol and p.pattern_key='impulse_buy' and p.decision_at=r.cycle_at limit 1) snapshot_price,
  r.oi30m, r.vol_mult, r.price24h, r.prescan_cycles
from scan_reject_log r where r.pattern='impulse_buy' and r.cycle_at>='2026-10-01' order by r.id;
-- price: snapshot_price if an exact-time impulse_buy decision snapshot exists, else close of the last closed BingX 15m candle (open <= cycle_at-15m, within 45 min), see build_outputs.py
-- candles: BingX /openApi/swap/v3/quote/klines interval=15m (fetch_klines.py), 72h forward from the 15m candle containing cycle_at, closed candles only
