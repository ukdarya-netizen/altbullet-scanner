import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluateStealthArmedSetup,
  type StealthArmedSnapshot,
} from "../src/lib/stealth-breakout-armed.js";
import type { BreakoutCandle } from "../src/lib/breakout-analysis.js";

const HOUR = 60 * 60 * 1000;
const FOUR_HOURS = 4 * HOUR;

function candles4h(closes: number[]): BreakoutCandle[] {
  return closes.map((close, index) => ({
    time: index * FOUR_HOURS,
    open: close,
    high: close + 1,
    low: close - 1,
    close,
    volume: 100,
  }));
}

function arm(
  overrides: Partial<StealthArmedSnapshot> = {},
): StealthArmedSnapshot {
  return {
    structureKey: "horizontal:100:3",
    breakoutSource: "horizontal",
    breakoutLevel: 100,
    touches: 3,
    armedAt: 0,
    armedAfterFourHourCandleTime: 0,
    expiresAt: 72 * HOUR,
    ...overrides,
  };
}

test("1H-only cross cannot qualify while every closed 4H candle stays below", () => {
  const decision = evaluateStealthArmedSetup({
    arm: arm({ expiresAt: 200 * HOUR }),
    breakoutCandles4h: candles4h(Array.from({ length: 20 }, () => 98)),
    refinementCandles: [],
    evaluatedAt: 20 * FOUR_HOURS,
  });
  assert.equal(decision.status, "armed");
  assert.equal(decision.reason, "awaiting_later_4h_cross");
});

test("forming 4H candle and a prior close already above cannot qualify", () => {
  const base = candles4h(Array.from({ length: 19 }, () => 98));
  const trigger: BreakoutCandle = {
    time: 19 * FOUR_HOURS,
    open: 98,
    high: 104,
    low: 97,
    close: 102,
    volume: 100,
  };
  const unfinished = evaluateStealthArmedSetup({
    arm: arm({ expiresAt: 200 * HOUR }),
    breakoutCandles4h: [...base, trigger],
    refinementCandles: [],
    evaluatedAt: trigger.time + 3 * HOUR,
  });
  assert.equal(unfinished.status, "armed");

  const alreadyAbove = evaluateStealthArmedSetup({
    arm: arm({ expiresAt: 200 * HOUR }),
    breakoutCandles4h: [
      ...candles4h(Array.from({ length: 18 }, () => 98)),
      { ...trigger, time: 18 * FOUR_HOURS, close: 102 },
      { ...trigger, time: 19 * FOUR_HOURS, open: 102, close: 103 },
    ],
    refinementCandles: [],
    evaluatedAt: 20 * FOUR_HOURS,
  });
  assert.equal(alreadyAbove.status, "armed");
});

test("closed decisive 4H cross of a local level qualifies and freezes its first-cross time", () => {
  const trigger: BreakoutCandle = {
    time: 19 * FOUR_HOURS,
    open: 98,
    high: 104,
    low: 97,
    close: 103,
    volume: 100,
  };
  const refinement: BreakoutCandle[] = [
    {
      time: trigger.time + FOUR_HOURS,
      open: 100.5,
      high: 102,
      low: 99.5,
      close: 101,
      volume: 100,
    },
    {
      time: trigger.time + FOUR_HOURS + 30 * 60 * 1000,
      open: 101,
      high: 102,
      low: 100,
      close: 101,
      volume: 100,
    },
  ];
  const decision = evaluateStealthArmedSetup({
    arm: arm({ expiresAt: 200 * HOUR }),
    breakoutCandles4h: [
      ...candles4h(Array.from({ length: 19 }, () => 98)),
      trigger,
    ],
    refinementCandles: refinement,
    evaluatedAt: trigger.time + FOUR_HOURS + HOUR,
  });
  assert.equal(decision.status, "qualified", JSON.stringify(decision));
  if (decision.status === "qualified") {
    assert.equal(decision.firstCrossAt, trigger.time + FOUR_HOURS);
    assert.equal(decision.confirmation.timeframe, "4h");
    assert.equal(decision.refinement.timeframe, "30m");
  }
});

test("one-off frozen levels are not actionable", () => {
  const trigger: BreakoutCandle = {
    time: FOUR_HOURS,
    open: 98,
    high: 104,
    low: 97,
    close: 102,
    volume: 100,
  };
  const decision = evaluateStealthArmedSetup({
    arm: arm({ touches: 1 }),
    breakoutCandles4h: [...candles4h([98]), trigger],
    refinementCandles: [],
    evaluatedAt: trigger.time + FOUR_HOURS,
  });
  assert.equal(decision.status, "armed");
});

test("a pre-arm historical cross cannot validate a later weak post-arm candle", () => {
  const candles: BreakoutCandle[] = [
    ...candles4h([98, 103, 98]),
    {
      time: 3 * FOUR_HOURS,
      open: 100.1,
      high: 101,
      low: 99.9,
      close: 100.3,
      volume: 100,
    },
  ];
  const decision = evaluateStealthArmedSetup({
    arm: arm({
      armedAfterFourHourCandleTime: 2 * FOUR_HOURS,
      expiresAt: 200 * HOUR,
    }),
    breakoutCandles4h: candles,
    refinementCandles: [],
    evaluatedAt: 4 * FOUR_HOURS,
  });
  assert.equal(decision.status, "armed");
  assert.equal(decision.reason, "awaiting_later_4h_cross");
});

test("a weak post-arm cross does not mask a later decisive post-arm cross", () => {
  const candles: BreakoutCandle[] = [
    ...candles4h([98, 98, 98]),
    {
      time: 3 * FOUR_HOURS,
      open: 100.1,
      high: 101,
      low: 99.9,
      close: 100.3,
      volume: 100,
    },
    {
      time: 4 * FOUR_HOURS,
      open: 99,
      high: 99.5,
      low: 98,
      close: 98,
      volume: 100,
    },
    {
      time: 5 * FOUR_HOURS,
      open: 98,
      high: 104,
      low: 97,
      close: 103,
      volume: 100,
    },
  ];
  const decision = evaluateStealthArmedSetup({
    arm: arm({ expiresAt: 200 * HOUR }),
    breakoutCandles4h: candles,
    refinementCandles: [
      {
        time: 6 * FOUR_HOURS,
        open: 100,
        high: 102,
        low: 99,
        close: 101,
        volume: 100,
      },
      {
        time: 6 * FOUR_HOURS + 30 * 60 * 1000,
        open: 101,
        high: 102,
        low: 100,
        close: 101,
        volume: 100,
      },
    ],
    evaluatedAt: 7 * FOUR_HOURS,
  });
  assert.equal(decision.status, "qualified", JSON.stringify(decision));
  if (decision.status === "qualified") {
    assert.equal(decision.firstCrossAt, 6 * FOUR_HOURS);
  }
});
