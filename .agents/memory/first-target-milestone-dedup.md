---
name: First-target milestone dedup
description: Keeps first-target state, visual, and delivery identity aligned across live and startup recovery paths.
---

# Rule
When a signal crosses its first target and changes from `active` to `in_run`, use
that exact target for the text, visual milestone card, and `lastMilestone` in the
same atomic update that claims the status transition. Startup recovery must reuse
the same event identity on every retry.

**Why:** The first-target message is already sent by the transition. If its level
is not recorded, the subsequent fast cycle interprets it as a new in-run
milestone and sends the same target achievement again. A generic +5% image on
startup recovery also contradicts profiles whose first target is +8% or +10%.

**How to apply:** Any new first-target path, including per-pattern exit profiles,
must derive the caption/card/durable milestone from one configured target and
update status plus `lastMilestone` together under the same `UPDATE ... WHERE
status = 'active' RETURNING` claim. Reuse one deterministic outbox event key for
all startup recovery attempts of that signal.