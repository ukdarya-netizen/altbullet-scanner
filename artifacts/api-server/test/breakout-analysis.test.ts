import assert from "node:assert/strict";
import test from "node:test";
import {
  analyzeBreakout,
  analyzeStealthBreakoutTimeframes,
  analyzeStealthContinuationShelf,
  analyzeStealthStructure,
  buildStealthEarlyBreakoutObservation,
  chooseStealthResistanceCeiling,
  claimStealthTechnicalKlineFallback,
  confirmStealthOneHourBreakout,
  confirmStealthFourHourBreakout,
  isStealthStructureReadyToArm,
  isFreshStealthBreakout,
  isQualifiedStealthBreakout,
  isTechnicalStealthBreakout,
  normalizeClosedBreakoutCandles,
  replayStealthBreakouts,
  refineStealthBreakoutEntry,
  type BreakoutCandle,
} from "../src/lib/breakout-analysis.js";
import {
  analyzeStealthParticipation,
  buildStealthArmedSnapshot,
  buildStealthArmStructureKey,
  buildStealthBreakoutVolumeShadow,
  evaluateStealthArmedSetup,
  type StealthArmedSnapshot,
} from "../src/lib/stealth-breakout-armed.js";
import {
  analyzeStealthWindowCalibration,
  replayStealthWindowStop,
} from "../src/lib/stealth-window-calibration.js";

test("Stealth window replay resolves same-candle stop before favorable move", () => {
  const replay = replayStealthWindowStop(
    {
      entryAt: 1,
      entryPrice: 100,
      closedAt: 2,
      candles: [
        {
          time: 1,
          open: 100,
          high: 110,
          low: 93,
          close: 105,
          volume: 1,
        },
      ],
    },
    6,
  );
  assert.equal(replay.hit, true);
  assert.equal(replay.hitAt, 1);
});

test("Stealth window replay ignores candles outside the entry-to-horizon interval", () => {
  const replay = replayStealthWindowStop(
    {
      entryAt: 1_000,
      entryPrice: 100,
      closedAt: 2_000,
      candles: [
        { time: 900, open: 100, high: 101, low: 90, close: 100, volume: 1 },
        { time: 1_500, open: 100, high: 101, low: 99, close: 100, volume: 1 },
        { time: 2_100, open: 100, high: 101, low: 90, close: 100, volume: 1 },
      ],
    },
    6,
  );
  assert.equal(replay.hit, false);
  assert.equal(replay.maePct, -1);
});

test("Stealth window shadow excludes candles inside the 4H breakout candle", () => {
  const triggerAt = 1_700_000_000_000;
  const candles: BreakoutCandle[] = [
    {
      time: triggerAt + 30 * 60 * 1000,
      open: 100,
      high: 102,
      low: 99,
      close: 101,
      volume: 1,
    },
    {
      time: triggerAt + 4 * 60 * 60 * 1000,
      open: 101,
      high: 103,
      low: 100,
      close: 101.5,
      volume: 1,
    },
    {
      time: triggerAt + 4.5 * 60 * 60 * 1000,
      open: 101.5,
      high: 103,
      low: 101,
      close: 102,
      volume: 1,
    },
  ];
  const live = refineStealthBreakoutEntry({ breakoutLevel: 100 }, candles);
  const shadow = refineStealthBreakoutEntry({ breakoutLevel: 100 }, candles, {
    confirmationStartsAt: triggerAt + 4 * 60 * 60 * 1000,
    requiredConsecutiveCloses: 2,
  });
  assert.equal(live.status, "near_level");
  assert.equal(shadow.status, "near_level");
  assert.deepEqual(shadow.confirmationCandleTimes, [
    triggerAt + 4 * 60 * 60 * 1000,
    triggerAt + 4.5 * 60 * 60 * 1000,
  ]);
  assert.equal(shadow.confirmationAt, triggerAt + 5 * 60 * 60 * 1000);
});

test("Stealth window calibration stays insufficient below twenty complete rows", () => {
  const report = analyzeStealthWindowCalibration([
    {
      entryAt: 1,
      entryPrice: 100,
      closedAt: 2,
      outcome: "profit",
      pnlPct: 4,
      candles: [
        { time: 1, open: 100, high: 105, low: 99, close: 104, volume: 1 },
      ],
    },
  ]);
  assert.equal(report.decision, "insufficient_cohort");
  assert.equal(report.completed, 1);
  assert.equal(report.stops.length, 3);
  assert.equal(report.outcomes.profit, 1);
});

test("Stealth participation remains shadow-only below 20 completed fires", () => {
  const report = analyzeStealthParticipation([
    {
      firedAt: 2,
      outcome: "profit",
      volumeRatio: 0.8,
      turnover: 80_000,
      oi30m: null,
      cvdPositiveCount: 1,
      spotTakerNetBuy: -2,
    },
    {
      firedAt: 1,
      outcome: "stop_loss",
      volumeRatio: 1.2,
      turnover: null,
      oi30m: -1,
      cvdPositiveCount: null,
      spotTakerNetBuy: 3,
    },
  ]);

  assert.equal(report.decision, "shadow_only");
  assert.equal(report.reason, "insufficient_completed_fires");
  assert.deepEqual(report.chronologicalSplit, { firstHalf: 1, secondHalf: 1 });
  assert.deepEqual(
    report.rules.find((rule) => rule.metric === "turnover"),
    {
      metric: "turnover",
      rule: "turnover >= 100000",
      available: 1,
      unavailable: 1,
      goodOutcomesLost: 1,
      badOutcomesRemoved: 0,
      goodLostPerBadRemoved: null,
    },
  );
});

test("Stealth participation requires a zero-good-loss rule in both chronological halves", () => {
  const rows = Array.from({ length: 20 }, (_, index) => ({
    firedAt: index,
    outcome: index % 5 === 0 ? ("stop_loss" as const) : ("profit" as const),
    volumeRatio: index % 5 === 0 ? 0.5 : 1.5,
    turnover: null,
    oi30m: null,
    cvdPositiveCount: null,
    spotTakerNetBuy: null,
  }));
  const report = analyzeStealthParticipation(rows);
  assert.equal(report.decision, "eligible_for_live_hybrid_review");
  assert.equal(report.reason, "robust_zero_cost_rule");
});

function buildCandles(finalClose: number): BreakoutCandle[] {
  const candles: BreakoutCandle[] = [];
  for (let index = 0; index < 56; index += 1) {
    const resistanceTouch = [15, 30, 45].includes(index);
    const close = resistanceTouch ? 98.6 : 97 + (index % 3) * 0.25;
    candles.push({
      time: 1_700_000_000_000 + index * 30 * 60 * 1000,
      open: close - 0.2,
      high: resistanceTouch ? 100 : 99,
      low: 95.5,
      close,
      volume: 1000,
    });
  }
  candles.push(
    {
      time: 1_700_000_000_000 + 56 * 30 * 60 * 1000,
      open: 98.5,
      high: 101.4,
      low: 98,
      close: 101,
      volume: 1600,
    },
    {
      time: 1_700_000_000_000 + 57 * 30 * 60 * 1000,
      open: 100.9,
      high: 102.1,
      low: 100.5,
      close: 101.6,
      volume: 1300,
    },
    {
      time: 1_700_000_000_000 + 58 * 30 * 60 * 1000,
      open: 101.4,
      high: 102.3,
      low: 100.8,
      close: 101.8,
      volume: 1100,
    },
    {
      time: 1_700_000_000_000 + 59 * 30 * 60 * 1000,
      open: 101.5,
      high: Math.max(102, finalClose + 0.4),
      low: Math.min(99.2, finalClose - 0.4),
      close: finalClose,
      volume: 1200,
    },
  );
  return candles;
}

