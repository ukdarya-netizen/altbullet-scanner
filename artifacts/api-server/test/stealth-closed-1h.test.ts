import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluateStealthArmedSetup,
  type StealthArmedSnapshot,
} from "../src/lib/stealth-breakout-armed.js";

const HOUR = 60 * 60_000;
const HALF_HOUR = HOUR / 2;

const candle = (time: number, close: number, volume = 100_000) => ({
  time,
  open: close,
  high: close * 1.005,
  low: close * 0.995,
  close,
  volume,
  volumeUsd: volume * 1.01,
});

function arm(): StealthArmedSnapshot {
  return {
    structureKey: "quiet:1",
    breakoutSource: "horizontal",
    breakoutLevel: 1,
    touches: 3,
    armedAt: 20 * HOUR + HALF_HOUR,
    armedAfterFourHourCandleTime: 20 * HOUR,
    armedAfterOneHourCandleTime: 20 * HOUR,
    expiresAt: 72 * HOUR,
    technicalMode: "closed_1h_30m",
  };
}

function hourly(volume = 100_000) {
  return [
    ...Array.from({ length: 21 }, (_, index) => candle(index * HOUR, 0.99)),
    candle(21 * HOUR, 1.01, volume),
  ];
}

function evaluate(input: {
  oneHour?: ReturnType<typeof hourly>;
  halfHour?: ReturnType<typeof hourly>;
  evaluatedAt?: number;
  setup?: StealthArmedSnapshot;
}) {
  return evaluateStealthArmedSetup({
    arm: input.setup ?? arm(),
    breakoutCandles4h: [],
    breakoutCandles1h: input.oneHour ?? hourly(),
    refinementCandles: input.halfHour ?? [],
    evaluatedAt: input.evaluatedAt ?? 22 * HOUR + HALF_HOUR,
  });
}

test("a closed 1H cross alone cannot fire; a later closed 30m hold can", () => {
  const hold = candle(22 * HOUR, 1.012);
  const pending = evaluate({
    halfHour: [hold],
    evaluatedAt: 22 * HOUR + 15 * 60_000,
  });
  assert.equal(pending.status, "armed");
  assert.equal(pending.reason, "breakout_active_waiting_30m_data");

  const qualified = evaluate({ halfHour: [hold] });
  assert.equal(qualified.status, "qualified");
  assert.equal(qualified.confirmation?.timeframe, "1h");
  assert.equal(qualified.confirmation?.triggerCandle?.time, 21 * HOUR);
  assert.equal(qualified.refinement?.timeframe, "30m");
  assert.equal(qualified.refinement?.confirmationAt, 22 * HOUR + HALF_HOUR);
  assert.equal(qualified.oneHourVolume?.gatePassed, true);
  assert.equal(qualified.oneHourVolume?.ratio, 1);
});

test("30m-only crosses and pre-arm 1H crosses cannot consume a frozen level", () => {
  assert.equal(
    evaluate({
      oneHour: hourly().map((item) => ({ ...item, close: 0.99 })),
      halfHour: [candle(22 * HOUR, 1.02)],
    }).status,
    "armed",
  );
  assert.equal(
    evaluate({
      setup: { ...arm(), armedAt: 22 * HOUR },
      halfHour: [candle(22 * HOUR, 1.02)],
    }).status,
    "armed",
  );
});

test("1H volume must have 20 prior closed candles and meet both minimums", () => {
  const hold = [candle(22 * HOUR, 1.01)];
  const shortHistory = evaluate({
    oneHour: hourly().slice(-10),
    halfHour: hold,
  });
  assert.equal(shortHistory.status, "armed");
  assert.equal(shortHistory.oneHourVolume?.reason, "insufficient_history");
  for (const [volume, reason] of [
    [20_000, "below_relative_volume"],
    [40_000, "below_turnover"],
  ] as const) {
    const decision = evaluate({ oneHour: hourly(volume), halfHour: hold });
    assert.equal(decision.status, "armed");
    assert.equal(decision.oneHourVolume?.reason, reason);
  }
  assert.equal(
    evaluate({ oneHour: hourly(50_000), halfHour: hold }).status,
    "qualified",
  );
});

test("a 30m close below the frozen level invalidates the waiting setup", () => {
  const result = evaluate({
    halfHour: [candle(22 * HOUR, 0.999), candle(22 * HOUR + HALF_HOUR, 1.02)],
    evaluatedAt: 23 * HOUR,
  });
  assert.equal(result.status, "invalidated");
  assert.equal(result.reason, "breakout_rejected_below_level");
});

test("a stale crossing never opens a late trade after the entry window", () => {
  const result = evaluate({
    halfHour: [candle(22 * HOUR, 1.01)],
    evaluatedAt: 28 * HOUR + 1,
  });
  assert.equal(result.status, "invalidated");
  assert.equal(result.reason, "breakout_entry_window_elapsed");
});

test("legacy pending raw 30m state is not accepted as a new 1H cross", () => {
  const result = evaluate({
    setup: {
      ...arm(),
      rawCrossObservedAt: HOUR,
      rawCrossCandleAt: HALF_HOUR,
      lastCandleAt: HALF_HOUR,
    },
    oneHour: hourly().map((item) => ({ ...item, close: 0.99 })),
    halfHour: [candle(22 * HOUR, 1.02)],
  });
  assert.equal(result.status, "armed");
});
