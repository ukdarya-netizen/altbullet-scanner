import test from "node:test";
import assert from "node:assert/strict";
import { rehydrateUnlocks } from "../src/lib/unlock-rehydrate.js";

test("rehydrateUnlocks recomputes days and drops passed events", () => {
  const now = Date.UTC(2026, 9, 19, 12);
  const out = rehydrateUnlocks(
    [
      [
        "AAA",
        { daysUntil: 9, pctSupply: 2, unlockTime: now + 2.5 * 86_400_000 },
      ],
      ["BBB", { daysUntil: 1, pctSupply: 2, unlockTime: now - 2 * 3_600_000 }],
    ],
    now,
  );
  assert.equal(out.get("AAA")?.daysUntil, 2);
  assert.equal(out.has("BBB"), false);
});
