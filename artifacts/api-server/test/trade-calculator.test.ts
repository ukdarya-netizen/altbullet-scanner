import assert from "node:assert/strict";
import test from "node:test";
import {
  calculateCalculatorSummary,
  getCalculatorMonthlyCounts,
  getDubaiMonthKey,
  getDubaiMonthStartUtc,
  getNextDubaiMonthBoundary,
  getPreviousDubaiMonthKey,
} from "../src/lib/trade-calculator.js";

test("uses Asia/Dubai boundaries at 20:00 UTC, including 31-day months", () => {
  const justBefore = new Date("2026-07-31T19:59:59.999Z");
  const boundary = new Date("2026-07-31T20:00:00.000Z");

  assert.equal(getDubaiMonthKey(justBefore), "2026-07");
  assert.equal(getDubaiMonthKey(boundary), "2026-08");
  assert.equal(
    getNextDubaiMonthBoundary(justBefore).toISOString(),
    boundary.toISOString(),
  );
  assert.equal(
    getDubaiMonthStartUtc("2026-08").toISOString(),
    boundary.toISOString(),
  );
});

test("handles February and the exact boundary without local timezone dependence", () => {
  const februaryBoundary = new Date("2026-02-28T20:00:00.000Z");
  assert.equal(getDubaiMonthKey(new Date("2026-02-28T19:59:59Z")), "2026-02");
  assert.equal(getDubaiMonthKey(februaryBoundary), "2026-03");
  assert.equal(getPreviousDubaiMonthKey("2026-03"), "2026-02");
  assert.equal(
    getNextDubaiMonthBoundary(februaryBoundary).toISOString(),
    "2026-03-31T20:00:00.000Z",
  );
});

test("a closed-month summary is deterministic for an idempotent rerun", () => {
  const settings = {
    depositUsdt: 1_000,
    leverage: 10,
    allocationPercent: 10,
    commissionPercent: 0.1,
  };
  const rows = [
    {
      status: "profit",
      pnlPercent: 20,
      closedAt: new Date("2026-07-15T10:00:00.000Z"),
    },
    {
      status: "cancelled",
      pnlPercent: null,
      closedAt: new Date("2026-07-20T10:00:00.000Z"),
    },
  ];

  const first = calculateCalculatorSummary("2026-07", rows, settings);
  const rerun = calculateCalculatorSummary("2026-07", rows, settings);

  assert.deepEqual(rerun, first);
  assert.equal(first.closedTrades, 1);
  assert.equal(first.cancelledSignals, 1);
  assert.equal(first.netPnlUsdt, 199);
});

test("BE stops are counted separately and excluded from calculator PnL and fees", () => {
  const summary = calculateCalculatorSummary(
    "2026-08",
    [
      {
        status: "bu_stop",
        pnlPercent: -45.3,
        closedAt: new Date("2026-08-10T12:00:00.000Z"),
      },
      {
        status: "bu_stop",
        pnlPercent: 8,
        closedAt: new Date("2026-08-11T12:00:00.000Z"),
      },
    ],
    {
      depositUsdt: 1_000,
      leverage: 1,
      allocationPercent: 10,
      commissionPercent: 0,
    },
  );

  assert.equal(summary.grossPnlUsdt, 0);
  assert.equal(summary.netPnlUsdt, 0);
  assert.equal(summary.lossTrades, 0);
  assert.equal(summary.profitTrades, 0);
  assert.equal(summary.buStopTrades, 2);
});

test("calculator reports partial plus BE estimate separately from factual PnL", () => {
  const summary = calculateCalculatorSummary(
    "2026-08",
    [
      {
        status: "bu_stop",
        pnlPercent: -45.3,
        lastMilestone: 8,
        closedAt: new Date("2026-08-10T12:00:00.000Z"),
      },
      {
        status: "bu_stop",
        pnlPercent: 0,
        lastMilestone: null,
        closedAt: new Date("2026-08-11T12:00:00.000Z"),
      },
    ],
    {
      depositUsdt: 1_000,
      leverage: 1,
      allocationPercent: 10,
      commissionPercent: 0,
    },
  );

  assert.equal(summary.netPnlUsdt, 0);
  assert.equal(summary.estimatedBuStopPnlUsdt, 1.6);
  assert.equal(summary.pnlWithEstimatedBuStopUsdt, 1.6);
  assert.equal(summary.estimatedBuStopTrades, 1);
  assert.equal(summary.unavailableBuStopEstimateTrades, 1);
});

test("archive counts satisfy the DB invariant with expired and protected exits", () => {
  const summary = calculateCalculatorSummary(
    "2026-08",
    [
      {
        status: "profit",
        pnlPercent: 12,
        closedAt: new Date("2026-08-05T12:00:00.000Z"),
      },
      {
        status: "stop_loss",
        pnlPercent: -10,
        closedAt: new Date("2026-08-06T12:00:00.000Z"),
      },
      {
        status: "bu_stop",
        pnlPercent: -45.3,
        lastMilestone: 8,
        closedAt: new Date("2026-08-07T12:00:00.000Z"),
      },
      {
        status: "breakeven",
        pnlPercent: 0,
        closedAt: new Date("2026-08-08T12:00:00.000Z"),
      },
      {
        status: "expired",
        pnlPercent: 2.5,
        closedAt: new Date("2026-08-09T12:00:00.000Z"),
      },
      {
        status: "cancelled",
        pnlPercent: null,
        closedAt: new Date("2026-08-10T12:00:00.000Z"),
      },
    ],
    {
      depositUsdt: 1_000,
      leverage: 1,
      allocationPercent: 10,
      commissionPercent: 0,
    },
  );

  const counts = getCalculatorMonthlyCounts(summary);
  assert.deepEqual(counts, {
    closedTrades: 5,
    profitTrades: 1,
    lossTrades: 1,
    buStopTrades: 1,
    breakevenTrades: 1,
    expiredTrades: 1,
    cancelledSignals: 1,
  });
  assert.equal(
    counts.closedTrades,
    counts.profitTrades +
      counts.lossTrades +
      counts.buStopTrades +
      counts.breakevenTrades +
      counts.expiredTrades,
  );
});
