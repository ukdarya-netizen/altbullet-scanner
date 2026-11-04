---
name: Telegram outbox integration testing
description: Durable constraints for exercising concurrent outbox workers against PostgreSQL without touching application data.
---

# Rule

Run outbox integration tests only with an explicit opt-in and a caller-provided disposable PostgreSQL connection. Create a unique schema per run, connect workers with that schema in `search_path`, synchronize distinct worker processes after candidate selection but before the conditional claim update, and always drop the schema in `finally`.

**Why:** A wall-clock start delay does not prove concurrent workers reached the claim boundary together, while an arbitrary database URL can make test cleanup destructive. PostgreSQL-backed tests must demonstrate the real claim race without contacting Telegram or mutating shared application tables.

**How to apply:** Use separate child processes for worker state, a per-process database claim barrier, deterministic sender injection, and cleanup that closes pools and removes temporary logs even when assertions fail.