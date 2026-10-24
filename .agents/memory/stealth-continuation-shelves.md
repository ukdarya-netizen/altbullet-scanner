---
name: Stealth continuation shelves
description: Durable boundaries for fresh post-impulse shelf detection and its coexistence with legacy Stealth.
---

Historically, continuation shelves were a separate Stealth method, not a relaxation or replacement of the legacy quiet-zone method. As of 2026-09-27 both Resistance methods are retired for new trades in favor of 4H Range Breakout. Preserve their frozen setups, audit events, prior signals, and entry metrics for calibration; do not reopen the method as an active detector.

**Why:** A fresh intermediate shelf can be actionable before an older high is reclaimed, while forcing that shelf through multi-pivot 4H logic either misses the move or weakens the established detector. Silent method replacement or implicit row selection loses valid legacy setups.

**How to apply:** Build shelves only from consecutive closed event-time 1H candles after a strong impulse and repeated consolidation. Preserve older overhead resistance as context rather than an automatic blocker. Freeze method, bounds, timestamps, and decisions in append-only idempotent telemetry.