function buildFreshHorizontalBreakout(): BreakoutCandle[] {
  const candles: BreakoutCandle[] = [];
  for (let index = 0; index < 60; index += 1) {
    const resistanceTouch = [15, 30, 45].includes(index);
    const close = index === 59 ? 101.2 : 97 + (index % 3) * 0.2;
    candles.push({
      time: 1_700_000_000_000 + index * 30 * 60 * 1000,
      open: index === 59 ? 98.7 : close - 0.15,
      high: index === 59 ? 101.8 : resistanceTouch ? 100 : 99,
      low: index === 59 ? 98.3 : 95.7,
      close,
      volume: index === 59 ? 1600 : 1000,
    });
  }
  return candles;
}

function buildFreshTrendlineBreakout(): BreakoutCandle[] {
  const candles: BreakoutCandle[] = [];
  const levelAt = (index: number) => 115 - index / 3;
  for (let index = 0; index < 60; index += 1) {
    const trendTouch = [15, 30, 45].includes(index);
    const close = index === 59 ? levelAt(index) + 1.4 : levelAt(index) - 2.5;
    candles.push({
      time: 1_700_000_000_000 + index * 30 * 60 * 1000,
      open: index === 59 ? levelAt(index) - 2.5 : close - 0.15,
      high:
        index === 59
          ? levelAt(index) + 1.8
          : trendTouch
            ? levelAt(index)
            : close + 0.35,
      low: index === 59 ? levelAt(index) - 2.8 : close - 1,
      close,
      volume: index === 59 ? 1600 : 1000,
    });
  }
  return candles;
}

function buildFourHourQuietStructure(): BreakoutCandle[] {
  const candles: BreakoutCandle[] = [];
  for (let index = 0; index < 60; index += 1) {
    const resistanceTouch = [15, 30, 45].includes(index);
    const isQuietZone = index >= 52;
    const close = isQuietZone ? 98.2 + (index % 2) * 0.2 : 97.2;
    candles.push({
      time: 1_700_000_000_000 + index * 4 * 60 * 60 * 1000,
      open: close - 0.15,
      high: resistanceTouch ? 100 : isQuietZone ? 99.2 : 99,
      low: isQuietZone ? 97.2 : 95.5,
      close,
      volume: 1000,
    });
  }
  return candles;
}

function buildOneHourBreakout(includeFormingCandle = true): BreakoutCandle[] {
  const candles: BreakoutCandle[] = [];
  for (let index = 0; index < 50; index += 1) {
    const isBreakout = index === 49;
    const close = isBreakout ? 101.2 : 98.2;
    candles.push({
      time: 1_700_000_000_000 + index * 60 * 60 * 1000,
      open: isBreakout ? 98.6 : 98,
      high: isBreakout ? 101.6 : 99,
      low: isBreakout ? 98.2 : 97.5,
      close,
      volume: 1000,
    });
  }
  if (includeFormingCandle) {
    candles.push({
      time: 1_700_000_000_000 + 50 * 60 * 60 * 1000,
      open: 101.2,
      high: 102.2,
      low: 100.9,
      close: 101.7,
      volume: 900,
    });
  }
  return candles;
}

function buildFourHourBreakout(includeFormingCandle = true): BreakoutCandle[] {
  return buildOneHourBreakout(includeFormingCandle).map((candle, index) => ({
    ...candle,
    time: 1_700_000_000_000 + index * 4 * 60 * 60 * 1000,
  }));
}

function buildThirtyMinuteRefinement(): BreakoutCandle[] {
  const candles: BreakoutCandle[] = [];
  for (let index = 0; index < 12; index += 1) {
    const isLatest = index === 11;
    const close = isLatest ? 100.7 : 98.4;
    candles.push({
      time: 1_700_000_000_000 + index * 30 * 60 * 1000,
      open: isLatest ? 99.8 : 98.2,
      high: isLatest ? 100.9 : 99,
      low: isLatest ? 99.6 : 97.7,
      close,
      volume: 1000,
    });
  }
  return candles;
}

function buildContinuationShelfFixture(): BreakoutCandle[] {
  const hour = 60 * 60 * 1000;
  const triggerTime = Date.parse("2026-08-20T12:00:00Z");
  const candles: BreakoutCandle[] = Array.from({ length: 20 }, (_, index) => ({
    time: triggerTime - (24 - index) * hour,
    open: 520,
    high: index === 4 ? 580.75 : 524,
    low: 516,
    close: 521,
    volume: 100,
  }));
  candles.push(
    {
      time: triggerTime - 4 * hour,
      open: 522,
      high: 562,
      low: 520,
      close: 558,
      volume: 500,
    },
    {
      time: triggerTime - 3 * hour,
      open: 558,
      high: 566.4,
      low: 556,
      close: 563.8,
      volume: 180,
    },
    {
      time: triggerTime - 2 * hour,
      open: 563.8,
      high: 567.1,
      low: 560.5,
      close: 564.9,
      volume: 140,
    },
    {
      time: triggerTime - hour,
      open: 564.9,
      high: 567.8,
      low: 562.4,
      close: 565.6,
      volume: 130,
    },
  );
  return candles;
}

test("ZEC continuation shelf freezes 566-568 while old 580.75 stays contextual", () => {
  const fixture = buildContinuationShelfFixture();
  const shelf = analyzeStealthContinuationShelf(fixture);
  assert.equal(shelf.status, "approaching");
  assert.equal(
    shelf.continuationShelf?.method,
    "post_impulse_consolidation_v1",
  );
  assert.ok((shelf.breakoutLevel ?? 0) >= 566);
  assert.ok((shelf.breakoutLevel ?? 0) <= 568);
  assert.equal(shelf.continuationShelf?.nearestUpperResistance, 580.75);

  const triggerTime = Date.parse("2026-08-20T12:00:00Z");
  const fourHourFixture = fixture.map((candle) => ({
    ...candle,
    time:
      triggerTime -
      (fixture[fixture.length - 1]!.time - candle.time) * 4 -
      4 * 60 * 60 * 1000,
  }));
  const arm = buildStealthArmedSnapshot({
    structure: shelf,
    latestClosedFourHourCandleTime:
      fourHourFixture[fourHourFixture.length - 1]!.time,
    confirmationCandles: fourHourFixture,
    armedAt: triggerTime,
    structureKeyPrefix: "continuation-shelf-v1",
  });
  assert.ok(arm);
  assert.equal(arm.breakoutLevel, shelf.breakoutLevel);
  assert.match(arm.structureKey, /^continuation-shelf-v1:horizontal:/);

  const trigger: BreakoutCandle = {
    time: triggerTime,
    open: 565.87,
    high: 571.63,
    low: 561.6,
    close: 571.58,
    volume: 400,
  };
  const confirmation = confirmStealthFourHourBreakout(
    shelf,
    [...fourHourFixture, trigger],
    triggerTime + 4 * 60 * 60 * 1000,
  );
  assert.equal(confirmation.status, "fresh_breakout");

  const refinement: BreakoutCandle[] = [
    {
      time: triggerTime + 4 * 60 * 60 * 1000,
      open: 565.87,
      high: 570,
      low: 561.6,
      close: 568.2,
      volume: 200,
    },
    {
      time: triggerTime + 4.5 * 60 * 60 * 1000,
      open: 568.2,
      high: 572,
      low: 567,
      close: 569,
      volume: 200,
    },
  ];
  const decision = evaluateStealthArmedSetup({
    arm,
    breakoutCandles4h: [...fourHourFixture, trigger],
    refinementCandles: refinement,
    evaluatedAt: triggerTime + 5 * 60 * 60 * 1000,
  });
  assert.equal(decision.status, "qualified", JSON.stringify(decision));
});

