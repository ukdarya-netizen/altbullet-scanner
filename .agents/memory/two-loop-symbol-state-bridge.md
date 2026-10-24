---
name: Two-loop symbol state bridge in scanner.ts
description: performScan() has two separate per-symbol loops; per-symbol state computed in loop1 is lost by loop2 unless bridged via a Map.
---

`performScan()` in scanner.ts runs two separate loops over different collections:
- loop1 iterates `usdtTickers` — this is where pattern boolean gates (`is4hMomentum`, `isFlushReversal`, etc.) are evaluated.
- loop2 iterates `candidates` (built after a CoinGlass OI-confirm filter sits between the loops) — this is where `finalAlphaScore` and `finalSentiment.key` (det) become known.

**Why:** Not every symbol whose pattern gate passes in loop1 becomes a `candidate` for loop2 — the OI-confirm filter can drop it. Passing state between the loops (e.g. "which patterns passed gate for this symbol") requires a `Map<symbol, ...>` declared before loop1 and read inside loop2, same convention already used for `_spotCvdMapScan`. Never assume loop1 and loop2 see the same symbol set 1:1.

**How to apply:** When adding any diagnostic or logic that needs data from both loops for the same symbol, write to a scoped `Map` in loop1 and read it in loop2 — but ALSO keep the loop1-side base behavior/logging intact for symbols that never reach loop2, or that data is silently lost with no fallback.
