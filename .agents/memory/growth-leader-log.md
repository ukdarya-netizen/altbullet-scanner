---
name: growth_leader_log — prod DDL and entry metrics
description: growth_leader_log table setup, prod DDL requirement, entry OI fields, and data flow
---

## Table never existed in prod — root cause

`growth_leader_log` was created via `drizzle push` in dev only. Production Neon DB never received the DDL. All INSERT calls silently failed in try/catch. Zero rows were ever logged until `CREATE TABLE IF NOT EXISTS` was added to `runStartupMigration`.

**Rule:** Any new table MUST ship a `CREATE TABLE IF NOT EXISTS` block in `runStartupMigration` in `artifacts/api-server/src/index.ts`. `drizzle push` only reaches the local (heliumdb) dev DB, never Neon.

## Entry metrics source

`first_oi_30m / first_oi_1h / first_oi_4h` live in `prescan_tracker` DB table (set via COALESCE on first INSERT, never overwritten). They must be loaded into `PrescanEntry` in-memory map via `loadPrescanFromDb`, then passed to `saveGrowthLeadersToLog` as `entryOi30m/1h/4h`.

## Logging frequency

Called inside `performScan` at the end of each scan cycle (~10 min) as `void saveGrowthLeadersToLog(tickers)`. Logs top-100 BingX tokens with p24h > 3%. TTL 30 days. Separate from scan batch — uses raw `allTickers` BingX array.

## isCryptoFuture scope

`isCryptoFuture` is defined inside `performScan` function scope — cannot be called from module-level functions. The filter must be inlined in `saveGrowthLeadersToLog`.
