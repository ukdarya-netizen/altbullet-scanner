import test from "node:test";
import assert from "node:assert/strict";
import { oiExceedsMarketCapCollisionLimit } from "../src/lib/coinglass_oi.js";

test("ATOM-like OI (18% of mcap) is not a collision", () => {
  assert.equal(
    oiExceedsMarketCapCollisionLimit(146_950_079, 800_000_000),
    false,
  );
});
test("OI 100x above market cap is a collision", () => {
  assert.equal(
    oiExceedsMarketCapCollisionLimit(2_000_000_000, 20_000_000),
    true,
  );
});
test("unknown market cap never marks a collision", () => {
  assert.equal(oiExceedsMarketCapCollisionLimit(1e9, null), false);
});

import { oiCollisionByMarketCaps } from "../src/lib/coinglass_oi.js";

test("CoinGecko ticker mismatch alone does not flag a collision (CT-like)", () => {
  // OI 26.4M; CoinGecko mcap 31k (wrong coin), CoinGlass mcap 64M.
  assert.equal(
    oiCollisionByMarketCaps(26_445_833, [31_195, 64_199_537]),
    false,
  );
});
test("collision requires every known market cap to be exceeded", () => {
  assert.equal(oiCollisionByMarketCaps(2e9, [20e6, 15e6]), true);
  assert.equal(oiCollisionByMarketCaps(2e9, [null, undefined]), false);
});
