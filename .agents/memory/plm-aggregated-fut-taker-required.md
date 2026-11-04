---
name: PLM requires aggregated futures taker
description: PLM fire is fail-closed on multi-exchange aggregated futures taker data
---
PLM uses CoinGlass aggregated futures taker (7 exchanges, latest 15m candle) as the primary source; if unavailable the signal is not issued (pdb reject `fut_taker_unavailable`). The old Binance+BingX per-symbol fallback is removed.

**Why:** the owner said this path is primary, not a fallback; no data means no signal.
**How to apply:** do not reintroduce a single-exchange fallback; thresholds (≥20% shadow class) remain observational.
