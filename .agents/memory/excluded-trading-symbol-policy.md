---
name: Excluded trading symbol policy
description: How permanently excluded symbols leave live trading without corrupting historical outcomes.
---

Permanently excluded symbols must be blocked at the shared tracked-signal persistence boundary so scanner, OI Watch, liquidation, recovery, and future fire paths cannot bypass the rule. Existing open positions must be reconciled before production pre-scanner closes or discovery starts, not left to optional maintenance.

**Why:** Path-specific scanner filters are easy to miss, and an ordinary cancellation or synthetic close would contaminate PnL, win rate, and outcome statistics. Optional maintenance can be deferred while the scanner is busy, leaving a window for the old active position to close or notify normally.

**How to apply:** Keep historical terminal trades intact. Move only open positions to the neutral `reclassified` state with no exit/PnL/closed timestamp, clear pending lifecycle notifications, and expire active confirmation watches idempotently. A failed pre-scanner reconciliation should pause and retry production startup instead of starting trading.