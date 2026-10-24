import assert from "node:assert/strict";
import test from "node:test";
import {
  autoRangeEventMatchesIdentity,
  evaluateStealthArmedSetup,
  isLiveStealthBreakoutSource,
  sameStealthAutoRangeIdentity,
  sameStealthAutoRangeInstance,
  type StealthArmedSnapshot,
  type StealthAutoRangeIdentity,
  updateStealthAutoRangeBounds,
} from "../src/lib/stealth-breakout-armed.js";
import { detectAutoRangePine } from "../src/lib/auto-range-pine.js";

const FOUR_HOURS = 4 * 60 * 60_000;
const ONE_HOUR = 60 * 60_000;
const THIRTY_MINUTES = 30 * 60_000;

test("only 4H and 1H Range arms can produce new Stealth trades", () => {
  assert.equal(isLiveStealthBreakoutSource("auto_range_4h"), false);
  assert.equal(isLiveStealthBreakoutSource("auto_range_1h"), true);
  for (const historicalSource of ["stealth_legacy", "continuation_shelf"]) {
    assert.equal(isLiveStealthBreakoutSource(historicalSource), false);
  }
});

const identity: StealthAutoRangeIdentity = {
  version: "auto_range_pine_v1",
  openedAt: 20 * FOUR_HOURS,
  anchorAt: 10 * FOUR_HOURS,
  upper: 100,
  lower: 90,
  candleCutoff: 26 * FOUR_HOURS,
};

const event = {
  openedAt: identity.openedAt,
  anchorAt: identity.anchorAt,
  upper: identity.upper,
  lower: identity.lower,
  breakoutCloseTime: 32 * FOUR_HOURS,
};

function arm(
  overrides: Partial<StealthArmedSnapshot> = {},
): StealthArmedSnapshot {
  return {
    structureKey: "auto_range_pine_v1:range",
    breakoutSource: "horizontal",
    breakoutLevel: identity.upper,
    touches: 2,
    armedAt: 26 * FOUR_HOURS,
    armedAfterFourHourCandleTime: identity.candleCutoff,
    expiresAt: 10_000 * FOUR_HOURS,
    technicalMode: "auto_range_4h",
    autoRangeIdentity: identity,
    ...overrides,
  };
}

function breakoutCandles() {
  return [
    {
      time: event.breakoutCloseTime - 2 * FOUR_HOURS,
      open: 99,
      high: 100,
      low: 98,
      close: 99,
      volume: 100,
    },
    {
      time: event.breakoutCloseTime - FOUR_HOURS,
      open: 99,
      high: 103,
      low: 99,
      close: 102,
      volume: 120,
    },
  ];
}

function holdCandles1h(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    time: event.breakoutCloseTime + index * ONE_HOUR,
    open: 100.2,
    high: 101,
    low: 100,
    close: 100.5,
    volume: 10,
  }));
}

test("Auto Range event matching includes range times and frozen bounds", () => {
  assert.equal(autoRangeEventMatchesIdentity(identity, event), true);
  assert.equal(
    autoRangeEventMatchesIdentity(identity, {
      ...event,
      openedAt: event.openedAt - FOUR_HOURS,
    }),
    false,
  );
  assert.equal(
    autoRangeEventMatchesIdentity(identity, {
      ...event,
      upper: event.upper + 1,
    }),
    false,
  );
  assert.equal(
    sameStealthAutoRangeIdentity(identity, {
      ...identity,
      venue: "binance",
    }),
    false,
    "equal levels and timestamps from different venues are distinct frozen identities",
  );
  assert.equal(
    autoRangeEventMatchesIdentity(identity, {
      ...event,
      venue: "binance",
    }),
    false,
  );
});

