---
name: Health and cancellation outcomes schema
description: Schema contract for owner-only health and cancellation outcome analytics
---

**Rule:** The health event, cancellation outcome, and weekly cancellation snapshot tables must be ensured by a lightweight, idempotent startup schema gate in both development and production. Do not rely on optional heavy startup maintenance or manual development DDL.

**Why:** These tables are read directly by owner-only dashboard endpoints. When their DDL was limited to optional production maintenance, a fresh development database returned 500 for both analytics pages even though the frontend and routes were correct.

**How to apply:** When adding a column or index required by these analytics endpoints, extend the lightweight health-outcomes schema gate in the same change. Keep it transactional and protected by an advisory lock so multiple workers can start safely.

**Rule:** Accuracy must use the first event for each signal and message type. Report total message rows separately; cooldown repeats from one position are not independent evidence.

**Why:** Counting every notification inflates the sample because one position can emit the same advice repeatedly.

**How to apply:** Deduplicate by signal plus message type before calculating coverage, averages, and hold/exit accuracy. Keep the target at ≥55% after at least 20 observed independent outcomes; follow remains observational without a binary accuracy score.
