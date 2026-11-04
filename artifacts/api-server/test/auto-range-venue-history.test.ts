import assert from "node:assert/strict";
import test from "node:test";
import {
  AUTO_RANGE_VENUE_HISTORY_CONCURRENCY,
  AUTO_RANGE_VENUE_HISTORY_FETCHES_PER_CYCLE,
  AutoRangeVenueHistoryQueue,
} from "../src/lib/auto-range-venue-history.js";
import type { LcAutoRangeVenueHistory } from "../src/lib/lc-ob-wait.js";

function emptyHistory(
  symbol: string,
  venue: LcAutoRangeVenueHistory["venue"],
): LcAutoRangeVenueHistory {
  return {
    venue,
    instrumentId: symbol,
    fourHour: [],
    oneHour: [],
    fetchedAt: 1_000,
  };
}

test("venue history work is capped at four in flight and unknown venues are local", async () => {
  const queue = new AutoRangeVenueHistoryQueue();
  for (const venue of [
    "binance",
    "okx",
    "bybit",
    "gate",
    "kucoin",
    "mexc",
    "bitget",
    "htx",
    "kraken",
  ] as const) {
    queue.enqueue("BTC-USDT", venue, 1, 1_000);
  }

  let active = 0;
  let maximumActive = 0;
  const stats = {
    attempted: 0,
    succeeded: 0,
    unknown: 0,
  };
  const attemptsPerCycle: number[] = [];
  for (let cycle = 0; cycle < 5; cycle += 1) {
    const cycleStats = await queue.fetchBatch({
      signal: new AbortController().signal,
      now: () => 1_000 + cycle * 100,
      async fetchHistory(symbol, venue) {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await new Promise((resolve) => setTimeout(resolve, 1));
        active -= 1;
        return venue === "okx"
          ? { usable: false, reason: "geo-blocked" }
          : { usable: true, history: emptyHistory(symbol, venue) };
      },
    });
    attemptsPerCycle.push(cycleStats.attempted);
    stats.attempted += cycleStats.attempted;
    stats.succeeded += cycleStats.succeeded;
    stats.unknown += cycleStats.unknown;
  }

  assert.ok(AUTO_RANGE_VENUE_HISTORY_CONCURRENCY <= 4);
  assert.ok(maximumActive <= AUTO_RANGE_VENUE_HISTORY_CONCURRENCY);
  assert.ok(
    attemptsPerCycle.every(
      (attempts) => attempts <= AUTO_RANGE_VENUE_HISTORY_FETCHES_PER_CYCLE,
    ),
  );
  assert.equal(stats.attempted, 9);
  assert.equal(stats.succeeded, 8);
  assert.equal(stats.unknown, 1);
  assert.equal(queue.get("BTC-USDT", "binance")?.status, "ready");
  assert.equal(queue.get("BTC-USDT", "okx")?.status, "unknown");
});

test("transient failures retry quickly without clearing other venue caches", async () => {
  const queue = new AutoRangeVenueHistoryQueue();
  queue.enqueue("ETH-USDT", "binance", 1, 1_000);
  queue.enqueue("ETH-USDT", "mexc", 1, 1_000);
  await queue.fetchBatch({
    signal: new AbortController().signal,
    now: () => 1_000,
    async fetchHistory(symbol, venue) {
      return venue === "binance"
        ? { usable: false, reason: "http-503" }
        : { usable: true, history: emptyHistory(symbol, venue) };
    },
  });

  assert.equal(queue.get("ETH-USDT", "mexc")?.status, "ready");
  const noRetryYet = await queue.fetchBatch({
    signal: new AbortController().signal,
    now: () => 2_000,
    async fetchHistory() {
      throw new Error("must not retry before the transient backoff");
    },
  });
  assert.equal(noRetryYet.attempted, 0);
  const retried = await queue.fetchBatch({
    signal: new AbortController().signal,
    now: () => 62_000,
    async fetchHistory(symbol, venue) {
      return { usable: true, history: emptyHistory(symbol, venue) };
    },
  });
  assert.equal(retried.attempted, 1);
});