test("overshoot bound updates preserve the same range instance across scans and restart", () => {
  const firstScan = { ...identity };
  const overshoot = {
    ...identity,
    upper: 102,
    lower: 88,
    candleCutoff: identity.candleCutoff + FOUR_HOURS,
  };
  assert.equal(sameStealthAutoRangeInstance(firstScan, overshoot), true);
  assert.equal(sameStealthAutoRangeIdentity(firstScan, overshoot), false);

  const storedAfterOvershoot = updateStealthAutoRangeBounds(
    firstScan,
    overshoot,
    firstScan.candleCutoff,
  );
  assert.ok(storedAfterOvershoot);
  assert.equal(storedAfterOvershoot.upper, 102);
  assert.equal(storedAfterOvershoot.lower, 88);

  // The durable JSON row is re-read after a process restart on the next call.
  const reloaded = JSON.parse(
    JSON.stringify(storedAfterOvershoot),
  ) as StealthAutoRangeIdentity;
  const laterOvershoot = { ...overshoot, upper: 104, lower: 87 };
  const storedAfterRestart = updateStealthAutoRangeBounds(
    reloaded,
    laterOvershoot,
  );
  assert.ok(storedAfterRestart);
  assert.equal(storedAfterRestart.openedAt, identity.openedAt);
  assert.equal(storedAfterRestart.anchorAt, identity.anchorAt);
  assert.equal(storedAfterRestart.upper, 104);
  assert.equal(storedAfterRestart.lower, 87);

  assert.equal(
    autoRangeEventMatchesIdentity(storedAfterRestart, {
      openedAt: identity.openedAt,
      anchorAt: identity.anchorAt,
      upper: 104,
      lower: 87,
      breakoutCloseTime: 40 * FOUR_HOURS,
    }),
    true,
  );
});

test("a frozen 4H level close above the bound qualifies even when replay yields a mismatched event", () => {
  const decision = evaluateStealthArmedSetup({
    arm: arm(),
    breakoutCandles4h: breakoutCandles(),
    refinementCandles: [],
    evaluatedAt: event.breakoutCloseTime + FOUR_HOURS,
    autoRangeBreakoutEvent: {
      ...event,
      openedAt: event.openedAt - FOUR_HOURS,
    },
  });
  assert.equal(decision.status, "qualified");
});

test("event must be later than the arm cutoff and closed by evaluation time", () => {
  const future = evaluateStealthArmedSetup({
    arm: arm(),
    breakoutCandles4h: breakoutCandles(),
    refinementCandles: [],
    evaluatedAt: event.breakoutCloseTime - 1,
    autoRangeBreakoutEvent: event,
  });
  assert.equal(future.status, "armed");

  const preArm = evaluateStealthArmedSetup({
    arm: arm({
      armedAfterFourHourCandleTime: event.breakoutCloseTime - FOUR_HOURS,
    }),
    breakoutCandles4h: breakoutCandles(),
    refinementCandles: [],
    evaluatedAt: event.breakoutCloseTime + FOUR_HOURS,
    autoRangeBreakoutEvent: event,
  });
  assert.equal(preArm.status, "armed");
});

