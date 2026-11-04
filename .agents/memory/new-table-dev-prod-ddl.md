---
name: New table DDL — dev vs prod split
description: runStartupMigration is prod-only; dev DB needs manual/drizzle-push DDL, prod needs the DDL in runStartupMigration
---

**Rule:** Any new table or index must exist in TWO places: (1) `runStartupMigration()` in api-server index.ts (CREATE TABLE/INDEX IF NOT EXISTS) — this is the ONLY thing that runs against prod Neon; (2) the dev DB via drizzle push or manual psql, because `runStartupMigration` is gated by `NODE_ENV !== "development"` and never runs in dev.

**Why:** Whale Alerts L11 index (`whale_alert_pool_symbol_watching_uq`) silently never appeared in dev after restart — the migration block is skipped entirely in dev mode. Conversely, drizzle push never runs against prod.

**How to apply:** After adding DDL to runStartupMigration, also apply it to dev via `psql "$DATABASE_URL"` (or drizzle push) and keep the drizzle schema in `lib/db` in sync (partial unique indexes via `uniqueIndex(...).where(sql\`...\`)`).

**Raw-SQL caveat:** In this Drizzle/Postgres setup, `ANY(${stringArray})` in a raw SQL template expands into a parameter tuple rather than a PostgreSQL array. Use a static `IN (${sql.join(...)})` whitelist instead.

**Why:** A newly deployed observational aggregate returned 500 despite its table existing because PostgreSQL rejected `ANY(($1, $2, ...))`.

**How to apply:** When filtering a raw query with a known in-code key list, build `IN` from `sql.join(keys.map((key) => sql\`${key}\`), sql\`, \`)`; keep free-form user values separately parameterized.
