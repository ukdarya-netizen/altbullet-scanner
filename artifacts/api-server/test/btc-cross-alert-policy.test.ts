import assert from "node:assert/strict";
import test from "node:test";
import {
  buildBtcCrossHistory,
  formatPgDate,
  findCrossingEvents,
  type CrossObservationDay,
} from "../src/lib/btc-cross-alert-policy.js";

const anchor = {
  day: "2025-01-01",
  btcPrice: 100,
  btcDominance: 50,
};

function paired(
  day: string,
  btcPrice: number,
  btcDominance: number,
): CrossObservationDay {
  return {
    day,
    btcPrice,
    btcDominance,
    dominanceObservedAt: new Date(`${day}T12:00:00.000Z`),
    dominanceSource: "coinglass",
  };
}

test("does not create a first crossing from the shared anchor baseline", () => {
  const history = buildBtcCrossHistory(
    [paired("2025-01-01", 100, 50), paired("2025-01-02", 110, 50)],
    anchor,
  );
  assert.deepEqual(findCrossingEvents(history, "2025-01-01"), []);
});

test("gaps break crossing comparisons rather than bridging missing closed days", () => {
  const history = buildBtcCrossHistory(
    [
      paired("2025-01-01", 100, 50),
      paired("2025-01-02", 110, 50),
      {
        day: "2025-01-03",
        btcPrice: null,
        btcDominance: null,
        dominanceObservedAt: null,
        dominanceSource: null,
      },
      paired("2025-01-04", 90, 50),
    ],
    anchor,
  );
  assert.deepEqual(findCrossingEvents(history, "2025-01-02"), []);
});

test("reports crossing direction from the strict relative-performance sign", () => {
  const history = buildBtcCrossHistory(
    [
      paired("2025-01-01", 100, 50),
      paired("2025-01-02", 110, 50),
      paired("2025-01-03", 90, 50),
    ],
    anchor,
  );
  assert.deepEqual(findCrossingEvents(history, "2025-01-02"), [
    {
      day: "2025-01-03",
      direction: "dominance_outperformed",
      btcPrice: 90,
      btcDominance: 50,
    },
  ]);

  const inverse = buildBtcCrossHistory(
    [
      paired("2025-01-01", 100, 50),
      paired("2025-01-02", 90, 50),
      paired("2025-01-03", 110, 50),
    ],
    anchor,
  );
  assert.equal(
    findCrossingEvents(inverse, "2025-01-02")[0]?.direction,
    "btc_outperformed",
  );
});

test("repeated reconciliation inputs produce the same unique event days", () => {
  const history = buildBtcCrossHistory(
    [
      paired("2025-01-01", 100, 50),
      paired("2025-01-02", 110, 50),
      paired("2025-01-03", 90, 50),
      paired("2025-01-04", 110, 50),
    ],
    anchor,
  );
  const first = findCrossingEvents(history, "2025-01-01");
  const repeated = findCrossingEvents(history, "2025-01-01");
  assert.deepEqual(repeated, first);
  assert.equal(
    new Set(repeated.map((event) => event.day)).size,
    repeated.length,
  );
});

test("normalizes database DATE values without PostgreSQL Date.toString text", () => {
  assert.equal(
    formatPgDate(new Date("2025-01-02T00:00:00.000Z")),
    "2025-01-02",
  );
  assert.equal(formatPgDate("2025-01-02"), "2025-01-02");
});

test("computes each available series independently but requires a pair to alert", () => {
  const history = buildBtcCrossHistory(
    [
      paired("2025-01-01", 100, 50),
      {
        ...paired("2025-01-02", 110, 50),
        btcDominance: null,
        dominanceObservedAt: null,
        dominanceSource: null,
      },
      {
        ...paired("2025-01-03", 90, 55),
        btcPrice: null,
      },
    ],
    anchor,
  );
  assert.equal(history.days[1]!.btcChangePercent, 10);
  assert.equal(history.days[1]!.dominanceChangePercent, null);
  assert.equal(history.days[2]!.btcChangePercent, null);
  assert.equal(history.days[2]!.dominanceChangePercent, 10);
  assert.deepEqual(findCrossingEvents(history, "2025-01-01"), []);
});

test("bounded re-evaluation catches late observations without crossing gaps", () => {
  const missingLateData = buildBtcCrossHistory(
    [
      paired("2025-01-01", 100, 50),
      {
        ...paired("2025-01-02", 110, 50),
        btcDominance: null,
        dominanceObservedAt: null,
        dominanceSource: null,
      },
      paired("2025-01-03", 90, 50),
    ],
    anchor,
  );
  assert.deepEqual(findCrossingEvents(missingLateData, "2025-01-01"), []);

  const lateObservationArrived = buildBtcCrossHistory(
    [
      paired("2025-01-01", 100, 50),
      paired("2025-01-02", 110, 50),
      paired("2025-01-03", 90, 50),
    ],
    anchor,
  );
  assert.deepEqual(findCrossingEvents(lateObservationArrived, "2025-01-01"), [
    {
      day: "2025-01-03",
      direction: "dominance_outperformed",
      btcPrice: 90,
      btcDominance: 50,
    },
  ]);
});
