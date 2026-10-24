import assert from "node:assert/strict";
import test from "node:test";
import { buildMemberSymbolStatusHistory } from "../src/lib/scanner-member-symbol-history.js";

test("member history exposes status and approved historical metrics, not owner diagnostics", () => {
  const now = new Date("2026-09-27T08:30:00.000Z");
  // Source rows carry owner-only fields; passing variables (rather than fresh
  // object literals) verifies the allowlist without excess-property errors.
  const prescanRow = {
    ts: now,
    score: 42,
    price24h: 1.5,
    oi30m: null,
    oi1h: 2,
    oi4h: 3,
    cvd30m: true,
    netBuyPct: 90,
  };
  const watchRow = {
    id: 5,
    status: "fired",
    triggerTf: "1h",
    addedAt: now,
    expiresAt: now,
    firedAt: now,
    volStatusReason: "owner-only reason",
    priceAtEntry: 100,
  };
  const result = buildMemberSymbolStatusHistory(
    "ETH-USDT",
    [prescanRow],
    [watchRow],
  );
  assert.deepEqual(result, {
    symbol: "ETH-USDT",
    prescanHistory: [
      {
        ts: now.toISOString(),
        score: 42,
        price24h: 1.5,
        oi30m: null,
        oi1h: 2,
        oi4h: 3,
      },
    ],
    oiWatchHistory: [
      {
        id: 5,
        status: "fired",
        triggerTf: "1h",
        addedAt: now.toISOString(),
        expiresAt: now.toISOString(),
        firedAt: now.toISOString(),
      },
    ],
  });
});
