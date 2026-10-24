import assert from "node:assert/strict";
import { test } from "node:test";
import { buildBreakoutReplayIndicators } from "../src/lib/breakout-replay-indicators.js";
import type { BreakoutCandle } from "../src/lib/breakout-analysis.js";

const HOUR = 60 * 60_000;
const start = Date.UTC(2025, 0, 1);
function candles(count: number, step: number): BreakoutCandle[] {
  return Array.from({ length: count }, (_, index) => ({
    time: start + index * step,
    open: 100,
    high: 101,
    low: 99,
    close: 100,
    volume: 1000,
  }));
}

test("event-time indicator snapshots do not see later candles", () => {
  const four = candles(901, 4 * HOUR);
  const one = candles(3604, HOUR);
  const eventAt = start + 900 * 4 * HOUR;
  const first = buildBreakoutReplayIndicators({
    eventAt,
    candles4h: four,
    candles1h: one,
  });
  assert.equal(first.abNeon.status, "ready");
  assert.equal(first.rangeDetector.status, "ready");
  assert.equal(first.rangeDetector.historyCandles, 900);
  assert.equal(first.candles4h.at(-1)!.time + 4 * HOUR, eventAt);
  const changedFuture4h = four.map((candle) =>
    candle.time + 4 * HOUR > eventAt
      ? { ...candle, high: 1000, close: 999 }
      : candle,
  );
  const changedFuture1h = one.map((candle) =>
    candle.time + HOUR > eventAt
      ? { ...candle, high: 1000, close: 999 }
      : candle,
  );
  assert.deepEqual(
    buildBreakoutReplayIndicators({
      eventAt,
      candles4h: changedFuture4h,
      candles1h: changedFuture1h,
    }),
    first,
  );
});

test("short, gapped, stale and failed histories stay unknown", () => {
  const four = candles(900, 4 * HOUR);
  const one = candles(3600, HOUR);
  const eventAt = start + 900 * 4 * HOUR;
  assert.equal(
    buildBreakoutReplayIndicators({
      eventAt,
      candles4h: four.slice(1),
      candles1h: one,
    }).rangeDetector.status,
    "unknown",
  );
  const gapped = [...four.slice(0, 500), ...four.slice(501)];
  const missing = buildBreakoutReplayIndicators({
    eventAt,
    candles4h: gapped,
    candles1h: one,
  });
  assert.equal(missing.abNeon.status, "unknown");
  assert.equal(missing.rangeDetector.status, "unknown");
  const missing1h = buildBreakoutReplayIndicators({
    eventAt,
    candles4h: four,
    candles1h: [],
    error1h: true,
  });
  assert.equal(missing1h.abNeon.status, "unknown");
  assert.equal(missing1h.rangeDetector.status, "ready");
  assert.equal(
    buildBreakoutReplayIndicators({
      eventAt: eventAt + 8 * HOUR,
      candles4h: four,
      candles1h: one,
    }).rangeDetector.status,
    "unknown",
  );
});