test("continuation shelf rejects a single bounce after an impulse", () => {
  const candles = buildContinuationShelfFixture().slice(0, -2);
  const shelf = analyzeStealthContinuationShelf(candles);
  assert.notEqual(shelf.status, "approaching");
  assert.equal(shelf.continuationShelf, null);
});

test("continuation shelf rejects an impulse candle without consolidation", () => {
  const candles = buildContinuationShelfFixture().slice(0, -3);
  const shelf = analyzeStealthContinuationShelf(candles);
  assert.notEqual(shelf.status, "approaching");
  assert.equal(shelf.continuationShelf, null);
});

test("continuation shelf rejects stair-step drift without one strong impulse candle", () => {
  const candles = buildContinuationShelfFixture();
  const impulseIndex = candles.length - 4;
  candles[impulseIndex]!.open = 554;
  candles[impulseIndex]!.close = 558;
  const shelf = analyzeStealthContinuationShelf(candles);
  assert.notEqual(shelf.status, "approaching");
  assert.equal(shelf.continuationShelf, null);
});

test("continuation shelf rejects gapped or duplicate event-time candles", () => {
  const candles = buildContinuationShelfFixture();
  candles[candles.length - 2]!.time = candles[candles.length - 3]!.time;
  const shelf = analyzeStealthContinuationShelf(candles);
  assert.notEqual(shelf.status, "approaching");
  assert.match(shelf.reasons[0]!, /event-time/);
});

test("recognizes a fresh horizontal breakout from a quiet zone", () => {
  const evidence = analyzeBreakout(buildFreshHorizontalBreakout());

  assert.equal(evidence.status, "fresh_breakout");
  assert.equal(evidence.kind, "horizontal");
  assert.equal(evidence.quietZone, true);
});

test("recognizes a fresh descending-trendline breakout from a quiet zone", () => {
  const evidence = analyzeBreakout(buildFreshTrendlineBreakout());

  assert.equal(evidence.status, "fresh_breakout");
  assert.equal(evidence.kind, "trendline");
  assert.equal(evidence.quietZone, true);
});

test("allows a fresh technical breakout with one flow confirmation only", () => {
  const evidence = analyzeBreakout(buildFreshHorizontalBreakout());

  assert.equal(
    isFreshStealthBreakout(evidence, {
      oi: false,
      cvd: true,
      spotTaker: false,
    }),
    true,
  );
  assert.equal(
    isFreshStealthBreakout(evidence, {
      oi: false,
      cvd: false,
      spotTaker: false,
    }),
    false,
  );
  assert.equal(
    isFreshStealthBreakout(evidence, {
      oi: false,
      cvd: false,
      spotTaker: true,
    }),
    true,
  );
});

test("uses the immediately preceding closed 30m candle, never the forming candle", () => {
  const closedBreakout = buildFreshHorizontalBreakout();
  const formingCandle: BreakoutCandle = {
    ...closedBreakout[closedBreakout.length - 1]!,
    time: closedBreakout[closedBreakout.length - 1]!.time + 30 * 60 * 1000,
    close: 94,
    low: 93.5,
    high: 102,
  };

  const evidence = analyzeBreakout(
    normalizeClosedBreakoutCandles([...closedBreakout, formingCandle]),
  );

  assert.equal(evidence.status, "fresh_breakout");
  assert.equal(evidence.quietZone, true);
});

test("drops malformed rows before choosing the final closed candle", () => {
  const candles = buildFreshHorizontalBreakout();
  const malformedFinalRow = {
    ...candles[candles.length - 1]!,
    time: "not-a-timestamp",
  };

  const normalized = normalizeClosedBreakoutCandles([
    ...candles,
    malformedFinalRow,
  ]);

  assert.equal(normalized.length, candles.length - 1);
  assert.equal(
    normalized[normalized.length - 1]!.time,
    candles[candles.length - 2]!.time,
  );
});

test("does not treat non-fresh breakout statuses as Stealth entries", () => {
  const evidence = analyzeBreakout(buildCandles(102));

  assert.notEqual(evidence.status, "fresh_breakout");
  assert.equal(
    isFreshStealthBreakout(evidence, {
      oi: true,
      cvd: true,
      spotTaker: true,
    }),
    false,
  );
});

test("classifies a repeated horizontal resistance breakout", () => {
  const evidence = analyzeBreakout(buildCandles(102));
  assert.equal(evidence.kind, "horizontal");
  assert.ok(
    ["fresh_breakout", "confirmed_breakout", "retest"].includes(
      evidence.status,
    ),
  );
  assert.ok(evidence.breakoutLevel !== null);
  assert.ok(evidence.score > 0);
});

test("keeps returns to the same level in one breakout lifecycle", () => {
  const candles = buildFreshHorizontalBreakout();
  candles.push(
    {
      time: candles[candles.length - 1]!.time + 30 * 60 * 1000,
      open: 101.2,
      high: 101.5,
      low: 99.8,
      close: 100.7,
      volume: 1300,
    },
    {
      time: candles[candles.length - 1]!.time + 30 * 60 * 1000,
      open: 100.7,
      high: 101.8,
      low: 100.5,
      close: 101.4,
      volume: 1500,
    },
  );

  const evidence = analyzeBreakout(candles);

  assert.equal(evidence.kind, "horizontal");
  assert.equal(evidence.breakoutLevel, 100);
  assert.ok(evidence.breakoutTolerance !== null);
  assert.ok(evidence.breakoutZone !== null);
  assert.ok(evidence.lifecycle !== null);
  assert.equal(evidence.lifecycle?.breakoutIndex, 59);
  assert.equal(evidence.lifecycle?.endIndex, 61);
  assert.deepEqual(evidence.lifecycle?.retestIndices, [60]);
});

test("anchors a descending-trendline breakout at the crossing level", () => {
  const candles = buildFreshTrendlineBreakout();
  const evidence = analyzeBreakout(candles);

  assert.equal(evidence.kind, "trendline");
  assert.equal(evidence.breakoutSource, "trendline");
  assert.ok(evidence.trendline);
  assert.equal(evidence.lifecycle?.breakoutIndex, 59);
  assert.equal(evidence.lifecycle?.endIndex, 59);
  assert.deepEqual(evidence.lifecycle?.retestIndices, []);
  const trendline = evidence.trendline!;
  const slope =
    (trendline.endPrice - trendline.startPrice) /
    (trendline.endIndex - trendline.startIndex);
  const projectedBreakoutLevel =
    trendline.startPrice +
    slope * (evidence.lifecycle!.breakoutIndex - trendline.startIndex);
  assert.equal(
    evidence.breakoutLevel,
    Number(projectedBreakoutLevel.toFixed(4)),
  );
});

test("marks a rejected recent breakout as a fakeout", () => {
  const evidence = analyzeBreakout(buildCandles(95));
  assert.equal(evidence.status, "fakeout");
  assert.equal(evidence.kind, "horizontal");
});

test("does not infer structure from too few closed candles", () => {
  const evidence = analyzeBreakout(buildCandles(102).slice(0, 20));
  assert.equal(evidence.status, "insufficient_data");
  assert.equal(evidence.score, 0);
});

test("requires 4h quiet structure and a fresh closed 4h breakout", () => {
  const structure = analyzeStealthStructure(buildFourHourQuietStructure());
  const fourHour = confirmStealthFourHourBreakout(
    structure,
    buildFourHourBreakout(false),
  );
  const refinement = refineStealthBreakoutEntry(
    structure,
    buildThirtyMinuteRefinement(),
  );

  assert.equal(structure.timeframe, "4h");
  assert.equal(structure.quietZone, true);
  assert.equal(fourHour.status, "fresh_breakout");
  assert.equal(refinement.status, "near_level");
  assert.equal(
    isQualifiedStealthBreakout(structure, fourHour, refinement, {
      oi: false,
      cvd: true,
      spotTaker: false,
    }),
    true,
  );
});

