import assert from "node:assert/strict";
import { test } from "node:test";
import { createScannerCycleAbort } from "../src/lib/scannerCycleAbort.js";

test("scanner hard timeout actively aborts the cycle signal", async () => {
  const cycle = createScannerCycleAbort();
  const error = await new Promise<Error>((resolve) => {
    cycle.armHardTimeout(5, resolve);
  });

  assert.match(error.message, /SCAN_HARD_TIMEOUT/);
  assert.equal(cycle.signal.aborted, true);
  assert.equal(cycle.signal.reason, error);
  cycle.dispose();
});

test("stopping a scanner cycle cancels its deadline", async () => {
  const cycle = createScannerCycleAbort();
  let deadlineCalled = false;
  cycle.armHardTimeout(10, () => {
    deadlineCalled = true;
  });

  const stopReason = new Error("Scanner stopped; cancelling active cycle");
  cycle.controller.abort(stopReason);
  cycle.dispose();
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(cycle.signal.aborted, true);
  assert.equal(cycle.signal.reason, stopReason);
  assert.equal(deadlineCalled, false);
});
