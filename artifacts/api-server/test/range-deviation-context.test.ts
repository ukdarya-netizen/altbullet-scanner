import assert from "node:assert/strict";
import test from "node:test";
import {
  findCandleReaction,
  findDeviations,
} from "../src/lib/range-deviation-context.js";

const M = 15 * 60 * 1000;
const now = 1000 * M;
const bar = (i: number, low: number, close: number) => ({
  time: now - (20 - i) * M,
  open: close,
  high: close,
  low,
  close,
});

test("wick below lower with close back inside is a deviation", () => {
  const r = findDeviations(
    [bar(0, 10, 10), bar(1, 9, 10), bar(2, 10, 11)],
    10,
    now,
  );
  assert.equal(r.events.length, 1);
  assert.equal(r.events[0]!.depthPct, 10);
  assert.equal(r.belowUnreclaimed, false);
});

test("close below with no reclaim stays unreclaimed, no event", () => {
  const r = findDeviations([bar(0, 10, 10), bar(1, 9, 9.5)], 10, now);
  assert.equal(r.events.length, 0);
  assert.equal(r.belowUnreclaimed, true);
});

test("no probe means no deviation", () => {
  const r = findDeviations([bar(0, 10, 10), bar(1, 10.5, 11)], 10, now);
  assert.equal(r.events.length, 0);
  assert.equal(r.belowUnreclaimed, false);
});

test("candle reaction picks the largest lower wick with volume ratio", async () => {
  const { findCandleReaction } =
    await import("../src/lib/range-deviation-context.js");
  const candles = Array.from({ length: 22 }, (_, i) => ({
    time: now - (23 - i) * M,
    open: 10,
    high: 10.1,
    low: 9.9,
    close: 10,
    volume: 100,
  }));
  candles[21] = { ...candles[21]!, low: 9, close: 9.9, open: 10, volume: 400 };
  const r = findCandleReaction(candles, now);
  assert.ok(r);
  assert.equal(r.time, candles[21]!.time);
  assert.equal(r.volumeRatio, 4);
  assert.ok(Math.abs(r.lowerWickPct - 10) < 1e-9);
  assert.ok(Math.abs(r.recoveryPct - 10) < 1e-9);
});

test("candle reaction is null without candles", () => {
  assert.equal(findCandleReaction(null, now), null);
});
