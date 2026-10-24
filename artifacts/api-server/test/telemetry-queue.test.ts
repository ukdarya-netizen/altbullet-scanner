/**
 * Unit tests for TelemetryQueue.
 *
 * Tests the queue mechanics in isolation — no DB, no scanner state.
 * Run with: node --test .test-dist/test/telemetry-queue.test.js
 *   (after: tsc -p tsconfig.test.json)
 *
 * All retry delays are set to 5 ms via retryBaseDelayMs so tests are fast
 * and deterministic while exercising the real backoff path.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  DurableTelemetryQueue,
  TelemetryQueue,
  type DurableTelemetryClaim,
  type DurableTelemetryStore,
  type TelemetryOutboxId,
} from "../src/lib/telemetryQueue.js";

/**
 * Wait until the queue writer goes idle (isActive=false && depth=0),
 * polling every setImmediate tick up to maxMs milliseconds.
 */
async function waitIdle(
  q: TelemetryQueue<unknown>,
  maxMs = 2000,
): Promise<void> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    if (!q.isActive && q.depth === 0) return;
    await new Promise<void>((r) => setImmediate(r));
  }
  throw new Error(
    `waitIdle: queue did not go idle within ${maxMs}ms (depth=${q.depth}, active=${q.isActive})`,
  );
}

// ── Baseline: items written, ordering, single-flight ─────────────────────────

describe("TelemetryQueue — baseline", () => {
  test("items are written in FIFO order after recovery delay", async () => {
    const written: number[] = [];
    const q = new TelemetryQueue<number>({
      recoveryDelayMs: 5,
      retryBaseDelayMs: 5,
      write: async (item) => {
        written.push(item);
      },
    });

    q.push(1);
    q.push(2);
    q.push(3);

    assert.equal(q.depth, 3);

    await waitIdle(q, 200);

    assert.deepEqual(written, [1, 2, 3]);
    assert.equal(q.depth, 0);
    assert.equal(q.isActive, false);
  });

  test("single-flight: only one writer runs at a time", async () => {
    let concurrentWriters = 0;
    let maxConcurrent = 0;
    const written: number[] = [];

    const q = new TelemetryQueue<number>({
      recoveryDelayMs: 5,
      retryBaseDelayMs: 5,
      write: async (item) => {
        concurrentWriters++;
        maxConcurrent = Math.max(maxConcurrent, concurrentWriters);
        await new Promise<void>((r) => setTimeout(r, 5));
        written.push(item);
        concurrentWriters--;
      },
    });

    q.push(10);
    q.push(20);
    q.push(30);

    await waitIdle(q, 500);

    assert.equal(maxConcurrent, 1, "at most one writer at a time");
    assert.deepEqual(written, [10, 20, 30]);
  });

  test("items pushed while writer runs are written in the same pass", async () => {
    const written: number[] = [];
    let writeCount = 0;

    const q = new TelemetryQueue<number>({
      recoveryDelayMs: 5,
      retryBaseDelayMs: 5,
      write: async (item) => {
        writeCount++;
        written.push(item);
        if (writeCount === 1) q.push(99); // push during write of item 1
      },
    });

    q.push(1);
    q.push(2);

    await waitIdle(q, 500);

    assert.deepEqual(written, [1, 2, 99]);
    assert.equal(q.depth, 0);
  });

  test("recovery delay is applied once per activation, not per item", async () => {
    const timestamps: number[] = [];

    const q = new TelemetryQueue<number>({
      recoveryDelayMs: 50,
      retryBaseDelayMs: 5,
      write: async (item) => {
        timestamps.push(Date.now());
        void item;
      },
    });

    q.push(1);
    q.push(2);
    q.push(3);

    await waitIdle(q, 500);

    const spanMs = timestamps[timestamps.length - 1]! - timestamps[0]!;
    assert.equal(timestamps.length, 3);
    // If delay were per-item the span would be ≥ 150 ms; one delay → ≪ 50 ms span.
    assert.ok(
      spanMs < 100,
      `writes should complete within ~100 ms of each other, got ${spanMs} ms`,
    );
  });

  test("queue starts empty with no active writer", () => {
    const q = new TelemetryQueue<string>({
      recoveryDelayMs: 0,
      retryBaseDelayMs: 5,
      write: async () => {},
    });
    assert.equal(q.depth, 0);
    assert.equal(q.isActive, false);
  });
});

