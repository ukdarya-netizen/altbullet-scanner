---
name: noOiNoVol bypass — missing patterns (complete audit)
description: ALL new patterns were structurally unable to fire because they were missing from the noOiNoVol bypass list
---

# noOiNoVol bypass — complete audit (2026-07-16)

## The bug

`scanner.ts` line ~4734 has a guard:
```
if (!anyOiPass && <all bypass booleans false>) → break symbolBlock
```
Any token that doesn't pass OI thresholds AND doesn't have a bypass boolean set to true gets skipped. Every `if (!det && isXxx)` or `if (!det)` pattern block after this line never runs.

## Patterns fixed — round 1 (isXxx booleans, all had det-creation after the break)

These had `const isXxx = ...` defined before line 4734 but were missing from the bypass condition:
- `isBingxExclusive` — cgOI.available=false by definition → anyOiPass always false
- `isSpotAbsorption` — oi30m < 3.0 by definition, below anyOiPass
- `isWhaleAlert` — OI30m ≥1% below anyOiPass thresholds

## Patterns fixed — round 2 (no isXxx var, conditions evaluated inline after break)

These had their gate conditions evaluated INSIDE the symbolBlock AFTER the break. Added lightweight pre-checks:
- `isSpotDivergenceCandidate` — spotCvd 1h+4h positive + 30m negative (explicitly blocks when anyOiPass=true)
- `isInBidWallPool` — `_bidWallCandidateMap.has(symbol)` (Layer 9 pool)
- `isOversoldCandidate` — RSI 1h ≤ 32 + price24h -25..-5%
- `isSmartMoneyCandidate` — prescan OI 1h ≥ 1% + price24h ≤ 20
- `isExchangeOutflowCandidate` — low OI + spotVol ≥ 1.3 + price gate
- `isLiqMagnetCandidate` — OI 30m ≥ 3% or OI 1h ≥ 1.5%

## Evidence of impact

`tracked_signals` table: zero rows for ANY of these 9 patterns (only legacy patterns like hidden_accumulation, whale_futures, whale_watch had rows).

## Rule for future patterns

**Every new pattern boolean OR inline pattern condition must be added to the noOiNoVol bypass list at line ~4734, or it can never fire when anyOiPass=false.**

When adding a new pattern:
1. If it has a `const isXxx` boolean defined before line 4734: add `&& !isXxx` to bypass condition
2. If its conditions are evaluated inline after the break: add a lightweight pre-check boolean before line 4734, then add it to bypass condition

See new-pattern-checklist.md for the full 6-place update list.
