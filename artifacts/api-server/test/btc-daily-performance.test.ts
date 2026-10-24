import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildBtcDailyPerformance,
  getBtcDailyPerformanceWindow,
  type BtcDailyPerformanceSourceRow,
} from "../src/lib/btc-daily-performance.js";
import { buildBtcDailyMarketContext } from "../src/lib/btc-daily-market-context.js";

const NOW = new Date("2026-10-15T10:00:00.000Z");

function row(
  overrides: Partial<BtcDailyPerformanceSourceRow> = {},
): BtcDailyPerformanceSourceRow {
  return {
    signalId: 1,
    sentimentKey: "neon_support_bounce",
    status: "active",
    detectedAt: "2026-10-14T20:00:00.000Z",
    closedAt: null,
    pnlPercent: null,
    exitPrice: null,
    ...overrides,
  };
}

describe("BTC daily performance", () => {
  it("builds an ascending 30-day Dubai window with exact midnight bounds", () => {
    const window = getBtcDailyPerformanceWindow(
      new Date("2026-10-15T19:59:59.999Z"),
    );
    assert.equal(window.days.length, 30);
    assert.equal(window.days[0], "2026-09-16");
    assert.equal(window.days[29], "2026-10-15");
    assert.equal(window.start.toISOString(), "2026-09-15T20:00:00.000Z");
    assert.equal(window.end.toISOString(), "2026-10-15T20:00:00.000Z");
  });

  it("uses Dubai detected/closed days, including the boundary instant", () => {
    const result = buildBtcDailyPerformance(
      [
        row({ detectedAt: "2026-10-14T19:59:59.999Z" }),
        row({
          detectedAt: "2026-10-14T20:00:00.000Z",
          status: "profit",
          closedAt: "2026-10-15T19:59:59.999Z",
          exitPrice: 110,
          pnlPercent: 7.25,
        }),
        row({
          signalId: null,
          status: "stop_loss",
          closedAt: "2026-10-15T20:00:00.000Z",
          exitPrice: 90,
          pnlPercent: -3,
        }),
      ],
      NOW,
    );
    const priorDay = result.find((item) => item.day === "2026-10-14")!;
    const today = result.find((item) => item.day === "2026-10-15")!;
    assert.equal(priorDay.signals, 1);
    assert.equal(priorDay.closedTrades, 0);
    assert.equal(priorDay.stopLosses, 0);
    assert.equal(priorDay.stopLossRate, null);
    assert.equal(priorDay.netPnlPercent, null);
    assert.equal(today.closedTrades, 1);
    assert.equal(today.completedTrades, 1);
    assert.equal(today.stopLosses, 0);
    assert.equal(today.netPnlPercent, 7.25);
  });

  it("selects linked active-pattern signal cohorts and valid monetary closes", () => {
    const result = buildBtcDailyPerformance(
      [
        row(),
        row({ signalId: null }),
        row({ sentimentKey: "not_an_active_pattern" }),
        row({ sentimentKey: "balanced_grind" }),
        row({ status: "reclassified" }),
        row({
          sentimentKey: "impulse_buy",
          status: "stop_loss",
          detectedAt: "2026-09-11T14:50:30.999Z",
          closedAt: "2026-10-15T08:00:00.000Z",
          pnlPercent: -9,
          exitPrice: 91,
        }),
        row({
          status: "active",
          closedAt: "2026-10-15T08:00:00.000Z",
          pnlPercent: 8,
          exitPrice: 108,
        }),
        row({
          status: "profit",
          closedAt: "2026-10-15T08:00:00.000Z",
          pnlPercent: 4,
          exitPrice: 104,
        }),
        row({
          status: "breakeven",
          closedAt: "2026-10-15T08:00:00.000Z",
          pnlPercent: 0,
          exitPrice: 100,
        }),
        row({
          status: "cancelled",
          closedAt: "2026-10-15T08:00:00.000Z",
          pnlPercent: -2,
          exitPrice: null,
        }),
      ],
      NOW,
    );
    const today = result.find((item) => item.day === "2026-10-15")!;
    assert.equal(today.signals, 5);
    assert.equal(today.closedTrades, 1);
    assert.equal(today.completedTrades, 2);
    assert.equal(today.stopLosses, 0);
    assert.equal(today.stopLossRate, 0);
    assert.equal(today.netPnlPercent, 4);
    assert.equal(result[0]?.signals, 0);
    assert.equal(result[0]?.netPnlPercent, null);
  });

  it("counts exact stop losses by close day against all eligible completed positions", () => {
    const result = buildBtcDailyPerformance(
      [
        row({
          status: "stop_loss",
          closedAt: "2026-10-14T19:59:59.999Z",
          pnlPercent: -10,
        }),
        row({
          status: "stop_loss",
          closedAt: "2026-10-14T20:00:00.000Z",
          pnlPercent: null,
        }),
        row({
          status: "bu_stop",
          closedAt: "2026-10-15T09:00:00.000Z",
          pnlPercent: 5,
        }),
        row({
          status: "breakeven",
          closedAt: "2026-10-15T09:00:00.000Z",
          pnlPercent: 0,
        }),
        row({
          status: "cancelled",
          closedAt: "2026-10-15T09:00:00.000Z",
          pnlPercent: null,
          exitPrice: null,
        }),
      ],
      NOW,
    );
    assert.equal(result.at(-2)?.stopLosses, 1);
    assert.equal(result.at(-2)?.stopLossRate, 100);
    assert.equal(result.at(-1)?.completedTrades, 3);
    assert.equal(result.at(-1)?.stopLosses, 1);
    assert.equal(result.at(-1)?.stopLossRate, 33.3);
    assert.equal(result.at(-1)?.netPnlPercent, null);
  });
});

