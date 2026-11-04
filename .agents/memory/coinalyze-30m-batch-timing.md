---
name: Coinalyze 30m batch — Neon pool deadlock
description: Why Coinalyze 30m OI batch was silently never running in production despite correct code.
---

# Root cause

The Coinalyze 30m batch block was placed at scanner.ts line ~1572, which is AFTER the full per-symbol scan loop (lines ~680-1560). The per-symbol loop awaits `batchGetCoinglassOI` for 520 tokens (takes ~5-10 min) AND does per-candidate Neon DB queries — saturating the pg-pool for the entire duration of the scan.

When the code finally reached the Coinalyze block's `await db.update(settingsTable)` (the DB claiming guard), the Neon connection pool was exhausted. The `await` hung indefinitely (no timeout on pg-pool queued queries by default). The code never reached `logger.info("🦑 Coinalyze batch: этот процесс...")` — explaining why "Coinalyze" NEVER appeared in any production logs, even in the catch block.

**Why:** The DB guard `await db.update(...)` is INSIDE the try/catch. When it hangs (not throws), no log fires. The outer scan completes, the next scan is scheduled, and the pattern repeats every cycle.

**Evidence:** `fetch_deployment_logs` with filter "Coinalyze" across ALL time returned zero results — not even the catch block warning.

# Fix

Move the Coinalyze 30m batch to the VERY START of `performScan()` (line ~571), BEFORE `batchGetCoinglassOI` and BEFORE any Neon queries saturate the pool:

```ts
// Right after clearCoinglassOICache() / "Starting AltBullet Scanner" log
const prescan30mSymbols = [...prescanTracker.keys()];
if (prescan30mSymbols.length > 0) {
  batchGetCoinalyzeOI30m(prescan30mSymbols)
    .then(() => { /* save snapshot to DB */ })
    .catch(...);
}
```

**No DB guard** — both processes run independently, each fills its own in-memory `cache30m`. `checkDailyLimit()` inside `batchGetCoinalyzeOI30m` caps to 90 req/day/process. DB save in `.then()` for cross-process fallback (PID 21's data visible to PID 20 via DB).

**Why it works:** At scan start, the Neon pool is fresh (only 1-2 startup queries ran). The fire-and-forget HTTP call completes in ~10s. By the time `getScannerCandidates()` is called, `getCoinalyzeCache30mSnapshot()` returns non-empty data.

# How to apply

Whenever adding a Coinalyze (or other external API) batch call to the scanner:
- Place it at the START of performScan, before `batchGetCoinglassOI`
- Do NOT use DB guard/await for rate-limiting external API calls — use process-local counters (`checkDailyLimit()`) instead
- Fire-and-forget only; never `await` the external HTTP call inside the main scan path
