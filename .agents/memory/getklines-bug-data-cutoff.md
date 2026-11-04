---
name: getKlines candle-ordering bug — historical data cutoff
description: Any pattern-log statistics dated before 2026-07-04 15:37 UTC are unreliable due to unsorted candle data; use this as the start of the retention window. Entry/stop/target prices are unaffected.
---

`getKlines` (in `artifacts/api-server/src/lib/bingx.ts`) never sorted BingX's candle
response before 2026-07-04 15:37 UTC. BingX returns klines newest-first, but all
downstream code assumed ascending (oldest→newest, current=last) order. The bug existed
from the function's creation (2026-04-14) until the fix — the entire ~81-day operating
history of the bot.

**Why:** Any pattern relying on candle-derived trend/delta math (`4h_momentum`,
`impulse_buy`, `flush_reversal`, `spot_momentum_reversal`, and anything else consuming
`getKlines` output) computed on wrong-order candles before the fix. Their historical
rows in `pattern_debug_log` / `prescan_history` / `missed_signals_log` /
`exhausted_pump_log` do not reflect real market behavior.

**Scope confirmed NOT affected:** `entryPrice`/`stopPrice`/target levels for tracked
signals never came from `getKlines` — they use live ticker price (`getFutureTicker` /
`getFreshPrice`), with targets defined as fixed percentages off entry
(`PARTIAL_TARGET`/`FIRST_TARGET`/`TRAILING_ACTIVATION_PCT` in `watcher-config.ts`). So
historical P&L / win-rate of already-tracked signals is trustworthy; only the
scanner's pattern-firing decisions (what it detected/missed) are in question.

**How to apply:** When validating any gate/threshold change against historical pattern
data, only trust rows timestamped **on or after 2026-07-04 15:37 UTC**. Do not count
elapsed days from before that cutoff toward the "wait N days for enough statistics"
requirement — the clock effectively restarts at the fix. Do not extend this doubt to
closed-trade P&L stats — those remain valid across the whole history.
