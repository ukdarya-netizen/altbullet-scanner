---
name: Tracked open-status contract
description: Canonical position statuses versus Telegram-only accompaniment events.
---

Open tracked positions have only two statuses: `active` before the first target and `in_run` after the first target.

`ACCUMULATION` and `RE-ENTRY` are not position statuses. A re-entry may still produce a Telegram accompaniment message, but the tracked position remains `active`.

**Why:** The user confirmed these statuses never represented real position states and must not appear in labels, filters, sorting, reports, or runtime status checks.

**How to apply:** New lifecycle logic, API filters, reports, and UI status lists must treat only `active` and `in_run` as open. Do not confuse pattern names such as Bullish Accumulation or Telegram event hashtags with `tracked_signals.status`.