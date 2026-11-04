---
name: prescan snapshot retention
description: Durable trajectory rule for tokens that leave the prescan pool.
---

## Rule
A missed mover owns a durable, normalized copy of its full per-cycle prescan path; the exit point is captured with the parent so a same-cycle departure cannot leave the path empty.

**Why:** A symbol/time join against a rolling dataset loses history as TTLs expire and can mix separate appearances of the same token.

**How to apply:** Keep rolling-source retention and backfill eligibility aligned. Parent removal may delete its path, but rolling-source cleanup must not. Capped backfills select only incomplete paths so every batch progresses.

## Analysis focus

The primary use of a missed mover trajectory is to study the token from its first growth/prescan appearance through rejection or overheating. Post-exit prices are only optional labels for deciding whether the path was a true miss; they must not drive entry-gate calibration.

**Why:** The product question is how a token becomes overheated and where the scanner loses it, not how profitable it was after leaving the pool. Mixing future price outcomes into the feature analysis risks look-ahead bias.

**How to apply:** Align BG/SB comparisons by the pre-exit cycle path (p24h, OI, volume, WI, CVD, cycles, and rejection reason), then use any later price only to label missed-big-move versus cooled-off cohorts.
