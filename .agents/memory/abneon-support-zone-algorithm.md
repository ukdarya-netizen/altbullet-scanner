---
name: ABNeon support zone algorithm
description: Server ABNeon support-bounce detector uses the Pine indicator's TF-independent zones with ±1% touch tolerance
---
Owner 2026-10-18: S/R levels must be identical on any timeframe; the Pine indicator and the server detector use the same algorithm (4H pivots length 6, 600-bar lookback, ATR(14) bins 0.35, gap 1.2 ATR, up to 6 zones, zone = extreme pivots of cluster). Old pivot-with-two-retests (0.5% band, 3% depth) logic was deleted. Touch/bounce tolerance is ±1%.

**Why:** owner drew SAND zone 0.0485–0.0524 by eye; old detector never saw it.

**How to apply:** frozenLevel is now the zone's top edge; zones are re-derived from 4H candles closed at arm time; rows armed under the old rule fall back to a legacy zone [level*0.97, level]. Do not reintroduce chart-TF-dependent levels.
