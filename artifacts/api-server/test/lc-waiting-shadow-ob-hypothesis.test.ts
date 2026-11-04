import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyObProximity,
  classifyMissedStrongWinner,
  evaluateObFollowup,
  isObHypothesisTerminal,
  obPolicyDecision,
  obPolicyDecisionWithAvailability,
  resolveFrozenOb,
  summarizeObCohorts,
} from "../src/lib/lc-ob-hypothesis.js";

test("OB proximity uses inside, 1%, 2%, and farther bands", () => {
  assert.equal(classifyObProximity(0.5), "inside_or_within_1pct");
  assert.equal(classifyObProximity(1), "inside_or_within_1pct");
  assert.equal(classifyObProximity(1.01), "between_1_2pct");
  assert.equal(classifyObProximity(2), "between_1_2pct");
  assert.equal(classifyObProximity(2.01), "beyond_2pct");
  assert.equal(classifyObProximity(30, true), "inside_or_within_1pct");
  assert.equal(classifyObProximity(null), "unavailable");
});

test("1% and 2% policies freeze enter, wait, and no-target decisions", () => {
  assert.equal(obPolicyDecision(0.8, 1, true), "enter_now");
  assert.equal(obPolicyDecision(1.5, 1, true), "wait");
  assert.equal(obPolicyDecision(1.5, 2, true), "enter_now");
  assert.equal(obPolicyDecision(10, 2, true), "wait");
  assert.equal(obPolicyDecision(10.01, 2, true), "no_target");
  assert.equal(obPolicyDecision(null, 2, false), "no_target");
  assert.equal(obPolicyDecision(-0.2, 1, true, true), "enter_now");
});

test("a missing timeframe only permits a definitively near frozen zone", () => {
  const candidate = {
    high: 98.5,
    low: 97,
    timeframe: "1h" as const,
    createdAt: 1,
    detectedAt: 2,
  };
  const partialSources = resolveFrozenOb(100, candidate, false);
  assert.equal(partialSources.status, "available");
  assert.equal(partialSources.proximity, "unavailable");
  assert.equal(
    obPolicyDecisionWithAvailability(1.5, 1, true, false),
    "unavailable",
  );
  assert.equal(
    obPolicyDecisionWithAvailability(1.5, 2, true, false),
    "enter_now",
  );
  assert.equal(
    resolveFrozenOb(100, { ...candidate, high: 95 }, false).status,
    "unavailable",
  );
  assert.equal(resolveFrozenOb(100, undefined, false).proximity, "unavailable");
  assert.equal(resolveFrozenOb(100, undefined, true).proximity, "no_zone");
});

test("OB touch candle is excluded from hypothetical fill outcome hits", () => {
  const interval = 15 * 60_000;
  const bars = Array.from({ length: 99 }, (_, index) => ({
    time: index * interval,
    open: 100,
    high: index === 2 ? 112 : index === 3 ? 108 : 101,
    low: index === 2 ? 99 : 101,
    close: 100,
  }));
  const hypothesis = {
    version: 1,
    status: "available",
    zone: { high: 100, low: 90 },
  };
  const result = evaluateObFollowup(bars, 0, 110, hypothesis, 25 * 60 * 60_000);

  assert.equal(result.followup.touchAt, 45 * 60_000);
  assert.equal(result.followup.firstPlus8At, 60 * 60_000);
  assert.equal(result.followup.firstPlus10At, null);
  assert.equal(result.followup.outcome, "completed");
});

test("missing 15m candles remain unknown rather than no-touch", () => {
  const interval = 15 * 60_000;
  const bars = Array.from({ length: 97 }, (_, index) => ({
    time: index * interval,
    open: 100,
    high: 101,
    low: 101,
    close: 100,
  })).filter((_, index) => index !== 20);
  const result = evaluateObFollowup(
    bars,
    0,
    110,
    { version: 1, status: "available", zone: { high: 100, low: 90 } },
    25 * 60 * 60_000,
  );

  assert.equal(result.followup.outcome, "unknown");
  assert.equal(result.followup.coverageComplete, false);
});

test("gap before apparent first touch cannot create a hypothetical fill", () => {
  const interval = 15 * 60_000;
  const bars = Array.from({ length: 99 }, (_, index) => ({
    time: index * interval,
    open: 100,
    high: index === 10 ? 105 : 101,
    low: index === 10 ? 99 : 101,
    close: 100,
  })).filter((_, index) => index !== 5);
  const result = evaluateObFollowup(
    bars,
    0,
    110,
    { version: 1, status: "available", zone: { high: 100, low: 90 } },
    25 * 60 * 60_000,
  );

  assert.equal(result.followup.touchAt, null);
  assert.equal(result.followup.outcome, "unknown");
  assert.equal(result.followup.reason, "history_gap_before_first_touch");
});

