import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = readFileSync(
  new URL("../src/lib/reject-reasons.ts", import.meta.url),
  "utf8",
);
const keys = [...src.matchAll(/^\s{2}"?([A-Za-z0-9_]+)"?:\s/gm)].map(
  (m) => m[1],
);

// Frequent codes from scan_reject_log plus ABNeon detector reasons.
const required = [
  "oi1h_low",
  "rsi1h_high",
  "price3h_low",
  "prev_oi_not_flush",
  "oi_low",
  "oi30m_low",
  "price4h_low",
  "no_pool_row",
  "not_in_pool",
  "cg_no_data_low",
  "oi_high",
  "spot_vol_low",
  "price24h_range",
  "deepNeg",
  "not_exhausted",
  "vol4h_low",
  "stalePump",
  "range_1h_no_confirmed_range",
  "qualified_fire_gate_closed",
  "awaiting_later_1h_reaction",
  "reaction_window_expired",
  "support_invalidated_before_reaction",
  "missing_frozen_order_block_evidence",
];
test("frequent reject codes have Russian text", () => {
  for (const k of required) assert.ok(keys.includes(k), `missing ${k}`);
});

test("readable text passes through; unknown codes get neutral text; ABNeon states are mapped", () => {
  assert.match(src, /\[А-Яа-яЁё\]/);
  assert.match(src, /Причина отказа \(без описания\)/);
  for (const k of [
    "awaiting_later_1h_reaction",
    "later_closed_1h_bullish_reaction",
  ])
    assert.ok(keys.includes(k), `missing ${k}`);
});
