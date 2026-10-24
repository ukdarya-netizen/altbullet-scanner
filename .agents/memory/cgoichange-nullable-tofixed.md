---
name: cgOIChange nullable despite number type
description: Why scan-loop "toFixed of null" crashes happen and where to fix them
---

`cgOIChange` in the scan loop is declared `let cgOIChange: number` but is assigned through non-null assertions (`oi30m!`, `oi1h!`, `oi24h!`) in the OI tie-break chain. The guarded branches are safe (thresholds require non-null), but the final fallback `: oi24h!` leaked null for symbols that pass gates via non-OI paths (spot patterns, L11/L12 injected tokens with no CG OI data) — crashing any later `cgOIChange.toFixed()` with "Cannot read properties of null".

**Why:** C-USDT/WOO-USDT crashed the per-symbol scan in prod (near-miss priceGate logging path) on 2026-07-15.

**How to apply:** Fixed at the source: fallback is now `(oi24h ?? 0)` — null and 0 are treated identically by all downstream comparisons. If adding new tie-break branches or similar `!`-assertion chains, normalize null at assignment, not at each `.toFixed` call site. TypeScript's `number` type is not trustworthy where `!` assertions feed the variable.
