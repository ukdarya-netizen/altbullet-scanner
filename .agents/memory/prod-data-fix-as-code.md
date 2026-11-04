---
name: One-time prod data fixes must ship as code
description: How to correct historical rows in the production DB when the dev shell has no write path to it.
---

## Constraint
- `executeSql` with `environment: "production"` is read-only (SELECT only).
- The dev shell's own `DATABASE_URL` points at the local dev DB (see `dev-prod-split-brain.md`), not Neon prod — running a write from bash/code_execution in dev never reaches production data.
- There is no prod DB credential available directly in the dev shell.

## Pattern that works
Write the correction as an idempotent function that runs inside the app itself (e.g. a guarded step in the startup sequence), matched on a condition that uniquely identifies the bug artifact (not a one-off symbol/ID list). Ship it in the same deploy as the code fix that stops new bad rows from being created. It self-executes once in prod on next boot, logs the affected row count, and becomes a no-op on subsequent restarts once the backlog is clean. This startup-after-publish flow has been confirmed to restore a production signal successfully.

**Why:** Matches the existing documented approach in `dev-prod-split-brain.md` ("the only write path is through the prod API itself") — generalizes it from "temporary admin HTTP endpoint" to "idempotent startup fix", which avoids the extra add-endpoint/curl/remove-endpoint cycle for pure data-correction cases (no external caller needed, no manual trigger required).

**How to apply:** Before writing a one-off backfill SQL script, check whether the condition can be expressed as a durable, idempotent guard and wired into the app's normal startup path instead. Verify the logic on the local dev DB first (restart the dev workflow, confirm the log line reports the expected row count) before it ships to prod via deploy.
