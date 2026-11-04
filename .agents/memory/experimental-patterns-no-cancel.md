---
name: Experimental patterns never auto-cancel
description: Standing owner rule — experimental patterns (whale_watch, stealth_breakout) must not be auto-cancelled.
---

Experimental patterns (those in `isExperimentalPattern`) get no automatic cancellation of any kind (stale, smart, max-age); they close only via normal trade exits.

**Why:** the owner said so after a Whale Futures position was stale-cancelled; cancelled rows are deleted from tracked_signals, so they cannot be restored afterwards.

**How to apply:** any pattern newly marked experimental needs a dedicated policy with automaticCancellationEnabled=false in the cancellation policy module.

**Exception (owner, 2026-10-11):** Stealth Range breakouts (1H/4H arms) are cancelled while still `active` (before first target) when a closed candle of the signal's own timeframe closes below the broken Range upper level after entry; reason `stealth_returned_to_range`. Independent of the policy flag (automaticCancellationEnabled stays false for generic stale/smart/max-age). Missing data never cancels; continuation-shelf signals are excluded.
