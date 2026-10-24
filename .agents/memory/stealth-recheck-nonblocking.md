---
name: Stealth range recheck non-blocking
description: Fresh-replay range mismatch no longer blocks Stealth fires; recorded in decision metrics instead
---
Since 2026-10-13 a frozen-vs-fresh-Pine-replay range mismatch (tolerance 5%) does not block a qualified 1H Stealth arm; result is stored as stealthRangeRecheck in decision metrics.

**Why:** it blocked BATON (+35% after) and AIOT (+15%); replay is path-dependent (BATON replay upper 6.9% off, AIOT replay showed an older range). Of 11 recheck-paused arms with candle data, 2 reached +10%, median +0.9%, none fell below -8%. Risk: phantom ranges like SAND 2026-10-07.

**How to apply:** if phantom-range fires appear, compare stealthRangeRecheck.ok=false cohort outcomes before re-adding a block. Post-stop/post-BU 72h data lives in bu_stop_followup_snapshots (not stealth_hourly_snapshots).
