import test from "node:test";
import assert from "node:assert/strict";

const HOUR = 3_600_000;

process.env.CoinGlassAPI = "test-key";
const {
  drainClosedVolumeCacheHits,
  getAggFuturesVolumeByInterval,
  resetClosedVolumeCacheForTests,
} = await import("../src/lib/coinglass_taker.js");

import { clearMemoForTests } from "../src/lib/coinglass-memo.js";

test("second request for closed 1H bars is served from cache without HTTP", async () => {
  resetClosedVolumeCacheForTests();
  const now = Date.UTC(2026, 9, 19, 14, 20);
  const latestClosed = Math.floor(now / HOUR) * HOUR - HOUR;
  let calls = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    calls++;
    const data = Array.from({ length: 39 }, (_, i) => ({
      time: latestClosed - (38 - i) * HOUR,
      aggregated_buy_volume_usd: 1,
      aggregated_sell_volume_usd: 2,
    }));
    return new Response(JSON.stringify({ code: "0", data }), { status: 200 });
  }) as typeof fetch;
  try {
    const first = await getAggFuturesVolumeByInterval(
      "ATOM-USDT",
      "1h",
      40,
      now,
    );
    const second = await getAggFuturesVolumeByInterval(
      "ATOM-USDT",
      "1h",
      30,
      now,
    );
    assert.equal(calls, 1);
    assert.equal(first, second);
    assert.equal(drainClosedVolumeCacheHits(), 1);
    // After the next bar closes the cached series lacks the new bar: refetch.
    // (The response memo runs on the real clock; clear it to test this cache.)
    clearMemoForTests();
    await getAggFuturesVolumeByInterval("ATOM-USDT", "1h", 30, now + HOUR);
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = realFetch;
  }
});
