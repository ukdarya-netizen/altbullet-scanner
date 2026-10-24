---
name: liqExhausted null/false semantics fix
description: liquidation_cascade pattern — liqExhausted null conflated two cases; fixed in watcher.ts + scanner.ts 2026-07-19
---

## Rule

`liqExhausted` in `liq_cascade_watch` has three correct semantic states:
- `true`  — CG confirmed cascade exhausted (best signal, 21% bounce)
- `false` — CG answered: cascade still running **OR** `longLiq1hAtDetect == 0` (dump without liq)
- `null`  — CG data unavailable (timeout/cold cache) → scanner treats as fail-open

## Bug (pre-fix)

`longLiq1hAtDetect == 0` (pure sell-pressure dump, no liquidations) was stored as `null` in watcher.ts. Scanner used `=== true` (fail-closed), so both "no liq" and "CG timeout" cases were blocked. 7d data: 220 entries had `liq1h=0→null` (valid block) and 262 had `cold cache→null` (valid candidate, wrongly blocked).

## Fix (2026-07-19)

**watcher.ts** (line ~328): 
```js
const liqExhausted = (row.longLiq1hAtDetect != null && row.longLiq1hAtDetect === 0)
  ? false   // confirmed: dump without liquidations
  : (liqNow !== null && row.longLiq1hAtDetect != null && row.longLiq1hAtDetect > 0)
    ? liqNow.longLiq1h < row.longLiq1hAtDetect * 0.3
    : null;  // CG unavailable → fail-open
```

**scanner.ts** (line ~4486): `_l10Pool.liqExhausted !== false` (was `=== true`)

**PDB block**: `=== false` (was `!== true`) so only confirmed "not exhausted" blocks.

## Why

The pool entry itself is evidence of a dump event (p24h ≤ -7% or liq order stream). null was never "confirmed no liquidations" — it was CG unreachable. Making null=fail-open adds ~262/7d valid candidates without noise from genuine dump-without-liq tokens (those now correctly → false).

## How to apply

When adding checks on `liqExhausted`: use `!== false` for fail-open null, `=== true` only when requiring confirmed exhaustion.
