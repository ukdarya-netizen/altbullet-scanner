---
name: lastPrice24h not persisted — stale on restart
description: prescan_tracker had no last_price_24h column; loadPrescanFromDb used firstPrice24h (original value at first detection, could be 100+ hours old); fixed by adding column + persisting in UPSERT.
---

# lastPrice24h not persisted — stale on restart

## The rule
`prescan_tracker` must persist `last_price_24h` so `loadPrescanFromDb` can restore the current value after a restart. Without this, the column shows the value from when the token FIRST entered prescan — which can be 100+ hours stale for long-running tokens.

**Why:** loadPrescanFromDb initialized `lastPrice24h = row.firstPrice24h` (comment: "will be updated on next scan"). For BANK at 618 cycles (~100h), firstPrice24h was from 100 hours ago. Even with the `|| existing.lastPrice24h` in-memory preservation, after restart the stale firstPrice24h becomes the new baseline. If BingX returns "0" on the first post-restart scan, the stale value is preserved indefinitely.

**How to apply:** Any new `PrescanEntry` field that needs to survive restarts must be:
1. Added to `prescanTrackerTable` schema in `lib/db/src/schema/signals.ts`
2. Added to UPSERT values in `savePrescanToDb` (scanner.ts ~line 815)
3. Added to conflict set in the UPSERT ON CONFLICT block (scanner.ts ~line 863)
4. Loaded in `loadPrescanFromDb` (scanner.ts ~line 704) with `row.newField ?? fallback`
5. ALTER TABLE in `runStartupMigration` Part 2 (`index.ts`)
6. Direct psql ALTER for dev DB (NODE_ENV gate prevents Part 2 from running in dev)

## Fix applied (2026-07-23)
- Added `lastPrice24h: real("last_price_24h")` to prescanTrackerTable
- UPSERT values: `lastPrice24h: e.lastPrice24h`
- UPSERT conflict set: `COALESCE(NULLIF(excluded.last_price_24h, 0), existing, excluded)` — preserves non-zero at DB level too
- loadPrescanFromDb: `row.lastPrice24h ?? row.firstPrice24h`
- runStartupMigration Part 2: `ALTER TABLE prescan_tracker ADD COLUMN IF NOT EXISTS last_price_24h real`
