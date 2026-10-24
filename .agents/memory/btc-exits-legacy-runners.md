---
name: BTC exits and legacy runner positions
description: Boundary between BTC's unified exit ladder and already partially closed component positions.
---

BTC uses one position-level protection ladder; a prior pattern's core/runner split must not be inherited by new BTC trades or intact legacy BTC trades. But an already core-closed BTC runner must finish under its saved component lifecycle rather than be reclassified as a whole position.

**Why:** The core of such a trade has already been settled. Reinterpreting the remainder as an untouched full BTC position would double-count the economic result or close the wrong quantity.

**How to apply:** When changing BTC exits or replaying history, distinguish whole open positions from those whose core was actually closed; preserve the latter's immutable component outcomes. Do not infer that an external order was filled merely because its event was queued.