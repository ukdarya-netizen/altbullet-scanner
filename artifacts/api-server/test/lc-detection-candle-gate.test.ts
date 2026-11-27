import test from "node:test";
import assert from "node:assert/strict";
import { evaluateLcDetectionCandleGate } from "../src/lib/lc-detection-candle-gate.js";

// Owner 2026-11-27: largest candle from 3 before to 1 after the detection ≥ 5.6% (any body), next candle
// body ≥ −1%, entry within 30 minutes after the rebound candle / window close.
const M = 15 * 60 * 1000;
const T = 1_000_000 * M;
const k = (i: number, o: number, h: number, l: number, cl: number) => ({
  time: T + i * M,
  open: o,
  high: h,
  low: l,
  close: cl,
});
const flat = (i: number) => k(i, 100, 100.5, 99.5, 100);
const det = T + 60_000;
const ready = T + 3 * M; // window −3..+1 closed and the rebound of +1 too

test("big candle before the detection + non-falling next candle passes", () => {
  const candles = [flat(-3), k(-2, 100, 100, 88, 89), k(-1, 89, 92, 88.5, 91), flat(0), flat(1), flat(2)];
  const d = evaluateLcDetectionCandleGate(candles, det, ready);
  assert.equal(d.pass, true);
  assert.equal(d.cascadeCandleTime, T - 2 * M);
});
test("a big candle with a buy-back (no red body) passes", () => {
  const candles = [flat(-3), flat(-2), flat(-1), k(0, 100, 101, 93, 100), k(1, 100, 101, 99.5, 100.4), flat(2)];
  assert.equal(evaluateLcDetectionCandleGate(candles, det, ready).pass, true);
});
test("next candle keeps falling: rejected as no rebound", () => {
  const candles = [flat(-3), flat(-2), flat(-1), k(0, 100, 100, 92, 93), k(1, 93, 93.2, 91, 91.5), flat(2)];
  const d = evaluateLcDetectionCandleGate(candles, det, ready);
  assert.equal(!d.pass && d.reason, "detection_candle_no_rebound");
});
test("no candle ≥ 5.6% in the window: too small", () => {
  const candles = [flat(-3), flat(-2), flat(-1), k(0, 100, 101, 96, 97), flat(1), flat(2)];
  const d = evaluateLcDetectionCandleGate(candles, det, ready);
  assert.equal(!d.pass && d.reason, "detection_candle_too_small");
});
test("waits while the window is open; missing data blocks; late entry is terminal", () => {
  assert.equal(
    (evaluateLcDetectionCandleGate(null, det, T + M + 60_000) as { reason?: string }).reason,
    "detection_candle_pending",
  );
  assert.equal(evaluateLcDetectionCandleGate(null, det, ready).pass, false);
  const candles = [flat(-3), flat(-2), flat(-1), k(0, 100, 101, 93, 100), k(1, 100, 101, 99.5, 100.4), flat(2)];
  const late = evaluateLcDetectionCandleGate(candles, det, T + 2 * M + 30 * 60_000 + 1);
  assert.equal(!late.pass && late.reason, "detection_candle_entry_window_passed");
});
