---
name: Prescan tracker stale BingX-only fix
description: Root cause and three-part fix for tokens wrongly showing "BingX only" despite CoinGlass having their data.
---

## Root cause

`prescanTracker` is an in-memory Map. `currentTopSymbols` was built only from `topByActivity` (Layer 1, top-50 by activity score filtered by `isExhaustedByTicker`). Every scan cycle, any token NOT in `currentTopSymbols` was deleted from in-memory tracker. DB records (from `savePrescanToDb`) remained stale with null OI fields. The UI reads from DB → cycleCount≥2 + null OI → triggers "BingX only" label.

Two specific failure modes:
- BEAT (price24h=-28.25%): excluded by old ±25% filter every cycle → deleted from memory → DB OI always null
- SIREN (recently pumped >25%, now at -9.97%): was excluded during pump → DB OI never updated → recovered but still shows stale null

## Three-part fix

### 1. `isExhaustedByTicker` threshold: ±25% → ±40% (scanner.ts ~line 600)

```ts
const pct = parseFloat(pctChange24h) || 0;
return pct > 40 || pct < -40;
```

**Why:** Tokens at -28% (BEAT) are valid accumulation candidates, not dead coins. The old ±25% was too aggressive — it excluded dip-accumulation scenarios. Deep scanner has its own exhausted pump guard at line 1333 (price24hChange > 25).

### 2. Prescan OI DB refresh for stale entries (scanner.ts ~line 675)

After the in-memory prescan OI refresh loop, a fire-and-forget async IIFE:
1. Queries all symbols in `prescan_tracker` DB table
2. Finds ones NOT in current in-memory prescanTracker
3. For each with CG `available=true`, updates OI fields in DB directly

**Why:** Even if a token is correctly excluded from top-50 (e.g. BEAT with extreme move), its DB record should reflect fresh CG data so the UI label is accurate.

### 3. `currentTopSymbols` expanded to Layer 1 + 3 + 4 + watchlist (scanner.ts ~line 808)

```ts
const currentTopSymbols = new Set([
  ...topByActivity.map(t => t.symbol),
  ...oiMoverTickers.map(t => t.symbol),
  ...volAwakenTickers.map(t => t.symbol),
  ...watchlistTickers.map(t => t.symbol),
]);
```

Plus a second loop that adds oiMoverTickers and volAwakenTickers to prescanTracker with cycleCount tracking.

**Why:** OI movers (Layer 3) and VolAwaken (Layer 4) tokens are deep-scanned but were never tracked in prescanTracker → never accumulated cycleCount → never benefited from OI data refresh.

## Important: Layer 2 (topByVolume, 200 tokens) deliberately excluded

topByVolume is NOT added to `currentTopSymbols` — that would bloat the tracker to 250+ entries. The activity score naturally handles ranking; Layer 2 tokens are scanned but don't need persistent cycleCount tracking.