test("Stealth freezes the upper edge of a 4H resistance cluster, not its median", () => {
  const candles = buildFourHourQuietStructure();
  candles[45] = { ...candles[45]!, high: 100.7 };
  const structure = analyzeStealthStructure(candles);
  assert.equal(structure.status, "approaching");
  assert.equal(structure.breakoutLevel, 100.7);
  assert.equal(structure.touches, 3);
});

test("Stealth does not re-arm a lower 4H shelf after a prior closed impulse above it", () => {
  const scale = 0.000005;
  const candles = buildFourHourQuietStructure().map((candle) => ({
    ...candle,
    open: candle.open * scale,
    high: candle.high * scale,
    low: candle.low * scale,
    close: candle.close * scale,
  }));
  // The impulse is outside the last eight quiet candles, but is still part of
  // this setup's recent 4H history; a later 1H cross is not the first breakout.
  candles[49] = {
    ...candles[49]!,
    open: 0.00049,
    high: 0.000538,
    low: 0.000485,
    close: 0.0005166,
  };
  const structure = analyzeStealthStructure(candles);
  assert.notEqual(structure.status, "approaching");
  assert.notEqual(structure.breakoutLevel, 0.0005);
});

test("experimental technical-only Stealth mode does not require flow or volume confirmation", () => {
  const structure = analyzeStealthStructure(buildFourHourQuietStructure());
  const fourHour = confirmStealthFourHourBreakout(
    structure,
    buildFourHourBreakout(false),
  );
  const refinement = refineStealthBreakoutEntry(
    structure,
    buildThirtyMinuteRefinement(),
  );

  assert.equal(
    isTechnicalStealthBreakout(structure, fourHour, refinement),
    true,
  );
});

test("claims bounded TA fallback when global prefetch ended before a symbol", () => {
  const state = { prefetchTimedOut: false, attempts: 0 };

  assert.equal(claimStealthTechnicalKlineFallback(state, true, 2), false);
  assert.equal(state.attempts, 0);

  state.prefetchTimedOut = true;
  assert.equal(claimStealthTechnicalKlineFallback(state, true, 2), true);
  assert.equal(state.attempts, 1);
  assert.equal(claimStealthTechnicalKlineFallback(state, false, 2), false);
  assert.equal(state.attempts, 1);
  assert.equal(claimStealthTechnicalKlineFallback(state, true, 2), true);
  assert.equal(claimStealthTechnicalKlineFallback(state, true, 2), false);
  assert.equal(state.attempts, 2);
});

test("keeps the three Stealth detail layers distinct for chart consumers", () => {
  const analysis = analyzeStealthBreakoutTimeframes({
    structureCandles: buildFourHourQuietStructure(),
    breakoutCandles4h: buildFourHourBreakout(false),
    refinementCandles: buildThirtyMinuteRefinement(),
    evaluatedAt:
      1_700_000_000_000 + 50 * 4 * 60 * 60 * 1000 + 4 * 60 * 60 * 1000,
  });

  assert.equal(analysis.structure.timeframe, "4h");
  assert.equal(analysis.structure.quietZone, true);
  assert.equal(analysis.confirmation.timeframe, "4h");
  assert.equal(analysis.confirmation.status, "fresh_breakout");
  assert.equal(analysis.refinement.timeframe, "30m");
  assert.equal(analysis.refinement.status, "near_level");
  assert.notEqual(analysis.refinement.status, "fresh_breakout");
});

test("composition excludes a forming 4H breakout until its close boundary", () => {
  const structureCandles = buildFourHourQuietStructure();
  const breakoutCandles4h = buildFourHourBreakout(true);
  const closedPrior = breakoutCandles4h[breakoutCandles4h.length - 2]!;
  closedPrior.close = 98.2;
  closedPrior.open = 98;
  closedPrior.high = 99;
  const forming = breakoutCandles4h[breakoutCandles4h.length - 1]!;
  forming.open = 98.6;
  forming.high = 102;
  const formingClose = forming.time + 4 * 60 * 60 * 1000;
  const beforeClose = analyzeStealthBreakoutTimeframes({
    structureCandles,
    breakoutCandles4h,
    refinementCandles: buildThirtyMinuteRefinement(),
    evaluatedAt: formingClose - 1,
  });
  assert.notEqual(beforeClose.confirmation.status, "fresh_breakout");

  const atClose = analyzeStealthBreakoutTimeframes({
    structureCandles,
    breakoutCandles4h,
    refinementCandles: buildThirtyMinuteRefinement(),
    evaluatedAt: formingClose,
  });
  assert.equal(atClose.confirmation.status, "fresh_breakout");
});

test("does not use a forming 4h candle as Stealth confirmation", () => {
  const structure = analyzeStealthStructure(buildFourHourQuietStructure());
  const candles = buildFourHourBreakout(true);
  candles[candles.length - 2]!.close = 98.2;
  candles[candles.length - 2]!.open = 98;
  candles[candles.length - 2]!.high = 99;
  const fourHour = confirmStealthFourHourBreakout(
    structure,
    candles,
    1_700_000_000_000 + 50 * 4 * 60 * 60 * 1000 + 4 * 60 * 60 * 1000 - 1,
  );

  assert.notEqual(fourHour.status, "fresh_breakout");
});

test("does not allow a 30m breakout to create Stealth without 4h confirmation", () => {
  const structure = analyzeStealthStructure(buildFourHourQuietStructure());
  const noFourHourBreakout = confirmStealthFourHourBreakout(
    structure,
    buildFourHourBreakout(false).slice(0, -1),
  );
  const refinement = refineStealthBreakoutEntry(
    structure,
    buildThirtyMinuteRefinement(),
  );

  assert.notEqual(noFourHourBreakout.status, "fresh_breakout");
  assert.equal(
    isQualifiedStealthBreakout(structure, noFourHourBreakout, refinement, {
      oi: true,
      cvd: true,
      spotTaker: true,
    }),
    false,
  );
});

test("ARMED setup cannot fire on the same closed 4H candle that created it", () => {
  const structure = analyzeStealthStructure(buildFourHourQuietStructure());
  const fourHour = buildFourHourBreakout(false);
  const arm = buildStealthArmedSnapshot({
    structure,
    latestClosedFourHourCandleTime: fourHour[fourHour.length - 1]!.time,
    armedAt: fourHour[fourHour.length - 1]!.time + 4 * 60 * 60 * 1000,
  });
  assert.ok(arm);

  const decision = evaluateStealthArmedSetup({
    arm,
    breakoutCandles4h: fourHour,
    refinementCandles: buildThirtyMinuteRefinement(),
    evaluatedAt: arm.armedAt,
  });
  assert.equal(decision.status, "armed");
});

