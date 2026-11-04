---
name: Broadcast-window conflict dropped real signals
description: signals.broadcast_window_key conflict was treated as foreign duplicate; orphan rows were never tracked and the Stealth arm was consumed.
---
Conflict on the symbol:30min key returned zero rows and the fire was dropped. In 14 days all 162 logged duplicates matched a same-pattern signals row that was untracked (125 Stealth). Fix: adopt the existing row if same pattern, untracked, and it is this decision or older than 90s.

**Why:** owner lost a real RSR Stealth breakout (11.10) to "broadcast_window_conflict"; she called the excuse unacceptable.
**How to apply:** root cause of the first insert (who wrote it, why untracked) was not proven; after publish check that dup rows drop and the adopt warning appears in logs. scan_reject_log now carries `decision_reason_not_recorded` markers per live pattern to expose silent gaps; arm waiting reasons are `armed_<waitingReason>:<levelSource>`. 4H detection is OFF in code since 2026-10-10 (no 4H arms created after that); only stale 4H labels in reject reasons remained and were switched to range_1h_*.
