import assert from "node:assert/strict";
import { test } from "node:test";
import { runWhenMarketCycleIdle } from "../src/lib/market-job-guard.js";

test("low-priority market timer does not start work while scanner lease is active", async () => {
  let started = false;

  const outcome = await runWhenMarketCycleIdle(
    async () => true,
    async () => {
      started = true;
    },
  );

  assert.equal(outcome, "deferred");
  assert.equal(started, false);
});

test("low-priority market timer runs only when the persisted lease is idle", async () => {
  let started = false;

  const outcome = await runWhenMarketCycleIdle(
    async () => false,
    async () => {
      started = true;
    },
  );

  assert.equal(outcome, "ran");
  assert.equal(started, true);
});
