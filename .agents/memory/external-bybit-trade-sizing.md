---
name: External Bybit trade sizing intent
description: User-confirmed distinction between initial margin and total collateral for a separate trading executor
---

The intended external Bybit executor starts each position with $10 of isolated margin at 10× leverage. This replaced the earlier percentage-of-deposit sizing. The user explicitly permits automatic additional isolated margin from the available futures balance without a per-position top-up limit; $10 is **not** the maximum collateral or loss for a trade. Price targets refer to the unleveraged move from the actual entry price.

**Why:** Calling the initial $10 a per-trade risk limit would materially understate how much of the futures deposit could be committed when positions move adversely. Adding margin changes the liquidation distance but does not reverse trading losses.

**How to apply:** Keep sizing and margin management in the separate executor with live exchange balance and instrument constraints, not in the signal producer. State account-wide exposure plainly before any real-trading enablement; do not enable orders merely by connecting the signal feed. Reconfirm the policy if the user changes it.