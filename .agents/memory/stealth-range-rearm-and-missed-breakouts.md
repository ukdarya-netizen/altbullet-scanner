---
name: Stealth Range re-arm and missed-breakout analysis
description: why Stealth missed real Pine 1H Range breakouts (Oct 2026) and what was changed
---
Of 18 real Pine 1H Range breakouts since 2026-10-08, Stealth fired on 3 (ON, KAIA, STRK). Main miss cause: one arm per Pine range (UNIQUE symbol+structure_key = venue:version:openedAt:anchorAt); after an arm ended unfired/obsolete, the same still-active range could never be re-armed and later breakouts were ignored. Fix: 1H arms re-arm under key suffix ":rN" unless an earlier arm for that range fired/was reclassified.
Unfired qualified arms (243): 231 blocked by breakout_candle_not_impulse; only ~9% of them peaked >=10% in 24h, body bucket does not separate winners — do not loosen the impulse gate on this evidence. Data-unavailable (spot_volume etc.) blocks were ~8 arms.
qualified_broadcast_window_conflict on ON/KAIA = the signal had already been inserted (self-duplicate), not a lost signal.
**Why:** owner asked to fix missed real breakouts. **How to apply:** recheck fire rate on re-armed (":r") arms after publish.

Momentum filter (2026-10-10): on 211 replayed 1H crossings, p24h>=4% & OI30m>=+0.04% gave 33% (8/24) +10%-before-−8% vs 11% base; candle-shape features (body, wick, close strength, width, age, volume) did not separate winners. Implemented as an OR with the impulse gate (pass_reason momentum_filter_pass); unavailable data / non-bullish never pass. Sample is 23 winners — overfit risk, recheck on forward data. Crossing telemetry (OI/CVD/taker) was stored as "unavailable_delayed" for most arms, so richer filters need that captured at the crossing.

Taker/volume hypothesis test (2026-10-11): on 89 rejected breakout_candle_not_impulse crossings (CG aggregated, 48h, +10% before −8%) and 13 fired + 4 champion candles, spot/futures taker net sign and spot-taker ≥10% did not separate winners (e.g. spotNet>0: 3 tp/15 stop vs 3/12). Volume ratio hint only: futures ≥3x = 2 tp/0 stop (n=3), spot ≥5x = 2/1 (n=4); fired set contradicts (CKB, MANTA, CFX had big volume and stopped). Not decision-grade. Live Stealth gate is body ≥5% only (no volume/taker).
