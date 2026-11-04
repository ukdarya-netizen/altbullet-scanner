---
name: OI collision ratio check false-positives on liquid majors
description: Why comparing CoinGlass aggregate OI to single-exchange BingX OI with a flat ratio threshold wrongly flags liquid tokens as ticker collisions.
---

CoinGlass `oiUsd` (as stored via `batchGetCoinglassOI`/`getCoinglassOI`) is the "All exchanges" aggregate, not BingX-specific. A batch/historical reconciliation job that compares this aggregate against single-exchange BingX OI with a flat ratio threshold (e.g. >30x = collision) will false-positive on any token where BingX carries a small share of global liquidity — which is normal for majors like BTC, ADA, XRP, DOGE, TRX, ARB, APE, etc. (most volume sits on Binance/OKX/Bybit).

**Why:** A real ticker collision (CoinGlass matching a short/generic symbol to the wrong instrument) produces an absolute `oiUsd` implausible for that token given its own market cap/volume (e.g. ratios in the 1600x-38000x range for RSR/AKE/TAC, or ~19000x for SATS). A merely-thin-on-BingX major produces a ratio that can exceed 30x too, but for a structurally different, legitimate reason. Ratio-to-BingX alone cannot distinguish the two cases; only manual/absolute-magnitude review can.

**How to apply:** Never run this ratio check as a scan-all-symbols/mass-cleanup batch job. Any batch OI collision cleanup must operate on a manually-verified allowlist of specific symbols, not an automatic ratio sweep — an automatic sweep already destroyed ~300 symbols' `oi_daily_snapshots` history and wrongly cancelled a legitimate signal (APE-USDT) in production on 2026-07-10. The existing per-request live cross-validation in `coinglass_oi.ts` (same 30x ratio, but checked against fresh single-request data, not a historical max-over-10-days) is safer in practice but shares the same theoretical flaw — treat any of its `collisionSuspected` flags on high-liquidity majors with suspicion too.
