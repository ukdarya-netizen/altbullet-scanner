---
name: Stealth live volume legs
description: What the Stealth live-fire volume gate actually measures; the 5x/3% impulse rule is NOT Stealth
---
Live fire: bullish trigger candle + (aggregated futures ratio OR aggregated spot ratio) >= STEALTH_LIVE_MIN_VOLUME_RATIO. Both legs must be measured: spot missing -> `stealth_spot_volume_unavailable`, futures missing -> `futures_volume_unavailable`. The 5x constant belongs to Liquidation Cascade; "5x and 3% body" appears only in an old neutral-close note.
**Why:** from 2026-10-18 to 2026-10-19 the spot aggregate was never requested, so spotRatio was always null and the gate was futures-only (owner objected).
**How to apply:** the spot leg is loaded only when `withSpot` is passed; other callers (fast >=10x path, peaks) stay futures-only. The ≥10x fast path, legacy 3x constants and 1.5x Neon support ratio were not recalibrated to 28/10 exchanges.
