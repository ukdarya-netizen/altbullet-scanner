---
name: Impulse core counts as its own trade in statistics
description: Owner rule — a closed Impulse Buy core is a separate settled trade in stats immediately; the runner is another trade later
---
When an Impulse Buy core closes, its core PnL goes into statistics at once as its own closed trade (core close time); the runner later adds a separate trade with its pure runner PnL. Owner stated this 2026-10-17 and contradicted the older "core is telemetry only / never affects totals" rule in impulse-runner-exit-policy.md.

**Why:** the owner expected the +18% core result to appear in totals right away; it did not.

**How to apply:** aggregate stats read tracked_signals through the derived relation in core-settlement-stats (pseudo rows, negative id). Wired so far: tracker journal summary/best/worst/pattern, monthly-stats, per-token and daily-stats. NOT yet wired: Telegram digests/reports, calculator, daily-profitability lib, other raw reports — check them before claiming totals match.
