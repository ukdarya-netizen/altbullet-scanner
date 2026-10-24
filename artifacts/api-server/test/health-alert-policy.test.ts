import assert from "node:assert/strict";
import test from "node:test";
import {
  calibratePositionHealthMessage,
  classifyPriceConfirmedHealth,
  classifyPositionHealth,
  decideHealthNotification,
} from "../src/lib/health-alert-policy.js";

const checkAt = new Date("2026-09-28T12:05:00Z");
const closedCandles = [
  { time: Date.parse("2026-09-28T07:30:00Z"), close: "100" },
  { time: Date.parse("2026-09-28T10:30:00Z"), close: "101" },
  { time: Date.parse("2026-09-28T12:00:00Z"), close: "100000" }, // open; never read
];

test("price shadow confirms a hold only from available pre-check references", () => {
  const result = classifyPriceConfirmedHealth({
    state: "hold",
    price: 102,
    at: checkAt,
    positionOpenedAt: new Date("2026-09-28T07:00:00Z"),
    candles: closedCandles,
  });
  assert.equal(result.state, "hold");
  assert.equal(result.reason, "confirmed");
  assert.equal(result.reference1hAt?.toISOString(), "2026-09-28T11:00:00.000Z");
  assert.equal(result.reference4hAt?.toISOString(), "2026-09-28T08:00:00.000Z");
  assert.ok(result.price1hPct! > 0);
});

test("price shadow rejects a bearish exit against a rising market", () => {
  const result = classifyPriceConfirmedHealth({
    state: "exit",
    price: 102,
    at: checkAt,
    positionOpenedAt: new Date("2026-09-28T07:00:00Z"),
    candles: closedCandles,
  });
  assert.equal(result.state, "neutral");
  assert.equal(result.reason, "not_confirmed");
});

test("price shadow confirms bearish follow and exit only with distinct price evidence", () => {
  const follow = classifyPriceConfirmedHealth({
    state: "follow",
    price: 99.5,
    at: checkAt,
    positionOpenedAt: new Date("2026-09-28T07:00:00Z"),
    candles: closedCandles,
  });
  assert.equal(follow.state, "follow");
  const exit = classifyPriceConfirmedHealth({
    state: "exit",
    price: 98.5,
    at: checkAt,
    positionOpenedAt: new Date("2026-09-28T07:00:00Z"),
    candles: closedCandles,
  });
  assert.equal(exit.state, "exit");
});

test("price shadow fails closed on missing or stale pre-check candles", () => {
  const missing = classifyPriceConfirmedHealth({
    state: "exit",
    price: 98,
    at: checkAt,
    positionOpenedAt: new Date("2026-09-28T07:00:00Z"),
    candles: [{ time: Date.parse("2026-09-28T12:00:00Z"), close: "98" }],
  });
  assert.equal(missing.state, "neutral");
  assert.equal(missing.reason, "missing_reference");
  const stale = classifyPriceConfirmedHealth({
    state: "hold",
    price: 102,
    at: checkAt,
    positionOpenedAt: new Date("2026-09-28T07:00:00Z"),
    candles: [{ time: Date.parse("2026-09-28T06:00:00Z"), close: "90" }],
  });
  assert.equal(stale.reason, "missing_reference");
});

test("price shadow never treats a pre-entry rally as confirmation", () => {
  const result = classifyPriceConfirmedHealth({
    state: "hold",
    price: 102,
    at: checkAt,
    positionOpenedAt: new Date("2026-09-28T09:00:00Z"),
    candles: closedCandles,
  });
  assert.equal(result.state, "neutral");
  assert.equal(result.reason, "reference_before_entry");
});

test("emits exit when low turnover and CVD provide two negative categories", () => {
  const result = classifyPositionHealth({
    oiPct: null,
    turnover: 0.05,
    cvdBadCount: 2,
  });

  assert.equal(result.state, "exit");
  assert.equal(result.oiBad, false);
  assert.equal(result.volBad, true);
  assert.equal(result.cvdBad, true);
});

test("exit takes priority over hold when high turnover coexists with two negatives", () => {
  const result = classifyPositionHealth({
    oiPct: -4,
    turnover: 0.12,
    cvdBadCount: 2,
  });

  assert.equal(result.state, "exit");
  assert.equal(result.volGood, true);
});

test("does not emit exit when only one negative category is available", () => {
  const result = classifyPositionHealth({
    oiPct: null,
    turnover: 0.05,
    cvdBadCount: 0,
  });

  assert.equal(result.state, "neutral");
});

