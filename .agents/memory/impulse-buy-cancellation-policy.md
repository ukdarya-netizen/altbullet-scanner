---
name: Impulse Buy cancellation policy
description: Evidence boundary and lifecycle rule for automatic Impulse Buy cancellations.
---

Impulse Buy must not use the generic one-hour stale path. Its dedicated policy permits only smart cancellation after six hours and the 72-hour max-age fence. Smart cancellation is fail-closed: both entry CVD fields plus current CVD30m/CVD1h and OI30m/OI4h must be available. New cancellation reasons must remain separately attributable with an `impulse_` prefix.

**Why:** The historical replay showed that deleting all cancellations would retain many positions that continued to stop-loss, while early generic stale cancellations included avoidable recoveries. The first dedicated forward cohort also produced material recoveries after CVD smart-cancel, so incomplete evidence is not enough to close a position.

**How to apply:** Keep normal stale disabled. Preserve the six-hour smart path and 72-hour max-age boundary. Apply full CVD/OI completeness only to smart-cancel; max-age retains its independent OI30m plus spot-CVD outflow gate. Do not tighten entry gates from small or feature-incompatible cohorts.