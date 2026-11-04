---
name: Debug log after early return
description: Debug logs placed after early-return branches silently never fire — always place before early returns.
---

## Rule
When adding a debug/diagnostic log to a scan/cycle function, place it **before** any `if (x.length === 0) { ... return; }` early-exit blocks, not after.

## Why
`performScan()` in scanner.ts has an early return at `candidates.length === 0` (the common case — most scan cycles find no candidates). A debug log placed after this return will **never appear in prod logs**, making it look like the feature is broken or undeployed when it is actually just unreachable.

## How to apply
- Before adding a log: grep for `return` statements between the top of the function and the intended log location.
- Place scan-cycle snapshot logs immediately before the first `if (candidates.length === 0)` guard.
- Same rule applies to any watcher cycle function with early exits for empty lists.
