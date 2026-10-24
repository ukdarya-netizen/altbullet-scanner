---
name: Score audit stage 2
description: Per-pattern score rebuild (5-fold CV) results, data limits, and the trajectory-backfill stall root cause
---
Stage 2 (2026-10-21): LC (held-out AUC ~0.58-0.67) and Stealth (0.65-0.70) admit a rebuilt score; PLM and Impulse Buy do not (AUC ~0.50, non-monotone shares). LC score is wired (lc-score.ts); Stealth score is ALSO wired (verified 2026-10-24: scanner computes calcStealthScore at fire, prod signals 22-23.10 show scores 1-10).
**Why:** rejected snapshots carry few metrics; BingX price metrics cover only ~57% of rows and ~1/3 of PLM fired; fired-only metrics are not independent evidence.
**How to apply:** Stealth sample is small (274 resolved, censored); re-check its score vs outcomes once 30+ trades closed after the 2026-10-23 gate change.
Trajectory backfill stalled in prod from 2026-10-06: claim query hit "Query read timeout" on the ~250k pending backlog. Fixed with bounded per-pattern prefilter plus two partial indexes (unpublished, unverified on prod). Universal flowSnapshot already exists on rejects since 2026-10-10; ATR/body/close-strength/BTC are derivable post hoc from klines.
