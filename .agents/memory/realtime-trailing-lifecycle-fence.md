---
name: Realtime trailing lifecycle fence
description: Lifecycle contract for low-latency trailing-price callbacks across watcher stop and restart.
---

Realtime trailing callbacks must capture a monotonic monitor generation and validate it after every asynchronous pre-claim step. A stopped/replaced monitor rejects its old callbacks before they can initiate a terminal close.

**Why:** A simple shared running flag becomes true again after a stop/start, allowing an old WebSocket frame that was awaiting a database or health read to act on the replacement monitor. Once a callback has passed the generation validation inside the transaction and started the conditional terminal-state claim, the status-plus-Telegram-outbox transaction deliberately completes; cancelling it mid-transaction would risk breaking atomic delivery semantics.

**How to apply:** Thread the captured generation through realtime refresh, candidate handling, durable row reads, health lookup, and the transaction's pre-claim boundary. Keep FastCycle independent. On watcher stop, invalidate the generation, stop the stream, and clear in-memory candidate/in-flight state; start must create a new generation and transport.

A tick that validly crosses an already-armed trailing boundary remains a close event when a concurrent worker has since persisted a higher boundary. Use the higher durable boundary for the protected exit, but never re-arm and wait for another tick. All peak, stop, and milestone writes must require a live status so delayed workers cannot mutate a terminal position.

**Why:** Re-arming on a fresher higher stop loses short-lived dips, while unguarded delayed writes can make a completed trade inconsistent with its final peak.

**How to apply:** Evaluate tick time against the boundary that was armed when the callback began, re-read durable state, then atomically close at the maximum durable boundary. Startup recovery must use the same terminal claim path.

Cross-process trailing correctness requires a durable arming timestamp for every raised stop. An in-memory `armedAt` cannot decide whether another worker's higher boundary existed before or after the current exchange tick.

**Why:** Without durable ordering, a stale worker either misses a valid one-tick crossing or falsely applies a boundary that another worker armed after that tick.

**How to apply:** Persist the stop and its market-observation arming time atomically whenever the boundary rises. Compare exchange tick time to the durable arming time; retry transient DB failures without accepting the tick watermark first.