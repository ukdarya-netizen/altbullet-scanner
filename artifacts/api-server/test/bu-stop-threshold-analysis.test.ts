import assert from "node:assert/strict";
import { test } from "node:test";
import {
  analyzeBuStopThresholds,
  analyzeBuStopThresholdsByPattern,
} from "../src/lib/bu-stop-threshold-analysis.js";

function trajectory(
  id: number,
  moves: Partial<Record<number, number>>,
): {
  id: number;
  symbol: string;
  closedAt: string;
  samples: { hourAfterClose: number; movePct: number }[];
} {
  return {
    id,
    symbol: `TEST${id}-USDT`,
    closedAt: "2026-08-01T00:00:00.000Z",
    samples: Array.from({ length: 72 }, (_, index) => ({
      hourAfterClose: index + 1,
      movePct: moves[index + 1] ?? 1,
    })),
  };
}

test("threshold analysis refuses an incomplete cohort", () => {
  const result = analyzeBuStopThresholds([
    trajectory(1, { 72: 48.6 }),
    trajectory(2, { 72: 4 }),
  ]);

  assert.equal(result.qualified, false);
  assert.equal(result.sampleSize, 2);
  assert.equal(result.recommendation, "keep_5_until_cohort");
  assert.equal(result.thresholds[0]?.maxMovementAfterBuPct, 48.6);
});

test("threshold analysis compares continuation and lost protection", () => {
  const trades = [
    ...Array.from({ length: 9 }, (_, index) =>
      trajectory(index + 1, {
        10: index < 5 ? 11 : 7,
        20: index < 5 ? 14 : -2,
        72: index < 5 ? 12 : 3,
      }),
    ),
    trajectory(10, { 2: -2, 10: 12, 20: 14, 72: 8 }),
  ];
  const result = analyzeBuStopThresholds(trades);

  assert.equal(result.qualified, true);
  assert.equal(result.sampleSize, 10);
  assert.equal(result.thresholds[0]?.continuationCount, 10);
  assert.equal(result.thresholds[1]?.continuationCount, 6);
  assert.equal(result.thresholds[1]?.protectionLostCount, 5);
  assert.equal(result.thresholds[2]?.continuationCount, 6);
  assert.equal(result.thresholds[2]?.protectionLostCount, 5);
  assert.equal(result.thresholds[2]?.notReachedThresholdCount, 4);
  assert.equal(result.recommendation, "keep_5");
});

test("threshold analysis selects the highest safe milestone", () => {
  const result = analyzeBuStopThresholds(
    Array.from({ length: 10 }, (_, index) =>
      trajectory(index + 1, { 10: 16, 72: 12 }),
    ),
  );

  assert.equal(result.qualified, true);
  assert.equal(result.thresholds[2]?.continuationRatePct, 100);
  assert.equal(result.thresholds[2]?.protectionLostCount, 0);
  assert.equal(result.recommendation, "move_to_10");
});

test("threshold analysis qualifies each pattern independently", () => {
  const rows = [
    ...Array.from({ length: 10 }, (_, index) => ({
      ...trajectory(index + 1, { 10: 16, 72: 12 }),
      pattern: "price_led_momentum",
    })),
    ...Array.from({ length: 3 }, (_, index) => ({
      ...trajectory(index + 101, { 72: 4 }),
      pattern: "balanced_grind",
    })),
    { ...trajectory(999, { 72: 20 }), pattern: null },
  ];

  const result = analyzeBuStopThresholdsByPattern(rows);

  assert.deepEqual(
    result.map((row) => row.pattern),
    ["balanced_grind", "price_led_momentum"],
  );
  assert.equal(result[0]?.analysis.qualified, false);
  assert.equal(result[0]?.analysis.sampleSize, 3);
  assert.equal(result[1]?.analysis.qualified, true);
  assert.equal(result[1]?.analysis.recommendation, "move_to_10");
});
