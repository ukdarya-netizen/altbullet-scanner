import assert from "node:assert/strict";
import { test } from "node:test";
import {
  writeCancellationPrice72hSnapshots,
  type CancellationPriceSnapshotStore,
  type PendingCancellationPriceSnapshot,
} from "../src/lib/cancellation-price-snapshot.js";

type SnapshotWrite = {
  price72hAfterExitPct: number;
  price72hAfterExitObservedAt: Date;
  updatedAt: Date;
};

function createMockStore(pending: PendingCancellationPriceSnapshot[]) {
  const writes: SnapshotWrite[] = [];
  let findPendingCalls = 0;

  const store: CancellationPriceSnapshotStore = {
    findPending: async () => {
      findPendingCalls++;
      return pending;
    },
    persist: async ({ pct, observedAt }) => {
      writes.push({
        price72hAfterExitPct: pct,
        price72hAfterExitObservedAt: observedAt,
        updatedAt: observedAt,
      });
      return true;
    },
  };

  return {
    store,
    writes,
    get findPendingCalls() {
      return findPendingCalls;
    },
  };
}

function ticker(symbol: string, lastPrice: string) {
  return {
    symbol,
    lastPrice,
  };
}

test("cancellation price snapshot persists ticker-observation time with its percentage", async () => {
  const fetchedAt = new Date("2026-08-19T12:00:00.000Z");
  const laterDatabaseWriteAt = new Date("2026-08-19T12:04:00.000Z");
  const mock = createMockStore([
    {
      id: 42,
      symbol: "MATURE-USDT",
      isShort: false,
      exitPrice: 100,
    },
  ]);
  let nowCalls = 0;

  await writeCancellationPrice72hSnapshots({
    getTickers: async () => [ticker("MATURE-USDT", "112")],
    store: mock.store,
    now: () => {
      nowCalls++;
      return nowCalls === 1 ? fetchedAt : laterDatabaseWriteAt;
    },
  });

  assert.equal(
    nowCalls,
    1,
    "the writer captures one time immediately after fetch",
  );
  assert.deepEqual(mock.writes, [
    {
      price72hAfterExitPct: 12,
      price72hAfterExitObservedAt: fetchedAt,
      updatedAt: fetchedAt,
    },
  ]);
  assert.notEqual(
    mock.writes[0]?.price72hAfterExitObservedAt.getTime(),
    laterDatabaseWriteAt.getTime(),
  );
});

test("cancellation price snapshot leaves no-price rows pending", async () => {
  const mock = createMockStore([
    {
      id: 43,
      symbol: "NO-PRICE-USDT",
      isShort: false,
      exitPrice: 100,
    },
  ]);

  await writeCancellationPrice72hSnapshots({
    getTickers: async () => [ticker("NO-PRICE-USDT", "0")],
    store: mock.store,
    now: () => new Date("2026-08-19T12:00:00.000Z"),
  });

  assert.equal(mock.findPendingCalls, 0);
  assert.deepEqual(mock.writes, []);
});
