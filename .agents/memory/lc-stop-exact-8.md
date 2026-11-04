---
name: LC stop exactly 10%
description: Liquidation Cascade stop is a fixed 10% (was 8% 2026-10-01..10-10) and stop closures book exactly -10%.
---
Owner decision 2026-10-10: LC stop back to EXACTLY 10% (8% period ended; AIN stopped at -8% and rebounded).

**Why:** owner wants the wider stop; earlier she also wanted exact fills (not overshoot price).

**How to apply:** PATTERN_MAX_STOP.liquidation_cascade=10; exit price/PnL on stop closes come from pure `exactStopFill`; open LC rows are realigned at startup. Closed 8% rows stay as recorded.
