---
name: Post-publish cycle and cache figures Oct 2026
description: Baseline after the 2026-10-21 05:57 publish: symbols per cycle, duration, bounded caches.
---
After the 05:57 publish the loop covers 552 symbols per cycle (was ~382); cycles last 1019–1210 s (was ~836 s). process_health caches show sawtooth/bounded collections (symRejDedup, governor samples, coinglass_memo) and flat ones after warm-up; no unbounded collection found in the first hour (rss 448→738 MB).
**Why:** owner asked whether memory grows and how cycle time changed.
**How to apply:** compare later samples to these before calling a growth a leak; restrict by recorded_at since pid values get reused.
