---
  name: oi_pass_blocks removal for 11 fallback patterns
  description: Why removing the anyOiPass gate from 11 fallback patterns was safe, and the dedup guarantees that made it unnecessary to add new protection.
  ---

  Removed `!anyOiPass` from 11 fallback pattern booleans (quiet_oi_accumulation, volume_taker,
  bingx_exclusive, flush_reversal, oi1h_breakout, early_vol_oi, spot_oi4h_build,
  spot_trend_accumulation, short_squeeze, liquidation_cascade, spot_taker_lead) in scanner.ts so
  they can fire even when a strong OI-confirmed signal path exists (anyOiPass=true) but its own
  stricter conditions didn't actually match.

  **Why safe without new dedup code:**
  1. All 11 patterns are evaluated through a sequential `if (!det && isXxx)` chain — `det` is set
     once per symbol per cycle, so removing the gate cannot cause two patterns to fire for the same
     symbol in the same cycle (if/else-if ordering already enforces this regardless of anyOiPass).
  2. `trackSignal()` in watcher.ts (single shared insert path for all patterns, ~line 6780+) already
     blocks duplicate alerts across cycles by checking trackedSignalsTable for status
     active/accumulation/in_run/re_entry before broadcasting.

  **How to apply:** when unblocking/loosening any pattern gate in scanner.ts, check whether the
  pattern's insert path flows through this same trackSignal-guarded insert — if so, cross-cycle dedup
  is already covered and no new guard is needed.
  