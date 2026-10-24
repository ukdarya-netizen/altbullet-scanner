import assert from "node:assert/strict";
import test from "node:test";
import { buildLiqHeatmapShadow } from "../src/lib/liq-heatmap-shadow.js";

test("summarizes price-side heatmap bins without inventing liquidation side", () => {
  const snapshot = buildLiqHeatmapShadow(
    [80, 94, 98, 103, 108, 115, 125],
    [9, 6, 12, 15, 7, 3, 40],
    100,
    "2026-09-29T12:00:00.000Z",
  );
  assert.equal(snapshot.available, true);
  assert.deepEqual(snapshot.bands, {
    below0to5: 12,
    below5to10: 6,
    below10to20: 9,
    above0to5: 15,
    above5to10: 7,
    above10to20: 3,
  });
  assert.equal(snapshot.belowBinCount, 3);
  assert.equal(snapshot.aboveBinCount, 3);
  assert.deepEqual(snapshot.topBelow, [
    { price: 98, distancePct: -2, value: 12 },
    { price: 80, distancePct: -20, value: 9 },
    { price: 94, distancePct: -6, value: 6 },
  ]);
  assert.deepEqual(snapshot.topAbove, [
    { price: 103, distancePct: 3, value: 15 },
    { price: 108, distancePct: 8, value: 7 },
    { price: 115, distancePct: 15, value: 3 },
  ]);
  assert.equal(snapshot.fetchedAt, "2026-09-29T12:00:00.000Z");
  assert.equal("longLiquidations" in snapshot, false);
});

test("does not attribute a mismatched token map to the signal", () => {
  const snapshot = buildLiqHeatmapShadow(
    [3, 4],
    [100, 300],
    100,
    "2026-09-29T12:00:00.000Z",
  );
  assert.equal(snapshot.available, false);
  assert.equal(snapshot.reason, "price_range_mismatch");
});

test("preserves fallback provenance when the aggregate map is unavailable", () => {
  const snapshot = buildLiqHeatmapShadow(
    [95, 101, 105],
    [1, 2, 3],
    100,
    "2026-09-29T12:00:00.000Z",
    "coinglass_binance_heatmap_model2_3d",
  );
  assert.equal(snapshot.available, true);
  assert.equal(snapshot.source, "coinglass_binance_heatmap_model2_3d");
});
