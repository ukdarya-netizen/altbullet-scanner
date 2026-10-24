import assert from "node:assert/strict";
import test from "node:test";
import {
  AutoRangeHistoryQueue,
  createAutoRangeHistoryScope,
  serializeAutoRangeHistoryError,
  type AutoRangeHistoryCandle,
} from "../src/lib/auto-range-history.js";
import { normalizeClosedBreakoutCandles } from "../src/lib/breakout-analysis.js";
import { detectAutoRangePine } from "../src/lib/auto-range-pine.js";

interface Candle extends AutoRangeHistoryCandle {
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
}

function makeCandles(count: number): Candle[] {
  return Array.from({ length: count }, (_, index) => {
    const close = 10 + Math.sin(index / 7) * 0.2;
    return {
      time: index * 4 * 60 * 60 * 1_000,
      open: String(close),
      high: String(close + 0.1),
      low: String(close - 0.1),
      close: String(close),
      volume: "100",
    };
  });
}

function createQueue() {
  return new AutoRangeHistoryQueue<Candle>({
    maxItemsPerCycle: 16,
    countClosedCandles: (candles) =>
      normalizeClosedBreakoutCandles(candles).length,
  });
}

test("queue promotion deduplicates keys and honors the 1,500-symbol cap", () => {
  const queue = new AutoRangeHistoryQueue<Candle>({
    maxItemsPerCycle: 16,
    countClosedCandles: (candles) =>
      normalizeClosedBreakoutCandles(candles).length,
  });

  for (let index = 0; index < 1_500; index += 1) {
    assert.equal(queue.enqueue(`4h:SYMBOL-${index}`, index), true);
  }
  assert.equal(queue.enqueue("4h:SYMBOL-0", 3_000), true);
  assert.equal(queue.enqueue("4h:OVERFLOW", 1), false);
  const entries = queue.getQueuedEntries();
  assert.equal(entries.length, 1_500);
  assert.equal(new Set(entries.map((entry) => entry.key)).size, 1_500);
  assert.equal(entries[0]?.priority, 3_000);
});

test("expired generic prefetch signal does not cancel a fresh range-history lease", async () => {
  const genericPrefetch = new AbortController();
  genericPrefetch.abort(new Error("generic prefetch deadline"));
  const parentLease = new AbortController();
  const scope = createAutoRangeHistoryScope(parentLease.signal, 5_000);
  const queue = createQueue();
  queue.enqueue("4h:BTC-USDT", 3);
  let receivedSignal: AbortSignal | undefined;
  let receivedLimit = 0;

  try {
    const stats = await queue.fetchBatch({
      signal: scope.signal,
      fetchHistory: async (_key, limit, signal) => {
        receivedSignal = signal;
        receivedLimit = limit;
        return makeCandles(901);
      },
    });

    assert.equal(genericPrefetch.signal.aborted, true);
    assert.equal(scope.signal.aborted, false);
    assert.equal(receivedSignal, scope.signal);
    assert.equal(receivedLimit, 901);
    assert.deepEqual(
      {
        attempted: stats.attempted,
        succeeded: stats.succeeded,
        shortHistory: stats.shortHistory,
        cancelled: stats.cancelled,
      },
      { attempted: 1, succeeded: 1, shortHistory: 0, cancelled: 0 },
    );
    assert.equal(queue.getLastSuccessfulFetchAt("4h:BTC-USDT") > 0, true);
  } finally {
    scope.dispose();
  }
});