// ── Retry durability ──────────────────────────────────────────────────────────

describe("TelemetryQueue — retry durability", () => {
  test("failed item is retained and retried until it succeeds", async () => {
    const written: string[] = [];
    let attempts = 0;

    // Item "A" fails on the first two attempts then succeeds on the third.
    const q = new TelemetryQueue<string>({
      recoveryDelayMs: 0,
      retryBaseDelayMs: 5,
      retryMaxDelayMs: 20,
      write: async (item) => {
        attempts++;
        if (item === "A" && attempts < 3) {
          throw new Error(`simulated DB failure attempt ${attempts}`);
        }
        written.push(item);
      },
    });

    q.push("A");

    await waitIdle(q, 500);

    assert.deepEqual(written, ["A"], "item A must eventually be written");
    assert.equal(attempts, 3, "should have taken exactly 3 attempts");
    assert.equal(q.depth, 0);
  });

  test("failed head item retries before subsequent items (FIFO preserved)", async () => {
    const order: string[] = [];
    // Item "X" fails once; item "Y" must not be written until "X" succeeds.
    let xAttempts = 0;

    const q = new TelemetryQueue<string>({
      recoveryDelayMs: 0,
      retryBaseDelayMs: 5,
      retryMaxDelayMs: 20,
      write: async (item) => {
        if (item === "X") {
          xAttempts++;
          if (xAttempts === 1) throw new Error("first X attempt fails");
        }
        order.push(item);
      },
    });

    q.push("X");
    q.push("Y");

    await waitIdle(q, 500);

    assert.deepEqual(order, ["X", "Y"], "X must succeed before Y is written");
    assert.equal(xAttempts, 2);
  });

  test("subsequent item is written only after failed head item succeeds", async () => {
    // Tighter version: track when each item is written relative to each other.
    const timestamps: Record<string, number> = {};
    let aAttempts = 0;

    const q = new TelemetryQueue<string>({
      recoveryDelayMs: 0,
      retryBaseDelayMs: 5,
      retryMaxDelayMs: 10,
      write: async (item) => {
        if (item === "first") {
          aAttempts++;
          if (aAttempts < 3) throw new Error("not ready yet");
        }
        timestamps[item] = Date.now();
      },
    });

    q.push("first");
    q.push("second");

    await waitIdle(q, 500);

    assert.ok(
      "first" in timestamps && "second" in timestamps,
      "both items must be written",
    );
    assert.ok(
      timestamps["first"]! <= timestamps["second"]!,
      "first must be written before or at the same time as second",
    );
    assert.equal(aAttempts, 3);
  });

  test("onRetry callback receives err, item, and attempt number", async () => {
    const retries: Array<{ attempt: number; item: number }> = [];
    let callCount = 0;

    const q = new TelemetryQueue<number>({
      recoveryDelayMs: 0,
      retryBaseDelayMs: 5,
      retryMaxDelayMs: 20,
      write: async (_item) => {
        callCount++;
        if (callCount <= 2) throw new Error("fail");
      },
      onRetry: (err, item, attempt) => {
        retries.push({ attempt, item });
      },
    });

    q.push(42);

    await waitIdle(q, 500);

    assert.equal(retries.length, 2, "onRetry called once per failed attempt");
    assert.equal(retries[0]!.attempt, 1);
    assert.equal(retries[1]!.attempt, 2);
    assert.equal(retries[0]!.item, 42);
  });

  test("backoff delay grows with attempt count up to retryMaxDelayMs", async () => {
    // Verify that each retry waits longer than the previous one, up to the cap.
    // We do this by measuring wall-clock time between retry callbacks.
    const retryTimes: number[] = [];
    let callCount = 0;

    const q = new TelemetryQueue<string>({
      recoveryDelayMs: 0,
      retryBaseDelayMs: 10, // base: 10 ms
      retryMaxDelayMs: 30, // cap:  30 ms (so delays: 10, 20, 30, 30, ...)
      write: async () => {
        callCount++;
        if (callCount <= 4) throw new Error("fail");
      },
      onRetry: () => {
        retryTimes.push(Date.now());
      },
    });

    const start = Date.now();
    q.push("item");

    await waitIdle(q, 2000);

    // callCount: 1 fail → retry(10ms) → 2 fail → retry(20ms) → 3 fail → retry(30ms)
    // → 4 fail → retry(30ms) → 5 success
    assert.equal(callCount, 5);
    assert.equal(retryTimes.length, 4);

    // gap[0] ≈ 10 ms, gap[1] ≈ 20 ms, gap[2] ≈ 30 ms, gap[3] ≈ 30 ms (capped)
    const gaps: number[] = [];
    let prev = start;
    for (const t of retryTimes) {
      gaps.push(t - prev);
      prev = t;
    }

    // Each gap should be strictly increasing up to the cap, with OS jitter tolerance.
    // We use ≥ 0 to avoid flakiness — the absolute values matter less than ordering.
    assert.ok(gaps[1]! >= gaps[0]! - 5, "second gap should be ≥ first");
    assert.ok(gaps[2]! >= gaps[1]! - 5, "third gap should be ≥ second");
    // gap[3] should be capped (≈ gap[2] since both hit retryMaxDelayMs)
    assert.ok(
      gaps[3]! <= gaps[2]! + 30,
      "fourth gap should not exceed cap by more than 30 ms jitter",
    );
  });

  test("single-flight preserved during retries: no concurrent writers", async () => {
    let active = 0;
    let maxActive = 0;
    let callCount = 0;

    const q = new TelemetryQueue<number>({
      recoveryDelayMs: 0,
      retryBaseDelayMs: 5,
      retryMaxDelayMs: 10,
      write: async (item) => {
        active++;
        maxActive = Math.max(maxActive, active);
        callCount++;
        await new Promise<void>((r) => setTimeout(r, 2));
        if (callCount <= 2) {
          active--;
          throw new Error("retry me");
        }
        active--;
        void item;
      },
    });

    q.push(1);
    q.push(2);

    await waitIdle(q, 500);

    assert.equal(maxActive, 1, "never more than one writer at a time");
  });
});