test("ARMED setup qualifies only a later first close across the frozen level", () => {
  const structure = analyzeStealthStructure(buildFourHourQuietStructure());
  const fourHour = buildFourHourBreakout(false);
  fourHour[fourHour.length - 1]!.close = 98.2;
  fourHour[fourHour.length - 1]!.open = 98;
  fourHour[fourHour.length - 1]!.high = 99;
  const arm = buildStealthArmedSnapshot({
    structure,
    latestClosedFourHourCandleTime: fourHour[fourHour.length - 1]!.time,
    armedAt: fourHour[fourHour.length - 1]!.time + 4 * 60 * 60 * 1000,
  });
  assert.ok(arm);
  const laterBreakout: BreakoutCandle = {
    time: fourHour[fourHour.length - 1]!.time + 4 * 60 * 60 * 1000,
    open: 98.6,
    high: 101.6,
    low: 98.2,
    close: 101.2,
    volume: 1000,
  };
  const firstCrossAt = laterBreakout.time + 4 * 60 * 60 * 1000;
  const refinement: BreakoutCandle[] = [
    {
      time: firstCrossAt,
      open: arm.breakoutLevel + 0.2,
      high: arm.breakoutLevel + 1,
      low: arm.breakoutLevel,
      close: arm.breakoutLevel + 0.6,
      volume: 1,
    },
    {
      time: firstCrossAt + 30 * 60 * 1000,
      open: arm.breakoutLevel + 0.6,
      high: arm.breakoutLevel + 1,
      low: arm.breakoutLevel + 0.2,
      close: arm.breakoutLevel + 0.7,
      volume: 1,
    },
  ];

  const decision = evaluateStealthArmedSetup({
    arm,
    breakoutCandles4h: [...fourHour, laterBreakout],
    refinementCandles: refinement,
    evaluatedAt: firstCrossAt + 60 * 60 * 1000,
  });
  assert.equal(decision.status, "qualified");
  if (decision.status === "qualified") {
    assert.equal(decision.confirmation.breakoutLevel, arm.breakoutLevel);
  }
});

test("Stealth volume shadow uses only the 20 closed 1H candles before the cross", () => {
  const hour = 60 * 60 * 1000;
  const candles: BreakoutCandle[] = Array.from({ length: 20 }, (_, index) => ({
    time: index * hour,
    open: 100,
    high: 101,
    low: 99,
    close: 100,
    volume: 100,
    volumeUsd: 100,
  }));
  candles.push({
    time: 20 * hour,
    open: 100,
    high: 102,
    low: 99,
    close: 101,
    volume: 80,
    volumeUsd: 80,
  });
  candles.push({
    time: 21 * hour,
    open: 101,
    high: 103,
    low: 100,
    close: 102,
    volume: 1_000_000,
    volumeUsd: 1_000_000,
  });

  const shadow = buildStealthBreakoutVolumeShadow(candles, 20);
  assert.equal(shadow.status, "available");
  if (shadow.status === "available") {
    assert.equal(shadow.lookback, 20);
    assert.equal(shadow.priorMeanVolume, 100);
    assert.equal(shadow.breakoutVolume, 80);
    assert.equal(shadow.ratio, 0.8);
  }
});

test("Stealth volume shadow records insufficient history explicitly", () => {
  const shadow = buildStealthBreakoutVolumeShadow(
    [
      {
        time: 0,
        open: 100,
        high: 102,
        low: 99,
        close: 101,
        volume: 80,
      },
    ],
    0,
  );
  assert.equal(shadow.status, "unavailable");
  if (shadow.status === "unavailable") {
    assert.equal(shadow.reason, "insufficient_prior_candles");
    assert.equal(shadow.ratio, null);
  }
});

test("does not arm a Stealth structure that is already holding above resistance", () => {
  const structure = analyzeStealthStructure(buildFourHourQuietStructure());
  const oneHour = buildOneHourBreakout(false);
  const level = structure.breakoutLevel!;
  for (const candle of oneHour.slice(-8)) {
    candle.close = level + 1;
  }
  assert.equal(isStealthStructureReadyToArm(structure, oneHour), false);
});

test("a slow 1H drift above resistance is consumed but not qualified", () => {
  const structure = analyzeStealthStructure(buildFourHourQuietStructure());
  const oneHour = buildOneHourBreakout(false);
  const level = structure.breakoutLevel!;
  const previous = oneHour[oneHour.length - 2]!;
  const latest = oneHour[oneHour.length - 1]!;
  previous.close = level + 0.05;
  latest.open = level + 0.05;
  latest.close = level + 0.5;
  latest.high = level + 0.6;
  latest.low = level - 0.05;

  const confirmation = confirmStealthOneHourBreakout(structure, oneHour);
  assert.equal(confirmation.crossed, false);
  assert.equal(confirmation.status, "no_breakout");
});

test("ARMED setup ignores a weak first cross and accepts a later decisive breakout", () => {
  const structure = analyzeStealthStructure(buildFourHourQuietStructure());
  const fourHour = buildFourHourBreakout(false);
  fourHour[fourHour.length - 1]!.close = 98.2;
  const arm = buildStealthArmedSnapshot({
    structure,
    latestClosedFourHourCandleTime: fourHour[fourHour.length - 1]!.time,
    armedAt: fourHour[fourHour.length - 1]!.time + 4 * 60 * 60 * 1000,
  });
  assert.ok(arm);
  const weakCross: BreakoutCandle = {
    time: fourHour[fourHour.length - 1]!.time + 4 * 60 * 60 * 1000,
    open: 100.1,
    high: 101,
    low: 99.9,
    close: 100.3,
    volume: 1000,
  };
  const resetBelow: BreakoutCandle = {
    time: weakCross.time + 4 * 60 * 60 * 1000,
    open: 99.2,
    high: 99.6,
    low: 98.4,
    close: 98.8,
    volume: 900,
  };
  const laterStrongCross: BreakoutCandle = {
    time: weakCross.time + 8 * 60 * 60 * 1000,
    open: 98.6,
    high: 101.7,
    low: 98.2,
    close: 101.3,
    volume: 1000,
  };
  const decision = evaluateStealthArmedSetup({
    arm,
    breakoutCandles4h: [...fourHour, weakCross, resetBelow, laterStrongCross],
    refinementCandles: [0, 1].map((index) => ({
      time: laterStrongCross.time + 4 * 60 * 60 * 1000 + index * 30 * 60 * 1000,
      open: arm.breakoutLevel + 0.3,
      high: arm.breakoutLevel + 1,
      low: arm.breakoutLevel + 0.1,
      close: arm.breakoutLevel + 0.7,
      volume: 1,
    })),
    evaluatedAt: laterStrongCross.time + 5 * 60 * 60 * 1000,
  });
  assert.equal(decision.status, "qualified");
  if (decision.status === "qualified") {
    assert.equal(
      decision.firstCrossAt,
      laterStrongCross.time + 4 * 60 * 60 * 1000,
    );
  }
});

function buildProductionOneHourFixture(input: {
  level: number;
  triggerTime: number;
  previousClose: number;
  trigger: Omit<BreakoutCandle, "time" | "volume">;
  laterCloses?: number[];
}): BreakoutCandle[] {
  const typicalRange = Math.max(
    input.trigger.high - input.trigger.low,
    input.level * 0.004,
  );
  const candles: BreakoutCandle[] = [];
  for (let index = 0; index < 15; index += 1) {
    const close = input.previousClose;
    candles.push({
      time: input.triggerTime - (15 - index) * 60 * 60 * 1000,
      open: close,
      high: close + typicalRange / 2,
      low: close - typicalRange / 2,
      close,
      volume: 1,
    });
  }
  candles.push({
    time: input.triggerTime,
    ...input.trigger,
    volume: 1,
  });
  for (const [index, close] of (input.laterCloses ?? []).entries()) {
    candles.push({
      time: input.triggerTime + (index + 1) * 60 * 60 * 1000,
      open: close,
      high: close + typicalRange / 4,
      low: close - typicalRange / 4,
      close,
      volume: 1,
    });
  }
  return candles;
}

function buildProductionFourHourFixture(input: {
  level: number;
  triggerTime: number;
  previousClose: number;
  trigger: Omit<BreakoutCandle, "time" | "volume">;
  laterCloses?: number[];
}): BreakoutCandle[] {
  return buildProductionOneHourFixture(input).map((candle) => ({
    ...candle,
    time: input.triggerTime + (candle.time - input.triggerTime) * 4,
  }));
}

