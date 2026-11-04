---
name: LC liquidity shelf evidence
description: Interpretation boundary for bid depth versus liquidation maps in LC rebound studies.
---

Treat an executable bid wall below price and an aggregated CoinGlass liquidation cluster below price as different observations. Neither substitutes for the other; a liquidation cluster can attract a downward move rather than stop it. A current map joined to an entry-time bid measurement does not prove that both existed at entry.

**Why:** The user wants to test whether their presence or combination accompanies a fast, strong LC rebound without changing trades prematurely. Model-map intensity is not exchange order-book USD depth, and historical entry maps cannot be reconstructed from a later provider response.

**How to apply:** Preserve source, venue, observation time, and explicit unavailable groups. Compare time-aligned forward snapshots and subsequent trajectories before interpreting combinations; label retrospective bid-distance/realized-PnL cohorts as associative only. Keep LC entries, exits, and orders unchanged pending evidence.

CoinGlass Model2 `range` is a time aggregation window, not a Y-price span.
The official schema supports windows through `1y` and maps cells by X/Y indices
alongside timestamped price candles. Absence of a documented arbitrary end-date
parameter does not establish absence of historical time slices.

**Why:** Earlier project documentation incorrectly described `range` as a price
span and ruled out historical analysis. The official provider documentation
explicitly calls it a time range and documents the temporal cell axis.

**How to apply:** Verify returned coverage before declaring retrospective UAI/ARB
or other LC cases unavailable. Match cell X indices to candle timestamps and
respect closed-bar cutoffs. Label a map retrieved after the entry as provider
reconstruction, with retrieval time retained; it is not an immutable map known
at entry. Keep reconstructed and originally captured cohorts separate.

The owner has retired new CoinGlass liquidation-heatmap snapshots/captures.
Keep historical `cg_liq_heatmap_snapshot` rows and their read-only analysis, but
do not resume periodic/manual map fetches, snapshot backfills, or LC
`liqHeatmapShadow` capture without explicit re-approval. This does not authorize
changing unrelated CoinGlass traffic or live signal/stop behavior.

**Why:** On 2026-10-01 the owner checked CoinGlass documentation and confirmed
that new heatmap snapshots are not needed. Historical maps remain useful for
associative research, but future collection is not approved.

**How to apply:** Keep missing maps unknown, not empty liquidity. Do not infer a
production-wide invalid key from a map-specific access failure or confuse a
development credential test with production authentication. This research
boundary does not authorize deleting retained history or changing unrelated
CoinGlass traffic or trading rules.