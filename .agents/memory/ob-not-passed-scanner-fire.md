---
name: OB data not passed from scanner.ts fire paths
description: scanner.ts broadcastBatchAlert calls were missing entryOb — consumeObAtFire was not imported and never called; OB data was always null in Telegram signals from main scan
---

## The rule

`consumeObAtFire` MUST be imported from `watcher.js` in `scanner.ts` AND explicitly passed to every `broadcastBatchAlert` call that comes after `trackSignal`.

**Why:** `trackSignal` fetches BingX order book and stores it in `_obAtFire[symbol]`. Fire paths in `watcher.ts` (background jobs: WhaleFutures, LiqCascade, WhaleAlert, OB patterns) correctly pass `entryOb: consumeObAtFire(symbol)`. But the two scanner.ts fire paths (VolBreakoutSpot at line ~3624; CONFIRMED FIRE / main scan at line ~8523) were missing the import and the call entirely — so OB was always `undefined` → `null` in Telegram signals for ALL main-scan patterns (trend_accumulation, bullish_accumulation, spot_vol_accumulation, etc.).

**How to apply:**
```typescript
// scanner.ts import
import { trackSignal, consumeObAtFire } from "./watcher.js";

// Each broadcastBatchAlert call after trackSignal:
await broadcastBatchAlert([{ ...result, entryOb: consumeObAtFire(symbol) }]);
```

When adding a NEW fire path in scanner.ts: always include `entryOb: consumeObAtFire(theSymbol)` in the spread — it's free (just reads from Map) and silently returns null if OB timed out.