test("the parent market lease abort cancels an active range-history request", async () => {
  const parentLease = new AbortController();
  const scope = createAutoRangeHistoryScope(parentLease.signal, 5_000);
  const queue = createQueue();
  queue.enqueue("4h:ETH-USDT", 2);

  try {
    const statsPromise = queue.fetchBatch({
      signal: scope.signal,
      now: () => 1_000,
      fetchHistory: (_key, _limit, signal) =>
        new Promise<Candle[]>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
          parentLease.abort(new Error("market lease lost"));
        }),
    });
    const stats = await statsPromise;

    assert.equal(scope.signal.aborted, true);
    assert.equal(stats.attempted, 1);
    assert.equal(stats.cancelled, 1);
    assert.equal(stats.failed, 0);
    assert.equal(stats.queuedRemaining, 1);
    assert.equal(queue.getQueuedEntries()[0]?.priority, 2);
    assert.equal(queue.getLastSuccessfulFetchAt("4h:ETH-USDT"), 0);
  } finally {
    scope.dispose();
  }
});

test("one bounded batch retains unstarted and cancelled work with priority", async () => {
  const parentLease = new AbortController();
  const queue = createQueue();
  const priorities = new Map<string, number>();
  for (let index = 0; index < 20; index += 1) {
    const key = `4h:SYMBOL-${index}`;
    const priority = index < 4 ? 3 : index < 12 ? 2 : 0;
    priorities.set(key, priority);
    queue.enqueue(key, priority);
  }
  const scope = createAutoRangeHistoryScope(parentLease.signal, 20);
  let fetchCalls = 0;

  try {
    const stats = await queue.fetchBatch({
      signal: scope.signal,
      now: () => 1_000,
      fetchHistory: (_key, _limit, signal) =>
        new Promise<Candle[]>((_resolve, reject) => {
          fetchCalls += 1;
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        }),
    });
    const remaining = queue.getQueuedEntries();

    assert.equal(stats.selected, 16);
    assert.equal(stats.attempted, 8);
    assert.equal(stats.cancelled, 8);
    assert.equal(stats.deferred, 12);
    assert.equal(stats.queuedRemaining, 20);
    assert.equal(scope.deadlineExceeded, true);
    assert.equal(fetchCalls, 8);
    assert.equal(new Set(remaining.map(({ key }) => key)).size, 20);
    assert.deepEqual(
      remaining.slice(0, 12).map(({ key }) => key),
      Array.from({ length: 12 }, (_, index) => `4h:SYMBOL-${index + 8}`),
    );
    for (const entry of remaining) {
      assert.equal(entry.priority, priorities.get(entry.key));
    }
    assert.equal(
      remaining.filter((entry) => entry.retryAfter === 0).length,
      12,
    );
  } finally {
    scope.dispose();
  }

  const later = await queue.fetchBatch({
    signal: new AbortController().signal,
    now: () => 61_000,
    fetchHistory: async () => makeCandles(901),
  });
  assert.equal(later.attempted, 16);
  assert.equal(later.succeeded, 16);
  const laterKeys = new Set(later.attempts.map(({ key }) => key));
  for (let index = 8; index < 16; index += 1) {
    assert.equal(laterKeys.has(`4h:SYMBOL-${index}`), true);
  }
  const trailing = await queue.fetchBatch({
    signal: new AbortController().signal,
    now: () => 61_000,
    fetchHistory: async () => makeCandles(901),
  });
  assert.equal(trailing.attempted, 4);
  for (let index = 16; index < 20; index += 1) {
    assert.equal(
      trailing.attempts.some(({ key }) => key === `4h:SYMBOL-${index}`),
      true,
    );
  }
});

test("failed oldest batches rotate so a later batch reaches trailing symbols", async () => {
  const queue = createQueue();
  const keys = Array.from({ length: 20 }, (_, index) => `4h:SYMBOL-${index}`);
  for (const key of keys) queue.enqueue(key, 0, 1_000);

  const firstCycle = await queue.fetchBatch({
    signal: new AbortController().signal,
    now: () => 1_000,
    fetchHistory: async () => {
      throw new Error("repeated provider failure");
    },
  });
  assert.equal(firstCycle.attempted, 16);
  assert.equal(firstCycle.failed, 16);
  assert.deepEqual(
    queue
      .getQueuedEntries()
      .slice(0, 4)
      .map(({ key }) => key),
    keys.slice(16),
  );

  const requested: string[] = [];
  const laterCycle = await queue.fetchBatch({
    signal: new AbortController().signal,
    now: () => 61_000,
    fetchHistory: async (key) => {
      requested.push(key);
      if (!keys.slice(16).includes(key)) {
        throw new Error("leading symbols remain unavailable");
      }
      return makeCandles(901);
    },
  });

  assert.equal(laterCycle.attempted, 16);
  assert.equal(laterCycle.succeeded, 4);
  for (const key of keys.slice(16)) {
    assert.equal(requested.includes(key), true);
  }
});

