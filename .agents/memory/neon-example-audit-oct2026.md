---
name: Neon missed-bounce audit Oct 2026
description: Why Neon missed BASED/ELSA/LAB/PYTH/REZ/VVV lows and what a 30-day universe replay (no volume) showed
---
Bot support zones (top-6 4H clusters) had no zone near BASED/LAB lows (price below all zones); chart zone ×1 appears only after pivot confirmation. Other examples had arms that expired/invalidated; failing condition (1H aggregated volume ≥1.5×) not verifiable without per-candle CoinGlass history. scan_reject_log starts 2026-10-18.
Replay (946 symbols, 30d, price-only, Neon exits): current price conditions work share 15.7%, ΣPnL negative; best ≤3-condition rules positive only in first 15d, negative in last 15d → not robust. Nothing implemented.

**Why:** owner asked for rule ≤3 conditions catching ≥5 of examples; no rule held out-of-sample without volume.
**How to apply:** do not ship a price-only Neon loosening; any retry needs aggregated 1H volume per event.

Follow-up findings: owner's chart is BingX SPOT 4H; bot uses swap klines (bingx.ts getKlines). ABNeon zone needs pivots confirmed after 6 closed 4H bars (24h lag) so fresh lows have no zone at event time; zones picked by pivot count desc, max 6 (detectors ~187-190), ×1 clusters never picked. Volume gate vs price touch: ELSA/VVV windows had 0 touching candles (volume was high elsewhere); PYTH/LAB 15.10 touching candles had ratio <1.5.
Spring invalidation (4H close < bottom−ATR with no return in 2 closes) replay price-only: equal work share (15.8%) and ΣPnL; patch kept in .local/neon-spring.patch, not applied pending owner's «внедряй».
Spring NOT applied (owner 2026-10-21). Neon reaction: removed close ≤ top×1.01 cap (owner 2026-10-21); of 8 examples only REZ 19.10 candle 16:00 (ratio 5.82, entry 0.003359) qualifies; rest fail on touch/volume/invalidation.
Neon reaction touch now = low in [zone bottom, top+1×ATR(4H)] (owner 2026-10-21); needs ≥15 closed 4H for ATR. Of 8 examples: REZ 19.10 16:00 (0.003359, r5.82), VVV 18.10 23:00 (22.634, r3.55), LAB 16.10 re-arm 17:00 (0.04535, r1.71, approx zone).
Neon reaction split (owner 2026-10-21): touch = any 1H in window with low in [bottom, top+1×ATR4H]; confirmation = bullish latest 1H, ratio≥1.5, close≥bottom, low≤top+2×ATR4H (same-or-later candle than touch). Replay: first hits ELSA 13.10 14.10 01:00 (0.0534,r11.66), LAB 16.10 17:00, PYTH 19.10 15:00, REZ 19.10 17:00, VVV 18.10 23:00. /tmp/neon is lost between sessions — refetch.
