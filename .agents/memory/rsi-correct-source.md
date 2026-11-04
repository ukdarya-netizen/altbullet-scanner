---
name: RSI correct source — loadRsiBulkMap
description: loadRsiMap1h uses a broken CG endpoint; the correct source for RSI data is loadRsiBulkMap from coinglass_ta.ts
---

## Rule
Always use `loadRsiBulkMap()` from `coinglass_ta.ts` for RSI data, never `loadRsiMap1h()` from `coinglass_rsi.ts`.

**Why:** `loadRsiMap1h()` calls `/api/futures/indicators/rsi/list` — this endpoint returns empty/broken data. Confirmed by querying `tracked_signals`: `entry_rsi_1h` was NULL for all 131 signals over 30 days despite the function being wired into `trackSignal`. `loadRsiBulkMap()` calls `/api/futures/rsi/list`, is the source for the working TA tab, and has a 5-min module-level cache (`_rsiBulkCache`).

**How to apply:**
- `loadRsiBulkMap()` returns `Map<string, RsiListEntry>` where key = base ticker (e.g. "BTC" for "BTC-USDT")
- Key extraction: `sym.replace(/-USDT$/i, "").replace(/^1000/, "").toUpperCase()`  
  (mirrors `toCgBase()` in coinglass_ta.ts which does `replace(/USDT.*$/i, "").toUpperCase().trim()`)
- Field access: `map.get(base)?.rsi1h ?? null` (also has rsi15m, rsi4h, rsi12h, rsi24h)
- `coinglass_rsi.ts` (`loadRsiMap1h`, `getRsiFromMap`) should NOT be used anywhere — fully replaced.
- `RsiListEntry` type and `loadRsiBulkMap` are already imported in `watcher.ts` from coinglass_ta.js.
