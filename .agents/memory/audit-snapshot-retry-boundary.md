---
name: Offline audit snapshot and retry boundary
description: Keep parallel calibration audits on one frozen cohort and avoid repeating market downloads after report failures.
---

Freeze outcome statuses, original entry prices, recorded peaks and PnL once before parallel analysis. Workers must join immutable feature and candle evidence to that frozen identity set, rather than independently reading later mutable outcomes. Acquisition and report rendering need separate retry boundaries: a report failure must rerender saved data without another market download.

**Why:** During the PLM audit a report-render failure caused a second public candle acquisition pass. Each pass was bounded, but the aggregate request count exceeded the intended audit budget. Parallel live outcome reads would also let one analysis use different membership or closure states from another.

**How to apply:** Persist successful acquisition before constructing narrative output, use explicit report-only/offline reruns, and budget requests across the entire request including retries. Keep separately timed global inventory reads labelled as such; do not present them as the same atomic snapshot as the frozen trade cohort.