test("weak historical crosses do not manufacture a confirmed breakout", () => {
  const cases = [
    {
      symbol: "ESP-USDT",
      level: 0.0905,
      previousClose: 0.08886,
      trigger: {
        open: 0.08886,
        high: 0.09211,
        low: 0.08827,
        close: 0.09128,
      },
      laterCloses: Array.from({ length: 20 }, () => 0.0864),
    },
    {
      symbol: "DEEP-USDT",
      level: 0.0146,
      previousClose: 0.01436,
      trigger: {
        open: 0.01436,
        high: 0.0147,
        low: 0.01428,
        close: 0.01463,
      },
      laterCloses: [0.01455, 0.01452, 0.01449],
    },
  ] as const;

  for (const item of cases) {
    const triggerTime = Date.parse("2026-08-28T00:00:00Z");
    const candles = buildProductionFourHourFixture({
      ...item,
      triggerTime,
      laterCloses: [...item.laterCloses],
    });
    const arm: StealthArmedSnapshot = {
      structureKey: item.symbol,
      breakoutSource: "horizontal",
      breakoutLevel: item.level,
      touches: 2,
      armedAt: triggerTime - 60 * 60 * 1000,
      armedAfterFourHourCandleTime: triggerTime - 4 * 60 * 60 * 1000,
      expiresAt: triggerTime + 200 * 60 * 60 * 1000,
    };
    const decision = evaluateStealthArmedSetup({
      arm,
      breakoutCandles4h: candles,
      refinementCandles: [],
      evaluatedAt: candles[candles.length - 1]!.time + 4 * 60 * 60 * 1000,
    });
    assert.equal(decision.status, "armed", item.symbol);
    if (decision.status === "armed")
      assert.equal(decision.reason, "awaiting_later_4h_cross");
  }
});

test("a valid breakout waits for current 30m data instead of expiring after ten minutes", () => {
  const level = 100;
  const triggerTime = Date.parse("2026-08-28T00:00:00Z");
  const candles = buildProductionFourHourFixture({
    level,
    triggerTime,
    previousClose: 98.2,
    trigger: {
      open: 98.4,
      high: 102,
      low: 98,
      close: 101.5,
    },
  });
  const arm: StealthArmedSnapshot = {
    structureKey: "stale-partial-feed",
    breakoutSource: "horizontal",
    breakoutLevel: level,
    touches: 3,
    armedAt: triggerTime - 60 * 60 * 1000,
    armedAfterFourHourCandleTime: triggerTime - 4 * 60 * 60 * 1000,
    expiresAt: triggerTime + 72 * 60 * 60 * 1000,
  };
  const decision = evaluateStealthArmedSetup({
    arm,
    breakoutCandles4h: candles,
    refinementCandles: [],
    evaluatedAt: triggerTime + 16 * 60 * 60 * 1000,
  });
  assert.equal(decision.status, "armed");
  if (decision.status === "armed") {
    assert.equal(decision.reason, "breakout_active_waiting_30m_data");
  }
});

test("RUNE-style delayed evaluation still qualifies inside the 24h entry window", () => {
  const hour = 60 * 60 * 1000;
  const structure = analyzeStealthStructure(buildFourHourQuietStructure());
  const level = structure.breakoutLevel!;
  const fourHour = buildFourHourBreakout(false);
  fourHour[fourHour.length - 1]!.close = level - 1;
  fourHour[fourHour.length - 1]!.open = level - 1.2;
  fourHour[fourHour.length - 1]!.high = level - 0.5;
  const triggerTime = fourHour[fourHour.length - 1]!.time + 4 * hour;
  const trigger: BreakoutCandle = {
    time: triggerTime,
    open: level - 1,
    high: level + 1.6,
    low: level - 1.2,
    close: level + 1.2,
    volume: 1000,
  };
  const arm = buildStealthArmedSnapshot({
    structure,
    latestClosedFourHourCandleTime: fourHour[fourHour.length - 1]!.time,
    armedAt: triggerTime,
  });
  assert.ok(arm);
  const refinement: BreakoutCandle[] = [
    {
      time: triggerTime + 4 * hour,
      open: level,
      high: level + 1,
      low: level - 0.5,
      close: level + 0.8,
      volume: 1,
    },
    {
      time: triggerTime + 4.5 * hour,
      open: level + 0.8,
      high: level + 1.2,
      low: level + 0.3,
      close: level + 0.9,
      volume: 1,
    },
  ];
  const decision = evaluateStealthArmedSetup({
    arm,
    breakoutCandles4h: [...fourHour, trigger],
    refinementCandles: refinement,
    evaluatedAt: triggerTime + 5 * hour,
  });
  assert.equal(decision.status, "qualified", JSON.stringify(decision));
});

test("an extended breakout waits for a retest and expires after 24 hours", () => {
  const hour = 60 * 60 * 1000;
  const level = 100;
  const triggerTime = Date.parse("2026-09-10T10:00:00Z");
  const candles = buildProductionFourHourFixture({
    level,
    triggerTime,
    previousClose: 98,
    trigger: { open: 98, high: 102, low: 97.8, close: 101.5 },
  });
  const arm: StealthArmedSnapshot = {
    structureKey: "extended-breakout",
    breakoutSource: "horizontal",
    breakoutLevel: level,
    touches: 3,
    armedAt: triggerTime - hour,
    armedAfterFourHourCandleTime: triggerTime - 4 * hour,
    expiresAt: triggerTime + 72 * hour,
  };
  const refinement: BreakoutCandle[] = [
    {
      time: triggerTime + 4 * hour,
      open: 102,
      high: 104,
      low: 101.5,
      close: 103,
      volume: 1,
    },
    {
      time: triggerTime + 4.5 * hour,
      open: 103,
      high: 104,
      low: 102.5,
      close: 103.5,
      volume: 1,
    },
  ];
  const waiting = evaluateStealthArmedSetup({
    arm,
    breakoutCandles4h: candles,
    refinementCandles: refinement,
    evaluatedAt: triggerTime + 8 * hour,
  });
  assert.equal(waiting.status, "armed");
  if (waiting.status === "armed") {
    assert.equal(waiting.reason, "breakout_active_waiting_retest");
  }

  const expired = evaluateStealthArmedSetup({
    arm,
    breakoutCandles4h: candles,
    refinementCandles: refinement,
    evaluatedAt: triggerTime + 30 * hour,
  });
  assert.equal(expired.status, "invalidated", JSON.stringify(expired));
  if (expired.status === "invalidated") {
    assert.equal(expired.reason, "breakout_entry_window_elapsed");
  }
});

