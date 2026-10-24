---
name: Publish-time partial unique indexes
description: How historical production rows can invalidate a new partial unique index during Publish validation.
---

Before adding a partial unique index in development, run a read-only production
duplicate check using the exact proposed predicate. A clean development table
does not prove that the constraint can be installed on production history.

**Why:** Publish validates the development-to-production diff against a
disposable production fork. Existing historical rows that satisfy the predicate
can make `CREATE UNIQUE INDEX` fail even when development accepts the index.

**How to apply:** If production data cannot be remediated in the approved
workflow, remove the incompatible constraint from the development schema and
development database so it is absent from the Publish diff. Never bypass Publish
with direct production DDL or startup cleanup.