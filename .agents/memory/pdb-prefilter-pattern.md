---
name: PDB pre-filter pattern
description: How to eliminate noisy PDB rejections by wrapping the PDB block in a precondition guard
---

## Rule
When a pattern has a necessary precondition (a gate that fires on nearly every candidate), declare it as a boolean variable BEFORE the PDB block and wrap the entire `_pdbCheck / _pdbPass / _pdbReject` block in `if (precond)`.

## Why
flush_reversal PDB was logging 98.7% `prev_oi_not_flush` rejections — every token without prevOI30m ≤ -0.3% generated a PDB row. The PDB block was polluting pattern_debug_log with meaningless data. Wrapping in `if (_flushPrecond)` reduces PDB rows to only genuine candidates.

## How to apply
1. Extract the necessary gate into a named boolean: `const _flushPrecond = _prevOi30mLocal !== null && _prevOi30mLocal <= -0.3;`
2. Use it in the pattern boolean: `const isFlush = _flushPrecond && ...rest...`
3. Wrap PDB block: `if (_flushPrecond) { _pdbCheck(...); if (isFlush) _pdbPass(); else if ... }`
4. Remove the rejection branch for the precondition itself (it's now the outer guard, not a reject reason).
5. The outer `noOiNoVol` bypass list still references the pattern boolean — no change needed there.

## Applied to
`flush_reversal` — 2026-07-20: `_flushPrecond = prevOI30m ≤ -0.3%`
