---
name: FS volume module (futures_spot_volume_ratio)
description: New CoinGlass endpoint for absolute 24h futures+spot volumes; replaces getCoinglassSpotVolume24h everywhere in the codebase.
---

## Rule
Use `getFsVolume(sym)` from `coinglass_fs_volume.ts` everywhere spot or futures 24h volume is needed.
`getCoinglassSpotVolume24h` is still exported from `coinglass_spot_cvd.ts` (kept for backward compat / external callers) but must NOT be called from scanner/watcher/tracker internals.

**Why:** cgVolUsd (old futures vol from OI snapshot) has been null since OHLC v4 migration. The new `/api/futures_spot_volume_ratio` endpoint (Binance+OKX+Bybit, 1h×24) gives both futures and spot 24h USD volumes in one call.

## How to apply
- Import: `import { getFsVolume } from "./coinglass_fs_volume.js";`
- Returns `FsVolumeResult`: `{ available, futVolUsd24h, spotVolUsd24h, futSpotRatio }`
- Cache: 30-min positive, 24h negative, semaphore MAX_CONCURRENT=8
- For spot-only callers: `getFsVolume(sym).then(r => r.spotVolUsd24h ?? null)`
- cgVolumeCache (L2 ranking) populated from `futVolUsd24h` inside `runSpotVolBatch` (not the old dead cgVolUsd loop)

## Prescan tracker DB columns (real, nullable)
`fut_vol_usd_24h`, `spot_vol_usd_24h`, `fut_spot_ratio`, `fut_vol_pct_mcap`, `spot_vol_pct_mcap`
Added via idempotent ALTERs in `runStartupMigration` Part 1 and Drizzle schema `prescanTrackerTable`.

## Files changed
- `coinglass_fs_volume.ts` — NEW module
- `scanner.ts` — runSpotVolBatch, saveSpotVolToDb, savePrescanToDb, loadPrescanFromDb, refreshSpotVolFromDb, getScannerCandidates, 3× spot gate replacements
- `watcher.ts` — fetchMarketHealth (cgTurnover now futVol/OI), buildMarketHealthBlock, 6× replacements
- `spotPool.ts`, `tracker.ts` — import replaced
- `lib/db/src/schema/signals.ts` — 5 new prescanTrackerTable columns
- `lib/api-spec/openapi.yaml` — 5 new fields in PrescanCandidateEntry
- `candidates.tsx` — F.Vol% / S.Vol% / F/S× columns in Спот tab
