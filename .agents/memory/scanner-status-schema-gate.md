---
name: Scanner status schema gate
description: Prevent scanner and dashboard status outages caused by optional schema maintenance being disabled.
---

Any settings column read by the scanner startup path or `/api/scanner/status` must be installed in the mandatory scanner recovery schema gate, not only in broad optional startup maintenance.

Deployment liveness must also become unhealthy after a bounded grace when a fresh worker has not completed any scanner cycle and remains in a bootstrap DB/schema error. The grace must exceed both the VM promote window and a normal cold scanner start; a transient error after a completed cycle should not trigger this bootstrap restart path.

**Why:** With `RUN_STARTUP_MAINTENANCE` disabled, a new scan-duration column was absent in production. The status endpoint returned 500, dashboard API indicators became empty, and the scanner's `getSettings()` query failed before each discovery cycle while `/api/healthz` still returned 200.

**How to apply:** When adding or changing scanner settings/status fields, place idempotent DDL and any safe backfill in the required scanner schema gate that runs before scanner startup. Keep broad maintenance for non-critical cleanup only. Ensure local liveness distinguishes a never-bootstrapped worker from a scanner that has already completed a cycle, and never use a bootstrap grace shorter than publishing readiness.