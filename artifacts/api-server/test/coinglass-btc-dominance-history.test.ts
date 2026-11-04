import assert from "node:assert/strict";
import test from "node:test";
import {
  recentDominanceHistory,
  type BitcoinDominancePoint,
} from "../src/lib/coinglass_btc_dominance.js";

test("sub-daily BTC dominance observations retain thirty calendar days", () => {
  const now = new Date("2026-09-30T20:00:00.000Z");
  const start = Date.parse("2026-09-01T00:00:00.000Z");
  const points: BitcoinDominancePoint[] = Array.from(
    { length: 60 },
    (_, index) => ({
      timestamp: new Date(start + index * 12 * 60 * 60 * 1000).toISOString(),
      dominance: 52 + index / 100,
      btcPrice: null,
      btcMarketCap: null,
    }),
  );
  const retained = recentDominanceHistory(points, now);
  assert.equal(retained.length, 60);
  assert.equal(retained[0]?.timestamp, "2026-09-01T00:00:00.000Z");
  assert.equal(retained.at(-1)?.timestamp, "2026-09-30T12:00:00.000Z");
  assert.equal(
    recentDominanceHistory(
      [{ ...points[0]!, timestamp: "2026-08-31T20:00:00.000Z" }, ...points],
      now,
    ).length,
    61,
  );
  assert.equal(
    recentDominanceHistory(
      [
        { ...points[0]!, timestamp: "2026-08-30T23:59:00.000Z" },
        ...points,
        { ...points[0]!, timestamp: "2026-10-01T00:00:00.000Z" },
      ],
      now,
    ).length,
    60,
  );
});