test("suppresses tiny negative OI plus one red CVD timeframe", () => {
  const result = classifyPositionHealth({
    oiPct: -0.15,
    turnover: null,
    cvdBadCount: 1,
  });

  assert.equal(result.state, "neutral");
});

test("keeps follow for material OI weakness plus multi-timeframe CVD weakness", () => {
  const result = classifyPositionHealth({
    oiPct: -1.2,
    turnover: null,
    cvdBadCount: 2,
  });

  assert.equal(result.state, "follow");
});

test("suppresses hold for patterns with unconfirmed hold accuracy", () => {
  assert.equal(
    calibratePositionHealthMessage("hold", "bullish_accumulation"),
    "neutral",
  );
  assert.equal(
    calibratePositionHealthMessage("hold", "liquidation_cascade"),
    "neutral",
  );
  assert.equal(
    calibratePositionHealthMessage("hold", "impulse_buy"),
    "neutral",
  );
  assert.equal(
    calibratePositionHealthMessage("hold", "price_led_momentum"),
    "neutral",
  );
});

test("keeps hold for patterns with sufficient preliminary evidence", () => {
  assert.equal(
    calibratePositionHealthMessage("hold", "stealth_breakout"),
    "hold",
  );
  assert.equal(
    calibratePositionHealthMessage("hold", "balanced_grind"),
    "hold",
  );
});

test("never downgrades exit advice", () => {
  assert.equal(
    calibratePositionHealthMessage("exit", "bullish_accumulation"),
    "exit",
  );
});

test("requires two consecutive evaluations before sending", () => {
  const now = new Date("2026-09-05T08:00:00Z");
  const first = decideHealthNotification({
    state: "follow",
    pendingState: null,
    pendingCount: 0,
    sentTypes: [],
    ordinarySentCount: 0,
    lastOrdinaryAt: null,
    now,
  });
  assert.equal(first.shouldSend, false);
  assert.equal(first.reason, "awaiting_confirmation");

  const second = decideHealthNotification({
    state: "follow",
    pendingState: first.nextPendingState,
    pendingCount: first.nextPendingCount,
    sentTypes: [],
    ordinarySentCount: 0,
    lastOrdinaryAt: null,
    now: new Date("2026-09-05T12:00:00Z"),
  });
  assert.equal(second.shouldSend, true);
  assert.deepEqual(second.nextSentTypes, ["follow"]);
});

test("resets confirmation when state becomes neutral", () => {
  const decision = decideHealthNotification({
    state: "neutral",
    pendingState: "hold",
    pendingCount: 1,
    sentTypes: [],
    ordinarySentCount: 0,
    lastOrdinaryAt: null,
    now: new Date("2026-09-05T12:00:00Z"),
  });
  assert.equal(decision.nextPendingState, null);
  assert.equal(decision.nextPendingCount, 0);
});

test("never sends the same user-facing type twice", () => {
  const decision = decideHealthNotification({
    state: "follow",
    pendingState: "follow",
    pendingCount: 1,
    sentTypes: ["follow"],
    ordinarySentCount: 1,
    lastOrdinaryAt: new Date("2026-09-04T00:00:00Z"),
    now: new Date("2026-09-05T12:00:00Z"),
  });
  assert.equal(decision.shouldSend, false);
  assert.equal(decision.reason, "already_sent");
});

test("applies 12h cooldown and two-message limit to ordinary advice", () => {
  const coolingDown = decideHealthNotification({
    state: "hold",
    pendingState: "hold",
    pendingCount: 1,
    sentTypes: ["follow"],
    ordinarySentCount: 1,
    lastOrdinaryAt: new Date("2026-09-05T06:00:00Z"),
    now: new Date("2026-09-05T12:00:00Z"),
  });
  assert.equal(coolingDown.reason, "ordinary_cooldown");

  const capped = decideHealthNotification({
    state: "hold",
    pendingState: "hold",
    pendingCount: 1,
    sentTypes: [],
    ordinarySentCount: 2,
    lastOrdinaryAt: new Date("2026-09-04T00:00:00Z"),
    now: new Date("2026-09-05T12:00:00Z"),
  });
  assert.equal(capped.reason, "ordinary_limit");
});

test("exit bypasses ordinary cooldown and cap but still needs confirmation", () => {
  const decision = decideHealthNotification({
    state: "exit",
    pendingState: "exit",
    pendingCount: 1,
    sentTypes: ["follow", "hold"],
    ordinarySentCount: 2,
    lastOrdinaryAt: new Date("2026-09-05T11:00:00Z"),
    now: new Date("2026-09-05T12:00:00Z"),
  });
  assert.equal(decision.shouldSend, true);
  assert.deepEqual(decision.nextSentTypes, ["follow", "hold", "exit"]);
});
