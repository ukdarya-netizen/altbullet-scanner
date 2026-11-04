---
name: Scanner status timestamp semantics
description: Durable meaning of scanner start, completion, and duration fields across workers and dashboard rendering.
---

Expose the scan start, successful completion, and duration as separate values. Never overload a completion timestamp as the active scan start or ask the dashboard to infer the distinction from `isScanning`.

**Why:** Repeated UI fixes still showed a completed scan with no trustworthy start information because one timestamp was serving both meanings. Cross-process status made that ambiguity visible.

**How to apply:** Persist and return `scanStartedAt`, `lastScanAt`, and `lastScanDurationMs` independently. Active UI uses the start for elapsed time; idle UI shows start, completion, and duration explicitly.