test("4H Auto Range needs two consecutive closed 1H holds, not 30m holds", () => {
  const waiting = evaluateStealthArmedSetup({
    arm: arm(),
    breakoutCandles4h: breakoutCandles(),
    breakoutCandles1h: holdCandles1h(1),
    refinementCandles: [],
    evaluatedAt: event.breakoutCloseTime + ONE_HOUR,
    autoRangeBreakoutEvent: event,
  });
  assert.equal(waiting.status, "armed");
  assert.equal(waiting.reason, "breakout_active_waiting_1h_data");
  const onlyThirtyMinute = evaluateStealthArmedSetup({
    arm: arm(),
    breakoutCandles4h: breakoutCandles(),
    refinementCandles: [
      { ...holdCandles1h(1)[0]! },
      {
        ...holdCandles1h(1)[0]!,
        time: event.breakoutCloseTime + THIRTY_MINUTES,
      },
    ],
    evaluatedAt: event.breakoutCloseTime + 2 * ONE_HOUR,
    autoRangeBreakoutEvent: event,
  });
  assert.equal(onlyThirtyMinute.status, "armed");

  const qualified = evaluateStealthArmedSetup({
    arm: arm(),
    breakoutCandles4h: breakoutCandles(),
    breakoutCandles1h: holdCandles1h(2),
    refinementCandles: [
      {
        ...holdCandles1h(1)[0]!,
        time: event.breakoutCloseTime + THIRTY_MINUTES,
      },
    ],
    evaluatedAt: event.breakoutCloseTime + 2 * ONE_HOUR,
    autoRangeBreakoutEvent: event,
  });
  assert.equal(qualified.status, "qualified");
  assert.equal(
    "refinement" in qualified ? qualified.refinement.timeframe : null,
    "1h",
  );
  assert.equal(
    "refinement" in qualified ? qualified.refinement.confirmationAt : null,
    event.breakoutCloseTime + 2 * ONE_HOUR,
  );
  assert.equal(
    "firstCrossAt" in qualified ? qualified.firstCrossAt : null,
    event.breakoutCloseTime,
  );

  for (const candles of [
    [
      { ...holdCandles1h(1)[0]!, time: event.breakoutCloseTime + ONE_HOUR },
      { ...holdCandles1h(1)[0]!, time: event.breakoutCloseTime + 2 * ONE_HOUR },
    ],
    [
      holdCandles1h(1)[0]!,
      { ...holdCandles1h(1)[0]!, time: event.breakoutCloseTime + 2 * ONE_HOUR },
    ],
  ]) {
    const missing = evaluateStealthArmedSetup({
      arm: arm(),
      breakoutCandles4h: breakoutCandles(),
      breakoutCandles1h: candles,
      refinementCandles: [],
      evaluatedAt: event.breakoutCloseTime + 3 * ONE_HOUR,
      autoRangeBreakoutEvent: event,
    });
    assert.equal(missing.status, "armed");
  }
  const exactlyAtLevel = evaluateStealthArmedSetup({
    arm: arm(),
    breakoutCandles4h: breakoutCandles(),
    breakoutCandles1h: [
      holdCandles1h(1)[0]!,
      { ...holdCandles1h(2)[1]!, close: identity.upper },
    ],
    refinementCandles: [],
    evaluatedAt: event.breakoutCloseTime + 2 * ONE_HOUR,
    autoRangeBreakoutEvent: event,
  });
  assert.equal(exactlyAtLevel.status, "invalidated");
});

test("Auto Range replay rejects an incomplete final 4H candle", () => {
  const candles = Array.from({ length: 220 }, (_, index) => ({
    time: index * FOUR_HOURS,
    open: 100,
    high: 101,
    low: 99,
    close: 100,
    closed: true,
  }));
  const complete = detectAutoRangePine(candles);
  assert.equal(complete.status, "ready");
  const incomplete = detectAutoRangePine([
    ...candles.slice(0, -1),
    { ...candles.at(-1)!, closed: false },
  ]);
  assert.equal(incomplete.status, "unknown");
  assert.equal(incomplete.latestUpsideBreakout, null);
});

test("the existing closed-1H Stealth method remains independently qualified", () => {
  const HOUR = 60 * 60_000;
  const hourly = Array.from({ length: 21 }, (_, index) => ({
    time: index * HOUR,
    open: 0.99,
    high: 0.995,
    low: 0.985,
    close: 0.99,
    volume: 100_000,
    volumeUsd: 99_000,
  }));
  hourly.push({
    time: 21 * HOUR,
    open: 1.005,
    high: 1.02,
    low: 1,
    close: 1.01,
    volume: 600_000,
    volumeUsd: 606_000,
  });
  const legacy = evaluateStealthArmedSetup({
    arm: {
      structureKey: "legacy",
      breakoutSource: "horizontal",
      breakoutLevel: 1,
      touches: 3,
      armedAt: 20 * HOUR,
      armedAfterFourHourCandleTime: 20 * HOUR,
      expiresAt: 100 * HOUR,
      technicalMode: "closed_1h_30m",
    },
    breakoutCandles4h: [],
    breakoutCandles1h: hourly,
    refinementCandles: [
      {
        time: 22 * HOUR,
        open: 1.005,
        high: 1.015,
        low: 1,
        close: 1.01,
        volume: 10,
      },
      {
        time: 22 * HOUR + THIRTY_MINUTES,
        open: 1.005,
        high: 1.015,
        low: 1,
        close: 1.01,
        volume: 10,
      },
    ],
    evaluatedAt: 23 * HOUR,
  });
  assert.equal(legacy.status, "qualified");
});

