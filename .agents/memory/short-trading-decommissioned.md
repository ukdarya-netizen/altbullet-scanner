---
name: Short trading decommissioned
description: Product decision to retire the dedicated short direction while preserving harmless shared schema compatibility.
---

**Rule:** Do not restore or add dedicated short trading, short-scalp analysis, short telemetry, UI, APIs, or archive tables. The product no longer evaluates short opportunities.

**Why:** The user explicitly decided that the available short evidence did not justify continuing the direction and requested deletion of its code and historical storage.

**How to apply:** Keep generic direction-compatible fields and enum values only where shared long infrastructure requires them; they must remain inert and must not trigger market-data requests or expose a short product surface.