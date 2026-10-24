import assert from "node:assert/strict";
import test from "node:test";
import {
  isDirectionAwareProfitLockHit,
  isProfitLockActivated,
  PROFIT_LOCK_ACTIVATION_PCT,
  PROFIT_LOCKED_PNL_PCT,
  resolveProfitLockObservationState,
  resolveDirectionAwareProfitLockLevel,
  buildProfitLockEvAnalysis,
} from "../src/lib/profit-lock-shadow.js";

test("profit lock activates at +10% and fixes +5% from long entry", () => {
  assert.equal(isProfitLockActivated(9.99), false);
  assert.equal(isProfitLockActivated(PROFIT_LOCK_ACTIVATION_PCT), true);

  const lockedStop = resolveDirectionAwareProfitLockLevel(
    100,
    PROFIT_LOCKED_PNL_PCT,
    false,
  );
  assert.equal(lockedStop, 105);
  assert.equal(isDirectionAwareProfitLockHit(105.01, lockedStop, false), false);
  assert.equal(isDirectionAwareProfitLockHit(105, lockedStop, false), true);
});

test("profit lock preserves its +5% meaning for short positions", () => {
  const lockedStop = resolveDirectionAwareProfitLockLevel(
    100,
    PROFIT_LOCKED_PNL_PCT,
    true,
  );
  assert.equal(lockedStop, 95);
  assert.equal(isDirectionAwareProfitLockHit(94.99, lockedStop, true), false);
  assert.equal(isDirectionAwareProfitLockHit(95, lockedStop, true), true);
});

test("short lifecycle retains the activation peak through a +5% rebound", () => {
  const activation = resolveProfitLockObservationState({
    entryPrice: 100,
    currentPrice: 90,
    isShort: true,
    trackedPeakPrice: 100,
  });
  assert.equal(activation.activated, true);
  assert.equal(activation.virtualHit, false);
  assert.equal(activation.peakPrice, 90);

  const extended = resolveProfitLockObservationState({
    entryPrice: 100,
    currentPrice: 85,
    isShort: true,
    trackedPeakPrice: 100,
    activatedPeakPrice: activation.peakPrice,
  });
  assert.equal(extended.peakPrice, 85);
  assert.equal(extended.peakPnlPct, 15);

  // Legacy tracked peak remains 100 for a short, but the durable shadow peak
  // keeps both the +5% hit and the higher +15% peak observable at 95.
  const rebound = resolveProfitLockObservationState({
    entryPrice: 100,
    currentPrice: 95,
    isShort: true,
    trackedPeakPrice: 100,
    activatedPeakPrice: extended.peakPrice,
  });
  assert.equal(rebound.activated, true);
  assert.equal(rebound.virtualHit, true);
  assert.equal(rebound.peakPrice, 85);
  assert.equal(rebound.peakPnlPct, 15);
  assert.equal(rebound.currentPnlPct, 5);
});

function evEvent(
  signalId: number,
  sentimentKey: string,
  eventType: string,
  hour: number,
  actualPnlPct: number | null = null,
) {
  return {
    signalId,
    sentimentKey,
    eventType,
    observedAt: new Date(Date.UTC(2026, 7, 1, hour)),
    currentPnlPct: eventType === "hit" ? 5 : null,
    peakPnlPct: 10,
    actualPnlPct,
  };
}

test("EV counterfactual uses +5 only for a hit before close", () => {
  const result = buildProfitLockEvAnalysis(
    [
      evEvent(1, "balanced_grind", "activated", 0),
      evEvent(1, "balanced_grind", "hit", 1),
      evEvent(1, "balanced_grind", "close", 2, -3),
      evEvent(2, "balanced_grind", "activated", 0),
      evEvent(2, "balanced_grind", "close", 2, 18),
      evEvent(3, "balanced_grind", "activated", 0),
      evEvent(3, "balanced_grind", "close", 1, 20),
      evEvent(3, "balanced_grind", "hit", 2),
    ],
    ["balanced_grind"],
  );

  assert.equal(result.summary.activated, 3);
  assert.equal(result.summary.closed, 3);
  assert.equal(result.summary.completedVirtualHits, 1);
  assert.equal(result.summary.totalActualPnl, 35);
  assert.equal(result.summary.totalCandidatePnl, 43);
  assert.equal(result.summary.totalDeltaPp, 8);
  assert.equal(result.summary.helped, 1);
  assert.equal(result.summary.hurt, 0);
  assert.equal(result.summary.unchanged, 2);
});

test("EV counterfactual separates open rows, coverage, upside and legacy", () => {
  const result = buildProfitLockEvAnalysis(
    [
      evEvent(1, "price_led_momentum", "activated", 0),
      evEvent(1, "price_led_momentum", "hit", 1),
      evEvent(1, "price_led_momentum", "72h", 2),
      evEvent(1, "price_led_momentum", "close", 3, 12),
      evEvent(2, "price_led_momentum", "activated", 0),
      evEvent(2, "price_led_momentum", "hit", 1),
      evEvent(3, "unknown", "activated", 0),
      evEvent(3, "unknown", "hit", 1),
      evEvent(3, "unknown", "close", 2, -20),
    ],
    ["price_led_momentum"],
  );

  assert.equal(result.summary.activated, 2);
  assert.equal(result.summary.closed, 1);
  assert.equal(result.summary.open, 1);
  assert.equal(result.summary.virtualHits, 2);
  assert.equal(result.summary.completedVirtualHits, 1);
  assert.equal(result.summary.trajectoryCoveragePct, 100);
  assert.equal(result.summary.hurt, 1);
  assert.equal(result.summary.lostUpsideCount, 1);
  assert.equal(result.summary.totalLostUpsidePp, 7);
  assert.equal(result.summary.recommendation, "insufficient_sample");
});

test("EV recommendation remains blocked below 20 completed hits", () => {
  const events = Array.from({ length: 20 }, (_, index) => {
    const signalId = index + 1;
    return [
      evEvent(signalId, "stealth_breakout", "activated", 0),
      evEvent(signalId, "stealth_breakout", "hit", 1),
      evEvent(signalId, "stealth_breakout", "close", 2, -2),
    ];
  }).flat();

  const sufficient = buildProfitLockEvAnalysis(events, ["stealth_breakout"]);
  const insufficient = buildProfitLockEvAnalysis(events.slice(0, -3), [
    "stealth_breakout",
  ]);

  assert.equal(sufficient.summary.sufficient, true);
  assert.equal(sufficient.summary.recommendation, "candidate_improves");
  assert.equal(insufficient.summary.sufficient, false);
  assert.equal(insufficient.summary.recommendation, "insufficient_sample");
});
