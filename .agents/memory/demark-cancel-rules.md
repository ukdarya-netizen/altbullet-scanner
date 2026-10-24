---
name: Demark cancel rules — complete set
description: Full list of all 4 demark cancel rules with current thresholds, guards, and rationale. Prevents surprises about unknown rules.
---

# Demark Cancel Rules — Complete Set (as of 2026-07-31)

There are exactly **4 rules**, no more. All live in the `DEMARK CANCEL` block in `watcher.ts`.

## Rule 1 — `demark_counter_td`
- Condition: `td1h ≤ -5` AND `pnl ≤ 0`
- Debounce: ≥2 consecutive TA-scanner cycles (~10 min)
- **Why -5**: 1/3 of setup (-3) fires on normal post-TD9 consolidation; -5 = majority of counter setup confirmed.
- **Why pnl guard**: profitable signal → thesis working, counter bars are noise inside the move (RLC case).
- **Why debounce**: CoinGlass includes current unclosed 1h bar; td1h can flicker every 5 min.

## Rule 2 — `demark_counter_td_4h`
- Condition: `td4h ≤ -5` AND `pnl ≤ 0`
- No debounce (4h bar closes every 4h, no repainting risk)
- **Why -5**: symmetric with Rule 1; -3 was too soft.
- **Why pnl guard**: same rationale as Rule 1.

## Rule 3 — `demark_setup_recycled`
- Condition: `td1h ∈ [1..4]` AND `pnl ≤ 0`
- Debounce: ≥2 consecutive TA-scanner cycles (~10 min)
- **Why pnl guard**: after successful TD9 Buy reversal, setup naturally resets to 1–4 as price moves up — not a thesis failure.
- **Root cause of RLC case**: setup_recycled fired at +2.9% pnl → signal missed +11% further.

## Rule 4 — `demark_td_expired`
- Condition: `ageHours > 36` AND `pnl < 0` AND `peak < 3%`
- No debounce, no pnl guard (pnl < 0 is already built in)
- **Rationale**: DeMark TD9 reversal window is 1–3 sessions; 36h without movement = thesis expired.

## Debounce infrastructure
- Module-level `_dmCancelDebounce = new Map<number, { r1: number; r3: number }>()`
- Key = `tracked.id`; resets per-counter when condition not met; deleted on actual cancel
- r1 = Rule 1 counter, r3 = Rule 3 counter (Rule 2 and 4 don't need debounce)

**Why:** Prevents false cancels from CoinGlass open-bar flickering on 1h TF.
**How to apply:** Any new demark rule reading td1h (unclosed bar) needs the same debounce pattern.
