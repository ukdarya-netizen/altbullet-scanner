---
name: Scheduler lease semantics
description: The limits and safe usage of the persisted market-cycle lease.
---

The `market-cycle` database lease is best-effort cross-worker serialization, not an exactly-once fence. Owner-token renewal and release prevent normal overlapping cycles and allow a crashed process to recover after the TTL; leased work now fails closed via an abortable context when ownership, heartbeat health, or the local TTL becomes unsafe.

**Why:** A heartbeat failure or event-loop stall can outlive the lease TTL. Cooperative cancellation plus shared DB-write/Telegram guards stop old work from starting new side effects after loss, while durable Telegram outbox draining must remain outside this lease because it has its own atomic claim.

**How to apply:** Keep all scheduler-side writes and broadcasts idempotent, pass the lease context through long-running jobs, and detach only independently durable queues. Do not claim strict never-overlap semantics: an in-flight DB/network operation cannot be cancelled retroactively. If strict exclusivity becomes required, add database-level fencing tokens.

## Cross-worker scanner integration testing

Cross-worker lease ownership and the market-request budget have different scopes: the lease is shared through PostgreSQL, while the transport budget is process-local.

**Why:** A test that saturates one worker and checks a FastCycle request in another proves lease exemption, but cannot prove critical queue priority under the saturated local budget.

**How to apply:** Use separate workers plus a disposable schema to prove persisted lease contention and optional-job deferral. In the scanner-owning worker, saturate scan transport, queue both scanner and critical work, then abort the cycle; assert that queued scanner work rejects while critical work proceeds. Always await worker exit before dropping the schema.