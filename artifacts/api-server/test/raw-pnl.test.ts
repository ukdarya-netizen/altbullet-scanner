import assert from "node:assert/strict";
import test from "node:test";
import {
  getEstimatedBuStopPnlPercent,
  getBuStopTakePct,
  getProtectedBuStopExit,
  formatDailyPnlLine,
  isClosedTradeOutcome,
  normalizeClosedPnlPercent,
  summarizeRawPnlPercent,
  summarizePnlWithEstimatedBuStop,
  sumRawNetPnlPercent,
} from "../src/lib/raw-pnl.js";

test("raw PnL includes cancellations but excludes all BE outcomes", () => {
  const result = sumRawNetPnlPercent([
    { status: "profit", pnlPercent: 20 },
    { status: "stop_loss", pnlPercent: -10 },
    { status: "bu_stop", pnlPercent: -2 },
    { status: "bu_stop", pnlPercent: 8, sentimentKey: "impulse_buy" },
    { status: "breakeven", pnlPercent: 7 },
    { status: "cancelled", pnlPercent: -5 },
    { status: "in_run", pnlPercent: 50 },
    { status: "active", pnlPercent: -50 },
  ]);

  assert.equal(result, 5);
});

test("only measurable cancellations are included in closed trade outcomes", () => {
  assert.equal(
    isClosedTradeOutcome({
      status: "cancelled",
      cancelReason: "no_price_30m",
      exitPrice: null,
      pnlPercent: null,
    }),
    false,
  );
  assert.equal(
    isClosedTradeOutcome({
      status: "cancelled",
      cancelReason: "spot_audit_low_vol",
      exitPrice: null,
      pnlPercent: null,
    }),
    false,
  );
  assert.equal(
    isClosedTradeOutcome({
      status: "cancelled",
      cancelReason: "stale_3h",
      exitPrice: 100,
      pnlPercent: -5,
    }),
    true,
  );
  assert.equal(
    isClosedTradeOutcome({
      status: "cancelled",
      cancelReason: "ghost_pump_cleanup",
      exitPrice: 100,
      pnlPercent: 0,
    }),
    true,
  );
  assert.equal(isClosedTradeOutcome({ status: "profit", pnlPercent: 0 }), true);
  assert.equal(
    isClosedTradeOutcome({ status: "active", pnlPercent: null }),
    false,
  );
  assert.equal(
    isClosedTradeOutcome({
      status: "cancelled",
      exitPrice: 100,
      pnlPercent: Number.NaN,
    }),
    false,
  );
  assert.equal(
    isClosedTradeOutcome({
      status: "cancelled",
      exitPrice: 100,
      pnlPercent: Number.POSITIVE_INFINITY,
    }),
    false,
  );
});

test("a price gap after protection cannot undercut the pattern floor", () => {
  assert.equal(normalizeClosedPnlPercent("bu_stop", -45.3), 0);
  assert.equal(normalizeClosedPnlPercent("bu_stop", 2.5), 0);
  assert.equal(normalizeClosedPnlPercent("bu_stop", -45.3, "impulse_buy"), 0);
  assert.equal(normalizeClosedPnlPercent("bu_stop", 0, "impulse_buy"), 0);
  assert.equal(normalizeClosedPnlPercent("bu_stop", 5, "impulse_buy"), 5);
  assert.equal(normalizeClosedPnlPercent("bu_stop", null), 0);
});

test("protected BE exit is always recorded at entry with zero remaining PnL", () => {
  assert.deepEqual(getProtectedBuStopExit(1.2345), {
    exitPrice: 1.2345,
    pnlPercent: 0,
  });
});

test("a positive protected stop records its factual locked profit", () => {
  assert.deepEqual(getProtectedBuStopExit(100, 5), {
    exitPrice: 105,
    pnlPercent: 5,
  });
});

test("BE stop exposes a recorded target without inventing legacy data", () => {
  assert.equal(getBuStopTakePct("bu_stop", 8), 8);
  assert.equal(getBuStopTakePct("bu_stop", "10"), 10);
  assert.equal(getBuStopTakePct("bu_stop", null), null);
  assert.equal(getBuStopTakePct("bu_stop", 0), null);
  assert.equal(getBuStopTakePct("profit", 10), null);
});

test("BE stop estimate uses 20% at the recorded target and 80% at BE", () => {
  assert.equal(getEstimatedBuStopPnlPercent("bu_stop", 5), 1);
  assert.equal(getEstimatedBuStopPnlPercent("bu_stop", 8), 1.6);
  assert.equal(getEstimatedBuStopPnlPercent("bu_stop", 10), 2);
  assert.equal(getEstimatedBuStopPnlPercent("bu_stop", null), null);
  assert.equal(getEstimatedBuStopPnlPercent("profit", 10), null);
});

test("estimated BE PnL stays separate from factual raw PnL", () => {
  const summary = summarizePnlWithEstimatedBuStop([
    { status: "profit", pnlPercent: 12 },
    { status: "stop_loss", pnlPercent: -10 },
    { status: "bu_stop", pnlPercent: -45, lastMilestone: 8 },
    { status: "bu_stop", pnlPercent: 20, lastMilestone: null },
  ]);

  assert.equal(summary.netPercent, 2);
  assert.equal(summary.estimatedBuStopPnlPercent, 1.6);
  assert.equal(summary.pnlWithEstimatedBuStopPercent, 3.6);
  assert.equal(summary.estimatedBuStopTrades, 1);
  assert.equal(summary.unavailableBuStopEstimateTrades, 1);
});

test("raw PnL ignores closed rows without a recorded PnL", () => {
  const result = sumRawNetPnlPercent([
    { status: "profit", pnlPercent: 10 },
    { status: "cancelled", pnlPercent: null },
  ]);

  assert.equal(result, 10);
});

test("raw PnL summary exposes profit minus loss for weekly reporting", () => {
  assert.deepEqual(
    summarizeRawPnlPercent([
      { status: "profit", pnlPercent: 20 },
      { status: "stop_loss", pnlPercent: -10 },
      { status: "cancelled", pnlPercent: -5 },
      { status: "bu_stop", pnlPercent: -2 },
      { status: "bu_stop", pnlPercent: 8, sentimentKey: "impulse_buy" },
      { status: "breakeven", pnlPercent: 7 },
      { status: "active", pnlPercent: 50 },
      { status: "cancelled", pnlPercent: null },
    ]),
    {
      profitPercent: 20,
      lossPercent: 15,
      netPercent: 5,
      rowsWithPnl: 3,
    },
  );
});

test("daily PnL line reports the normalized net percentage", () => {
  assert.equal(
    formatDailyPnlLine([
      { status: "profit", pnlPercent: 8 },
      { status: "stop_loss", pnlPercent: -3.5 },
      { status: "bu_stop", pnlPercent: -20 },
      { status: "cancelled", pnlPercent: null },
    ]),
    "💰 <b>PnL за день: +4.5%</b>",
  );
});
