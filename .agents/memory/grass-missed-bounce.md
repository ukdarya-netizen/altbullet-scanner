---
name: GRASS missed bounce — dip_accumulation gap
description: GRASS-USDT +27% recovery after -20% dip not caught; separate from OI accumulation patterns.
---

## The rule
GRASS-USDT is a confirmed missed `dip_accumulation` case, not related to OI daily accumulation.

## What happened (Jul 2026 analysis)
- Jul 7-8: GRASS-USDT dropped -10.7%, -12.1%, -8.8% (three consecutive large red candles)
- Added to DropsTab watchlist Jul 8 as `bounce_dip` category
- Jul 8-12: slow recovery — no single large candle, distributed grind
- By Jul 12: +26.9% from 5-day start ($0.40 → $0.508), vol5d=35.8M
- System: had 5 signals in May 2026 (4 cancelled, 1 profit +5.6%), no signal on current move

## Why system missed it
- Not a futures OI event — no OI accumulation signal
- Prescan DropsTab bug was present Jul 8+ (watchlist tokens not seeded into prescanTracker)
- After fix: token would need to show OI pattern or volume anomaly to fire a signal
- The recovery was gradual/distributed, not an explosive single-candle event

## What this is NOT
This is NOT evidence for the daily OI accumulation pattern. GRASS recovered because of oversold bounce mechanics (no futures OI signal), while BANK/C-USDT accumulated via OI growth before price moved. Different root causes.

**How to apply:** If investigating dip_accumulation performance, GRASS Jul 2026 is a missed case. If investigating daily OI accumulation, exclude GRASS from the sample.
