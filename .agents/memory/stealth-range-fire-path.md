---
name: Stealth Range fire path
description: Why qualified Range stealth arms did not fire and what keeps them firing
---
Qualified Range arms (1H within 3h of first cross, 4H within 6h) are re-offered every scan from the stored decision_json; expired ones are invalidated, never fired late. Missing OI / spot volume are fetched on demand for stealth only (fail-closed kept).

**Why:** arms were stuck `qualified` after a jsonb `::text` param bug and the live evaluator no longer sees the old breakout event; periodic OI/spot batches skipped them.

**How to apply:** if stealth shows `aggregated_data_unavailable:spot_cvd+spot_volume` while CoinGlass returns data (verified by direct request), suspect SpotCVD circuit breaker (returns "no data" silently) or 24h negative cache on a transient code 500 in getSpotVolume. Owner: no need to fire old arms (ADA/CHILLGUY); only future breakouts matter.
