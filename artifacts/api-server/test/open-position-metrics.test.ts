import assert from "node:assert/strict";
import test from "node:test";
import {
  calculateLivePnl,
  OpenPositionMetricsCache,
  resolveCurrentMetric,
  type OpenPositionLiveMetrics,
  type PositionMetricProvider,
} from "../src/lib/open-position-metrics.js";
import type { TrackedSignal } from "@workspace/db";
import { formatOpenPositionLines } from "../src/lib/watcher-formatters.js";

function metrics(
  fetchedAt: number,
  oi30m: number | null,
): OpenPositionLiveMetrics {
  return {
    fetchedAt,
    oi30m,
    oi1h: null,
    oi4h: null,
    oi24h: null,
    cvd15m: null,
    cvd30m: null,
    cvd1h: null,
    cvd4h: null,
    futuresTakerNetBuy: null,
    spotTakerNetBuy: null,
    spotTakerDominance: null,
    snf1h: null,
    snf4h: null,
    snf24h: null,
    whaleIndex: null,
    obRatio: null,
  };
}

test("current metric prefers position-scoped live data over scanner fallback", () => {
  assert.deepEqual(resolveCurrentMetric(4.2, 1.1, -0.5), {
    value: 4.2,
    source: "live",
  });
});

test("current metric falls back only to scanner or persisted prescan, never entry", () => {
  assert.deepEqual(resolveCurrentMetric(null, null, -1.5), {
    value: -1.5,
    source: "fallback",
  });
  assert.deepEqual(resolveCurrentMetric(null, null, null), {
    value: null,
    source: "unavailable",
  });
});

test("short P&L increases when the market price falls", () => {
  assert.equal(calculateLivePnl(100, 90, true), 10);
  assert.equal(calculateLivePnl(100, 110, true), -10);
  assert.equal(calculateLivePnl(100, 110, false), 10);
});

test("position metric cache shares an in-flight batch across dashboard polls", async () => {
  let now = 1_000;
  let calls = 0;
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const provider: PositionMetricProvider = {
    async refresh(symbols) {
      calls++;
      await pending;
      return new Map(symbols.map((symbol) => [symbol, metrics(now, 2.5)]));
    },
  };
  const cache = new OpenPositionMetricsCache(provider, 60_000, () => now);
  const first = cache.get(["AAA-USDT", "BBB-USDT"], new Map());
  const second = cache.get(["AAA-USDT", "BBB-USDT"], new Map());

  release();
  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.equal(calls, 1);
  assert.equal(firstResult.get("AAA-USDT")?.oi30m, 2.5);
  assert.equal(secondResult.get("BBB-USDT")?.oi30m, 2.5);

  now += 30_000;
  await cache.get(["AAA-USDT", "BBB-USDT"], new Map());
  assert.equal(calls, 1);
});

test("a stale symbol is served immediately while another batch refreshes", async () => {
  let now = 100_000;
  let calls = 0;
  let releaseFirst!: () => void;
  const firstBatch = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const provider: PositionMetricProvider = {
    async refresh(symbols) {
      calls++;
      if (calls === 2) await firstBatch;
      return new Map(symbols.map((symbol) => [symbol, metrics(now, calls)]));
    },
  };
  const cache = new OpenPositionMetricsCache(provider, 1_000, () => now);
  // Seed B with an entry that has become stale while A begins its own refresh.
  await cache.get(["BBB-USDT"], new Map());
  now += 1_001;

  const refreshA = cache.get(["AAA-USDT"], new Map());
  const pollB = cache.get(["BBB-USDT"], new Map());
  const pollC = cache.get(["BBB-USDT"], new Map());
  releaseFirst();

  const [b, c] = await Promise.all([pollB, pollC]);
  // Stale values are served without waiting for the in-flight batch.
  assert.equal(b.get("BBB-USDT")?.oi30m, 1);
  assert.equal(c.get("BBB-USDT")?.oi30m, 1);
  releaseFirst();
  await refreshA;
  await cache.get(["BBB-USDT"], new Map());
  await new Promise((resolve) => setImmediate(resolve));
  const fresh = await cache.get(["BBB-USDT"], new Map());
  assert.equal(fresh.get("BBB-USDT")?.oi30m, 3);
});

function reportPosition(): TrackedSignal {
  return {
    symbol: "ZEC-USDT",
    sentimentKey: "balanced_grind",
    isShort: false,
    entryPrice: 100,
    peakPrice: 120,
    trailingStopLevel: null,
    status: "in_run",
    detectedAt: new Date("2026-08-24T08:00:00.000Z"),
  } as TrackedSignal;
}

test("Telegram open-position rows include both the current price and peak", () => {
  const lines = formatOpenPositionLines(
    [reportPosition()],
    new Map([["ZEC-USDT", 110]]),
  );
  const positionLine = lines.find((line) => line.includes("ZEC"));

  assert.match(positionLine ?? "", /Сейчас: \$110/);
  assert.match(positionLine ?? "", /Пик: \+20\.0%/);
});

test("Telegram open-position rows state when the current price is unavailable", () => {
  const lines = formatOpenPositionLines([reportPosition()], new Map());
  const positionLine = lines.find((line) => line.includes("ZEC"));

  assert.match(positionLine ?? "", /Сейчас: недоступна/);
  assert.match(positionLine ?? "", /Пик: \+20\.0%/);
});
