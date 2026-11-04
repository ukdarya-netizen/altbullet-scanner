import assert from "node:assert/strict";
import test from "node:test";
import { evaluateLcWickGate } from "../src/lib/lc-wick-gate.js";

const M = 15 * 60 * 1000;
const now = 5000 * M;
const flat = (i: number, low = 9.95) => ({
  time: now - (30 - i) * M,
  open: 10,
  high: 10.05,
  low,
  close: 10,
  volume: 100,
});

test("blocks when no 24h candle has a lower wick >= 1%", () => {
  const d = evaluateLcWickGate(
    Array.from({ length: 30 }, (_, i) => flat(i)),
    now,
  );
  assert.equal(d.pass, false);
  assert.equal(d.reason, "no_lower_wick_reaction");
});

test("passes when one closed candle has a >= 2% lower wick", () => {
  const candles = Array.from({ length: 30 }, (_, i) => flat(i));
  candles[5] = flat(5, 9.6);
  const d = evaluateLcWickGate(candles, now);
  assert.equal(d.pass, true);
  assert.equal(d.reason, "ok");
});

test("ignores a still-open candle and blocks without data", () => {
  const open = { ...flat(0, 9), time: now - M / 2 };
  assert.equal(evaluateLcWickGate([open], now).reason, "wick_data_unavailable");
  assert.equal(evaluateLcWickGate(null, now).pass, false);
});

test("detection-candle mode ignores wicks on other candles", () => {
  const candles = Array.from({ length: 30 }, (_, i) => flat(i));
  candles[25] = flat(25, 9.8);
  const detectedAt = candles[10]!.time + 1000;
  const d = evaluateLcWickGate(candles, now, 1, detectedAt);
  assert.equal(d.pass, false);
  const ok = evaluateLcWickGate(candles, now, 1, candles[25]!.time + 1000);
  assert.equal(ok.pass, true);
  // The candle BEFORE the detection candle must not count.
  const prior = evaluateLcWickGate(candles, now, 1, candles[26]!.time + 1000);
  assert.equal(prior.pass, false);
  assert.equal(
    evaluateLcWickGate(candles, now, 1, 0).reason,
    "wick_data_unavailable",
  );
});

test("default threshold is 2%: a 1% wick is blocked", () => {
  const candles = Array.from({ length: 30 }, (_, i) => flat(i));
  candles[5] = flat(5, 9.9);
  assert.equal(
    evaluateLcWickGate(candles, now).reason,
    "no_lower_wick_reaction",
  );
});
