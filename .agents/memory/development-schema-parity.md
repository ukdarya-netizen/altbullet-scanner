---
name: Development schema parity
description: Development database schema may lag production-only subscription fields and cause false runtime failures.
---

Development can be missing tables, columns, or production-tuned indexes that startup migrations created only in production.

**Why:** A subscription-status smoke test can fail on a missing development column even when the same query is valid in production. More dangerously, Publish compares database instances, not just source schema: dev drift can make it propose dropping live production objects that source code still declares.

**How to apply:** Before testing or publishing code that reads a recently introduced field, inspect the development schema and add missing objects with an idempotent development-side migration. Match durable index definitions/names too, then re-run the Publish schema-diff check; never “fix” this by mutating production directly.