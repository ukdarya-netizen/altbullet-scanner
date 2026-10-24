---
name: No-fallback aggregate rule (Oct 2026)
description: Owner rule — no aggregate, no signal; MCap CoinGecko-only; all-exchange lists; what was converted and what remains
---
Rule: missing aggregate ⇒ explicit `<pattern>_<metric>_unavailable` reject; no fallback/stale/other-source.
- MCap: CoinGecko only (top-1000 pages); ~32% of 1207 BingX contracts get MCap, rest reject `mcap_unavailable`.
- Exchange lists (spot 10 / futures 28) auto-refresh daily; last list kept on failure (allowed).
- Futures taker/volume use all 28; Spot taker/CVD/SNF all 10. Thresholds recalibrated by percentile on a 90-symbol slice (not full universe).
- Whale Watch taker fallback deleted; unlock list unavailable ⇒ `unlock_data_unavailable`.
**Why:** owner demand (repeated). **How to apply:** new gates must reject on null; do not add fail-open.
Not converted: remaining fail-open comments in watcher.ts, coinglass_listings.ts, whale_index/global_ratio display paths, BA (decommissioned).

## Update (second pass, 2026-10-18)
- MCap now resolved by CoinGecko id (/coins/list by symbol, ambiguity = max mcap, /coins/markets by ids ×250): 573 universe → 514 matched → 509 with MCap.
- volMult/spot-taker/OB-ratio thresholds are named constants (scanner-patterns.ts, coinglass_orderbook.ts), percentile-recalibrated on the full 573-symbol universe.
- Smart Cancel (bid wall) and bearish-OB cancel use CoinGlass aggregated book (getCgAskBids); unavailable book ≠ bearish.
- unlock list >30 min unavailable → admin Telegram alert (apiHealth.reportUnlockListAvailability).
- Dev server does not run the scanner: real per-code reject counts need production; use per-symbol availability probe instead.
- whale_watch:v3 spot-volume exemption kept: v3 requires its own aggregated trigger-candle volume (bounce_volume_unavailable).
