---
name: Stealth frozen-level breakout
description: Auto Range replay is path-dependent; breakout derived from frozen level, replay recheck only blocks on a contradicting range
---
Closed 1H/4H bar closing above the frozen upper level (prev close ≤ upper×1.01) is the breakout even if Pine replay lost the range. Fresh-replay recheck blocks only when replay shows a DIFFERENT range (>5%); no-breakout/unavailable replay does not block.
**Why:** owner approved 2026-10-08/10; replay result depends on loaded history length (CTSI). Oct 7-10 audit: 104 of 619 crossings gave ≥10%, only 2 fired; body ≥5% → 57% winners vs 17% baseline.
**How to apply:** supersedes "Pine event is sole breakout gate"; body ≥3% impulse gate stays.