test("reserved oldest-work slots let low-priority healthy symbols pass failing high-priority work", async () => {
  const queue = createQueue();
  const highPriority = Array.from(
    { length: 16 },
    (_, index) => `4h:ARM-${index}`,
  );
  const lowPriority = Array.from(
    { length: 4 },
    (_, index) => `4h:MARKET-${index}`,
  );
  for (const key of highPriority) queue.enqueue(key, 3, 1_000);
  for (const key of lowPriority) queue.enqueue(key, 0, 1_000);

  const firstCycle = await queue.fetchBatch({
    signal: new AbortController().signal,
    now: () => 1_000,
    fetchHistory: async () => {
      throw new Error("priority arm history unavailable");
    },
  });
  assert.equal(firstCycle.attempted, 16);

  const requested: string[] = [];
  const laterCycle = await queue.fetchBatch({
    signal: new AbortController().signal,
    now: () => 61_000,
    fetchHistory: async (key) => {
      requested.push(key);
      if (lowPriority.includes(key)) return makeCandles(901);
      throw new Error("priority arm history still unavailable");
    },
  });

  assert.equal(laterCycle.succeeded, 4);
  for (const key of lowPriority) {
    assert.equal(requested.includes(key), true);
  }
});

test("a lease cancelled before work leaves queue order untouched", async () => {
  const queue = createQueue();
  for (let index = 0; index < 20; index += 1) {
    queue.enqueue(`4h:SYMBOL-${index}`, index % 4, 1_000);
  }
  const before = queue.getQueuedEntries();
  const parentLease = new AbortController();
  parentLease.abort(new Error("lease ended before warmup"));
  const scope = createAutoRangeHistoryScope(parentLease.signal, 5_000);
  let fetchCalls = 0;

  try {
    const stats = await queue.fetchBatch({
      signal: scope.signal,
      now: () => 1_000,
      fetchHistory: async () => {
        fetchCalls += 1;
        return makeCandles(901);
      },
    });

    assert.equal(stats.attempted, 0);
    assert.equal(stats.deferred, 20);
    assert.equal(fetchCalls, 0);
    assert.deepEqual(queue.getQueuedEntries(), before);
  } finally {
    scope.dispose();
  }
});

test("transient failures keep priority and retry in a later cycle", async () => {
  const queue = createQueue();
  queue.enqueue("4h:SOL-USDT", 3, 100);

  const failed = await queue.fetchBatch({
    signal: new AbortController().signal,
    now: () => 100,
    fetchHistory: async () => {
      throw new Error("temporary transport failure");
    },
  });
  assert.equal(failed.failed, 1);
  assert.deepEqual(queue.getQueuedEntries(), [
    { key: "4h:SOL-USDT", priority: 3, retryAfter: 60_100 },
  ]);

  const retried = await queue.fetchBatch({
    signal: new AbortController().signal,
    now: () => 60_100,
    fetchHistory: async () => makeCandles(901),
  });
  assert.equal(retried.attempted, 1);
  assert.equal(retried.succeeded, 1);
  assert.equal(retried.failed, 0);
  assert.equal(queue.queueSize, 0);
  assert.equal(
    normalizeClosedBreakoutCandles(queue.getCandles("4h:SOL-USDT")).length,
    900,
  );
});

