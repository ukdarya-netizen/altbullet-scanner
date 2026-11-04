---
name: Balanced Grind retirement
description: Product decision on retaining old BG positions while stopping new activity.
---

`balanced_grind` is retired from new signal generation, live strategy analytics, scanner-specific telemetry, alerts, and the external trading allowlist. It is *not* a dead pattern eligible for destructive cleanup: remaining open positions should stay visible and continue their saved exit/cancellation lifecycle unless the user explicitly approves a narrower administrative correction.

The user later approved a narrow dashboard-only neutral close for three reviewed open BG positions, without an exit price, PnL, or any Bybit order action. `reclassified` is an administrative dashboard state, not evidence that an external position was closed. Real outcomes that occur before applying the correction must remain intact.

**Why:** Hiding or deleting arbitrary open positions erases trading history, while presenting a dashboard-only correction as a Bybit execution would misstate external risk. An initial administrative close also cleared observed peaks and milestones; these are history, not PnL, and must be retained or repaired independently of the neutral status.

**How to apply:** Keep new-entry and relay eligibility separate from open-position/archival visibility. Preserve remaining BG positions and their exit rules; neutral closures must retain previously observed peaks/milestones and remain visible in history outside PnL metrics. Never infer a Bybit close from them.