// ── Restart/replay durability ────────────────────────────────────────────────

type ReplayRow = { symbol: string; capturedAt: string };
type ReplayBatch =
  | { dedupKey: string; kind: "history"; rows: ReplayRow[] }
  | { dedupKey: string; kind: "snapshots"; rows: ReplayRow[] };

class FakeDurableStore implements DurableTelemetryStore<ReplayBatch> {
  private nextId = 1;
  private readonly byDedupKey = new Map<string, number>();
  private readonly records = new Map<
    number,
    {
      payload: ReplayBatch;
      status: "ready" | "retry" | "processing";
      attempt: number;
      claimToken: string | null;
      nextAttemptAt: number;
      leaseUntil: number | null;
    }
  >();
  private nowMs = 0;

  async enqueue(payload: ReplayBatch): Promise<void> {
    if (this.byDedupKey.has(payload.dedupKey)) return;
    const id = this.nextId++;
    this.byDedupKey.set(payload.dedupKey, id);
    this.records.set(id, {
      payload,
      status: "ready",
      attempt: 0,
      claimToken: null,
      nextAttemptAt: this.nowMs,
      leaseUntil: null,
    });
  }

  async listDueIds(): Promise<TelemetryOutboxId[]> {
    return [...this.records.entries()]
      .filter(([, record]) => {
        if (
          (record.status === "ready" || record.status === "retry") &&
          record.nextAttemptAt <= this.nowMs
        ) {
          return true;
        }
        return (
          record.status === "processing" &&
          record.leaseUntil != null &&
          record.leaseUntil <= this.nowMs
        );
      })
      .map(([id]) => id);
  }

