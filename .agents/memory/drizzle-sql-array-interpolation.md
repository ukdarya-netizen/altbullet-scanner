---
name: Drizzle SQL array interpolation
description: Why raw Drizzle sql templates must not cast an interpolated JavaScript array to a PostgreSQL array.
---

Do not write `ANY(${ids}::integer[])` in a Drizzle raw `sql` template when `ids` is a JavaScript array. Drizzle expands it into a parenthesized parameter list, which PostgreSQL treats as a record and cannot cast to `integer[]`. For nonempty integer ID lists, use bound values with `IN (${sql.join(ids.map(id => sql`${id}`), sql`, `)})`, or bind a genuine PostgreSQL array by a separately verified method.

**Why:** A read-only enrichment of open positions failed with `cannot cast type record to integer[]`; the whole positions API returned 500, hiding real positions despite a healthy database.

**How to apply:** Check raw Drizzle queries that interpolate arrays into `ANY` or cast syntax, especially on critical list endpoints. Guard empty lists before building an `IN` clause and validate the generated query against PostgreSQL with multiple IDs.