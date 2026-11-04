---
name: CoinGlass OI request order
description: OI batch ordering and breaker behaviour; owner has not given the plan request limit
---
OI batch (phase 0, 4 min deadline, 400 ms start gap ≈ 223 s for 557 symbols) requests arm symbols, then prescan symbols, then the rest. Arm symbols wait for the breaker cooldown; others get breaker_skip.
**Why:** one prod key hit 429 and breaker skipped 216–385 of 557 symbols per cycle, including arm symbols.
**How to apply:** do not claim a key count without the real plan limit (the 600/min in code comments is unverified).

Plan limit (owner, 2026-10-19): STANDARD, 300 req/min per key, one key. Governor start gap set to 250 ms = 240/min (80%). The old "600/min" comment was wrong.

Supported-coins whitelist: when it is null at cycle start the OI universe drops from 557 to 100 symbols for that cycle (seen 2026-10-19 05:22). Scanner now retries the refresh at critical priority first; whitelist TTL is 24h (refresh every 12h).