test("Stealth participation telemetry is observational, fail-open, and decisions are stable", () => {
  const arm: StealthArmedSnapshot = {
    structureKey: "telemetry-observation",
    breakoutSource: "horizontal",
    breakoutLevel: 100,
    touches: 3,
    armedAt: 0,
    armedAfterFourHourCandleTime: 0,
    expiresAt: 72 * 60 * 60 * 1000,
  };
  const breakoutCandles4h = buildProductionFourHourFixture({
    level: 100,
    triggerTime: 4 * 60 * 60 * 1000,
    previousClose: 98,
    trigger: { open: 98, high: 103, low: 97.8, close: 101.5 },
  });
  const base = {
    arm,
    breakoutCandles4h,
    refinementCandles: [],
    evaluatedAt: 12 * 60 * 60 * 1000,
  };
  const unavailable = {
    capturedAt: base.evaluatedAt,
    oi: { value: null, source: "test", available: false },
    cvd: {
      value: { cvd15m: null, cvd30m: null, cvd1h: null, cvd4h: null },
      source: "test",
      available: false,
    },
    spotTaker: { value: null, source: "test", available: false },
  };
  const weak = {
    ...unavailable,
    oi: { value: -4, source: "test", available: true },
    spotTaker: { value: -20, source: "test", available: true },
  };
  const strong = {
    ...unavailable,
    oi: { value: 8, source: "test", available: true },
    cvd: {
      value: { cvd15m: true, cvd30m: true, cvd1h: true, cvd4h: true },
      source: "test",
      available: true,
    },
    spotTaker: { value: 20, source: "test", available: true },
  };
  const withoutTelemetry = evaluateStealthArmedSetup(base);
  assert.deepEqual(
    withoutTelemetry,
    evaluateStealthArmedSetup({
      ...base,
      participationTelemetry: unavailable,
    }),
  );
  assert.deepEqual(
    withoutTelemetry,
    evaluateStealthArmedSetup({
      ...base,
      participationTelemetry: weak,
    }),
  );
  assert.deepEqual(
    withoutTelemetry,
    evaluateStealthArmedSetup({
      ...base,
      participationTelemetry: strong,
    }),
  );
  assert.equal(unavailable.oi.value, null);
  assert.equal(unavailable.oi.available, false);
  assert.equal(unavailable.cvd.value.cvd4h, null);
});

test("production LA candle does not clear the nearby 0.058 horizontal ceiling", () => {
  const candles = buildProductionOneHourFixture({
    level: 0.058,
    triggerTime: Date.parse("2026-08-27T14:00:00Z"),
    previousClose: 0.05652,
    trigger: {
      open: 0.05652,
      high: 0.05807,
      low: 0.05638,
      close: 0.05772,
    },
  });
  const confirmation = confirmStealthOneHourBreakout(
    { breakoutLevel: 0.058 },
    candles,
  );
  assert.equal(confirmation.status, "no_breakout");
  assert.equal(confirmation.crossed, false);
});

test("production FLOCK remains a strong positive control", () => {
  const triggerTime = Date.parse("2026-08-27T20:00:00Z");
  const candles = buildProductionOneHourFixture({
    level: 0.033,
    triggerTime,
    previousClose: 0.03233,
    trigger: {
      open: 0.03233,
      high: 0.03414,
      low: 0.03228,
      close: 0.0338,
    },
  });
  const confirmation = confirmStealthOneHourBreakout(
    { breakoutLevel: 0.033 },
    candles,
  );
  assert.equal(confirmation.status, "fresh_breakout");
  assert.ok((confirmation.closeDistanceAtr ?? 0) >= 0.35);
  assert.ok((confirmation.closeStrength ?? 0) >= 0.75);
});

test("production AIO passes and borderline STO is rejected by the stronger close threshold", () => {
  const cases = [
    {
      symbol: "AIO-USDT",
      expectedStatus: "fresh_breakout",
      level: 0.0449,
      previousClose: 0.04408,
      trigger: {
        open: 0.04408,
        high: 0.04587,
        low: 0.04406,
        close: 0.04562,
      },
    },
    {
      symbol: "STO-USDT",
      expectedStatus: "no_breakout",
      level: 0.0425,
      previousClose: 0.04241,
      trigger: {
        open: 0.04241,
        high: 0.04286,
        low: 0.04237,
        close: 0.04275,
      },
    },
  ] as const;

  for (const item of cases) {
    const confirmation = confirmStealthOneHourBreakout(
      { breakoutLevel: item.level },
      buildProductionOneHourFixture({
        level: item.level,
        triggerTime: Date.parse("2026-08-28T00:00:00Z"),
        previousClose: item.previousClose,
        trigger: item.trigger,
      }),
    );
    assert.equal(
      confirmation.status,
      item.expectedStatus,
      `${item.symbol} must match the production threshold replay`,
    );
    assert.ok((confirmation.closeStrength ?? 0) >= 0.75);
  }
});

test("production ETHFI confirms a decisive horizontal breakout despite its lower wick", () => {
  const level = 0.6293;
  const triggerTime = Date.parse("2026-09-10T11:00:00Z");
  const candles = buildProductionOneHourFixture({
    level,
    triggerTime,
    previousClose: 0.6295,
    trigger: {
      open: 0.6295,
      high: 0.6479,
      low: 0.6227,
      close: 0.6401,
    },
  });
  for (const candle of candles.slice(0, -1)) {
    candle.high = candle.close + 0.006475;
    candle.low = candle.close - 0.006475;
  }

  const confirmation = confirmStealthOneHourBreakout(
    { breakoutLevel: level },
    candles,
  );

  assert.equal(confirmation.status, "fresh_breakout");
  assert.ok((confirmation.closeStrength ?? 0) >= 0.65);
  assert.ok((confirmation.closeStrength ?? 0) < 0.75);
  assert.ok((confirmation.bodyRange ?? 0) >= 0.4);
  assert.ok((confirmation.bodyRange ?? 0) < 0.5);
  assert.ok((confirmation.closeDistanceAtr ?? 0) >= 0.5);
});

test("production LA resistance cluster selects 0.058 above the lower projected trendline", () => {
  const selected = chooseStealthResistanceCeiling(
    [
      { source: "trendline", level: 0.0575, touches: 2 },
      { source: "horizontal", level: 0.058, touches: 2 },
      { source: "horizontal", level: 0.0596, touches: 3 },
    ],
    0.05362,
    0.0011505,
  );
  assert.equal(selected?.source, "horizontal");
  assert.equal(selected?.level, 0.058);
});

test("production HOME keeps the stronger 0.0064 quiet-zone ceiling above the weak inner shelf", () => {
  const selected = chooseStealthResistanceCeiling(
    [
      { source: "horizontal", level: 0.0062, touches: 2 },
      { source: "horizontal", level: 0.0064, touches: 3 },
      { source: "horizontal", level: 0.0067, touches: 2 },
    ],
    0.006058,
    0.00007215,
  );
  assert.equal(selected?.source, "horizontal");
  assert.equal(selected?.level, 0.0064);
});

test("ALICE and PENDLE cannot break a lower shelf while an equal-strength ceiling remains overhead", () => {
  const alice = chooseStealthResistanceCeiling(
    [
      { source: "trendline", level: 0.1342, touches: 2 },
      { source: "horizontal", level: 0.1407, touches: 2 },
      { source: "horizontal", level: 0.1434, touches: 2 },
    ],
    0.1333,
    0.00169,
  );
  const pendle = chooseStealthResistanceCeiling(
    [
      { source: "horizontal", level: 2.1482, touches: 2 },
      { source: "horizontal", level: 2.2729, touches: 2 },
    ],
    2.1,
    0.04,
  );

  assert.equal(alice?.level, 0.1407);
  assert.equal(pendle?.level, 2.2729);
});

test("KAT-style entry below the frozen 4H level is rejected", () => {
  const refinement = refineStealthBreakoutEntry({ breakoutLevel: 0.0049 }, [
    {
      time: 0,
      open: 0.0048,
      high: 0.00495,
      low: 0.00475,
      close: 0.00485,
      volume: 100,
    },
    {
      time: 1,
      open: 0.00488,
      high: 0.00492,
      low: 0.00484,
      close: 0.004858,
      volume: 100,
    },
  ]);

  assert.equal(refinement.status, "rejected");
});

test("trendline ARMED identity does not move with its projected breakout price", () => {
  const base = {
    breakoutSource: "trendline" as const,
    breakoutLevel: 100,
    touches: 2,
    quietZone: true,
    trendline: {
      startIndex: 10,
      endIndex: 30,
      startPrice: 110,
      endPrice: 104,
      kind: "resistance" as const,
    },
  };
  assert.equal(
    buildStealthArmStructureKey(base),
    buildStealthArmStructureKey({ ...base, breakoutLevel: 98.5 }),
  );
});

