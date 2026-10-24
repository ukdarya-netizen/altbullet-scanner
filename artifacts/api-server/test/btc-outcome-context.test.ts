import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildBtcEntryOutcomeContext,
  buildDailyMarketContext,
} from "../src/lib/btc-outcome-context.js";
import type { BtcDailyPerformanceSourceRow } from "../src/lib/btc-daily-performance.js";

const NOW = new Date("2026-10-15T10:00:00.000Z");

function trade(
  overrides: Partial<BtcDailyPerformanceSourceRow>,
): BtcDailyPerformanceSourceRow {
  return {
    signalId: 1,
    sentimentKey: "price_led_momentum",
    status: "stop_loss",
    detectedAt: "2026-10-13T12:00:00.000Z",
    closedAt: "2026-10-15T07:00:00.000Z",
    pnlPercent: -10,
    exitPrice: 90,
    entryBtc24h: -2,
    entryBtcDominance: 58,
    ...overrides,
  };
}

describe("BTC outcome context", () => {
  it("uses Dubai-day observations without filling missing days", () => {
    const days = buildDailyMarketContext(
      [
        { observedAt: "2026-10-13T19:59:00Z", value: 90 },
        { observedAt: "2026-10-13T20:00:00Z", value: 100 },
        { observedAt: "2026-10-14T23:00:00Z", value: 110 },
        { observedAt: "2026-10-15T12:00:00Z", value: 999 },
      ],
      [
        { observedAt: "2026-10-14T01:00:00Z", value: 58 },
        { observedAt: "2026-10-15T02:00:00Z", value: 59 },
      ],
      NOW,
    );
    assert.equal(days.find((item) => item.day === "2026-10-14")?.btcPrice, 100);
    assert.equal(days.find((item) => item.day === "2026-10-15")?.btcPrice, 110);
    assert.equal(
      days.find((item) => item.day === "2026-10-15")?.btcChangePercent,
      10,
    );
    assert.equal(
      days.find((item) => item.day === "2026-10-15")?.dominanceChangePoints,
      1,
    );
    assert.equal(
      days.find((item) => item.day === "2026-10-14")?.dominanceChangePoints,
      null,
    );
    assert.equal(
      days.find((item) => item.day === "2026-10-12")?.btcPrice,
      null,
    );
  });

  it("compares only completed linked entries with both immutable snapshots", () => {
    const result = buildBtcEntryOutcomeContext(
      [
        trade({ entryBtc24h: -2, entryBtcDominance: 58 }),
        trade({
          status: "profit",
          pnlPercent: 6,
          entryBtc24h: 2,
          entryBtcDominance: 60,
        }),
        trade({
          status: "breakeven",
          pnlPercent: 0,
          entryBtc24h: -1,
          entryBtcDominance: 60,
        }),
        trade({ entryBtcDominance: null }),
        trade({ signalId: null }),
        trade({ status: "active" }),
        trade({ detectedAt: "2026-09-01T00:00:00Z" }),
        trade({
          sentimentKey: "impulse_buy",
          detectedAt: "2026-09-11T14:50:30Z",
        }),
      ],
      NOW,
    );
    assert.equal(result.eligibleClosedTrades, 4);
    assert.equal(result.withBothSnapshots, 3);
    assert.equal(result.missingSnapshots, 1);
    assert.equal(result.medianDominance, 60);
    const fallingLow = result.groups.find(
      (group) =>
        group.btcDirection === "falling" &&
        group.dominanceLevel === "below_median",
    )!;
    assert.equal(fallingLow.trades, 1);
    assert.equal(fallingLow.stopLossRate, 100);
    assert.equal(fallingLow.averagePnlPercent, -10);
    const fallingHigh = result.groups.find(
      (group) =>
        group.btcDirection === "falling" &&
        group.dominanceLevel === "at_or_above_median",
    )!;
    assert.equal(fallingHigh.trades, 1);
    assert.equal(fallingHigh.stopLossRate, 0);
    assert.equal(fallingHigh.averagePnlPercent, null);
  });
});
