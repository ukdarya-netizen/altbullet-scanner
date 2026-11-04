import test from "node:test";
import assert from "node:assert/strict";
import { evaluatePosition, initialPosition } from "../engine.mjs";

const ordinaryRules = {
  priceMoveBasis: "unleveraged_percent_from_actual_entry_fill",
  rMultipleTargets: false,
  noFixedTakeProfit: true,
  partialProfitAdvice: {
    minFraction: 0.2,
    maxFraction: 0.25,
    execution: "advice_only_not_automated",
  },
  firstTargetPct: 10,
  firstTargetAction: "milestone_not_full_close",
  breakevenAtPct: 5,
  breakevenStopGainPct: 0,
  breakevenIncludesFees: false,
  protectedProfitAtPct: 10,
  protectedProfitPct: 5,
  trailingActivationPct: 15,
  trailingGapPercentagePoints: 10,
  trailingGapBasis: "percentage_points_of_entry_pnl",
  trailingStopNeverDecreases: true,
  trailingExitAction: "close_remaining_position",
  maxWatchDays: 4,
  expiryExitPrice: "observed_market_quote",
};

const btcRules = {
  ...ordinaryRules,
  firstTargetPct: 1,
  breakevenAtPct: 1,
  protectedProfitAtPct: 0,
  protectedProfitPct: 0,
  trailingActivationPct: 2,
  trailingGapPercentagePoints: 1,
  progressMilestoneIntervalPct: 1,
};

const impulseRules = {
  ...ordinaryRules,
  runner: {
    policyVersion: "impulse_runner_v1",
    coreFraction: 0.8,
    runnerFraction: 0.19999999999999996,
    coreExit: "standard_trailing_stop",
    afterCoreEmergencyStop: "original_entry_breakeven",
    trailingActivationPct: 30,
    trailingGapPercentagePoints: 30,
    trailingGapBasis: "percentage_points_of_entry_pnl",
    maxAgeHoursFromOriginalEntry: 120,
    expiryExitPrice: "observed_market_quote",
  },
};

function makeSignal({
  patternId = "liquidation_cascade",
  symbol = "XRPUSDT",
  rules = ordinaryRules,
} = {}) {
  return {
    sourceSignalId: "cab-signal-123",
    confirmationStatus: "confirmed",
    patternId,
    patternStatus: "approved",
    symbol,
    signalAt: "2026-09-25T00:00:00.000Z",
    stopLoss: "90",
    payload: { exitRules: rules },
  };
}

function openPosition(options = {}) {
  return initialPosition(makeSignal(options), {
    price: 100,
    quantity: 10,
    at: "2026-09-25T00:00:00.000Z",
    mode: "paper",
  });
}

test("ordinary patterns: +5% breakeven, +10% milestone/floor, no automatic partial close", () => {
  for (const patternId of [
    "neon_support_bounce",
    "liquidation_cascade",
    "price_led_momentum",
  ]) {
    const position = openPosition({ patternId });
    const { next, actions } = evaluatePosition(position, {
      price: 110,
      at: "2026-09-25T01:00:00.000Z",
    });

    assert.equal(next.status, "open");
    assert.equal(next.remainingQty, 10);
    assert.equal(next.milestones.firstTargetReached, true);
    assert.equal(next.stopPrice, 105);
    assert.deepEqual(actions.map((action) => action.type), ["raise_stop"]);
    assert.equal(actions[0].reason, "protected_profit_floor");
  }
});

test("BG is rejected for new entries while a persisted BG position still closes", () => {
  assert.throws(
    () => openPosition({ patternId: "balanced_grind" }),
    /Unsupported approved pattern/,
  );

  // Persisted snapshots already contain their rules. Removing BG from ingress
  // must not prevent the worker from managing and closing them.
  const existing = openPosition();
  existing.patternId = "balanced_grind";
  const { next, actions } = evaluatePosition(existing, {
    price: 89,
    at: "2026-09-25T01:00:00.000Z",
  });
  assert.equal(next.status, "closed");
  assert.equal(next.remainingQty, 0);
  assert.deepEqual(actions, [
    { type: "close_all", quantity: 10, price: 89, reason: "protective_stop" },
  ]);
});

test("Neon Support is approved by the engine for new positions", () => {
  const position = openPosition({ patternId: "neon_support_bounce" });
  assert.equal(position.patternId, "neon_support_bounce");
  assert.equal(position.status, "open");
});

test("ordinary trailing stop trails by percentage points and never decreases", () => {
  const position = openPosition();
  const first = evaluatePosition(position, {
    price: 124,
    at: "2026-09-25T01:00:00.000Z",
  });
  assert.ok(Math.abs(first.next.stopPrice - 114) < 1e-10);
  assert.equal(first.actions[0].reason, "percentage_point_trailing_stop");

  const pullback = evaluatePosition(first.next, {
    price: 118,
    at: "2026-09-25T02:00:00.000Z",
  });
  assert.ok(Math.abs(pullback.next.stopPrice - 114) < 1e-10);
  assert.deepEqual(pullback.actions, []);

  const stopped = evaluatePosition(pullback.next, {
    price: 113,
    at: "2026-09-25T03:00:00.000Z",
  });
  assert.equal(stopped.next.status, "closed");
  assert.equal(stopped.next.remainingQty, 0);
  assert.deepEqual(stopped.actions, [
    { type: "close_all", quantity: 10, price: 113, reason: "protective_stop" },
  ]);
});

