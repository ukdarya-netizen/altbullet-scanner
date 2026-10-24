---
name: Demark pattern implementation
description: Architecture and key decisions for the experimental demark (TD Sequential Buy TD9) pattern added 2026-07-28.
---

## Rule
The `demark` pattern fires when CoinGlass TA bulk data shows `td1h=9` OR `td4h=9` for a symbol (buy setup complete = 9 consecutive bars where close[i] < close[i-4]).

## Data bridge
- `artifacts/api-server/src/lib/ta-cache.ts` — new module; shared in-memory Map between watcher.ts and scanner.ts.
- Key format: cgBase (no "-USDT"), e.g. "BTC" not "BTC-USDT".
- Scanner lookup: `getTdAtrEntry(symbol.replace("-USDT", ""))`.
- watcher.ts `runTaScannerCycle()` populates via `setTdAtrEntry()` after building entries.
- TdAtrCacheEntry fields: `td1h`, `td4h`, `atr1h`, `updatedAt`.

## Detection (scanner.ts)
- Module-level `_demarkCooldown: Map<string, number>` with `DEMARK_COOLDOWN_MS = 4h` — prevents re-fire when td=9 persists across scan cycles.
- Conditions (as of 2026-08-02): `(_dmTd1h === 9 || _dmTd4h === 9) && _dmCooledDown && prescanCyclesCurrent >= 3 && price24hChange <= 30 && _dmCvdPass`
  - `price24hChange <= 30` (lowered from 40): p24h > 30% = TD9 fires at the top of a pump (deceleration), not at an oversold reversal. KOMA (112%) and CAP (45%) both hit stop/b/e.
  - `_dmCvdPass = cvd30m === true && cvd1h === true` (null = fail-closed): from 7-signal analysis, all profitable signals had all CVDs positive; all losers had 0/4 or null. Pair 30m+1h chosen: medium + slightly longer horizon, avoids 15m noise and 4h lag.
- noOiNoVol bypass: `!isDemarkCandidate` added to bypass chain.
- `_isArchetypeBypass`: `isDemarkCandidate` added — prevents volume filter kill.
- Fire block: after stealth_breakout fire, before `if (!det)`.
- `__isConfirmedFire = true` — skips OKNO confirmation window.
- Logger at fire now includes `cvd30m` and `cvd1h` for diagnostics.

## Cancellations — TD Sequential-only (watcher.ts)
Demark has ONLY its own cancels. **stale_oi_vol and smart_cancel_oi_taker are explicitly excluded.**

Four rules, checked in order (first match wins), all gated behind SMART_CANCEL_MIN_AGE_MS (4h):

1. **demark_counter_td** (td1h ≤ -3): sell setup forming on 1h — 3+ bars where close[i] > close[i-4]. Original cancel, kept.
2. **demark_counter_td_4h** (td4h ≤ -3): higher TF (4h) confirms downtrend. More definitive — overrides expected 1h reversal.
3. **demark_setup_recycled** (td1h ∈ [1..4] after 4h grace): original TD9 didn't produce reversal, market reset the count and started a new exhaustion cycle — old thesis is dead.
4. **demark_td_expired** (age > 36h AND pnl < 0 AND peak < 3%): DeMark's exhaustion window is 1-3 sessions. After 36h without meaningful move, setup has expired.

**Why:** TD9 is a pure price/timing signal — CVD and OI (generic cancels) are irrelevant. TD Sequential theory defines setup invalidation by counter-setups (Rules 1-2), recycling (Rule 3), and time decay (Rule 4).

**How to apply:** Any change to demark cancel must also check all 4 rules still make sense with available ta-cache data (td1h, td4h, atr1h). Do not re-add stale_oi_vol or smart_cancel as exceptions.

## Stop and exits
- `PATTERN_MAX_STOP["demark"] = 8` (ATR≈2×ATR_1h in practice).
- `getNoTouchStopMs("demark") = 4h` (same as whale_alert).
- Default exit profile (10%/15%/10%).
- `getMaxWatchDays("demark") = 2` days.

**Why:** TD9 setups decay in 2-3 days; if no move, thesis is dead. ATR-based stop (2×ATR_1h) maps to ~5-10% for typical alts, capped at 8%.
