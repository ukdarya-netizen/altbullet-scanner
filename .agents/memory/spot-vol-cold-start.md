---
name: spot_vol patterns cold-start, not plan-gated
description: no_spot_mult rejections are a cold-start artifact of testing on a freshly-restarted dev instance, not a CoinGlass plan/billing block.
---

CoinGlass Standard plan is active and `/api/spot/pairs-markets` returns real data (verified live, `code:"0"`). A prior memory note incorrectly attributed `no_spot_mult` rejections to a 401 plan-gate — that was already stale by the time it was written (it said "unblocked once Standard plan is active", which was true and had already happened).

**Real mechanics:** `spotVolMult` requires `prescanTracker` entry to have both `spotVolAvg1h` and `lastSpotVol1h`, which are only populated by `runSpotVolBatch()` — called as fire-and-forget at the very END of each scan (`scanner.ts`). So pattern evaluation *during* a scan always uses spot-vol data accumulated from *previous* cycles, never the current one. `spot_vol_accumulation`/`spot_vol_breakout` additionally need `prevSpotVolMult` (2+ cycles).

On a fresh restart with no accumulated history, the first scan(s) will show `no_spot_mult` for most/all candidates — this is expected and self-heals as cycles accumulate (~1 per scan interval).

**Dev vs prod are fully separate DBs** — dev connects to a local Postgres (`heliumdb`), prod uses Neon. A dev-only manual `scan-now` test never pollutes prod data, but also means dev's `prescan_tracker` state (cycle counts, cold-start) is NOT representative of prod. Always check prod's actual `prescan_tracker` (via read-only production DB query) before diagnosing prod-facing pattern behavior — do not extrapolate from a dev test.

**How to check current state (either env):** `SELECT COUNT(*), COUNT(*) FILTER (WHERE spot_vol_cycles>=2), MAX(spot_vol_cycles), AVG(spot_vol_cycles) FROM prescan_tracker`. Production observed with up to 93 accumulated cycles / avg ~5 — healthy, not stuck.
