import test from "node:test";
import assert from "node:assert/strict";
import { evaluateLcDetectionCandleGate } from "../src/lib/lc-detection-candle-gate.js";

const M = 15 * 60 * 1000;
const T = 1_000_000 * M;
const c = (o: number, h: number, l: number, cl: number) => [
  { time: T, open: o, high: h, low: l, close: cl },
];
const now = T + 2 * M;

test("passes only on range >= 6%", () => {
  assert.equal(
    evaluateLcDetectionCandleGate(c(100, 107, 100, 105), T + 60_000, now).pass,
    true,
  );
  assert.equal(
    evaluateLcDetectionCandleGate(c(100, 101, 96, 99), T + 60_000, now).pass,
    false,
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
