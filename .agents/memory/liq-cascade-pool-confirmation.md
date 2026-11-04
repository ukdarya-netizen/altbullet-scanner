---
name: liquidation_cascade pool-confirmation redesign
description: Why one-snapshot crash gates never fire and how the Layer 10 pool-confirmation redesign works; also documents 2026-07-20 liq_spike redesign replacing price-drop detection.
---

**Rule:** Patterns that must catch a fast event (1h crash) with a slow scan cycle (~10-14 min) cannot use one-snapshot gates — the event window rolls past between scans. Detection must live in a fast dedicated watcher (pool), and the scanner gate should only CONFIRM from pool state.

**Why:** Old liquidation_cascade gate (price1h −8..−15% + OI1h ≤−5% + vol ≥3x + reversal signs simultaneously) had 0 passes in 74,563 checks over 30 days. Live Layer 10 data showed OI1h ≤ −5% NEVER occurs during dumps (min observed −4.62%) — the threshold was above the physical extreme.

**2026-07-20 redesign — liq_spike replaces price-drop detection:**

Old Layer 10 trigger: `price24h ≤ -7%` (direct dump filter). Replaced by CoinGlass liquidation data:

- **liq_spike (PRIMARY):** `longLiq1h / longLiq24h ≥ 25%` + `longLiq1h ≥ $50K` + `p24h ≤ +5%` (pump filter — liq at +5% = squeeze, not cascade)
- **liq_order_stream (SECONDARY):** real-time stream ≥$30K/15min (unchanged)

Key changes vs old design:
- `WatchEntry` in `_watchMap` is now `{ detectedAt, liqExhausted, entryReason }` (was just a timestamp)
- `LiqCascadeL10Entry` exported type carries all 3 fields for scanner per-symbol gate
- `getLiqCascadeLayer10Candidates()` returns full `LiqCascadeL10Entry[]`, not `{ symbol }[]`
- `_l10Pool = new Map<string, LiqCascadeL10Entry>` declared OUTSIDE the `{}` block in scanner.ts so it's in scope for the per-symbol gate
- `LiqCascadeL10Entry` must be imported from `liq-cascade-watcher.js` in `scanner.ts` or TS infers `{}` type

**Scanner gate (as of 2026-07-20):**
```
isLiqCascade = _l10Entry !== undefined
  && _l10Entry.liqExhausted !== false   // false=cascade active; null=fail-open
  && (_l10AgeMin >= 30 || _l10Entry.entryReason === "liq_order_stream")
  && (oi30m === null || oi30m >= 0)
  && priceChange >= -2.0
  && price24hChange >= -50
```
Direct confirmed-fire (bypasses OI Watch PATH A price gate) — same as whale_alert.

**How to apply:**
- Pre-loop: `layer10Raw = getLiqCascadeLayer10Candidates()` declared outside the `{}` batch block; `_l10Pool` built after.
- In-memory sync: after each DB UPDATE in step 6 of the watcher, sync `_watchMap[entry].liqExhausted` so next scan cycle sees the updated state without DB round-trip.
- Bypass conditions: `!isLiqCascade` added to noOiNoVol bypass AND vol-threshold bypass (same pattern as `!isFlushReversal`).
