---
name: Overheat log kick-time fields
description: overheat_log stores full metric snapshot at kick time; route must SELECT them; COALESCE pattern for live vs stored whale_index
---

## Rule
When adding metrics to `overheat_log`, they must be:
1. Added to the DB INSERT in `logOverheatedTokens()` in scanner.ts
2. Added to the SQL SELECT in `GET /scanner/overheat-log` (routes/scanner.ts ~line 1220)
3. Added to the response mapping object
4. Added to the OpenAPI OverheatEntry schema
5. Re-codegen'd, typecheck'd, rebuilt

## whale_index COALESCE pattern
`COALESCE(pt.last_whale_index, l.whale_index) AS whale_index` — prescan_tracker (live) first, fall back to overheat_log stored value. Without this, ~80% of rows show null (tokens that left prescan).

**Why:** tokens leave prescan after being kicked; all current_* fields from the LEFT JOIN become null. kick-time values in overheat_log are always available for analysis.

## Entry metrics (до роста)
`entry_whale_index` + `entry_snf_1h` added 2026-07-31 — populated lazily via firstWhaleIndex/firstSnf1h in prescan_tracker. Older rows will be null (no backfill).

## SNF live-fetch removed
Previously snfCells() fetched live `/api/scanner/spot-netflow` in the frontend. Replaced with `kickSnf1h/4h/24h` from DB (kick-time, always populated for new rows). More reliable than live fetch.
