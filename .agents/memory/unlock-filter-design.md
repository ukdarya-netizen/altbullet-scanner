---
name: Unlock filter design
description: Architecture notes for the token unlock block/warn filter
---

# Unlock filter — design notes

## Rule: two AlphaResult interfaces

`AlphaResult` is defined in **`scanner-patterns.ts`** (exported, used for detection logic), not in `telegram.ts`.  
`telegram.ts` has its own independent `AlphaResult` interface for Telegram formatting — must update **both** when adding a new field.

**Why:** scanner.ts imports AlphaResult from scanner-patterns.ts; telegram.ts is the formatting layer with its own local definition.

**How to apply:** always grep both files when adding a field to AlphaResult.

## signalPayload nesting — critical

`oiWatchTable.signalPayload` is stored as `{ alphaResult: AlphaResult, signalRow: InsertSignal }`.  
When reading `upcomingUnlock` (or any AlphaResult field) from `signalPayload` in `getScannerCandidates()`, use:
```ts
r.signalPayload?.alphaResult?.upcomingUnlock
```
NOT `r.signalPayload?.upcomingUnlock` — that path is always `undefined`.

**Why:** The `{ alphaResult, signalRow }` wrapper is set at line ~7514 in scanner.ts where `const payload = { alphaResult: res, signalRow: sig }`.

## How unlock map flows

1. `getUpcomingUnlocks()` called **once** before `runConcurrent` → `_unlockMap` (4h cache, fail-open = empty Map)
2. Per-symbol: extract `_base = symbol.replace("-USDT", "")`, skip if BTC or ETH
3. Block: `_unlockMap.get(_base)` → daysUntil≤3 + pctSupply≥1% + not watchlist → `break symbolBlock` + `logOverheatedSkip(source="unlock_block", gate="unlock_block")`
4. Warn (4–7 days): `_unlockWarnMap.set(symbol, {...})` — local Map in `performScan()`
5. At `alphaResults.push(...)`: `upcomingUnlock: _unlockWarnMap.get(symbol) ?? null`
6. `formatAlphaSignal` in telegram.ts: reads `s.upcomingUnlock` → `unlockLine`

## Symbol normalization

CoinGlass unlock API returns base symbols (e.g., "SUI", "OP"). BingX symbols are "SUI-USDT".  
`symbol.replace("-USDT", "")` is the correct normalization — identical to `toCgSymbol()` in coinglass_spot_cvd.ts (which also just strips the suffix). No alias table needed.

## logOverheatedSkip source override

`OverheatedLogInput` now has `source?: string` (default: "overheated").  
For unlock blocks: pass `source: "unlock_block"` so `missed_signals_log.source = 'unlock_block'` — queryable independently from regular overheated skips.
