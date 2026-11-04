import assert from "node:assert/strict";
import test from "node:test";
import {
  isLeaseTtlElapsed,
  retrySchedulerLeaseHeartbeat,
} from "../src/lib/schedulerLease.js";

test("a transient scheduler heartbeat socket failure retries once before lease loss", async () => {
  let attempts = 0;
  const renewed = await retrySchedulerLeaseHeartbeat(
    async () => {
      attempts++;
      if (attempts === 1) throw new Error("Connection terminated unexpectedly");
      return true;
    },
    async () => undefined,
  );

  assert.equal(renewed, true);
  assert.equal(attempts, 2);
});

test("a second heartbeat failure remains visible to the lease safety fence", async () => {
  let attempts = 0;
  await assert.rejects(
    () =>
      retrySchedulerLeaseHeartbeat(
        async () => {
          attempts++;
          throw new Error("scheduler unavailable");
        },
        async () => undefined,
      ),
    /scheduler unavailable/,
  );
  assert.equal(attempts, 2);
});

test("heartbeat failure cancels only after the persisted TTL has elapsed", () => {
  assert.equal(isLeaseTtlElapsed(1_000, 91_000), false);
  assert.equal(isLeaseTtlElapsed(90_999, 91_000), false);
  assert.equal(isLeaseTtlElapsed(91_000, 91_000), true);
});