const identity1h: StealthAutoRangeIdentity = {
  version: "auto_range_pine_v1_1h",
  openedAt: 200 * ONE_HOUR,
  anchorAt: 190 * ONE_HOUR,
  upper: 100,
  lower: 90,
  candleCutoff: 220 * ONE_HOUR,
};
const event1h = {
  openedAt: identity1h.openedAt,
  anchorAt: identity1h.anchorAt,
  upper: identity1h.upper,
  lower: identity1h.lower,
  breakoutCloseTime: identity1h.candleCutoff + 2 * ONE_HOUR,
};

function autoRangeOneHourArm(
  overrides: Partial<StealthArmedSnapshot> = {},
): StealthArmedSnapshot {
  return {
    structureKey: "auto_range_pine_v1_1h:range",
    breakoutSource: "horizontal",
    breakoutLevel: identity1h.upper,
    touches: 2,
    armedAt: identity1h.candleCutoff,
    armedAfterOneHourCandleTime: identity1h.candleCutoff,
    expiresAt: 10_000 * ONE_HOUR,
    technicalMode: "auto_range_1h",
    autoRangeIdentity: identity1h,
    ...overrides,
  };
}

function autoRangeOneHourCandles() {
  return [
    {
      time: event1h.breakoutCloseTime - 2 * ONE_HOUR,
      open: 99,
      high: 100,
      low: 98,
      close: 99,
      volume: 100,
    },
    {
      time: event1h.breakoutCloseTime - ONE_HOUR,
      open: 99,
      high: 103,
      low: 99,
      close: 102,
      volume: 120,
    },
  ];
}

function autoRangeOneHourRefinement(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    time: event1h.breakoutCloseTime + index * THIRTY_MINUTES,
    open: 100.2,
    high: 101,
    low: 100,
    close: 100.5,
    volume: 10,
  }));
}

test("Auto Range identity versions reject cross-timeframe identity reuse", () => {
  assert.equal(
    sameStealthAutoRangeInstance(identity, {
      ...identity,
      version: identity1h.version,
    }),
    false,
  );
  assert.equal(
    evaluateStealthArmedSetup({
      arm: autoRangeOneHourArm({ autoRangeIdentity: identity }),
      breakoutCandles1h: autoRangeOneHourCandles(),
      refinementCandles: autoRangeOneHourRefinement(2),
      evaluatedAt: event1h.breakoutCloseTime + ONE_HOUR,
      autoRangeBreakoutEvent: event1h,
    }).status,
    "armed",
  );
});

test("1H Auto Range qualifies from the frozen-level closed 1H break when replay lost the range", () => {
  const missed = evaluateStealthArmedSetup({
    arm: autoRangeOneHourArm(),
    breakoutCandles1h: autoRangeOneHourCandles(),
    refinementCandles: autoRangeOneHourRefinement(2),
    evaluatedAt: event1h.breakoutCloseTime + ONE_HOUR,
  });
  assert.equal(missed.status, "qualified");

  const mismatched = evaluateStealthArmedSetup({
    arm: autoRangeOneHourArm(),
    breakoutCandles1h: autoRangeOneHourCandles(),
    refinementCandles: autoRangeOneHourRefinement(2),
    evaluatedAt: event1h.breakoutCloseTime + ONE_HOUR,
    autoRangeBreakoutEvent: {
      ...event1h,
      anchorAt: event1h.anchorAt - ONE_HOUR,
    },
  });
  assert.equal(mismatched.status, "qualified");
});

