---
name: Layer 10 watch-to-signal identity
description: Temporal identity and concurrency rules for linking liquidation-cascade watches to fired signals.
---

**Rule:** A liquidation-cascade watch may become fired only from an LC tracked signal for the same symbol whose detection time is strictly after the watch detection and no later than that watch's expiry. Claim the exact watch row by id while it is still watching.

**Why:** Symbol-only matching lets unrelated historical trades close a newly detected watch. In a multi-worker deployment, updating every watching row for a symbol can also erase a newer observation or let workers disagree about which event fired.

**How to apply:** Correlate watch and signal timestamps in the database query, choose the earliest eligible signal deterministically, and use a status-guarded update on the watch id. Remove in-memory state only when it represents the same watch timestamp. For rejected-watch analytics, one canonical row owns the trajectory: a no-price rejection may be atomically promoted by the first price-bearing rejection, after which its provenance stays immutable. If a fired watch is returned to observation, its signal link is intentionally cleared; a one-time correction must validate tracker identity independently of that link on later restarts, or its own successful first run will make every later startup fail.