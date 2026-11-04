---
name: OI24h Accum burst-on-deploy + missing spot volume filter
description: Why oi24h_accumulation fired many signals in a tight burst right after a deploy, independent of the main scan, and what was missing from its gate conditions.
---

`runOi24hAccumulationCycle` (oi24h_accumulation pattern) runs on its own independent
fast-cycle tracker (2 min), not gated by the main scanner at all — by design, same
shape as Whale Futures. `startWatcher()` also has a dedicated "immediate backfill on
deploy" `setTimeout` that runs this cycle 15s after every process boot.

Its only fire-dedup was "already fired today for this exact day3Date" — nothing
throttled how many *different* symbols could fire within a single invocation. So on
any restart/deploy, every candidate that hadn't fired yet that day fired back-to-back
within seconds, which looked like a burst/bug to the user even though the main scan
was still mid-cycle (unrelated).

Also: despite the intended design (per user/replit.md) being "OI growth + spot volume
≥1.5x", the original implementation only checked OI monotonic growth + an overheat
price filter — there was no spot volume condition in code at all.

**Fix (2026-07-08):** added a `spotVolMult >= 1.5` gate (same formula as OI Watch:
`lastSpotVol1h / spotVolAvg1h` from `getPrescanEntry`), and capped fires to 1 per
cycle invocation (`OI24H_MAX_FIRES_PER_CYCLE`) so a backlog of candidates trickles out
one per 2-minute tick instead of firing all at once.

**Why:** backtest for this pattern is already negative (10.1% vs 8.35% baseline,
statistically insignificant) — it's a live-data-collection experiment, so a mass burst
of untested-quality signals on every deploy was actively harmful to trust in the bot's
output, on top of not matching the documented gate.

**How to apply:** when adding any new independent fast-cycle tracker (not gated by
main scan) that can accumulate a backlog of eligible candidates, always cap
per-invocation fires and confirm the intended filter conditions are actually wired up
in code, not just documented in replit.md.
