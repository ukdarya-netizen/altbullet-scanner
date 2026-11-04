---
name: oi24h_accumulation floating daily-snapshot timing bug
description: oi_daily_snapshots is a single point-in-time value taken whenever the first scan cycle crosses UTC midnight, not a fixed daily candle — a delayed cycle can catch a noisy intraday peak instead of the day's real trend.
---

## Finding (EVAA case, 2026-07-09)
`saveDailyOiSnapshots()` is gated by `todayUtc !== lastOiSnapshotDate` inside the regular scan cycle (scanner.ts) — it fires on whichever scan cycle happens to be the first to run after UTC midnight, not on a fixed schedule. Normally that lands near ~00:03 UTC, but a delayed/slow cycle (long scan duration, restart, backlog) can push it hours later.

For EVAA, the day3 (2026-07-09) snapshot was taken at 05:27 UTC — 5+ hours late. The value happened to still show a small increase over day2 (+0.9%), so `oi24h_accumulation`'s 3-day monotonic-growth check fired. But the token had already pumped hard the prior day (07-08: OI +257.8%, price +260%) and was already reversing intraday — by the time the signal actually reached the user, live OI had crashed -30.88% from that morning's snapshot. The daily snapshot is a single point, not a candle, so it cannot see the reversal that happened *after* it was taken but *before* the signal check runs.

**Why:** any pattern built on once-a-day point-in-time snapshots is vulnerable to snapshot-timing noise — a single lucky/unlucky sample can flip the classification versus what a real daily candle (open/high/low/close) would show.

**How to apply:** Fixed 2026-07-09 by adding a live-OI reversal re-check in `runOi24hAccumulationCycle` (watcher.ts) right before firing: fetch current `getCoinglassOI(symbol)` and require `liveOi.oiUsd >= day3SnapshotOi * 0.97` (3% noise tolerance) — if OI has already reversed down since the day3 snapshot, skip. This is a general pattern worth reusing for any other tracker that fires off a stale daily/periodic snapshot rather than live data: always sanity-check the live value at fire time, not just the historical snapshot chain.
