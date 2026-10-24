---
name: OI24h Accum — spot-data hard block + message hardcode fix
description: 2026-07-08 fix for a signal firing while Telegram literally said "no spot data — should not have fired"
---

`runOi24hAccumulationCycle` (watcher.ts) did have a real spot-volume gate (`lastSpotVol1h/spotVolAvg1h >= 1.5`), but two separate problems made a real fire look like a data-integrity bug:

1. The ratio-only gate had no absolute USD floor, so a near-empty orderbook could produce a ≥1.5x ratio on negligible dollar volume. Added `OI24H_MIN_SPOT_VOL_1H_USD = 10_000` as a second, independent hard-block condition alongside the ratio.
2. The `AlphaResult` sent to Telegram hardcoded `spotVol24h: null` and `coinglassAvailable: false` for this pattern regardless of what data actually gated the signal — so the alert's own CONTEXT-line fallback text ("⛔ Нет спот-данных — сигнал не должен был сработать") fired even on signals that had genuinely passed the spot gate.

**Why:** a signal message that contradicts its own firing logic destroys trust fast — the user reads it as "the bot ignored its own rule," not as "the display code lied." Always trace whether a hardcoded null in a broadcast payload reflects a real absence of data or is stale scaffolding from before the real gate existed.

**How to apply:** when a pattern-specific `AlphaResult` sets a field to a hardcoded `null`/`false` (as opposed to deriving it from the actual gate variables), check whether that hardcode predates a real gate added later — it's a common source of "message says X, code did Y" bug reports. Prefer deriving broadcast fields from the same variables that gated the signal.

---

**OI24h dedup spam (2026-07-09):** cycle-based dedup queried `tracked_signals` but `trackSignal()` returned `"skip"` (symbol already active under a different pattern) → no row written to `tracked_signals` → dedup always saw 0 → signal fired every 2 min (30 signals overnight for SUP).

Fix: dedup now queries `signalsTable` (always written before `trackSignal()` is called) + module-level `oi24hFiredCache` Set keyed by `symbol:day3Date` as in-memory second guard.

**Rule:** any dedup that calls `trackSignal()` and then queries `tracked_signals` to confirm is structurally broken — `trackSignal` can return `"skip"` without writing. Always use the table that was written *before* `trackSignal()` (typically `signalsTable`) for dedup, or maintain a module-level cache.
