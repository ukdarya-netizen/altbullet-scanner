---
name: whale_alert cancel protection + global cancel block
description: Three layers of cancel protection for whale_alert in watcher.ts, plus hl-position-tracker.ts must NOT cancel on whale close.
---

## Rules

**Absolute rule: whale_alert NEVER gets cancelled for any reason.**
Only allowed closures: stop_loss, profit targets (FIRST_TARGET/trailing/milestone), timeout (14d via getMaxWatchDays).
It does NOT matter whether the whale closes their Hyperliquid position — signal continues.

**Task 1 — watcher.ts guards (fast cycle):**
1. `no_price_30m` block: `if (tracked.sentimentKey === "whale_alert") continue;` before the cancel.
2. `stale/peakPct<2.0` block: `if (tracked.sentimentKey === "whale_alert") continue;` at top of stale check — skips stale_oi_vol, stale_72h, and all OI guards.
3. `smart_cancel`: `tracked.sentimentKey !== "whale_alert"` inline guard (pre-existing, kept).

**Task 2 — hl-position-tracker.ts (whale position closed):**
`hl-position-tracker.ts` monitors Hyperliquid whale positions. When a whale closes their position, the tracker used to cancel the tracked_signal with `cancelReason: "whale_position_closed"` (two paths: active close + expired pool cleanup).
Both DB cancel operations have been REMOVED. The Telegram notification ("кит закрыл лонг") is kept but now says "Сигнал продолжает наблюдение — выход по стоп-лоссу или таймауту."

**Why:**
User confirmed: whale_alert never cancels regardless of what the whale does. Whale closing their position is informational only.

**Task 3 — dedup before whale fire:**
In `_runWhaleAlertFireCycle()`, before `trackSignal`, query `tracked_signals WHERE symbol=? AND status IN ('active','in_run','re_entry') LIMIT 1`. If any row found → `continue`.

**Task 4 — _globalCancelBlocked kill switch:**
At the start of the fast cycle for-loop: if no whale_alert cancelled in last 24h → `_globalCancelBlocked = true` → stale block and smart_cancel are disabled for ALL patterns (permanent since whale_alert never cancels).

**How to apply:**
Any new cancel path added to watcher.ts or hl-position-tracker.ts MUST have an explicit whale_alert exclusion before writing to DB.