describe("BTC daily market context", () => {
  it("keeps BTC daily changes when BTC.D has sparse observations", () => {
    const result = buildBtcDailyMarketContext({
      days: ["2026-10-14", "2026-10-15"],
      now: NOW,
      priceObservations: [
        { observedAt: "2026-10-12T20:00:00.000Z", price: 100 },
        { observedAt: "2026-10-13T20:00:00.000Z", price: 110 },
        { observedAt: "2026-10-14T20:00:00.000Z", price: 121 },
      ],
      priceCandles: [],
      dominanceObservations: [
        {
          observedAt: "2026-10-13T21:00:00.000Z",
          value: 58.2,
          source: "coinglass",
        },
      ],
    });

    assert.equal(result[0]?.btcChangePercent, 10);
    assert.equal(result[1]?.btcChangePercent, 10);
    assert.equal(result[0]?.btcDominance, 58.2);
    assert.equal(result[0]?.dominanceChangePoints, null);
    assert.equal(result[1]?.btcDominance, null);
    assert.equal(result[1]?.dominanceChangePoints, null);
  });

  it("uses a closed candle for prior days but never for the current day", () => {
    const result = buildBtcDailyMarketContext({
      days: ["2026-10-14", "2026-10-15"],
      now: NOW,
      priceObservations: [
        { observedAt: "2026-10-12T20:00:00.000Z", price: 100 },
      ],
      priceCandles: [
        { time: Date.parse("2026-10-13T00:00:00.000Z"), close: 110 },
        { time: Date.parse("2026-10-14T00:00:00.000Z"), close: 120 },
      ],
      dominanceObservations: [],
    });

    assert.equal(result[0]?.btcPrice, 110);
    assert.equal(result[0]?.btcChangePercent, 10);
    assert.equal(result[1]?.btcPrice, null);
    assert.equal(result[1]?.btcChangePercent, null);
    assert.equal(result[0]?.btcDominance, null);
  });

  it("preserves the exact 30-day Dubai window and uses a lookback price", () => {
    const window = getBtcDailyPerformanceWindow(NOW);
    const priorDay = new Date(
      Date.parse(`${window.days[0]}T12:00:00.000Z`) - 86_400_000,
    )
      .toISOString()
      .slice(0, 10);
    const priorDayStart = new Date(`${priorDay}T00:00:00.000Z`).toISOString();
    const firstDayStart = new Date(
      `${window.days[0]}T00:00:00.000Z`,
    ).toISOString();
    const result = buildBtcDailyMarketContext({
      days: window.days,
      now: NOW,
      priceObservations: [
        { observedAt: priorDayStart, price: 100 },
        { observedAt: firstDayStart, price: 125 },
      ],
      priceCandles: [],
      dominanceObservations: [],
    });

    assert.equal(result.length, 30);
    assert.deepEqual(
      result.map((point) => point.day),
      window.days,
    );
    assert.equal(result[0]?.btcChangePercent, 25);
  });
});
