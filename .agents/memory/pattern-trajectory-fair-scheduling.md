---
name: Pattern trajectory fair scheduling
description: Scheduling rule for post-decision OHLC backfill across active and legacy pattern keys.
---

Post-decision trajectory selection gives active pattern keys priority and ranks
eligible rows within each pattern before applying the small per-run limit.
Legacy rows remain eligible, but a large old backlog cannot monopolize every
run and delay current calibration for days.

Within each pattern, fired events and explicit final-gate near misses must rank
ahead of sampled low-value rejects. Queue status must report these
decision-grade and audit/sample backlogs separately so worker activity cannot
hide missing calibration coverage.

**Why:** A global oldest-first limit was dominated by April legacy keys such as
5m, 30m, and 1h. Eligible Liquidation Cascade rows from July stayed pending
with zero attempts even though the worker ran every five minutes. The log's
candle count also measured inserted candles rather than queue attempts, so zero
did not identify which patterns were starved.

**How to apply:** Reuse the canonical active-pattern whitelist and preserve
per-pattern ranking whenever changing trajectory selection. Do not solve
backlog pressure by deleting legacy decisions, marking empty provider results
complete, or raising concurrency enough to compete with the market scanner.
In multi-worker deployments, claim selected rows through a persisted expiring
lease and make every completion, retry, and classifier transition conditional
on the claim or final eligible state. Enforce the active-plus-preserved pattern
whitelist again at the expensive claim boundary; cleanup alone is not a safe
admission boundary. Interleave preserved patterns by per-pattern rank so active
traffic cannot starve their remaining outcome calibration.

The process-local maintenance admission must reserve the next healthy slot for
trajectory work after a collision, retry promptly rather than waiting on a
fixed long interval, and yield between bounded DB classification,
reconciliation, and market-fetch stages when scanner priority appears.

**Why:** A recurring five-minute timer repeatedly collided with other
maintenance jobs and completed zero trajectories for hours. A plain mutex
prevented overlap but provided no fairness.

**How to apply:** Keep trajectory admission identical at live insert, legacy
reconciliation, classifier, status, and claim boundaries. Compound rejection
reasons are `+`-delimited tokens; classify each token consistently. Require a
strictly positive recorded entry price everywhere. Avoid recurring full-history
dedup sorts; business-event keys own write-time deduplication.