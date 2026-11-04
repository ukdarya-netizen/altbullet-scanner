---
name: Stealth live conditions and 14d grid (Oct 2026)
description: What actually gates Stealth 1H fire, and the offline grid result behind the volume threshold change
---
Live Stealth fire = bullish trigger + volume (fut OR spot ratio) + chase limit (level+0.5×range height) + quality filter (close ≥1% over level AND body ≥1×ATR14, stealth-verdict-journal.ts). The quality filter, not volume, is what separates profitable breakouts in the 14d grid (with it: positive total; without: negative). Volume threshold lowered 2.9→0.8 by owner's criterion (max total PnL at good share ≥ current); 0.8 ≈ no gate, evidence weak (n=78).
Neon volume = aggregated futures taker USD attached to 1H candles (volumeUsd); without it the detector never qualifies. Neon replay 7d: all volume thresholds negative (good share ~5%), 1.5 kept.
ready4h=0 is by design (AUTO_RANGE_LIVE_ENABLED=false); Neon uses per-cycle 4H prefetch, not the Auto Range cache.
**Why:** owner asked criterion-based tuning. **How to apply:** don't loosen dist/body without a new grid; don't attribute Neon gaps to the 4H cache.
