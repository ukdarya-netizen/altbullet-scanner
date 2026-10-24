---
name: PDB cycle identity
description: Durable cross-worker rules for Pattern Debug cycle accounting and active-pattern instrumentation.
---

PDB scan cycles must use a globally allocated, monotonically increasing database identity rather than a process-local counter. Aggregate windows select the latest N actually persisted cycle identities, not an assumed contiguous numeric range.

**Why:** Production can run multiple workers and restart independently. Local counters collide after restarts, while failed scans can leave legitimate gaps in a global sequence. Treating numbers as contiguous can drop real cycles or return fewer cycles than requested.

**How to apply:** Every active pattern must materialize its cycle row even with zero passes. Every incremented check must reach exactly one pass or bounded reject; terminalize pending checks before immediate, idempotent cycle persistence, including error and abort paths.