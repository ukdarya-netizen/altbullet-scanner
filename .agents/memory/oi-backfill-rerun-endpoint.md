---
name: OI history backfill manual re-run endpoint
description: How to manually re-trigger the oi_daily_snapshots backfill without a full redeploy, and why nulls can temporarily reappear on clean dates.
---

`POST /api/admin/rerun-oi-backfill` (added 2026-07-10, artifacts/api-server/src/routes/tracker.ts) manually re-invokes `backfillOiHistoryAfterCollisionCleanup()` on demand — useful when the startup backfill run partially fails (e.g. Neon pool timeouts skip a few symbol/date pairs) and you don't want to force a full redeploy just to re-run it.

**Why:** the backfill only runs once, at server startup (`watcher.ts` ~line 4805). Under Neon pool stress a handful of symbol/date pairs can fail with "Connection terminated" and get permanently skipped for that boot — they need a manual re-run to close out, not a wait.

**How to apply:** hit the endpoint via the production URL (`getDeploymentInfo().primaryUrl`), then poll `oi_daily_snapshots` NULL counts. Because this app is autoscale, an idle deployment may spin up a *new* instance to serve the request — that new instance's own startup sequence re-runs `cleanupOiCollisionArtifacts()`, which re-nulls the 5 whitelisted collision symbols (POWER/RSR/AKE/TAC/LDO) across the last 10 days. This is expected and self-heals within ~2-3 min as that instance's own backfill refills them — don't mistake it for new corruption. May need 2-3 re-runs to fully converge to 0 NULLs due to this cascading restart effect.