test("a same-candle stop is conservative for both original and frozen fills", () => {
  const interval = 15 * 60_000;
  const bars = Array.from({ length: 99 }, (_, index) => ({
    time: index * interval,
    open: 100,
    high: index === 3 ? 110 : 101,
    low: index === 2 ? 99 : index === 3 ? 80 : 101,
    close: 100,
  }));
  const result = evaluateObFollowup(
    bars,
    0,
    100,
    { version: 1, status: "available", zone: { high: 100, low: 90 } },
    25 * 60 * 60_000,
  );

  assert.equal(result.originalEntryComparison.firstPlus8At, null);
  assert.equal(result.originalEntryComparison.firstPlus8Status, "stopped");
  assert.equal(result.originalEntryComparison.firstPlus10At, null);
  assert.equal(result.originalEntryComparison.firstPlus10Status, "stopped");
  assert.equal(result.followup.firstPlus8At, null);
  assert.equal(result.followup.firstPlus8Status, "stopped");
  assert.equal(result.followup.firstPlus10At, null);
  assert.equal(result.followup.firstPlus10Status, "stopped");
  assert.equal(result.followup.firstMinus10Status, "hit");
});

test("an observed original threshold after a coverage gap remains unknown", () => {
  const interval = 15 * 60_000;
  const bars = Array.from({ length: 99 }, (_, index) => ({
    time: index * interval,
    open: 100,
    high: index === 10 ? 110 : 101,
    low: 99,
    close: 100,
  })).filter((_, index) => index !== 5);
  const result = evaluateObFollowup(
    bars,
    0,
    100,
    { version: 1, status: "no_zone", zone: null },
    25 * 60 * 60_000,
  );
  assert.equal(result.originalEntryComparison.firstPlus10At, null);
  assert.equal(result.originalEntryComparison.firstPlus10Status, "unknown");
});

test("OB-only lifecycle keeps unresolved evidence due, then terminates", () => {
  const detectedAt = 0;
  const noZone = {
    version: 1,
    status: "no_zone",
    followup: { status: "no_zone" },
    originalEntryComparison: { status: "pending" },
  };
  assert.equal(
    isObHypothesisTerminal(noZone, detectedAt, 24 * 60 * 60_000),
    false,
  );
  assert.equal(
    isObHypothesisTerminal(
      { ...noZone, originalEntryComparison: { status: "completed" } },
      detectedAt,
      24 * 60 * 60_000,
    ),
    true,
  );
  const availableGap = {
    version: 1,
    status: "available",
    followup: { status: "unknown" },
    originalEntryComparison: { status: "pending" },
  };
  assert.equal(
    isObHypothesisTerminal(availableGap, detectedAt, 24 * 60 * 60_000),
    false,
  );
  assert.equal(
    isObHypothesisTerminal(
      {
        ...availableGap,
        originalEntryComparison: { status: "unknown" },
      },
      detectedAt,
      48 * 60 * 60_000,
    ),
    true,
  );
});

test("proximity cohorts exclude null PnL and incomplete comparisons", () => {
  const cohorts = summarizeObCohorts([
    {
      proximity: "inside_or_within_1pct",
      detectedAt: 0,
      trackerFinalStatus: "profit",
      trackerFinalPnl: null,
      originalEntryComparison: {
        status: "completed",
        firstPlus8Status: "hit",
        firstPlus8At: 30 * 60_000,
        firstPlus10Status: "stopped",
        firstPlus10At: null,
      },
    },
    {
      proximity: "between_1_2pct",
      detectedAt: 0,
      trackerFinalStatus: "stop_loss",
      trackerFinalPnl: -10,
      originalEntryComparison: {
        status: "completed",
        firstPlus8Status: "not_hit",
        firstPlus8At: null,
        firstPlus10Status: "not_hit",
        firstPlus10At: null,
      },
    },
    {
      proximity: "beyond_2pct",
      detectedAt: 0,
      trackerFinalStatus: null,
      trackerFinalPnl: null,
      originalEntryComparison: { status: "pending" },
    },
    {
      proximity: "beyond_2pct",
      detectedAt: 0,
      trackerFinalStatus: "profit",
      trackerFinalPnl: 12,
      originalEntryComparison: { status: "unknown" },
    },
  ]);

  assert.equal(cohorts.inside_or_within_1pct.total, 1);
  assert.equal(cohorts.inside_or_within_1pct.known, 1);
  assert.equal(cohorts.inside_or_within_1pct.finalizedWithPnl, 0);
  assert.equal(cohorts.inside_or_within_1pct.realizedPnlUnknown, 1);
  assert.equal(cohorts.inside_or_within_1pct.medianTimeToPlus8Minutes, 30);
  assert.equal(cohorts.inside_or_within_1pct.medianTimeToPlus10Minutes, null);
  assert.equal(cohorts.between_1_2pct.realizedAtOrBelow8, 1);
  assert.equal(cohorts.between_1_2pct.exactStopLossCount, 1);
  assert.equal(cohorts.beyond_2pct.open, 1);
  assert.equal(cohorts.beyond_2pct.pending, 1);
  assert.equal(cohorts.beyond_2pct.unknown, 1);
  assert.equal(cohorts.beyond_2pct.realizedAbove10, 1);
});

test("missed strong winners require no-touch or no-target and realized PnL", () => {
  assert.equal(
    classifyMissedStrongWinner("wait", "no_touch", "completed", "profit", 11),
    "missed",
  );
  assert.equal(
    classifyMissedStrongWinner("no_target", null, null, "profit", 11),
    "missed",
  );
  assert.equal(
    classifyMissedStrongWinner("wait", "touched", "touched", "profit", 11),
    "pending",
  );
  assert.equal(
    classifyMissedStrongWinner("wait", "pending", "pending", "profit", 11),
    "pending",
  );
  assert.equal(
    classifyMissedStrongWinner("wait", "no_touch", "completed", null, null),
    "pending",
  );
});
