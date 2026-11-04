---
name: Bullish accumulation milestone policy
description: Notification wording and stop-protection policy for bullish_accumulation before its first target.
---

`bullish_accumulation` must notify at +5% and +8% like every other pattern, including price, partial-profit guidance, health and market context. These progress messages must explicitly remind the user that the stop moves to breakeven at +10%; they must not claim that the stop has already moved. The +10% first target is the first point that activates breakeven/trading-state protection.

**Why:** The strategy deliberately retains a +10% breakeven threshold for bullish accumulation, and the user requested that early progress alerts make this threshold explicit without misrepresenting the current trading state.

**How to apply:** Use the pre-target message format for milestones below the pattern's B.U. threshold, include the +10% reminder only for bullish accumulation, then use the normal first-target/partial message only at that threshold. Any new early milestone must preserve this wording split.