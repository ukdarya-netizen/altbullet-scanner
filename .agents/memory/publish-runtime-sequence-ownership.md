---
name: Publish ownership of runtime sequences
description: Prevent Publish schema reconciliation from deleting PostgreSQL sequences created by runtime code.
---

Any PostgreSQL sequence used by runtime allocation must be declared in the database schema and exist in the development database as well as production.

**Why:** Publish compares actual development and production schemas. A sequence created only by a production worker appears production-only, so the publish diff can schedule `DROP SEQUENCE` even though current code still calls `nextval`.

**How to apply:** When adding or auditing a runtime sequence, declare it in the shared DB schema, create it idempotently in development, and require a clean publish schema diff before publishing.