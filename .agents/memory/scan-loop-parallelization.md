---
name: Scan loop parallelization — labeled block pattern
description: How to safely parallelize a giant for-loop body that uses `continue` (44 instances) and has a catch block, without rewriting the logic.
---

## The pattern

The main `for (const ticker of usdtTickers)` loop (4600+ lines, 44 `continue;`) was wrapped in `runConcurrent(N, 4, async (ticker) => {...})` using a **labeled do-while block** inside the try:

```typescript
const abortFlag = { value: false };
await runConcurrent(usdtTickers, 4, async (ticker) => {
  if (abortFlag.value) return;
  // ... timeout check: abortFlag.value = true; return; (replaces break)
  try {
    // eslint-disable-next-line no-labels
    symbolBlock: do {
      // ... all original loop body ...
      // every `continue;` becomes `break symbolBlock;`
    } while (false);
  } catch (err) {
    logger.warn({ symbol, err }, "Error scanning symbol");
  }
  await new Promise(r => setTimeout(r, 10)); // was 100ms
});
```

**Why:** `continue` in a try block can't become `return` (that exits the async function, skipping catch). The labeled `do...while(false)` lets `break symbolBlock` exit the loop body while still running the catch block. `return` in the async worker is the equivalent of `break` in the outer for-loop.

**How to apply:**
- Use `perl -i -pe 'if ($. >= START && $. <= END) { s/\bcontinue;/break symbolBlock;/g }'` for batch replacement.
- Verify no inner for/while loops have `continue` that should NOT be replaced — use a Python depth-tracking script.
- `break;` inside inner retry loops (e.g., for(attempt)) stays as `break;` — only outer-loop `break` needs → `abortFlag.value=true; return;`.
- All 44 outer-loop `continue;` can be in nested if/else — that's fine, they're still outer-loop continues.

## CG-batch cross-vol

`getTakerFlowCached(symbol)` is async — can't call inline. Added `getNetflowBatchEntry(symbol)` (sync getter from `netflowBatch` Map) in coinglass_taker.ts. The `volUsd1h` field (buy1h + sell1h from netflow-list) is stored in the batch. Cross-vol formula: `externalVolMult = max(0, cgVolUsd1h - bingxVol1h) / (avgVol * 2)`.

## Pre-fetch extension

Pre-fetch block (`Promise.all`) extended with 2 more legs:
- `runConcurrent(usdtTickers, 4, async t => getSpotTakerFlow(t.symbol))` — warms 2-min cache
- `runConcurrent(usdtTickers, 4, async t => getSpotVolume(t.symbol))` — warms 5-min cache

After this, all loop-internal calls to these functions are instant O(1) cache hits.

## Per-symbol delay

100ms → 10ms. The 100ms was a rate-limiting throttle; with all I/O pre-fetched, the loop has no significant per-symbol API calls, so it's safe to reduce.
