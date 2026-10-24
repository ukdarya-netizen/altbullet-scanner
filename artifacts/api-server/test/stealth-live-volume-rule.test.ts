import test from "node:test";
import assert from "node:assert/strict";
import {
  applyStealthLiveVolumeRule,
  STEALTH_LIVE_MIN_VOLUME_RATIO,
  type StealthVolumeDecision,
} from "../src/lib/stealth-volume-gate.js";

const candle = {
  version: "stealth_volume_gate:v8",
  pass: true,
  reason: "ok",
  futuresThreshold: 0,
  spotThreshold: 0,
  futuresRatio: null,
  spotRatio: null,
  bodyPct: 0.5,
  triggerTime: 1,
  barMs: 3_600_000,
  source: "bingx_price_candle_gate",
} as StealthVolumeDecision;
const vol = (f: number | null, s: number | null) =>
  ({ ...candle, futuresRatio: f, spotRatio: s }) as StealthVolumeDecision;
const T = STEALTH_LIVE_MIN_VOLUME_RATIO;

test("either measured aggregated leg at the threshold passes", () => {
  assert.equal(applyStealthLiveVolumeRule(candle, vol(T, 0.5)).pass, true);
  assert.equal(applyStealthLiveVolumeRule(candle, vol(0.5, T)).pass, true);
});
test("both measured legs below the threshold block", () => {
  const r = applyStealthLiveVolumeRule(candle, vol(T - 0.1, 0.5));
  assert.equal(r.pass, false);
  assert.equal(r.reason, "both_volumes_below_threshold");
});
test("unavailable spot is rejected even when futures is strong", () => {
  const r = applyStealthLiveVolumeRule(candle, vol(24.9, null));
  assert.equal(r.pass, false);
  assert.equal(r.reason, "stealth_spot_volume_unavailable");
});
test("unavailable futures is rejected", () => {
  const r = applyStealthLiveVolumeRule(candle, vol(null, 9));
  assert.equal(r.pass, false);
  assert.equal(r.reason, "futures_volume_unavailable");
});
