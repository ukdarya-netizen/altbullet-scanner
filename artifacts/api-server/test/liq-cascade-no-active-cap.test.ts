import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("Liquidation Cascade admission is never limited by active signal count", () => {
  const source = readFileSync(
    new URL("../src/lib/liq-cascade-watcher.ts", import.meta.url),
    "utf8",
  );

  assert.doesNotMatch(source, /MAX_CONCURRENT_LIQ_CASCADE/);
  assert.doesNotMatch(source, /remainingCapacity/);
  assert.doesNotMatch(source, /concurrent capacity check/);
  assert.doesNotMatch(source, /лимит одновременных сигналов/);
});
