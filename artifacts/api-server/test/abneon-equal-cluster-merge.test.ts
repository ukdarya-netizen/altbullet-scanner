import assert from "node:assert/strict";
import test from "node:test";
import {
  computeSupportZones,
  type ClosedDetectorCandle,
} from "../src/lib/stealth-abneon-detectors.js";
import { JCT_4H_ROWS } from "./fixtures/jct-4h-2026-10-18-2000.js";

// Real JCT-USDT closed 4H candles up to 2026-10-18 20:00 UTC (BingX perp).
// Pivots 0.0017-0.0018 (7) tie with the 0.0016-0.0017 cluster (7) inside the
// 1.2 ATR suppression gap; they must merge into one zone, not be suppressed.
const H4 = 4 * 3600e3;
const candles: ClosedDetectorCandle[] = JCT_4H_ROWS.trim()
  .split(";")
  .map((row) => {
    const [time, open, high, low, close] = row.split(",").map(Number);
    return { time, open, high, low, close, volume: 0 } as ClosedDetectorCandle;
  });

test("equal-strength neighbouring clusters merge into one support zone", () => {
  assert.equal(candles.at(-1)!.time + H4, Date.parse("2026-10-18T20:00:00Z"));
  const zones = computeSupportZones(candles);
  const merged = zones.find((z) => z.bottom < 0.00161 && z.top > 0.00179);
  assert.ok(merged, "merged zone exists");
  assert.ok(Math.abs(merged.bottom - 0.001606) < 1e-9);
  assert.ok(Math.abs(merged.top - 0.0018) < 1e-9);
  assert.equal(merged.count, 14);
  assert.equal(
    zones.some((z) => z !== merged && z.top > 0.0016 && z.bottom < 0.0018),
    false,
  );
});
