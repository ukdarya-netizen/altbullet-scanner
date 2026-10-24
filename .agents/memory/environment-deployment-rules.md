---
name: Environment and deployment rules
description: Index of non-obvious build, development/production and publishing constraints
---

Read the relevant topic before changing schema, generated code, publishing or production-data workflows:

- [Composite declarations](composite-lib-declarations-rebuild.md) — rebuild library declarations after codegen or export changes.
- [Dev vs prod data](dev-prod-split-brain.md) — verify data provenance rather than assuming cohorts match.
- [New table DDL](new-table-dev-prod-ddl.md) — production startup DDL does not initialize the development database.
- [Production data fixes](prod-data-fix-as-code.md) — corrections must ship as idempotent startup code.
- [Dist rebuild](dist-rebuild-before-deploy.md) — published bundles may stay stale after source-only changes.
- [Development schema parity](development-schema-parity.md) — align dev schema safely before runtime tests.
- [Deployment target verification](deployment-target-verification.md) — config alone does not prove the live target.
- [Runtime sequences](publish-runtime-sequence-ownership.md) — sequences must exist in declared and dev schema.
- [Partial unique indexes](publish-partial-unique-indexes.md) — validate old production duplicates first.
- [Runtime DDL drift](publish-runtime-ddl-drift.md) — dev-only checks and prod-only tables affect publish.
- [Production SQL validation](production-sql-result-validation.md) — transaction success without a result is not evidence.
- [Drizzle arrays](drizzle-sql-array-interpolation.md) — interpolated JS arrays are tuples, not PostgreSQL arrays.
- [Impure helper lifetime](codeexecution-impure-helper-lifetime.md) — define and invoke network helpers in one execution cell.

**Why:** Build and data environments differ in ways that have caused false confidence about code and production state.

**How to apply:** Consult the specific topic before asserting runtime parity, changing production schema or relying on generated artifacts.