---
name: Open positions API truth
description: Truthfulness boundary for the Dashboard open-position count during API or partial-schema failures.
---

The open-position view must query only nonterminal position statuses, rather than filtering a limited mixed-status response in the browser. A non-2xx API response must become an explicit loading error, never an empty list.

**Why:** A partial production schema made the tracker endpoint return HTTP 500 while the client treated the error body as a successful empty response. Independently, a newest-first limit across all statuses could let recent closed rows displace real open positions.

**How to apply:** Keep the open-position endpoint compatible with partial deployments, filter nonterminal statuses in SQL before applying a limit, and make every client fetch reject non-2xx responses.