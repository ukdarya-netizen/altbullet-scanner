---
name: Neon Support trading approval
description: User decision to treat Neon Support as a full tradable pattern, with separate receiver ownership.
---

`neon_support_bounce` is no longer an experiment. It is approved for the sender's trading relay and should not carry an experimental label in the dashboard, Telegram, or reports. This does not by itself establish that the separately deployed Bybit receiver accepts or executes Neon orders.

**Why:** The user explicitly approved automatic Neon trades; the prior experimental classification excluded Neon from the relay. The receiver's executable allowlist and live deployment are distinct from this project's sender and checked-in handoff.

**How to apply:** Keep sender and handoff contracts consistent, but require receiver-side update and paper-mode confirmation before claiming end-to-end order execution. Continue to fail closed for unknown patterns and retired BG.