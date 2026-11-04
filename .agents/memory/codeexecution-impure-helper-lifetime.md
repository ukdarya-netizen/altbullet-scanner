---
name: Impure helper lifetime
description: Reusing a network helper defined inside CodeExecution across notebook cells can fail at the sandbox boundary.
---

Define and invoke an impure network helper within the same CodeExecution cell; if a large replay needs repeated batches, prefer a shell script with explicit inputs and rate limits.

**Why:** A public-market `fetch` helper worked when defined and called together, then returned an internal `executeJs is not defined` error when invoked from later cells. Repeated calls through a durable wrapper did not fix it.

**How to apply:** Do not treat this error as an upstream API failure or retry it indefinitely. Keep the impure call in its defining cell, or export the non-secret read-only cohort to a temporary file and run the replay in Node.