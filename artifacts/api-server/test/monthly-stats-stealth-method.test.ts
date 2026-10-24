import assert from "node:assert/strict";
import test from "node:test";
import { ACTIVE_PATTERN_KEYS } from "../src/lib/dead-patterns.js";
import { ensureActiveArchivePatternRows } from "../src/routes/tracker.js";

test("standalone Neon remains an active pattern separate from Stealth provenance", () => {
  assert.ok(ACTIVE_PATTERN_KEYS.includes("neon_support_bounce"));
  assert.ok(
    ACTIVE_PATTERN_KEYS.indexOf("stealth_breakout") <
      ACTIVE_PATTERN_KEYS.indexOf("neon_support_bounce"),
  );
  assert.ok(
    ACTIVE_PATTERN_KEYS.indexOf("neon_support_bounce") <
      ACTIVE_PATTERN_KEYS.indexOf("impulse_buy"),
  );
  assert.ok(!ACTIVE_PATTERN_KEYS.includes("price_led_momentum" as never));
});

test("monthly archive adds zero baselines in canonical active order", () => {
  const rows = ensureActiveArchivePatternRows([
    { sentimentKey: "whale_watch", total: 2 },
    { sentimentKey: "demark", total: 1 },
  ]);

  assert.deepEqual(
    rows.slice(0, 4).map((row) => [row.sentimentKey, row.total]),
    [
      ["liquidation_cascade", 0],
      ["stealth_breakout", 0],
      ["neon_support_bounce", 0],
      ["impulse_buy", 0],
    ],
  );
  assert.deepEqual(
    rows.slice(4).map((row) => row.sentimentKey),
    ["demark", "whale_watch"],
  );
});
