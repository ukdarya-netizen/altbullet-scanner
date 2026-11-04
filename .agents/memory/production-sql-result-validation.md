---
name: Production read-only SQL result validation
description: How to recognize a non-result from the production SQL reader during larger audits.
---

Treat a production SELECT returning only `START TRANSACTION` and `ROLLBACK` as a failed query, even if the database callback reports success. Do not interpret it as an empty cohort.

**Why:** Large retrospective audit queries have returned this envelope with no rows or column header, while bounded versions of the same analysis returned valid data. Relying on the success flag alone can turn an execution problem into a false finding.

**How to apply:** Check for a real column header and result; if absent, bound the query by month or reduce joins and retry the narrower read-only analysis. Report the coverage limit if it remains unavailable.