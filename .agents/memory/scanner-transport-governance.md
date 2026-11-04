---
name: Scanner transport governance
description: Shared request limits and cancellation must be enforced at every market-data transport boundary.
---

All scanner- and watcher-reachable market-data clients must enter the shared
transport gate and compose their endpoint timeout with the owning market-cycle
abort signal. Wrapping only the most obvious OI endpoint leaves prefetch,
market-cap, or other enrichment calls able to survive a stopped/timed-out scan
and recreate the same pool/API pressure.

**Why:** a local `Promise.race` only stops awaiting work; it does not cancel
the HTTP request or prevent the next request from starting.

**How to apply:** for CoinGlass use the common timed fetch wrapper; for other
market providers use the shared market request helper. Optional background jobs
must defer on the persisted market-cycle lease, while FastCycle remains
priority work for open positions.

Cancellation scopes must follow stage lifetimes. A later bounded market-data
stage keeps the parent lease signal but must not inherit an expired deadline
from an earlier stage. Queued or cancelled work is not a successful fetch and
must not start a long success/short-history retry cooldown.

**Why:** Range history warming ran after a three-minute prefetch deadline under
the already-aborted prefetch signal. Every request could be cancelled while
enqueue-time bookkeeping suppressed another attempt for six hours.

**How to apply:** compose each sequential stage's own deadline with the same
lease, await cancellation fully, retain unstarted/cancelled queue items, and
base long cooldowns only on a classified successful response.