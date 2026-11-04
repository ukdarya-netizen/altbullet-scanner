---
name: Neon DUSK delayed delivery (review after outcome)
description: Case 2026-10-13 — Neon Support signal waited 457 min in the qualified queue before sending; owner wants to revisit after the trade closes.
---
Neon Support DUSK-USDT: 4H bounce detected 2026-10-13 08:00 UTC, sent 15:37 UTC (457 min). Every 30-min cycle re-offered it and it was rejected by aggregated_data_unavailable (spot_volume/oi/spot_cvd) or spot_taker_sell_dominance. Entry price was taken at send time ($0.09602), not at detection. Telegram showed "Taker 30%⚠️".

**Why:** the owner declined a max-wait limit ("посмотрим, как отработает") and asked to return to this case after the trade finishes.

**How to apply:** when DUSK's tracker closes, report outcome (peak/PnL) and whether the late entry hurt vs. detection-time price; only then discuss a Neon queue max-age (e.g. 2–3h). Do not add the limit before she decides.