test("a late 1H Pine breakout is invalidated rather than replayed", () => {
  const late = evaluateStealthArmedSetup({
    arm: autoRangeOneHourArm(),
    breakoutCandles1h: autoRangeOneHourCandles(),
    refinementCandles: autoRangeOneHourRefinement(2),
    evaluatedAt: event1h.breakoutCloseTime + 24 * 60 * 60_000 + 1,
    autoRangeBreakoutEvent: event1h,
  });
  assert.equal(late.status, "invalidated");
  assert.equal(
    late.status === "invalidated" ? late.reason : null,
    "breakout_entry_window_elapsed",
  );
});

test("matched closed 1H Auto Range Pine event uses 1H candles and the 30m refinement gate", () => {
  const waiting = evaluateStealthArmedSetup({
    arm: autoRangeOneHourArm(),
    breakoutCandles1h: autoRangeOneHourCandles(),
    refinementCandles: autoRangeOneHourRefinement(0),
    evaluatedAt: event1h.breakoutCloseTime + THIRTY_MINUTES,
    autoRangeBreakoutEvent: event1h,
  });
  assert.equal(waiting.status, "armed");
  assert.equal(
    waiting.status === "armed" ? waiting.reason : null,
    "breakout_active_waiting_30m_data",
  );

  const qualified = evaluateStealthArmedSetup({
    arm: autoRangeOneHourArm(),
    breakoutCandles1h: autoRangeOneHourCandles(),
    refinementCandles: autoRangeOneHourRefinement(2),
    evaluatedAt: event1h.breakoutCloseTime + ONE_HOUR,
    autoRangeBreakoutEvent: event1h,
  });
  assert.equal(qualified.status, "qualified");
  assert.equal(
    "firstCrossAt" in qualified ? qualified.firstCrossAt : null,
    event1h.breakoutCloseTime,
  );
  assert.equal(
    "confirmation" in qualified
      ? qualified.confirmation.triggerCandle?.time
      : null,
    event1h.breakoutCloseTime - ONE_HOUR,
  );
  for (const candles of [
    [
      {
        ...autoRangeOneHourRefinement(1)[0]!,
        time: event1h.breakoutCloseTime + THIRTY_MINUTES,
      },
      {
        ...autoRangeOneHourRefinement(1)[0]!,
        time: event1h.breakoutCloseTime + ONE_HOUR,
      },
    ],
  ]) {
    const missing = evaluateStealthArmedSetup({
      arm: autoRangeOneHourArm(),
      breakoutCandles1h: autoRangeOneHourCandles(),
      refinementCandles: candles,
      evaluatedAt: event1h.breakoutCloseTime + 2 * ONE_HOUR,
      autoRangeBreakoutEvent: event1h,
    });
    assert.equal(missing.status, "armed");
  }
  const atLevel = evaluateStealthArmedSetup({
    arm: autoRangeOneHourArm(),
    breakoutCandles1h: autoRangeOneHourCandles(),
    refinementCandles: [
      autoRangeOneHourRefinement(1)[0]!,
      { ...autoRangeOneHourRefinement(2)[1]!, close: identity1h.upper },
    ],
    evaluatedAt: event1h.breakoutCloseTime + ONE_HOUR,
    autoRangeBreakoutEvent: event1h,
  });
  assert.equal(atLevel.status, "invalidated");
});

test("1H Auto Range mode does not consume the 4H candle/event path", () => {
  const decision = evaluateStealthArmedSetup({
    arm: autoRangeOneHourArm(),
    breakoutCandles4h: breakoutCandles(),
    breakoutCandles1h: [],
    refinementCandles: autoRangeOneHourRefinement(2),
    evaluatedAt: event1h.breakoutCloseTime + ONE_HOUR,
    autoRangeBreakoutEvent: event,
  });
  assert.equal(decision.status, "armed");
  assert.equal(
    decision.status === "armed" ? decision.reason : null,
    "awaiting_later_1h_auto_range_breakout",
  );
});
