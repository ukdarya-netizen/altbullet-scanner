---
name: Calculator month-boundary snapshots
description: Rules for immutable calculator archives at the Asia/Dubai calendar boundary.
---

Monthly calculator archives must use the rolling row for the just-closed month
as the parameter source. A background retry or restart reconciliation must not
re-read the user's current settings for that prior month.

**Why:** Settings saved after the month boundary belong to the new month. If a
delayed archive used live settings, it could silently rewrite the historical
model even while trade data was correctly cutoff at the boundary.

**How to apply:** Keep the current Dubai month's rolling row updated whenever
calculator settings are saved. At closure, conditionally freeze that row; a
retry may create a missing row only from settings that existed by the cutoff.
Already closed rows are immutable, and late corrections require an explicit
manual revision rather than an automatic rewrite.