function buildReplayFixture(): {
  structureCandles: BreakoutCandle[];
  breakoutCandles4h: BreakoutCandle[];
  refinementCandles: BreakoutCandle[];
  eventAt: number;
} {
  const start = 1_700_000_000_000;
  const eventAt = start + 240 * 60 * 60 * 1000;
  const structureCandles: BreakoutCandle[] = [];
  for (let index = 0; index < 70; index += 1) {
    const resistanceTouch = [15, 30, 45].includes(index);
    const isQuietZone = index >= 52;
    const close = isQuietZone ? 98.2 + (index % 2) * 0.2 : 97.2;
    structureCandles.push({
      time: start + index * 4 * 60 * 60 * 1000,
      open: close - 0.15,
      high: resistanceTouch ? 100 : isQuietZone ? 99.2 : 99,
      low: isQuietZone ? 97.2 : 95.5,
      close,
      volume: 1000,
    });
  }

  const breakoutCandles4h: BreakoutCandle[] = [];
  for (let index = 0; index < 61; index += 1) {
    const isBreakout = index === 59;
    const close = isBreakout ? 101.2 : 98.2;
    breakoutCandles4h.push({
      time: start + index * 4 * 60 * 60 * 1000,
      open: isBreakout ? 98.6 : 98,
      high: isBreakout ? 101.6 : 99,
      low: isBreakout ? 98.2 : 97.5,
      close,
      volume: 1000,
    });
  }

  const refinementCandles: BreakoutCandle[] = [];
  for (let index = 0; index < 576; index += 1) {
    const time = start + index * 30 * 60 * 1000;
    const isEntry = time + 30 * 60 * 1000 === eventAt;
    const close = isEntry ? 100.7 : 98.4 + (index % 2) * 0.05;
    refinementCandles.push({
      time,
      open: close - 0.15,
      high: isEntry ? 101 : close + 0.3,
      low: close - 0.4,
      close,
      volume: 1000,
    });
  }

  return {
    structureCandles,
    breakoutCandles4h,
    refinementCandles,
    eventAt,
  };
}

test("marks replay outcomes unavailable when a 30m candle is missing", () => {
  const fixture = buildReplayFixture();
  const completeReplay = replayStealthBreakouts({
    ...fixture,
    fromTime: fixture.eventAt,
    toTime: fixture.eventAt,
  });
  assert.equal(completeReplay.events.length, 1);
  assert.equal(completeReplay.events[0]!.outcomes.h4.status, "complete");

  const missingCandleAt = fixture.eventAt + 60 * 60 * 1000;
  const gappedReplay = replayStealthBreakouts({
    ...fixture,
    refinementCandles: fixture.refinementCandles.filter(
      (candle) => candle.time !== missingCandleAt,
    ),
    fromTime: fixture.eventAt,
    toTime: fixture.eventAt,
  });
  assert.equal(gappedReplay.events.length, 1);
  assert.equal(gappedReplay.events[0]!.outcomes.h4.status, "not_available");
  assert.equal(gappedReplay.events[0]!.outcomes.h48.status, "not_available");
});

test("does not backfill an earlier lifecycle crossing from a later replay evaluation", () => {
  const fixture = buildReplayFixture();
  const firstInRangeEvaluation = fixture.eventAt + 60 * 60 * 1000;
  const replay = replayStealthBreakouts({
    ...fixture,
    fromTime: firstInRangeEvaluation,
    toTime: firstInRangeEvaluation,
  });

  assert.equal(replay.events.length, 0);
});

test("freezes the first closed 4H crossing for the early TA observation", () => {
  const structure = {
    breakoutSource: "horizontal" as const,
    breakoutLevel: 100,
    touches: 3,
    quietZone: true,
  };
  const candles: BreakoutCandle[] = [
    {
      time: 1_700_000_000_000,
      open: 99,
      high: 100,
      low: 98,
      close: 99.5,
      volume: 100,
    },
    {
      time: 1_700_014_400_000,
      open: 99,
      high: 102,
      low: 98.8,
      close: 101.5,
      volume: 100,
    },
  ];
  const observation = buildStealthEarlyBreakoutObservation({
    symbol: "TA-USDT",
    structure,
    confirmation: {
      status: "fresh_breakout",
      timeframe: "4h",
      lifecycle: { breakoutIndex: 1, endIndex: 1, retestIndices: [] },
    },
    confirmationCandles: candles,
    firstDetectedAt: 1_700_028_900_000,
  });

  assert.deepEqual(observation, {
    symbol: "TA-USDT",
    observationKey: "TA-USDT:horizontal:100.0000:1700028800000",
    levelKey: "horizontal:100.0000",
    breakoutSource: "horizontal",
    breakoutLevel: 100,
    touches: 3,
    quietZone: true,
    firstCrossAt: 1_700_028_800_000,
    firstDetectedAt: 1_700_028_900_000,
    confirmationAt: null,
  });
});

test("keeps the same early TA key on repeated discovery and changes it for a new lifecycle", () => {
  const structure = {
    breakoutSource: "trendline" as const,
    breakoutLevel: 42.125,
    touches: 2,
    quietZone: true,
  };
  const candles: BreakoutCandle[] = [
    {
      time: 1000,
      open: 41,
      high: 42,
      low: 40,
      close: 41.5,
      volume: 100,
    },
    {
      time: 2000,
      open: 41.5,
      high: 43,
      low: 41,
      close: 42.8,
      volume: 100,
    },
    {
      time: 3000,
      open: 42.8,
      high: 44,
      low: 42.5,
      close: 43.5,
      volume: 100,
    },
  ];
  const create = (breakoutIndex: number) =>
    buildStealthEarlyBreakoutObservation({
      symbol: "RETEST-USDT",
      structure,
      confirmation: {
        status: "fresh_breakout",
        timeframe: "4h",
        lifecycle: { breakoutIndex, endIndex: 2, retestIndices: [] },
      },
      confirmationCandles: candles,
      firstDetectedAt: 4000,
    });

  assert.equal(create(1)?.observationKey, create(1)?.observationKey);
  assert.notEqual(create(1)?.observationKey, create(2)?.observationKey);
});

test("does not create an early TA observation without a fresh closed 4H confirmation", () => {
  const observation = buildStealthEarlyBreakoutObservation({
    symbol: "WAIT-USDT",
    structure: {
      breakoutSource: "horizontal",
      breakoutLevel: 10,
      touches: 3,
      quietZone: true,
    },
    confirmation: { status: "no_breakout", timeframe: "4h", lifecycle: null },
    confirmationCandles: [],
    firstDetectedAt: Date.now(),
  });

  assert.equal(observation, null);
});

test("never emits an early observation from a 1H-only confirmation", () => {
  const observation = buildStealthEarlyBreakoutObservation({
    symbol: "ONE-HOUR-USDT",
    structure: {
      breakoutSource: "horizontal",
      breakoutLevel: 10,
      touches: 3,
      quietZone: true,
    },
    confirmation: {
      status: "fresh_breakout",
      timeframe: "1h",
      lifecycle: { breakoutIndex: 1, endIndex: 1, retestIndices: [] },
    },
    confirmationCandles: [
      {
        time: 0,
        open: 9,
        high: 11,
        low: 8,
        close: 10.5,
        volume: 1,
      },
      {
        time: 4 * 60 * 60 * 1000,
        open: 9,
        high: 11,
        low: 8,
        close: 10.5,
        volume: 1,
      },
    ],
    firstDetectedAt: 1,
  });
  assert.equal(observation, null);
});
