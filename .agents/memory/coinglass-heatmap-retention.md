---
name: CoinGlass heatmap retention
description: Why forward liquidation-map snapshots must preserve historical backfill beyond a rolling month.
---

**Rule:** Preserve existing CoinGlass heatmap snapshots, including the original JSONB backfill, but do not run periodic or manual CoinGlass heatmap collection/capture unless the owner explicitly re-approves it. No age-based cleanup is authorized.

**Why:** The original backfill includes snapshots older than 30 days and remains useful for read-only historical analysis. The owner has said new liquidation-heatmap snapshots are not needed; historical retention does not imply permission to keep collecting.

**How to apply:** Keep the historical table and read-only endpoints/panels. Do not schedule CoinGlass heatmap fetches, run heatmap backfills, write new snapshot rows, or capture LC `liqHeatmapShadow` metrics. Treat any future deletion/retention reduction as a separate data-loss decision requiring explicit approval.