import assert from "node:assert/strict";
import test from "node:test";
import {
  buildStealthAbneonArmSnapshotSafely,
  classifyStealthAbneonLevels,
} from "../src/lib/stealth-abneon-arm-snapshot.js";
import { evaluateStealthArmedSetup } from "../src/lib/stealth-breakout-armed.js";
import type { BreakoutCandle } from "../src/lib/breakout-analysis.js";

const HOUR = 60 * 60_000;

function candles(count: number, timeframe: number): BreakoutCandle[] {
  return Array.from({ length: count }, (_, index) => {
    const close = 100 + (index % 3);
    return {
      time: index * timeframe,
      open: close - 0.25,
      high: close + 1,
      low: close - 1,
      close,
      volume: 100 + index,
    };
  });
}

test("ABNeon comparison is observational and does not change live level/decision", () => {
  const arm = {
    structureKey: "test",
    breakoutSource: "horizontal" as const,
    breakoutLevel: 101,
    touches: 3,
    armedAt: 20 * HOUR,
    armedAfterFourHourCandleTime: 20 * HOUR,
    expiresAt: 40 * HOUR,
  };
  const breakoutCandles = candles(12, 4 * HOUR);
  const refinementCandles = candles(20, 30 * 60_000);
  const liveInput = {
    arm,
    breakoutCandles4h: breakoutCandles,
    refinementCandles,
    evaluatedAt: 21 * HOUR,
  };
  const first = evaluateStealthArmedSetup(liveInput);
  const second = evaluateStealthArmedSetup(liveInput);

  const snapshotA = {
    nearestResistance: 101,
    classification: "agreement" as const,
  };
  const snapshotB = {
    nearestResistance: 110,
    classification: "neutral" as const,
  };
  assert.deepEqual(first, second);
  assert.equal(first.status, "armed");
  assert.equal(arm.breakoutLevel, 101);
  assert.notDeepEqual(snapshotA, snapshotB);
  assert.equal(
    classifyStealthAbneonLevels({
      frozenStealthLevel: arm.breakoutLevel,
      nearestResistance: snapshotA.nearestResistance,
    }).classification,
    snapshotA.classification,
  );
  assert.equal(
    classifyStealthAbneonLevels({
      frozenStealthLevel: arm.breakoutLevel,
      nearestResistance: snapshotB.nearestResistance,
    }).classification,
    snapshotB.classification,
  );
});

test("event-time snapshot ignores candles that were not closed at capture", () => {
  const capturedAt = 20 * HOUR;
  const fourHour = candles(40, 4 * HOUR);
  const oneHour = candles(80, HOUR);
  fourHour[20]!.high = 10_000;
  oneHour[40]!.high = 10_000;
  const snapshot = buildStealthAbneonArmSnapshotSafely({
    frozenStealthLevel: 101,
    candles4h: fourHour,
    candles1h: oneHour,
    capturedAt,
  });
  assert.equal(snapshot.capturedAt, capturedAt);
  assert.equal(snapshot.context.candles4h, 5);
  assert.equal(snapshot.context.candles1h, 20);
});

test("missing data and detector errors remain missing observational coverage", () => {
  const missing = buildStealthAbneonArmSnapshotSafely({
    frozenStealthLevel: 101,
    candles4h: [],
    candles1h: [],
    capturedAt: 20 * HOUR,
  });
  assert.equal(missing.coverage, "missing");
  assert.equal(missing.classification, "neutral");

  const errored = buildStealthAbneonArmSnapshotSafely(
    {
      frozenStealthLevel: 101,
      candles4h: [],
      candles1h: [],
      capturedAt: 20 * HOUR,
    },
    () => {
      throw new Error("synthetic snapshot failure");
    },
  );
  assert.equal(errored.coverage, "missing");
  assert.match(errored.reason, /synthetic snapshot failure/);
  assert.equal(errored.frozenStealthLevel, 101);
});
