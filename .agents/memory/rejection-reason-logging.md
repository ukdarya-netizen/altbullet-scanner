---
name: Rejection reasons for all patterns
description: Owner requires every pattern drop/hold to record a reason in scan_reject_log; what was covered and lessons
---
Every detected-but-not-fired path must write a reason (`_symRej`), including post-detection drops, volume-gate ratios, wider-range holds, claim losses, qualified-TTL expiry (stores lastScanReject).
**Why:** owner can't tell what to fix otherwise; BEAM case had no stored gate values.
**How to apply:** new skip/continue paths in scanner.ts need `_symRej`. Stealth volume gate is CoinGlass aggregated (futures ≥3×, spot ≥2×), not BingX ratio. Auto Range: chase cap removed, hold = 1 closed 30m candle. LC OI30m gate removed by owner.
