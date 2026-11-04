---
name: Telemetry retry idempotency
description: Rules for safely retrying prescan analytics history and snapshot writes.
---

Retryable telemetry writes must be idempotent by the immutable event identity: symbol plus the timestamp captured for that scan cycle. Persist each immutable batch to the telemetry outbox before target writes, establish the unique indexes in a serialized, awaited startup migration, then use conflict-safe inserts.

**Why:** A client-side database timeout does not prove that PostgreSQL cancelled the insert. A late commit followed by a whole-batch retry can duplicate trajectory rows; snapshot chunks can also be only partially committed. Rolling workers must not race legacy-table cleanup, schema alignment, or index creation.

**How to apply:** For any new retrying scanner telemetry writer, capture its event identity synchronously, make the database materialization conflict-safe, and place any required schema evolution under the same advisory lock before the worker starts. Use a durable claimed/leased outbox whenever the batch must survive a restart; retain it until the conflict-safe target insert is acknowledged.