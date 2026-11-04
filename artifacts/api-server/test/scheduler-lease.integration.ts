import assert from "node:assert/strict";
import test from "node:test";
import { db, pool, schedulerLeasesTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import {
  MARKET_CYCLE_LEASE,
  assertMarketCycleLeaseOwnership,
  SchedulerLeaseLostError,
  withMarketCycleLease,
  withSchedulerLease,
} from "../src/lib/schedulerLease.js";
import { dbWriteStrict } from "../src/lib/dbWriteFast.js";
import { sendPhotoCaptionResult } from "../src/lib/telegram.js";

const enabled = process.env.RUN_SCHEDULER_LEASE_INTEGRATION_TESTS === "true";
const testLeaseName = MARKET_CYCLE_LEASE;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test(
  "market-cycle lease is exclusive, renewable, expires safely, and releases",
  { skip: !enabled },
  async () => {
    await db
      .delete(schedulerLeasesTable)
      .where(eq(schedulerLeasesTable.leaseName, testLeaseName));

    let releaseFirst!: () => void;
    let firstEntered!: () => void;
    const firstEnteredPromise = new Promise<void>((resolve) => {
      firstEntered = resolve;
    });
    const first = withMarketCycleLease(
      "test-first",
      async () => {
        firstEntered();
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
        return "first";
      },
      { ttlMs: 800, heartbeatMs: 150 },
    );
    await firstEnteredPromise;

    const contended = await withMarketCycleLease(
      "test-contended",
      async () => "should-not-run",
      { ttlMs: 800, heartbeatMs: 150 },
    );
    assert.equal(contended.acquired, false);
    releaseFirst();
    assert.deepEqual(await first, { acquired: true, value: "first" });

    await db.execute(sql`
      INSERT INTO scheduler_leases (lease_name, owner_token, expires_at)
      VALUES (${testLeaseName}, 'expired-owner', NOW() - INTERVAL '1 second')
    `);
    const reclaimed = await withMarketCycleLease(
      "test-expired",
      async () => "reclaimed",
      { ttlMs: 800, heartbeatMs: 150 },
    );
    assert.deepEqual(reclaimed, { acquired: true, value: "reclaimed" });

    const heartbeat = await withMarketCycleLease(
      "test-heartbeat",
      async () => {
        await sleep(950);
        const [row] = await db
          .select({
            ownerToken: schedulerLeasesTable.ownerToken,
            expiresAt: schedulerLeasesTable.expiresAt,
          })
          .from(schedulerLeasesTable)
          .where(eq(schedulerLeasesTable.leaseName, testLeaseName));
        assert.ok(row);
        assert.ok(row.expiresAt.getTime() > Date.now());
        return row.ownerToken;
      },
      { ttlMs: 800, heartbeatMs: 150 },
    );
    assert.equal(heartbeat.acquired, true);

    const released = await db
      .select({ leaseName: schedulerLeasesTable.leaseName })
      .from(schedulerLeasesTable)
      .where(eq(schedulerLeasesTable.leaseName, testLeaseName));
    assert.equal(released.length, 0);
  },
);

test(
  "market-cycle work rejects stale side effects after ownership changes mid-job",
  { skip: !enabled },
  async () => {
    await db
      .delete(schedulerLeasesTable)
      .where(eq(schedulerLeasesTable.leaseName, testLeaseName));

    let entered!: () => void;
    const enteredPromise = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const staleWorker = withMarketCycleLease(
      "test-stale-worker",
      async () => {
        entered();
        await sleep(180);
        assert.throws(
          () => assertMarketCycleLeaseOwnership("test persisted side effect"),
          SchedulerLeaseLostError,
        );
        let writeInvoked = false;
        await assert.rejects(
          () =>
            dbWriteStrict("test stale persistence", async () => {
              writeInvoked = true;
              await db
                .update(schedulerLeasesTable)
                .set({ heartbeatAt: new Date() })
                .where(eq(schedulerLeasesTable.leaseName, testLeaseName));
            }),
          SchedulerLeaseLostError,
        );
        assert.equal(writeInvoked, false);
        await assert.rejects(
          () =>
            sendPhotoCaptionResult(
              "test-target",
              "/does-not-need-to-exist.png",
              "stale delivery must not start",
            ),
          SchedulerLeaseLostError,
        );
        return "must-not-complete";
      },
      { ttlMs: 600, heartbeatMs: 40 },
    );
    await enteredPromise;

    // Simulate a replacement worker claiming the expired/released row while the
    // original job is still unwinding. Its next heartbeat must abort the old
    // context before that context is allowed to persist or deliver anything.
    await db
      .update(schedulerLeasesTable)
      .set({
        ownerToken: "replacement-worker",
        expiresAt: new Date(Date.now() + 5_000),
      })
      .where(eq(schedulerLeasesTable.leaseName, testLeaseName));

    await assert.rejects(staleWorker, SchedulerLeaseLostError);

    await db
      .delete(schedulerLeasesTable)
      .where(eq(schedulerLeasesTable.leaseName, testLeaseName));
  },
);

test(
  "scheduler lease remains acquirable while the shared application pool is saturated",
  { skip: !enabled },
  async () => {
    const clients = await Promise.all(
      Array.from({ length: 8 }, () => pool.connect()),
    );
    try {
      const lease = await withMarketCycleLease(
        "test-app-pool-saturated",
        async () => "scheduler-control-plane-remains-free",
        { ttlMs: 800, heartbeatMs: 150 },
      );
      assert.deepEqual(lease, {
        acquired: true,
        value: "scheduler-control-plane-remains-free",
      });
    } finally {
      for (const client of clients) client.release();
    }
  },
);

test(
  "heartbeat failure keeps work alive until TTL, then recovers; late renewal after release is ignored",
  { skip: !enabled },
  async () => {
    const name = "test-heartbeat-recovery";
    await db
      .delete(schedulerLeasesTable)
      .where(eq(schedulerLeasesTable.leaseName, name));
    const { schedulerPool } = await import("@workspace/db");
    const losses: string[] = [];
    const origQuery = schedulerPool.query.bind(schedulerPool);
    let failing = false;
    (schedulerPool as any).query = (...args: unknown[]) =>
      failing
        ? Promise.reject(
            new Error("Connection terminated due to connection timeout"),
          )
        : (origQuery as any)(...args);
    try {
      const res = await withSchedulerLease(
        name,
        "hb-recovery",
        async (lease) => {
          failing = true;
          await sleep(1_500); // heartbeat (200ms) fails repeatedly; TTL is 4s
          lease.throwIfLost("still alive");
          failing = false;
          await sleep(1_000); // retry (2s) may land; TTL still valid
          lease.throwIfLost("recovered");
          return "ok";
        },
        {
          ttlMs: 4_000,
          heartbeatMs: 200,
          onLeaseLost: (d) => losses.push(d.reason),
        },
      );
      assert.deepEqual(res, { acquired: true, value: "ok" });
      await sleep(5_000); // no late timer may report loss after release
      assert.deepEqual(losses, []);
    } finally {
      (schedulerPool as any).query = origQuery;
    }
  },
);
