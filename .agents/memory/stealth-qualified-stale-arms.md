---
name: Stealth stale qualified arms and filter simulation
description: Qualified 1h arms never terminate after the retry window was removed; raw-event exit simulation shows no edge from dist/body filter
---
- Qualified arms older than the 6h fire gate stay `qualified` forever (no sweep covers qualified) and their symbol returns the stored decision instead of creating a new arm. Measured 2026-10-18: 58 such arms, but only 1 good breakout (of 480) was blocked on those symbols.
- Raw 1h breakout events (no live gates, no return-to-range cancel) simulate negative average PnL with stop 8 / BU / lock / trailing; dist>=1 & body/ATR>=1 barely changes the per-trade average. Do not present this filter as profit edge; its measured effect is removing reclassified returned-to-range exits.

**Why:** owner asked for evidence-based decisions; avoid overselling the fix.
**How to apply:** before changing the fire window or enabling the filter, restate these limits.

**Update 2026-10-18 (owner order, implemented):** qualified arms close as `qualified_stale_fire_window_elapsed` 2h after the trigger candle close (sweep at cycle start + scanner); 1H fires need dist>=1% and body/ATR14>=1 (`filter_dist_body`, fail-open when data missing); cut-offs go to `stealth_cutoff_shadow` with +24h outcome; every qualified verdict goes to `stealth_arm_verdict_log` (35d retention). 1H replay N=2000 (needs 2200-bar paged history; per-symbol candle cap separate from symbol-cache cap). Memory impact of ~2400 candles x 1207 symbols was NOT measured (dev scanner is off).
Simulation (raw 1H replay of full 2400-bar history, 21342 breakouts, Aug-Oct) did not reproduce the earlier 3690-event/-2.27% result; the earlier dataset is lost, so treat both as unreconciled.
- Rollback of the 1H replay window: env AUTO_RANGE_1H_REPLAY_WINDOW=600 + restart. Convergence (real weekly-anchored window, 443 symbols with >=5500 bars): N=2000 vs 5000 matched 99.6%; N=600 vs 5000 only 66%.
- Earlier -2.27% vs later +0.25% is a period effect: raw-event mean falls from +0.26% (last 37d+) to -3.3% (last 7d); 3690 events ~ last 15 days. Not a bug; recent breakouts lose.
- Live Stealth candle gate has body/width thresholds 0 (only bullish required); a 3%/3% gate was only in my simulation.
