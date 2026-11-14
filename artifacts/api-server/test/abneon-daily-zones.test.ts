import assert from "node:assert/strict";
import test from "node:test";
import { computeSupportZones, evaluateAbneonSupportBounce } from "../src/lib/stealth-abneon-detectors.js";
import { neonLevelCrossing4h } from "../src/lib/stealth-neon-level-breakout.js";

const H1 = 3_600_000, H4 = 4 * H1, D1 = 24 * H1;
const T0 = Date.UTC(2025, 0, 1);
/** Daily candles oscillating 0.9 … 1.1 — pivots at both ends. */
const days = Array.from({ length: 640 }, (_, i) => {
  const m = 1 + 0.1 * Math.sin(i / 7);
  return { time: T0 + i * D1, open: m, high: m * 1.01, low: m * 0.99, close: m, volume: 1 };
});
const now = days.at(-1)!.time + D1;
/** Flat 4H candles at 1.0 (no pivots of their own) and flat 1H. */
const h4 = Array.from({ length: 300 }, (_, i) => ({ time: now - (300 - i) * H4, open: 1, high: 1.001, low: 0.999, close: 1, volume: 1 }));
const h1 = Array.from({ length: 40 }, (_, i) => ({ time: now - (40 - i) * H1, open: 1, high: 1.001, low: 0.999, close: 1, volume: 1 }));

test("owner 2026-11-14: ABNeon zones come from the daily candles when given (4H stays for the touch)", () => {
  const daily = computeSupportZones(days);
  assert.ok(daily.length >= 2);
  const without = evaluateAbneonSupportBounce({ candles4h: h4, candles1h: h1, observedAt: now, sweepReclaimBars: 3 });
  const withDays = evaluateAbneonSupportBounce({ candles4h: h4, candles1h: h1, observedAt: now, sweepReclaimBars: 3, zoneCandles1d: days });
  const raw = (r: typeof without) => (r.evidence as { rawSupportZoneCount?: number }).rawSupportZoneCount ?? null;
  // Flat 4H has no zones of its own; with the daily candles the detector sees the daily zones.
  assert.equal(without.reason, "no_retested_support");
  assert.notEqual(raw(withDays) ?? daily.length, 0);
});

test("owner 2026-11-14: Stealth crossing uses the daily zones it is given", () => {
  const zones = computeSupportZones(days);
  const top = zones.sort((a, b) => b.top - a.top)[0]!;
  const bars = Array.from({ length: 80 }, (_, i) => ({ time: now - (80 - i) * H4, open: top.top * 0.98, high: top.top * 0.99, low: top.top * 0.97, close: top.top * 0.98, volume: 1 }));
  const last = bars.at(-1)!;
  last.close = top.top * 1.02; last.high = top.top * 1.03;
  const cross = neonLevelCrossing4h(bars, last.time, zones);
  assert.ok(cross);
  assert.equal(cross!.level.top, top.top);
});