test("only a successful short-history response starts the six-hour retry", async () => {
  const queue = createQueue();
  queue.enqueue("4h:ADA-USDT", 1, 1_000);
  assert.equal(queue.getLastSuccessfulFetchAt("4h:ADA-USDT"), 0);

  const short = await queue.fetchBatch({
    signal: new AbortController().signal,
    now: () => 1_000,
    fetchHistory: async () => makeCandles(100),
  });
  assert.equal(short.succeeded, 1);
  assert.equal(short.shortHistory, 1);
  assert.equal(queue.getLastSuccessfulFetchAt("4h:ADA-USDT"), 1_000);
  assert.equal(
    normalizeClosedBreakoutCandles(queue.getCandles("4h:ADA-USDT")).length,
    99,
  );
  assert.equal(queue.enqueue("4h:ADA-USDT", 2, 60_999), false);
  assert.equal(
    queue.enqueue("4h:ADA-USDT", 2, 1_000 + 6 * 60 * 60 * 1_000),
    true,
  );
});

test("901 returned candles provide 900 closed candles to the unchanged detector gate", async () => {
  const queue = createQueue();
  queue.enqueue("4h:DOGE-USDT", 3);
  const stats = await queue.fetchBatch({
    signal: new AbortController().signal,
    fetchHistory: async () => makeCandles(901),
  });

  assert.equal(stats.succeeded, 1);
  const closed = normalizeClosedBreakoutCandles(
    queue.getCandles("4h:DOGE-USDT"),
  );
  assert.equal(closed.length, 900);
  const detectorInput = closed.length >= 900 ? closed : [];
  assert.equal(detectorInput.length, 900);
  assert.doesNotThrow(() => detectAutoRangePine(detectorInput));
});

test("structured history errors redact credential-bearing message text", () => {
  assert.deepEqual(
    serializeAutoRangeHistoryError(
      new Error(
        "BingX API error: apiKey=abc123 signature=private-secret https://host/path?token=sensitive",
      ),
    ),
    {
      name: "Error",
      message:
        "BingX API error: apiKey=[redacted] signature=[redacted] https://host/path?[redacted]",
    },
  );
});

test("candles merged from a short prefetch are not ready before a full fetch", async () => {
  const queue = createQueue();
  queue.merge("1h:X", makeCandles(300));
  assert.equal(queue.isHistoryReady("1h:X"), false);
  assert.equal(queue.enqueue("1h:X", 1), true);
  await queue.fetchBatch({
    signal: new AbortController().signal,
    fetchHistory: async () => makeCandles(900),
  });
  assert.equal(queue.isHistoryReady("1h:X"), true);
});

test("hydrated history is ready without a network fetch and is not re-queued", () => {
  const queue = new AutoRangeHistoryQueue<Candle>({
    countClosedCandles: (candles) => candles.length,
    requiredClosedCandles: 100,
  });
  assert.equal(queue.enqueue("1h:AAA-USDT", 1), true);
  queue.hydrate("1h:AAA-USDT", makeCandles(150), 1_000);
  assert.equal(queue.isHistoryReady("1h:AAA-USDT"), true);
  assert.equal(queue.queueSize, 0);
  assert.equal(queue.enqueue("1h:AAA-USDT", 1), false);
  // A fresher in-memory entry is never overwritten by an older persisted one.
  queue.hydrate("1h:AAA-USDT", makeCandles(120), 500);
  assert.equal(queue.getLastFetchAt("1h:AAA-USDT"), 1_000);
});

test("onFetched fires after a full-history fetch only", async () => {
  const seen: string[] = [];
  const queue = new AutoRangeHistoryQueue<Candle>({
    countClosedCandles: (candles) => candles.length,
    requiredClosedCandles: 100,
    onFetched: (key) => seen.push(key),
  });
  queue.enqueue("1h:FULL-USDT", 1);
  queue.enqueue("1h:SHORT-USDT", 1);
  await queue.fetchBatch({
    signal: new AbortController().signal,
    fetchHistory: async (key) => makeCandles(key.includes("FULL") ? 150 : 20),
  });
  assert.deepEqual(seen, ["1h:FULL-USDT"]);
});
