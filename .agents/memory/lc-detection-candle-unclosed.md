---
name: LC detection-candle gate evaluates unclosed candle
description: Why LC signals collapsed from 7.6/day to ~0 after 2026-10-10 (not 18.10)
---
After LC entry-wait removal, the detection-candle gate runs ~1 min after detection, when the 15m candle is still open, so it returns detection_candle_unavailable and the watch dies (590 of 832 watches since 18.10; 229 more too_small). The 5x futures-volume gate and liq_not_exhausted are no longer live rejections (last seen 10.10 and 02.10).
**Why:** audit 2026-10-23; replay with entry at detection-candle close: range>=6 gives 144 watches 47% champions/17% stops vs 26%/32% overall, same direction in all 3 time thirds.
**How to apply:** IMPLEMENTED 2026-10-23: gate judges only the closed candle (pending is non-terminal), range >=6%, loader no longer caches empty or open results. Verify: LC per day and detection_candle_unavailable count after publish.
