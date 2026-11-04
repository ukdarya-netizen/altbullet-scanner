---
name: Watchdog false-fires — 3 root causes + fixes
description: Why watchdog fires 7× per 10h even when scanner is healthy, and all 3 fixes applied.
---

## Root cause 1 — isScanning/lastScanAt set AFTER slow awaits

`state.lastScanAt = new Date()` and `state.isScanning = true` were set ~50 lines into `performScan()`,
AFTER three `await` DB calls:
```
await persistPatternDebugSnapshot(...)  // line 1271
await persistSymRejectLog()             // line 1272
const settings = await getSettings()   // line 1274
```
Under Neon pool saturation these can hang 25+ min. During the hang:
- `isScanning = false` (not yet set)
- `lastScanAt` = previous scan completion time (25+ min ago)
- Watchdog threshold = 35 min → **false alert**

**Fix**: Moved `state.lastScanAt = new Date()` and `state.isScanning = true` (plus the `dbWriteBestEffort` DB persist) to be the very **first thing** after `scanCycleCounter++`, before any awaits.

## Root cause 2 — early return leaves isScanning=true

When `getFutureTickers()` throws, `performScan()` does an early `return` without resetting `isScanning`.
Next scan reschedules normally (10 min), but `isScanning` stays `true` until then.
If the next scan ALSO fails, `isScanning` stays true forever → after 70 min, CRIT alert fires.

**Fix**: Added `state.isScanning = false; state.lastScanAt = new Date();` before the early return.

Also added a `finally` block in `scheduledScan()` as a universal safety net:
```typescript
} finally {
  if (state.isScanning) {
    state.isScanning = false;
    state.lastScanAt = new Date();
    logger.warn("scheduledScan: isScanning stuck — force-reset");
  }
}
```

## Root cause 3 — in-memory cooldown, 2-worker prod

`watchdogLastAlertAt` was a module-level `let = 0`. Production runs 2 worker processes, each with
their own in-memory cooldown. Worker A fires → Worker B fires 1-5 min later (its cooldown = 0).
Effectively doubled alert rate.

**Fix**: Atomic DB claim via `settings.last_watchdog_alert_at` column. Pattern:
```typescript
// Fast pre-check (avoids DB hit when clearly in cooldown)
if (now - watchdogLastAlertAt < WATCHDOG_COOLDOWN - 60_000) return schedule();

// Atomic cross-process claim
const result = await db.update(settingsTable)
  .set({ lastWatchdogAlertAt: new Date(now) })
  .where(sql`... AND (last_watchdog_alert_at IS NULL OR last_watchdog_alert_at < ${boundary})`)
  .returning({ id: settingsTable.id });
if (result.length === 0) return schedule(); // other worker beat us
```
DB fallback: if DB fails, falls back to in-memory cooldown check.

Schema: `settings.last_watchdog_alert_at TIMESTAMP` — added to drizzle schema, `runStartupMigration` ALTER, dev DB patched.

## Timing summary (why 7× / 10h)

WATCHDOG_COOLDOWN = 60 min. With 2 workers each firing independently:
- ~every 60 min Worker A sends, ~every 60 min Worker B sends offset by a few minutes
- = ~7 total alerts per 10 hours
