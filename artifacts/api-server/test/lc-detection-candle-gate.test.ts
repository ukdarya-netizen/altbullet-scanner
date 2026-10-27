import test from "node:test";
import assert from "node:assert/strict";
import { evaluateLcDetectionCandleGate } from "../src/lib/lc-detection-candle-gate.js";

const M = 15 * 60 * 1000;
const T = 1_000_000 * M;
const c = (o: number, h: number, l: number, cl: number) => [
  { time: T, open: o, high: h, low: l, close: cl },
];
const now = T + 2 * M;

test("passes only a capitulation candle: range >= 5.6% and red body >= 3.5%", () => {
  // range 6%, body -4%
  assert.equal(
    evaluateLcDetectionCandleGate(c(100, 100.5, 94.5, 96), T + 60_000, now).pass,
    true,
  );
  // range 5.61%, body -3.5%
  assert.equal(
    evaluateLcDetectionCandleGate(c(100, 100, 94.39, 96.5), T + 60_000, now).pass,
    true,
  );
  // green candle with a big range: not a capitulation
  const green = evaluateLcDetectionCandleGate(c(100, 107, 100, 105), T + 60_000, now);
  assert.equal(!green.pass && green.reason, "detection_candle_not_capitulation");
  // red body -3% only
  const weak = evaluateLcDetectionCandleGate(c(100, 101, 94, 97), T + 60_000, now);
  assert.equal(!weak.pass && weak.reason, "detection_candle_not_capitulation");
  // range 5.5%
  const small = evaluateLcDetectionCandleGate(c(100, 100, 94.5, 95), T + 60_000, now);
  assert.equal(!small.pass && small.reason, "detection_candle_too_small");
});
test("entry only within 15 minutes after the detection candle close", () => {
  const late = evaluateLcDetectionCandleGate(c(100, 100.5, 94.5, 96), T + 60_000, T + 2 * M + 1);
  assert.equal(!late.pass && late.reason, "detection_candle_entry_window_passed");
  assert.equal(
    evaluateLcDetectionCandleGate(c(100, 100.5, 94.5, 96), T + 60_000, T + 2 * M).pass,
    true,
  );
});
test("small candle is rejected; missing or unclosed candle blocks", () => {
  const small = evaluateLcDetectionCandleGate(
    c(100, 102, 98, 99),
    T + 60_000,
    now,
  );
  assert.equal(small.pass, false);
  assert.equal(!small.pass && small.reason, "detection_candle_too_small");
  assert.equal(
    evaluateLcDetectionCandleGate(null, T, now).pass === false,
    true,
  );
  const open = evaluateLcDetectionCandleGate(
    c(100, 110, 90, 100),
    T,
    T + 60_000,
  );
  assert.equal(!open.pass && open.reason, "detection_candle_pending");
});