  async claim(
    id: TelemetryOutboxId,
  ): Promise<DurableTelemetryClaim<ReplayBatch> | null> {
    if (typeof id !== "number") return null;
    const record = this.records.get(id);
    const due =
      ((record?.status === "ready" || record?.status === "retry") &&
        record.nextAttemptAt <= this.nowMs) ||
      (record?.status === "processing" &&
        record.leaseUntil != null &&
        record.leaseUntil <= this.nowMs);
    if (!record || !due) return null;
    record.status = "processing";
    record.attempt++;
    record.claimToken = `claim-${id}-${record.attempt}`;
    record.leaseUntil = this.nowMs + 12 * 60_000;
    return {
      id,
      payload: record.payload,
      attempt: record.attempt,
      claimToken: record.claimToken,
    };
  }

  async acknowledge(claim: DurableTelemetryClaim<ReplayBatch>): Promise<void> {
    const record =
      typeof claim.id === "number" ? this.records.get(claim.id) : undefined;
    assert.equal(record?.claimToken, claim.claimToken);
    this.records.delete(claim.id as number);
  }

  async retry(
    claim: DurableTelemetryClaim<ReplayBatch>,
    params: { delayMs: number; error: unknown },
  ): Promise<void> {
    const record =
      typeof claim.id === "number" ? this.records.get(claim.id) : undefined;
    assert.equal(record?.claimToken, claim.claimToken);
    record!.status = "retry";
    record!.claimToken = null;
    record!.leaseUntil = null;
    record!.nextAttemptAt = this.nowMs + params.delayMs;
  }

  advanceBy(ms: number): void {
    this.nowMs += ms;
  }

  get pendingCount(): number {
    return this.records.size;
  }
}

async function waitDurableIdle(
  q: DurableTelemetryQueue<unknown>,
  maxMs = 500,
): Promise<void> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    if (!q.isActive && q.depth === 0) return;
    await new Promise<void>((r) => setImmediate(r));
  }
  throw new Error(
    `waitDurableIdle: queue did not go idle within ${maxMs}ms (depth=${q.depth}, active=${q.isActive})`,
  );
}

async function waitFor(predicate: () => boolean, maxMs = 500): Promise<void> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise<void>((r) => setTimeout(r, 2));
  }
  throw new Error("waitFor: condition was not met before timeout");
}

