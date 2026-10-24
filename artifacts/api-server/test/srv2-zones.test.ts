import assert from "node:assert/strict";
import test from "node:test";
import { computeSrv2Zones } from "../src/lib/srv2-zones.js";

// Zig-zag: lows repeatedly bottom near 100, highs near 120.
function zigzag() {
  const out: { high: number; low: number; close: number }[] = [];
  for (let k = 0; k < 8; k++) {
    for (let i = 0; i < 12; i++) {
      const p = k % 2 === 0 ? 120 - i * (20 / 11) : 100 + i * (20 / 11);
      out.push({ high: p + 1, low: p - 1, close: p });
    }
  }
  return out;
}

test("SRv2 clusters repeated pivots into zones with strength >= 2", () => {
  const zones = computeSrv2Zones(zigzag());
  assert.ok(zones.length >= 1);
  for (const z of zones) {
    assert.ok(z.strength >= 2);
    assert.ok(z.lo <= z.mid && z.mid <= z.hi);
  }
});

test("SRv2 returns no zones for too few candles", () => {
  assert.deepEqual(computeSrv2Zones(zigzag().slice(0, 15)), []);
});
