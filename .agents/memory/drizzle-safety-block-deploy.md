---
name: Replit publish warning — dev vs prod DB mismatch
description: Replit's Publish flow compares dev DB to prod DB directly. Columns only in prod (added via raw SQL) trigger "about to delete" warnings.
---

## The rule
When adding columns to the prod DB via runStartupMigration (raw SQL), you MUST also add those same columns to the dev database. Otherwise Replit's Publish flow will warn "about to delete" those columns on every publish.

## Why
Replit's Publish flow works by:
1. Introspecting both the dev database and the prod database directly
2. Computing a SQL diff (what would need to change to make prod match dev)
3. Showing destructive changes as warnings

It does NOT read TypeScript schema, Drizzle snapshots, or migration SQL files. Only the actual database schemas matter.

If a column exists in prod but NOT in dev, Replit interprets it as "extra in prod" and wants to delete it.

## How to apply
When adding columns via runStartupMigration:
1. Add column to TypeScript schema (signals.ts) ✅
2. runStartupMigration adds it to prod ✅
3. **Also add it to dev DB**: run `executeSql({ sqlQuery: "ALTER TABLE t ADD COLUMN IF NOT EXISTS ..." })`
   OR run `pnpm --filter @workspace/db run push-force` after the schema is updated

The cleanest ongoing approach: keep `pnpm --filter @workspace/db run push-force` working
against the dev DB so the Replit post-merge setup automatically syncs dev after each merge.

## What NOT to do (tried and failed)
- Safety block in drizzle.config.cjs: irrelevant — Replit doesn't read this file for publish diff
- Creating/updating Drizzle migration files: irrelevant — Replit doesn't use these either
- Updating Drizzle snapshots: irrelevant for the same reason
