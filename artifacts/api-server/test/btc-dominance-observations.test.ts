import assert from "node:assert/strict";
import test from "node:test";
import { observationsFromSummary } from "../src/lib/btc-dominance-observations.js";
import { buildDailyMarketContext } from "../src/lib/btc-outcome-context.js";
import { getCoinGeckoBitcoinDominance } from "../src/lib/coinglass_btc_dominance.js";
import type { BitcoinDominanceSummary } from "../src/lib/coinglass_btc_dominance.js";

const now = new Date("2026-10-15T10:00:00.000Z");

function summary(
  history: BitcoinDominanceSummary["history"],
): BitcoinDominanceSummary {
  return {
    source: "coingecko",
    current: 59,
    change24h: null,
    change7d: null,
    updatedAt: "2026-10-15T09:00:00.000Z",
    history,
  };
}

function sample(timestamp: string, dominance: number) {
  return { timestamp, dominance, btcPrice: null, btcMarketCap: null };
}

test("only provider-timestamped, valid observations are eligible for durable storage", () => {
  assert.deepEqual(
    observationsFromSummary(
      summary([
        sample("2026-10-15T09:00:00Z", 59),
        sample("2026-10-15T09:00:00Z", 59),
        sample("2026-10-16T09:00:00Z", 60),
        sample("2026-08-01T09:00:00Z", 57),
        sample("invalid", 58),
        sample("2026-10-14T09:00:00Z", 101),
      ]),
      now,
    ),
    [
      {
        observedAt: "2026-10-15T09:00:00.000Z",
        value: 59,
        source: "coingecko",
      },
    ],
  );
});

test("provider outage retains real stored days and leaves gaps even with daily BTC prices", () => {
  // The provider returns null. Only observations committed before the outage
  // (and timestamped signal snapshots) can contribute to the chart.
  const stored = [
    {
      observedAt: "2026-10-12T21:00:00Z",
      value: 58,
      source: "coingecko" as const,
    },
    {
      observedAt: "2026-10-14T09:00:00Z",
      value: 59,
      source: "coinglass" as const,
    },
  ];
  const days = buildDailyMarketContext(
    [
      { observedAt: "2026-10-13T08:00:00Z", value: 100 },
      { observedAt: "2026-10-14T08:00:00Z", value: 101 },
      { observedAt: "2026-10-15T08:00:00Z", value: 102 },
    ],
    [
      ...stored.map((point) => ({
        observedAt: point.observedAt,
        value: point.value,
        source: point.source,
      })),
    ],
    now,
  );
  assert.equal(days.length, 30);
  assert.deepEqual(
    days.filter((day) => day.btcDominance != null).map((day) => day.day),
    ["2026-10-13", "2026-10-14"],
  );
  assert.equal(
    days.find((day) => day.day === "2026-10-13")?.dominanceSource,
    "coingecko",
  );
  assert.equal(
    days.find((day) => day.day === "2026-10-14")?.dominanceObservedAt,
    "2026-10-14T09:00:00.000Z",
  );
  assert.equal(
    days.find((day) => day.day === "2026-10-14")?.dominanceChangePoints,
    1,
  );
  assert.equal(
    days.find((day) => day.day === "2026-10-15")?.btcDominance,
    null,
  );
  assert.equal(
    days.find((day) => day.day === "2026-10-15")?.dominanceChangePoints,
    null,
  );
});

test("CoinGecko HTTP failure and responses without provider time produce no observation", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(null, { status: 503 });
    assert.equal(await getCoinGeckoBitcoinDominance(), null);
    globalThis.fetch = async () =>
      Response.json({
        data: { market_cap_percentage: { btc: 59 } },
      });
    assert.equal(await getCoinGeckoBitcoinDominance(), null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
