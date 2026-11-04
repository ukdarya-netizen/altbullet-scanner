---
name: Упущенные tab — gap details + growth-leader enrichment
description: Design decisions for the missed_signals_log gapDetails column and growth-leader-monitor per-candidate enrichment, for future extensions to the "Упущенные" tab.
---

`missed_signals_log.gap_details` is a nullable TEXT column storing a JSON array
`[{metric, value, threshold}, ...]` — one entry per failed gate condition for a
`near_miss` row (e.g. all 4 OI timeframe thresholds when `noOiNoVol` fires, or
the SpotCVD comparisons for `dipAccumCvd`/`accumCvdMtf`). It is always `null`
for `growth_leader` rows since those have no single gate to compare against
(reason is always `not_in_prescan_pool`).

**Why:** the user wanted to see not just *which* gate blocked a signal but the
actual value vs. threshold for every failed condition, without re-deriving it
manually per token.

**How to apply:** when adding a new near-miss push site in `scanner.ts`,
populate `gaps: NearMissGap[]` on the `nearMissLog.push(...)` call listing ALL
failed conditions (not just the first). The frontend (`candidates.tsx`, tab
`missed`) parses `gapDetails` client-side and shows it as a title/tooltip on
the reason cell — no gaps stored means no tooltip.

`growth-leader-monitor.ts` originally only ever set `oi4hPct`; all other
metrics were left `null`. It now enriches with `getCoinglassOI` (OI
5m/30m/1h/4h), `getSpotVolume` (spotVolMult derived as `volumeUsd1h /
(volumeUsd24h/24)`), `getSpotCvdMtf` (cvd5m/1h/4h), and a futures volMult via
30m klines average — but **only for the final filtered candidate list** (after
excluding symbols already in prescan/signaled/logged), not the initial top-100
pool. This keeps per-cycle CoinGlass/BingX call volume bounded to genuinely-new
missed signals (usually a handful/hour) instead of ~100 calls/hour.
