import assert from "node:assert/strict";
import test from "node:test";
import {
  STEALTH_RECLASSIFIED_ARM_IDS,
  STEALTH_RECLASSIFIED_SYMBOLS,
  STEALTH_RECLASSIFIED_TRACKED_IDS,
} from "../src/lib/stealth-breakout-reclassification.js";

test("neutral Stealth reclassification is exact and excludes positive controls", () => {
  assert.equal(STEALTH_RECLASSIFIED_TRACKED_IDS.length, 31);
  assert.equal(STEALTH_RECLASSIFIED_ARM_IDS.length, 45);
  assert.equal(STEALTH_RECLASSIFIED_SYMBOLS.length, 30);
  assert.equal(new Set(STEALTH_RECLASSIFIED_TRACKED_IDS).size, 31);
  assert.equal(new Set(STEALTH_RECLASSIFIED_ARM_IDS).size, 45);
  assert.equal(new Set(STEALTH_RECLASSIFIED_SYMBOLS).size, 30);
  assert.equal(
    STEALTH_RECLASSIFIED_SYMBOLS.includes("HUMA-USDT" as never),
    false,
  );
  assert.equal(STEALTH_RECLASSIFIED_SYMBOLS.includes("S-USDT" as never), false);
  assert.equal(STEALTH_RECLASSIFIED_SYMBOLS.includes("EUL-USDT"), true);
  assert.equal(STEALTH_RECLASSIFIED_SYMBOLS.includes("NEO-USDT"), true);
  assert.equal(STEALTH_RECLASSIFIED_SYMBOLS.includes("YGG-USDT"), true);
  assert.equal(STEALTH_RECLASSIFIED_TRACKED_IDS.includes(1346), true);
  assert.equal(STEALTH_RECLASSIFIED_TRACKED_IDS.includes(1347), true);
  assert.equal(STEALTH_RECLASSIFIED_TRACKED_IDS.includes(1358), true);
  assert.equal(STEALTH_RECLASSIFIED_TRACKED_IDS.includes(1359), true);
  assert.equal(STEALTH_RECLASSIFIED_TRACKED_IDS.includes(1361), true);
  assert.equal(STEALTH_RECLASSIFIED_TRACKED_IDS.includes(1365), true);
  assert.equal(STEALTH_RECLASSIFIED_ARM_IDS.includes(735), true);
  assert.equal(STEALTH_RECLASSIFIED_SYMBOLS.includes("HOME-USDT"), true);
  assert.equal(
    STEALTH_RECLASSIFIED_SYMBOLS.includes("FLOCK-USDT" as never),
    false,
  );
});
