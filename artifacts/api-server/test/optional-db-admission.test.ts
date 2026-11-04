import assert from "node:assert/strict";
import test from "node:test";
import { createOptionalDbAdmission } from "../src/lib/optionalDbAdmission.js";

const healthyPool = {
  total: 2,
  idle: 1,
  waiting: 0,
  max: 8,
  underPressure: false,
};

test("optional DB work yields immediately while scanner control-plane has priority", () => {
  const admission = createOptionalDbAdmission(() => healthyPool);

  assert.deepEqual(admission.tryAcquire("oi-history-backfill", true), {
    acquired: false,
    reason: "scanner-priority",
  });
});

test("optional DB work does not add a waiter to a pressured application pool", () => {
  const admission = createOptionalDbAdmission(() => ({
    ...healthyPool,
    idle: 0,
    waiting: 3,
    underPressure: true,
  }));

  assert.deepEqual(admission.tryAcquire("trajectory-reconcile", false), {
    acquired: false,
    reason: "pool-pressure",
  });
});

test("only one optional DB maintenance job runs per process", () => {
  const admission = createOptionalDbAdmission(() => healthyPool);
  const first = admission.tryAcquire("oi-history-backfill", false);
  assert.equal(first.acquired, true);
  assert.deepEqual(admission.tryAcquire("entry-metrics-backfill", false), {
    acquired: false,
    reason: "another-maintenance-job",
  });
  if (first.acquired) first.release();
  assert.equal(
    admission.tryAcquire("entry-metrics-backfill", false).acquired,
    true,
  );
});

test("a deferred priority job reserves the next healthy maintenance slot", () => {
  const admission = createOptionalDbAdmission(() => healthyPool);
  const first = admission.tryAcquire("entry-metrics-backfill", false);
  assert.equal(first.acquired, true);
  assert.deepEqual(
    admission.tryAcquire("pattern-decision-history", false, true),
    {
      acquired: false,
      reason: "another-maintenance-job",
    },
  );
  if (first.acquired) first.release();

  assert.deepEqual(admission.tryAcquire("health-events-backfill", false), {
    acquired: false,
    reason: "priority-maintenance-waiting",
  });
  const priority = admission.tryAcquire(
    "pattern-decision-history",
    false,
    true,
  );
  assert.equal(priority.acquired, true);
  if (priority.acquired) priority.release();
  assert.equal(
    admission.tryAcquire("health-events-backfill", false).acquired,
    true,
  );
});
