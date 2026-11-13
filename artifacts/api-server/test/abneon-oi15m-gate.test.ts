import test from "node:test";
import assert from "node:assert/strict";
import { evaluateAbneonOi15mGate } from "../src/lib/abneon-oi15m-gate";

test("ABNeon OI 15m gate (owner 2026-11-13): above +0.18% passes; at or below, or unknown, no signal", () => {
  assert.deepEqual(evaluateAbneonOi15mGate(0.4), { pass: true, oi15mPct: 0.4, reason: "ok" });
  assert.equal(evaluateAbneonOi15mGate(0.18).reason, "oi15m_no_new_money");
  assert.equal(evaluateAbneonOi15mGate(-1.2).pass, false);
  assert.equal(evaluateAbneonOi15mGate(null).reason, "oi15m_unknown");
});
