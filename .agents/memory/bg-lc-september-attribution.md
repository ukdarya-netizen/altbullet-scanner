---
name: BG/LC September attribution
description: Evidence boundary for separating filter damage from market conditions in BG and LC.
---

Balanced Grind’s September frequency collapse is driven primarily by the early
OI30m gate: its rejection share rose sharply while the live pass rate collapsed.
The retained cohort stayed protected but produced fewer large winners. The
p24h risk band and upper cap also rejected candidates that later moved +10%,
but the approximate replay showed similar counts hitting −10% first, so it does
not justify either relaxing or defending those gates by itself.

**Why:** Equal-date production cohorts showed a much larger frequency change
for BG than for LC. PDB is observational and does not suppress trades, but its
decision-trajectory queue was overwhelmingly pending and legacy reject rows
lacked exact decision-time entry prices.

**How to apply:** Attribute BG changes using sequential gate shares and exact,
deduplicated same-gate trajectories. Do not claim rejected candidates were safe
or harmful until entry-price-complete trajectory coverage is representative.

Liquidation Cascade’s September weakness came mainly from smaller realized
winners, not a large fall in signal count. The existing negative spot-taker
gate remained supported; other reject reasons had too little completed forward
coverage for a gate decision.

**Why:** Same-date LC frequency was close to August, while average PROFIT size
fell sharply and the cohort shifted toward protected exits. Approximate reject
replay was small and mostly incomplete.

**How to apply:** Keep LC live gates unchanged until rejected watch trajectories
have enough completed 72-hour paths. Compare frequency, winner magnitude, and
TP-before-SL separately rather than treating net PnL alone as gate quality.