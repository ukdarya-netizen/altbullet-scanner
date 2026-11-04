import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildBtcTickerContext } from "../src/lib/btc-ticker-context.js";

describe("BTC ticker context", () => {
  it("parses change and price", () => {
    assert.deepEqual(
      buildBtcTickerContext({
        priceChangePercent: "-1.25",
        lastPrice: "65000.5",
      }),
      { change24h: -1.25, price: 65000.5 },
    );
  });
  it("returns nulls when the ticker is missing or invalid", () => {
    const empty = { change24h: null, price: null };
    assert.deepEqual(buildBtcTickerContext(null), empty);
    assert.deepEqual(
      buildBtcTickerContext({ priceChangePercent: "", lastPrice: "0" }),
      empty,
    );
    assert.deepEqual(
      buildBtcTickerContext({ priceChangePercent: "x", lastPrice: "NaN" }),
      empty,
    );
  });
});
