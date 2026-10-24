---
name: spot_absorption anyOiPass narrowing
description: Why spot_absorption used a narrower OI-exclusion boolean (spotAbsorptionOiBlock) instead of the shared anyOiPass.
---

## Finding
`spot_absorption`'s own gate only cares about `oi5m < 3.0` (low OI so far). It used to be excluded from firing whenever the shared `anyOiPass` was true, but `anyOiPass` also includes `longTfPass` (oi1h≥3% || oi4h≥5% || oi24h≥10%) — timeframes unrelated to the pattern's own 5m-OI condition. A token could have oi1h≥3% (unrelated slow drift) while still satisfying every spot_absorption condition, and get blocked for the wrong reason.

**Why:** `anyOiPass` was designed as a shared "does *any* standard OI pattern fire" flag for other patterns' exclusivity logic; reusing it for spot_absorption assumed all its sub-conditions were relevant, which they weren't for this pattern's short-timeframe thesis.

**How to apply:** `spotAbsorptionOiBlock = shortTfsConfirmed || tSteady` (excludes `longTfPass`) is the exclusion boolean scoped correctly for spot_absorption. If a future audit finds another pattern reusing `anyOiPass` for exclusivity, check whether its own condition timeframe actually overlaps with all of anyOiPass's sub-terms before assuming the shared flag is correct — don't assume by pattern label.
