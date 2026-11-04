---
name: CoinGlass global request governance
description: Cross-module quota, priority, cooldown, cancellation, and deduplication rules that protect live trading decisions.
---

**Rule:** Every CoinGlass transport path must use one global paced governor. Whale decision/fire and active-position requests receive high or critical priority; background enrichment remains lower priority without being starved forever. Deduplicated responses are buffered once and reconstructed per subscriber; never share or repeatedly clone a mutable response body stream.

**Why:** Independent per-module semaphores can collectively burst through an account-wide quota. Reliable recovery also requires HTTP and body-level 429 responses to extend one shared cooldown rather than letting other modules continue the storm. Shared response streams can become consumed or locked, producing rejected or hanging subscribers under startup concurrency.

**How to apply:** Re-check cooldown immediately before each serialized start; keep waiting abort-aware and outside active slots; deduplicate only identical method, URL, body, headers, and API-key identity; isolate subscriber aborts; preserve timeout reasons; use deterministic enqueue ordering and bounded aging. Reconstruct 204/205/304 with a null body.