---
name: Trailing gap uses PnL percentage points
description: Defines the user-approved meaning of the configured trailing gap.
---

The trailing gap is subtracted from peak PnL in percentage points, not applied as a percentage discount to the peak price. A +24.1% peak with a 10-point gap protects +14.1% from entry.

**Why:** Applying 10% to the peak price produced +11.7% protection for the same example, which did not match the intended trading rule.

**How to apply:** Live watcher, startup recovery, realtime boundaries, shadow tracking, replay analytics, REST/dashboard payloads, UI labels, and tests must all call the shared peak-PnL-minus-gap calculation; presentation endpoints must never reimplement it from peak price. Persisted stops may rise but never move down. At startup, a corrected boundary based on an already durable peak closes immediately when already crossed; the same-observation fence remains for genuinely new peaks.