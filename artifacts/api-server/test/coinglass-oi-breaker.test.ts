import assert from "node:assert/strict";
import { test } from "node:test";

const candles = Array.from({ length: 50 }, (_, index) => ({
  time: 1_700_000_000 + index * 1_800,
  close: String(100 + index),
}));

test("CoinGlass OI breaker counts upstream faults, not coverage outcomes", async () => {
  const originalFetch = globalThis.fetch;
  const originalRandom = Math.random;
  const originalCgKey = process.env.COINGLASS_API_KEY;
  process.env.COINGLASS_API_KEY = "test-coinglass-key";
  Math.random = () => 0;

  try {
    const {
      batchGetCoinglassOI,
      resetCoinglassOiStateForTests,
      setCgSupportedCoinsForTests,
    } = await import("../src/lib/coinglass_oi.js");

    let requests = 0;
    // Every replacement handles all URLs, so health-alert/Telegram fetches are
    // stubbed along with CoinGlass and cannot reach the network.
    globalThis.fetch = (async (input) => {
      if (!String(input).includes("open-api-v4.coinglass.com")) {
        return new Response(JSON.stringify({ ok: true, result: {} }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      requests++;
      return new Response(JSON.stringify({ code: "0", data: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    resetCoinglassOiStateForTests();
    setCgSupportedCoinsForTests(["BTC"]);
    const unsupported = await batchGetCoinglassOI(["NOTLISTED-USDT"]);
    assert.equal(
      unsupported.get("NOTLISTED-USDT")?.unavailableReason,
      "unsupported",
    );
    assert.equal(requests, 0, "whitelist rejection should not issue a request");

    resetCoinglassOiStateForTests();
    const emptySymbols = Array.from(
      { length: 6 },
      (_, index) => `EMPTY${index}-USDT`,
    );
    const empty = await batchGetCoinglassOI(emptySymbols);
    assert.ok(
      emptySymbols.every(
        (symbol) => empty.get(symbol)?.unavailableReason === "empty",
      ),
    );

    requests = 0;
    globalThis.fetch = (async (input) => {
      if (!String(input).includes("open-api-v4.coinglass.com")) {
        return new Response(JSON.stringify({ ok: true, result: {} }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      requests++;
      return new Response(JSON.stringify({ code: "0", data: candles }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    const recovered = await batchGetCoinglassOI(["RECOVERED-USDT"]);
    assert.equal(recovered.get("RECOVERED-USDT")?.available, true);
    // The OI request itself is issued (the breaker did not block it). The exact
    // count is not asserted: a market-cap lookup may add a request.
    assert.ok(
      requests >= 1,
      "six valid empty responses must not trip the breaker",
    );

    globalThis.fetch = (async (input) =>
      new Response(
        JSON.stringify(
          String(input).includes("open-api-v4.coinglass.com")
            ? { code: "500", data: [] }
            : { ok: true, result: {} },
        ),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      )) as typeof fetch;
    resetCoinglassOiStateForTests();
    const outageSymbols = Array.from(
      { length: 18 },
      (_, index) => `OUTAGE${index}-USDT`,
    );
    const outage = await batchGetCoinglassOI(outageSymbols);
    assert.ok(
      [...outage.values()].some(
        (result) => result.unavailableReason === "breaker_skip",
      ),
      "breaker skips should be visible as a low-cardinality reason",
    );
    assert.ok(
      [...outage.values()].some(
        (result) => result.unavailableReason === "http_5xx",
      ),
      "HTTP 5xx responses should retain their failure reason",
    );

    resetCoinglassOiStateForTests();
    globalThis.fetch = (async (input) =>
      new Response(
        JSON.stringify(
          String(input).includes("open-api-v4.coinglass.com")
            ? { code: "429", msg: "rate limit" }
            : { ok: true, result: {} },
        ),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      )) as typeof fetch;
    const body429 = await batchGetCoinglassOI(["BODY429-USDT"]);
    assert.equal(body429.get("BODY429-USDT")?.unavailableReason, "http_429");

    resetCoinglassOiStateForTests();
    globalThis.fetch = (async (input) =>
      new Response(
        String(input).includes("open-api-v4.coinglass.com")
          ? "not-json"
          : JSON.stringify({ ok: true, result: {} }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      )) as typeof fetch;
    const malformed = await batchGetCoinglassOI(["MALFORMED-USDT"]);
    assert.equal(
      malformed.get("MALFORMED-USDT")?.unavailableReason,
      "upstream_error",
    );
  } finally {
    globalThis.fetch = originalFetch;
    Math.random = originalRandom;
    if (originalCgKey === undefined) delete process.env.COINGLASS_API_KEY;
    else process.env.COINGLASS_API_KEY = originalCgKey;
  }
});
