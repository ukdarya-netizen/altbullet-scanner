import assert from "node:assert/strict";
import test from "node:test";
import { buildBtcMarketHistory } from "../src/lib/btc-market-history.js";

test("keeps BTC price and recorded BTC.D visible when CoinGlass has only a live fallback", () => {
  const result = buildBtcMarketHistory({
    now: new Date("2025-04-10T12:00:00.000Z"),
    dominance: {
      current: 59,
      change24h: null,
      change7d: null,
      updatedAt: "2025-04-10T11:00:00.000Z",
      source: "coingecko",
      history: [
        {
          timestamp: "2025-04-10T11:00:00.000Z",
          dominance: 59,
          btcPrice: null,
          btcMarketCap: null,
        },
      ],
    },
    signalDominance: [
      { observedAt: "2025-04-08T09:00:00.000Z", value: 58 },
      { observedAt: "2025-04-08T11:00:00.000Z", value: 58.4 },
      { observedAt: "2025-04-09T11:00:00.000Z", value: 58.7 },
      { observedAt: "2025-03-01T00:00:00.000Z", value: 12 },
    ],
    priceCandles: [
      { time: Date.parse("2025-04-08"), close: "81000" },
      { time: Date.parse("2025-04-09"), close: "82000" },
      { time: Date.parse("2025-04-10"), close: "83000" },
    ],
    priceSnapshots: [{ observedAt: "2025-04-10T11:00:00.000Z", price: 82500 }],
  });
  assert.equal(result.dominanceSource, "signal_snapshots");
  assert.equal(result.priceSource, "bingx");
  assert.deepEqual(result.history, [
    {
      timestamp: "2025-04-08T00:00:00.000Z",
      dominance: 58.4,
      btcPrice: 81000,
    },
    {
      timestamp: "2025-04-09T00:00:00.000Z",
      dominance: 58.7,
      btcPrice: 82000,
    },
    {
      timestamp: "2025-04-10T00:00:00.000Z",
      dominance: 59,
      btcPrice: 82500,
    },
  ]);
});

test("uses real CoinGlass history when it exists and does not invent missing days", () => {
  const result = buildBtcMarketHistory({
    now: new Date("2025-04-10T12:00:00.000Z"),
    dominance: {
      current: 60,
      change24h: null,
      change7d: null,
      updatedAt: "2025-04-10T00:00:00.000Z",
      source: "coinglass",
      history: [
        {
          timestamp: "2025-04-07T00:00:00.000Z",
          dominance: 59,
          btcPrice: null,
          btcMarketCap: null,
        },
        {
          timestamp: "2025-04-10T00:00:00.000Z",
          dominance: 60,
          btcPrice: null,
          btcMarketCap: null,
        },
      ],
    },
    signalDominance: [{ observedAt: "2025-04-08T12:00:00.000Z", value: 42 }],
    priceCandles: [],
    priceSnapshots: [],
  });
  assert.equal(result.dominanceSource, "coinglass");
  assert.deepEqual(
    result.history.map((point) => point.dominance),
    [59, 60],
  );
});
