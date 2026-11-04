---
name: Dev vs Prod data sources
description: Development and production cohorts differ; verify the production read-only SQL reader against live app evidence.
---

Development and production datasets are separate. The development cohort may be older than the live production cohort; never use development outcome counts as current production truth.

As of 2026-09-25, `executeSql({ environment: "production" })` returned read-only signal records that matched unique IDs and tickers in the live deployment logs, including a currently active tracked position. The previous claim that this reader *always* targets development was stale. Do not assume either reader's provenance forever: corroborate a current result with live application evidence before a consequential audit.

**Why:** A historical setup used a separate external production database, so early analysis treated the built-in SQL reader as unrelated. Later live-record comparison showed that assumption no longer described the current deployment. A development query in the same audit ended weeks before the production query.

**How to apply:** Use the `production` read-only SQL target for outcome audits only after checking its result header and cross-checking a current record against deployment evidence. Never use development writes or counts to infer production changes. For schema changes, inspect the *current* production database setup and follow the database skill; the project also has startup schema gates for runtime-required fields. Obtain the current production URL from deployment metadata, not saved URLs or development domains.
