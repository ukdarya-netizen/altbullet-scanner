---
name: Balanced Grind decision snapshots
description: Why BG entry telemetry must retain the exact values used to decide firing.
---

Balanced Grind calibration must use an immutable snapshot of the values actually
evaluated by the firing predicate: p24h, order-book ratio, funding, spot
netflow, whale index, CVD, OI and volume.

**Why:** The tracked-signal entry fields are enriched from the mutable prescan
tracker and later order-book requests after the scanner has evaluated the
pattern. They can therefore differ from the values that allowed or blocked the
original signal. Treating them as the decision inputs can falsely diagnose a
working hard gate as bypassed, or incorrectly tune a threshold.

**How to apply:** Before changing BG entry rules, pass a decision-time snapshot
through the confirmed-fire path and persist it alongside the signal. Only then
replay candidate thresholds and compare winners, stops, cancellations and
near-misses. Do not infer a new volume or OB hard gate solely from the current
post-enrichment cohort.

Scanner-rejected candidates must also persist the exact current 30m candle
close as their decision-time entry price. Missing rejected entry prices make
the shared OHLC trajectory worker skip every near-miss, so upper-cap and
risk-band shadows can never produce TP-before-SL evidence.

**Why:** The scanner already evaluated each gate against the current candle
close, but the generic rejection batch previously persisted only p24h, OI,
volume, and cycle metadata. All fresh BG rejected snapshots therefore had a
null entry price despite otherwise immutable metrics.

**How to apply:** Propagate the evaluated close through the centralized reject
context with explicit provenance. Never reconstruct legacy null prices, and do
not include price in rejection dedup/event identity.