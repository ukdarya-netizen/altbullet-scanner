import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import {
  clearMemoForTests,
  memoLookup,
  memoPolicy,
  memoStore,
  runWithoutMemo,
  memoDisabled,
} from "../src/lib/coinglass-memo.js";

const BASE = "https://open-api-v4.coinglass.com/api/futures";
const T0 = Date.UTC(2026, 9, 19, 12, 3, 0); // 12:03 UTC
const snap = (data: unknown[], code = "0", status = 200) => ({
  status,
  statusText: "",
  headers: [] as Array<[string, string]>,
  body: new TextEncoder().encode(JSON.stringify({ code, data })),
});
const url = (limit: number, extra = "") =>
  `${BASE}/aggregated-taker-buy-sell-volume/history?symbol=BTC&interval=15m&limit=${limit}${extra}`;

beforeEach(clearMemoForTests);

test("series is valid until the next bar boundary, capped at 15 min", () => {
  assert.equal(memoPolicy(url(2), T0)!.ttlMs, 12 * 60_000);
  const h1 = memoPolicy(`${BASE}/price/history?symbol=BTC&interval=4h`, T0)!;
  assert.equal(h1.ttlMs, 15 * 60_000);
});

test("non-memoizable endpoints are skipped", () => {
  assert.equal(
    memoPolicy(`${BASE}/orderbook/large-limit-order?symbol=BTC`, T0),
    null,
  );
});

test("a wider cached series answers a smaller limit with the newest bars", () => {
  const wide = memoPolicy(url(120), T0)!;
  memoStore(wide, snap([1, 2, 3, 4, 5]), T0);
  const hit = memoLookup(memoPolicy(url(2), T0 + 1000)!, T0 + 1000)!;
  assert.deepEqual(
    JSON.parse(new TextDecoder().decode(hit.snapshot.body)).data,
    [4, 5],
  );
  assert.equal(memoLookup(memoPolicy(url(500), T0)!, T0), null);
});

test("expires at the bar boundary", () => {
  memoStore(memoPolicy(url(2), T0)!, snap([1, 2]), T0);
  assert.ok(memoLookup(memoPolicy(url(2), T0)!, T0 + 11 * 60_000));
  assert.equal(memoLookup(memoPolicy(url(2), T0)!, T0 + 12 * 60_000 + 1), null);
});

test("errors and empty series are never stored", () => {
  const p = memoPolicy(url(2), T0)!;
  memoStore(p, snap([1], "0", 429), T0);
  memoStore(p, snap([1], "400"), T0);
  memoStore(p, snap([]), T0);
  assert.equal(memoLookup(p, T0), null);
});

test("different symbol or interval never shares an entry", () => {
  memoStore(memoPolicy(url(2), T0)!, snap([1, 2]), T0);
  assert.equal(
    memoLookup(memoPolicy(url(2).replace("BTC", "ETH"), T0)!, T0),
    null,
  );
  assert.equal(
    memoLookup(memoPolicy(url(2).replace("15m", "1h"), T0)!, T0),
    null,
  );
});

test("runWithoutMemo disables the memo for the async chain", async () => {
  assert.equal(memoDisabled(), false);
  await runWithoutMemo(async () => {
    await Promise.resolve();
    assert.equal(memoDisabled(), true);
  });
});
