---
name: Universal pattern backfill
description: Durable evidence contract for calibrating every pattern decision without look-ahead.
---

Every active-pattern decision after a canonical pattern identity exists is calibrated from an immutable decision snapshot linked to a post-decision 15-minute OHLC path. Outcomes include fired, missed, rejected, blocked, watching, expired, and deferred. Scanner pattern-gate rejects are captured centrally with the current immutable candidate context; OI Watch and Liquidation Cascade states are reconciled from their durable rows. Early market-universe filters before any pattern exists are intentionally not mislabeled as pattern decisions.

**Why:** Mutable tracker rows, point-in-time trajectory samples, and one-off CoinGlass snapshots cannot establish what a gate knew at decision time or whether TP preceded SL. Reconstructing absent legacy values would introduce look-ahead and false precision.

**How to apply:** Persist or reconcile the decision before later enrichment can mutate it, preserve per-field provenance and missingness, and collect only closed candles whose open time is not earlier than the decision. Treat legacy nulls as unknown and classify no-price trajectories as unavailable in the same insert, never during a later cleanup. Full trajectories are reserved for active/preserved fired outcomes, lifecycle decisions, and explicit final-gate near misses; low-value early rejects keep audit rows with a stable ~2% sample, while retired patterns stay audit-only. Keep collection idempotent, batched, bounded, retryable, and independent of live gates.