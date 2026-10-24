import assert from "node:assert/strict";
import test from "node:test";
import { resolveHealthObservationFlow } from "../src/lib/health-observation-flow.js";

test("disabled health persists observation and still reaches lifecycle checks", () => {
  const flow = resolveHealthObservationFlow(false, true);
  assert.deepEqual(flow, {
    persistObservation: true,
    sendTelegram: false,
    continueLifecycle: true,
  });
});

test("enabled health may send without changing lifecycle continuation", () => {
  assert.equal(resolveHealthObservationFlow(true, true).sendTelegram, true);
  assert.equal(
    resolveHealthObservationFlow(true, true).continueLifecycle,
    true,
  );
});
