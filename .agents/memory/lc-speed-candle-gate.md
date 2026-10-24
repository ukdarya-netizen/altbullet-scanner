---
name: LC speed candle gate
description: LC live filter by size of the detection 15m candle, chosen for fast outcomes, not flow.
---
LC fires only if the closed 15m candle containing the watch detection time has range >= 10% of open. Missing candle blocks. Applied after the 5x aggregated-volume gate.

**Why:** owner wants fast outcomes and explicitly does not care about signal flow; 119 open positions after a market-wide flush (2026-10-07) and bear-market deposit risk. On 356 signals since Sep 1: +5% within 4h for 16% passing vs 3% rest; still weak, unproven edge.

**How to apply:** detection time comes from liq_cascade_watch (watch.signal_id = tracked_signals.id), not the delayed entry time. Re-check after 20-30 new closed LC signals; no hard position cap (owner rule: quality, not cap).

**BTC exception (2026-10-10, owner):** BTC-USDT keeps the original LC fire rules; the oversized-cascade, detection-candle range and limit-entry filters skip BTC. BTC is the only exception.
