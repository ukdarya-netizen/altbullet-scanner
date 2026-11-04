---
name: missed_signals_log data collection design
description: Conventions used for missed_signals_log (near_miss + growth_leader sources) — read before extending or querying this table
---

- No dedup/rate-limit on inserts: matches the existing `exhausted_pump_log` precedent — every scan cycle a token still qualifies as a near-miss, a new row is inserted (no per-symbol/per-hour guard). This is intentional for these data-collection tables; time-series density over the same symbol is expected and used later for trend analysis, not considered log spam.
- Growth-leader source dedupes differently: it excludes tokens already in prescanTracker (6h), already tracked as a live signal (24h), or already logged as growth_leader (24h) — because it's proactively scanning top movers rather than reacting to a scan-time gate failure, so it needs its own exclusion window to avoid flooding on tokens that are trending for hours.
- Precedent to follow for any *new* "log why we skipped/missed X" table: check how `exhausted_pump_log` inserts are gated before assuming dedup is required — the codebase's convention for these tables is insert-every-occurrence, not insert-once.
