import assert from "node:assert/strict";
import { test } from "node:test";
import {
  APPROXIMATION,
  detectLuxAlgoDemandZones,
  replayLcWaitingOrderBlocks,
  type LcWaitingObCandle,
} from "../src/lib/lc-waiting-ob.js";

function bullishBreakFixture(): LcWaitingObCandle[] {
  const candles: LcWaitingObCandle[] = [
    { time: 0, open: 5, high: 7, low: 3, close: 5 },
  ];
  const add = (
    index: number,
    open: number,
    high: number,
    low: number,
    close: number,
  ) => candles.push({ time: index * 60_000, open, high, low, close });

  // Default swing length (50) establishes a distinct swing pivot before
  // the internal pivot is confirmed and broken.
  for (let index = 1; index <= 50; index += 1) {
    add(index, 7, 8, 6, 7);
  }
  add(51, 8, 9, 6, 8);
  for (let index = 52; index <= 101; index += 1) {
    add(index, 7, 8, 6, 7);
  }
  add(102, 6, 7, 4, 6);
  for (let index = 103; index <= 107; index += 1) {
    add(index, 7, 8, 6, 7);
  }
  add(108, 9, 10, 6, 9);
  for (let index = 109; index <= 113; index += 1) {
    add(index, 7, 8, 6, 8);
  }
  add(114, 8, 9, 6, 9);
  add(115, 9, 11, 6, 10.5);
  add(116, 10, 11, 6, 10.5);
  return candles;
}

test("internal bullish OB appears only after closed-bar confirmation", () => {
  const candles = bullishBreakFixture();
  const beforeConfirmation = replayLcWaitingOrderBlocks(
    candles.slice(0, 115),
    10.5,
  );
  assert.deepEqual(beforeConfirmation.orderBlocks, []);
  assert.equal(beforeConfirmation.nearestBullishDemandZone, null);

  const confirmed = replayLcWaitingOrderBlocks(candles, 10.5);
  assert.deepEqual(confirmed.orderBlocks, [
    {
      high: 10,
      low: 6,
      kind: "internal",
      createdAt: 108 * 60_000,
      detectedAt: 115 * 60_000,
      bias: "bullish",
    },
  ]);
  assert.equal(confirmed.nearestBullishDemandZone?.high, 10);
  assert.equal(confirmed.nearestBullishDemandZone?.detectedAt, 115 * 60_000);
  assert.match(APPROXIMATION, /Cumulative Mean Range/i);

  const backendResult = detectLuxAlgoDemandZones(candles, 10.5);
  assert.deepEqual(backendResult.zones, confirmed.orderBlocks);
  assert.deepEqual(backendResult.nearest, confirmed.nearestBullishDemandZone);
});

test("bullish order blocks use strict High/Low mitigation", () => {
  const candles = bullishBreakFixture();
  candles.push({
    time: 117 * 60_000,
    open: 6,
    high: 7,
    low: 6,
    close: 6.5,
  });
  assert.equal(replayLcWaitingOrderBlocks(candles, 10.5).orderBlocks.length, 1);

  candles.push({
    time: 118 * 60_000,
    open: 6,
    high: 6,
    low: 5,
    close: 5.5,
  });
  assert.deepEqual(replayLcWaitingOrderBlocks(candles, 10.5).orderBlocks, []);
});

test("rejects unordered candle times and invalid entry prices", () => {
  const candles = bullishBreakFixture();
  assert.throws(
    () => replayLcWaitingOrderBlocks([candles[1]!, candles[0]!], 10),
    /strictly chronological/,
  );
  assert.throws(() => replayLcWaitingOrderBlocks([], 0), /positive finite/);
});
