---
name: Auto Range history persistence and per-cycle CoinGlass metrics
description: 1H/4H Auto Range candle cache is now persisted in DB and restored at startup; CoinGlass governor stats are stored per cycle.
---
Auto Range history cache was memory-only: every restart/publish left ~200 symbols with range_1h_insufficient_history_queued_never_fetched for hours (warmup 48 symbols/cycle).
Now saved to table auto_range_history_cache after each full fetch, re-saved slowly, restored at startup (rows older than 7 days skipped, since prefetch merges only ~300 recent bars).
**Why:** owner asked that publishing must not cause hours of insufficient history.
**How to apply:** persistence/metrics schema setup is non-fatal (logs error, falls back to memory). Per-cycle CoinGlass load (byEndpoint, peak/min, 429, OI breaker trips, OI/prefetch phase coverage) is in table coinglass_cycle_metrics; query it instead of grepping the truncated deployment log.
