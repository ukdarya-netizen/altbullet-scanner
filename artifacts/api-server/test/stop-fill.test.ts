import assert from "node:assert/strict";
import test from "node:test";
import { exactStopFill } from "../src/lib/stop-fill.js";
import { getPatternMaxStop } from "../src/lib/watcher-config.js";

test("LC stop closes at exactly -10% even when price overshoots", () => {
  assert.equal(getPatternMaxStop("liquidation_cascade"), 10);
  const fill = exactStopFill("liquidation_cascade", 100, 10, 88.7, -11.3);
  assert.equal(fill.pnl, -10);
  assert.ok(Math.abs(fill.exitPrice - 90) < 1e-9);
});

test("every pattern books its stop level exactly", () => {
  const fill = exactStopFill("impulse_buy", 200, 8, 170, -15);
  assert.equal(fill.pnl, -8);
  assert.ok(Math.abs(fill.exitPrice - 184) < 1e-9);
  assert.equal(exactStopFill("stealth_breakout", 50, 10, 44, -12).pnl, -10);
});
