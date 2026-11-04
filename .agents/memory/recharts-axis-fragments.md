---
name: Recharts axes inside fragments
description: Why composite chart axes must be direct children in this project's Recharts version.
---

Do not group conditionally rendered axes and reference lines in a React Fragment inside a Recharts ComposedChart. Render each axis directly as a chart child.

**Why:** With two y-axes present, the installed Recharts version can fail to associate a Line with an axis nested inside Fragment. Its production build throws only `Invariant failed`, which escaped the BTC page and showed the dashboard's generic load error. A small server render reproduced the crash with nested axes and succeeded with sibling axes.

**How to apply:** When adding multiple data series or conditional YAxis components, keep axes as direct chart children and check the combination where both series have data, not just either series alone.