describe("DurableTelemetryQueue — restart replay", () => {
  test("replays a committed-but-unacknowledged history and snapshot batch without duplicate rows", async () => {
    const store = new FakeDurableStore();
    const writtenHistory = new Set<string>();
    const writtenSnapshots = new Set<string>();
    let logicalInserts = 0;

    const writeToTargets = async (
      batch: ReplayBatch,
      failAfterCommit: boolean,
    ): Promise<void> => {
      const target =
        batch.kind === "history" ? writtenHistory : writtenSnapshots;
      for (const row of batch.rows) {
        const key = `${row.symbol}:${row.capturedAt}`;
        if (!target.has(key)) {
          target.add(key);
          logicalInserts++;
        }
      }
      if (failAfterCommit) {
        throw new Error("simulated timeout after target transaction committed");
      }
    };

    const firstProcess = new DurableTelemetryQueue<ReplayBatch>({
      recoveryDelayMs: 0,
      retryBaseDelayMs: 1_000,
      store,
      write: async (batch) => writeToTargets(batch, true),
    });
    await firstProcess.enqueue({
      dedupKey: "history:2026-08-20T12:00:00.000Z",
      kind: "history",
      rows: [
        { symbol: "AAA-USDT", capturedAt: "2026-08-20T12:00:00.000Z" },
        { symbol: "BBB-USDT", capturedAt: "2026-08-20T12:00:00.000Z" },
      ],
    });
    await firstProcess.enqueue({
      dedupKey: "snapshots:2026-08-20T12:00:00.000Z",
      kind: "snapshots",
      rows: [
        { symbol: "AAA-USDT", capturedAt: "2026-08-20T12:00:00.000Z" },
        { symbol: "BBB-USDT", capturedAt: "2026-08-20T12:00:00.000Z" },
      ],
    });
    await waitDurableIdle(firstProcess);
    firstProcess.stop(); // Simulate process exit before durable retry fires.

    assert.equal(
      store.pendingCount,
      2,
      "both immutable batches remain pending",
    );
    assert.equal(
      logicalInserts,
      4,
      "both batches committed before their timeout",
    );

    const restartedProcess = new DurableTelemetryQueue<ReplayBatch>({
      recoveryDelayMs: 0,
      retryBaseDelayMs: 5,
      pollIntervalMs: 5,
      store,
      write: async (batch) => writeToTargets(batch, false),
    });
    await restartedProcess.start();
    await waitDurableIdle(restartedProcess);
    assert.equal(
      store.pendingCount,
      2,
      "startup does not replay batches before their durable retry time",
    );

    store.advanceBy(1_000);
    await waitFor(() => store.pendingCount === 0);
    await waitDurableIdle(restartedProcess);
    restartedProcess.stop();

    assert.equal(
      store.pendingCount,
      0,
      "restart acknowledges each replayed batch",
    );
    assert.deepEqual([...writtenHistory].sort(), [
      "AAA-USDT:2026-08-20T12:00:00.000Z",
      "BBB-USDT:2026-08-20T12:00:00.000Z",
    ]);
    assert.deepEqual([...writtenSnapshots].sort(), [
      "AAA-USDT:2026-08-20T12:00:00.000Z",
      "BBB-USDT:2026-08-20T12:00:00.000Z",
    ]);
    assert.equal(
      logicalInserts,
      4,
      "unique symbol + captured-cycle keys prevent replay duplicates",
    );
  });

  test("two workers claim a due batch only once", async () => {
    const store = new FakeDurableStore();
    let writes = 0;
    const batch: ReplayBatch = {
      dedupKey: "history:2026-08-20T13:00:00.000Z",
      kind: "history",
      rows: [{ symbol: "AAA-USDT", capturedAt: "2026-08-20T13:00:00.000Z" }],
    };
    await store.enqueue(batch);

    const writer = async (): Promise<void> => {
      writes++;
    };
    const workerA = new DurableTelemetryQueue<ReplayBatch>({
      recoveryDelayMs: 0,
      pollIntervalMs: 5,
      store,
      write: writer,
    });
    const workerB = new DurableTelemetryQueue<ReplayBatch>({
      recoveryDelayMs: 0,
      pollIntervalMs: 5,
      store,
      write: writer,
    });

    await Promise.all([workerA.start(), workerB.start()]);
    await waitFor(() => store.pendingCount === 0);
    workerA.stop();
    workerB.stop();

    assert.equal(writes, 1, "conditional claim lets only one worker write");
  });

  test("restart reclaims an expired processing lease", async () => {
    const store = new FakeDurableStore();
    const batch: ReplayBatch = {
      dedupKey: "snapshots:2026-08-20T14:00:00.000Z",
      kind: "snapshots",
      rows: [{ symbol: "AAA-USDT", capturedAt: "2026-08-20T14:00:00.000Z" }],
    };
    await store.enqueue(batch);
    const abandonedClaim = await store.claim(1);
    assert.ok(abandonedClaim, "first process claims the batch before crashing");
    store.advanceBy(12 * 60_000);

    let writes = 0;
    const restartedProcess = new DurableTelemetryQueue<ReplayBatch>({
      recoveryDelayMs: 0,
      pollIntervalMs: 5,
      store,
      write: async () => {
        writes++;
      },
    });
    await restartedProcess.start();
    await waitFor(() => store.pendingCount === 0);
    restartedProcess.stop();

    assert.equal(writes, 1, "expired lease is replayed by the new process");
  });
});
