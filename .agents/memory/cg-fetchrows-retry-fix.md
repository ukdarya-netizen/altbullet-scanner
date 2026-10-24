---
name: CoinGlass fetchCgRows retry bug fix
description: Two bugs in fetchCgRows caused false timedOut=true for valid tokens (EVAA, LAB); fixed 2026-07-13.
---

## The bugs

**Bug 1 — retry on empty array (pointless):**
When CoinGlass returned empty array (symbol not found), code retried with a different API key. Different key can't change whether CG has data for a symbol. This caused: empty array on "LAB" → retry → "LABUSDT" also got empty array → its retry timed out → propagated `timedOut=true` to final result. EVAA and LAB both showed `timedOut=true` every cycle despite CG having real data for them.

**Bug 2 — timeout too short (3000ms):**
Some tokens (EVAA, CZ, LUMIA) genuinely have CG data but the server-side lookup takes >3000ms. 3000ms was set to prevent scan duration regression after old code retried on empty array constantly. With Bug 1 fixed (no retry on empty), raising timeout to 5000ms is safe — empty-array tokens now exit instantly instead of burning 250ms + second request.

## The fix

- `CG_FETCH_TIMEOUT_MS`: 3000 → 5000ms
- `fetchCgRows`: retry block moved inside `!res.ok` branch only. Empty array returns `{rows: null, timedOut: false}` immediately — no retry.

## Result after deploy

- EVAA: now gets `globalOI=2.25%` from CoinGlass ✅
- LAB: now gets `globalOI=1.38%` from CoinGlass ✅
- Both appear in GATE_REJECT_LOG under `deepNeg` (p24h=-37/-40%) — correct behavior, not a CG data bug.
- LUMIA, CZ: still `n/a` — genuinely absent from CoinGlass v2 public API.

**Why:** Retry on empty array was correct for HTTP errors (different server instance might respond differently) but wrong for empty data (no key change can add data CG doesn't have).
