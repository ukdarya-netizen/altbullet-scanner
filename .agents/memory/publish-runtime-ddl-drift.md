---
name: Publish schema drift from runtime DDL
description: Dev-to-production publish introspection hazards from tables and constraints created only at application startup
---

Keep objects the application needs in the declared schema and keep the development database aligned with production before publishing. Treat a publish diff containing an unexpected DROP as a blocker, even if the schema source code looks correct.

**Why:** Publish builds its migration from the actual development and production database schemas. A simple CHECK created only by application startup in development was introspected and rendered as syntactically invalid `CHECK (CHECK (...))`. Separately, audit tables present only in production were interpreted as deletions with existing records. Neither problem was visible by reading the new table's Drizzle declaration alone.

**How to apply:** For future schema changes, compare the live dev and read-only production catalogues and inspect the recomputed publish diff before retrying. Align missing development structures non-destructively and declare them in schema source. Do not add startup or deployment-time DDL to repair production; Publish owns production schema changes. Ask before dropping or weakening any development constraint.