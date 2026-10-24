import assert from "node:assert/strict";
import test from "node:test";
import { requestedStopDecision } from "../src/lib/requested-stop-policy.js";

test("only prices strictly below -5% qualify", () => {
  assert.equal(requestedStopDecision(100, 95), null);
  assert.equal(requestedStopDecision(100, 97), null);
  assert.deepEqual(requestedStopDecision(100, 94.99), {
    exitPrice: 94.99,
    pnlPercent: -5.010000000000005,
  });
});

test("missing or invalid quote closes without inventing settlement PnL", () => {
  assert.deepEqual(requestedStopDecision(100, undefined), {
    exitPrice: null,
    pnlPercent: null,
  });
  assert.deepEqual(requestedStopDecision(100, NaN), {
    exitPrice: null,
    pnlPercent: null,
  });
  assert.throws(() => requestedStopDecision(0, 90), /invalid entry price/);
});
