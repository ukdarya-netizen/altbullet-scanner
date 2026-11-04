---
name: DB columns for broadcast dedup
description: New timestamp columns added to settings and tracked_signals tables for cross-process broadcast deduplication.
---

# settingsTable (lib/db/src/schema/signals.ts)
- `lastRestartNotifiedAt` — restart notification dedup (1h window)

# trackedSignalsTable (lib/db/src/schema/signals.ts)  
- `lastPeriodicUpdateAt` — 4h periodic update guard (3h55m window)
- `lastVolBuildAt` — accum vol-building alert guard (ACCUM_SCOUT_COOLDOWN_MS window)
- `lastOiBuildAt` — accum OI-building alert guard (ACCUM_OI_COOLDOWN_MS window)

**Migration:** Already pushed to dev DB via `pnpm --filter @workspace/db run push`. Must push to prod DB after deploy.

**Why:** In-memory Maps (accumScoutCooldowns) are process-local; DB timestamps are shared between both worker processes.
