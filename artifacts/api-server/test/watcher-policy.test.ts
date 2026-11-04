import assert from "node:assert/strict";
import test from "node:test";
import {
  getPatternMaxStop,
  getPatternMinStop,
} from "../src/lib/watcher-config.js";

test("calibrated pattern stop baselines are explicit", () => {
  assert.equal(getPatternMaxStop("impulse_buy"), 8);
  assert.equal(getPatternMaxStop("price_led_momentum"), 10);
  assert.equal(getPatternMaxStop("balanced_grind"), 10);
  assert.equal(getPatternMaxStop("liquidation_cascade"), 10);
  assert.equal(getPatternMaxStop("unknown_pattern"), 10);
  assert.equal(getPatternMinStop("impulse_buy"), 0);
});