test("existing stop is checked before a new quote can raise the peak", () => {
  const position = openPosition();
  position.stopPrice = 105;
  const result = evaluatePosition(position, {
    price: 104,
    at: "2026-09-25T01:00:00.000Z",
  });
  assert.equal(result.next.status, "closed");
  assert.equal(result.next.peakPct, 0);
  assert.equal(result.actions[0].reason, "protective_stop");
});

test("BTC has +1% breakeven and +2% peak-minus-one-point trailing", () => {
  const position = openPosition({
    patternId: "liquidation_cascade",
    symbol: "BTCUSDT",
    rules: btcRules,
  });

  const be = evaluatePosition(position, {
    price: 101,
    at: "2026-09-25T00:01:00.000Z",
  });
  assert.equal(be.next.stopPrice, 100);
  assert.equal(be.actions[0].reason, "breakeven_stop");

  const trail = evaluatePosition(be.next, {
    price: 102,
    at: "2026-09-25T00:02:00.000Z",
  });
  assert.equal(trail.next.stopPrice, 101);
  assert.equal(trail.actions[0].reason, "percentage_point_trailing_stop");

  const pullback = evaluatePosition(trail.next, {
    price: 101.5,
    at: "2026-09-25T00:03:00.000Z",
  });
  assert.equal(pullback.next.stopPrice, 101);
});

test("Impulse Buy splits 80/20 and retains runner after core exit", () => {
  const position = openPosition({
    patternId: "impulse_buy",
    symbol: "WAXPUSDT",
    rules: impulseRules,
  });
  position.stopPrice = 105;
  assert.equal(position.coreQty, 8);
  assert.ok(Math.abs(position.runnerQty - 2) < 1e-10);
  assert.equal(position.runnerOpen, false);

  const coreClosed = evaluatePosition(position, {
    price: 104,
    at: "2026-09-25T01:00:00.000Z",
  });
  assert.equal(coreClosed.next.status, "open");
  assert.equal(coreClosed.next.coreOpen, false);
  assert.equal(coreClosed.next.runnerOpen, true);
  assert.ok(Math.abs(coreClosed.next.remainingQty - 2) < 1e-10);
  assert.equal(coreClosed.next.runnerStopPrice, 100);
  assert.equal(coreClosed.actions[0].type, "close_core");
  assert.equal(coreClosed.actions[1].type, "raise_stop");
  assert.equal(coreClosed.next.status, "open");
});

test("Impulse runner trails by 30 percentage points after +30% peak", () => {
  const initial = openPosition({
    patternId: "impulse_buy",
    symbol: "WAXPUSDT",
    rules: impulseRules,
  });
  const coreClosed = evaluatePosition(initial, {
    price: 100,
    at: "2026-09-25T01:00:00.000Z",
  });
  const openRunner = {
    ...coreClosed.next,
    status: "open",
    coreOpen: false,
    runnerOpen: true,
    remainingQty: initial.runnerQty,
    runnerStopPrice: 100,
    peakPct: 30,
    runnerPeakPct: 30,
  };
  const trail = evaluatePosition(openRunner, {
    price: 140,
    at: "2026-09-25T02:00:00.000Z",
  });
  assert.ok(Math.abs(trail.next.runnerStopPrice - 110) < 1e-10);
  assert.equal(trail.actions[0].reason, "runner_percentage_point_trailing_stop");

  const pullback = evaluatePosition(trail.next, {
    price: 120,
    at: "2026-09-25T03:00:00.000Z",
  });
  assert.equal(pullback.next.runnerStopPrice, trail.next.runnerStopPrice);
  assert.deepEqual(pullback.actions, []);
});

test("four-day expiry closes at observed market quote", () => {
  const position = openPosition();
  const result = evaluatePosition(position, {
    price: 97,
    at: "2026-09-29T00:00:00.000Z",
  });
  assert.equal(result.next.status, "closed");
  assert.deepEqual(result.actions, [
    { type: "close_all", quantity: 10, price: 97, reason: "max_watch_expiry" },
  ]);
});

test("runner survives the four-day core window and expires at 120 hours", () => {
  const position = openPosition({
    patternId: "impulse_buy",
    symbol: "WAXPUSDT",
    rules: impulseRules,
  });
  position.coreOpen = false;
  position.runnerOpen = true;
  position.remainingQty = position.runnerQty;
  position.runnerStopPrice = 100;

  const result = evaluatePosition(position, {
    price: 105,
    at: "2026-09-29T20:00:00.000Z",
  });
  assert.equal(result.next.status, "open");
  assert.deepEqual(result.actions, []);

  const expired = evaluatePosition(position, {
    price: 105,
    at: "2026-09-30T00:00:00.000Z",
  });
  assert.equal(expired.next.status, "closed");
  assert.equal(expired.actions[0].reason, "runner_max_age_expiry");
});

test("initialPosition rejects unsupported rule sets and invalid stop prices", () => {
  assert.throws(
    () => initialPosition(makeSignal({ patternId: "unknown" }), {
      price: 100,
      quantity: 10,
      at: "2026-09-25T00:00:00.000Z",
      mode: "paper",
    }),
    /Unsupported approved pattern/,
  );

  const invalidStop = makeSignal();
  invalidStop.stopLoss = "101";
  assert.throws(
    () => initialPosition(invalidStop, {
      price: 100,
      quantity: 10,
      at: "2026-09-25T00:00:00.000Z",
      mode: "paper",
    }),
    /below the actual entry fill/,
  );
});