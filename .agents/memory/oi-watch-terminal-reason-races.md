---
name: OI Watch terminal-reason races
description: Preserving a terminal OI Watch rejection reason when two workers evaluate the same row.
---

Any non-terminal OI Watch diagnostic update must be conditional on the row still
being `watching`; it must never overwrite a terminal decision made by another
worker.

**Why:** Two independent watcher processes can both read a watching row. One can
atomically expire it with a calibrated rejection reason while the other is still
writing intermediate diagnostics from its earlier checks, leaving the terminal
status but replacing its explainable reason.

**How to apply:** When adding a per-cycle diagnostic field update near a terminal
gate, scope the write to the active status (or the appropriate ownership claim).
Exercise the affected branch with two real database clients and assert both final
status and reason, not only the absence of a signal.