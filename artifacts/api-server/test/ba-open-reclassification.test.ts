import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const source = readFileSync(
  new URL("../src/index.ts", import.meta.url),
  "utf8",
);
const migration = source.match(
  /async function reclassifyOpenBullishAccumulationPositions[\s\S]*?\n}\n/,
)?.[0];

describe("Bullish Accumulation open-position reclassification", () => {
  it("is a production-only administrative reclassification", () => {
    assert.ok(migration);
    assert.match(source, /process\.env\.NODE_ENV === "production"/);
    assert.match(migration, /status = 'reclassified'/);
    assert.match(migration, /cancel_reason = 'pattern_removed'/);
    assert.match(migration, /sentiment_key = 'bullish_accumulation'/);
    assert.match(migration, /status IN \('active', 'in_run'\)/);
  });

  it("clears outcome fields and has no delivery or outcome side effects", () => {
    assert.ok(migration);
    for (const field of [
      "exit_price = NULL",
      "pnl_percent = NULL",
      "closed_at = NULL",
      "trailing_stop_level = NULL",
      "last_smart_cancel_check_at = NULL",
    ]) {
      assert.match(migration, new RegExp(field.replaceAll(" ", "\\s+")));
    }
    assert.doesNotMatch(
      migration,
      /broadcast|telegram|outbox|trajectory|health_event|exit_metric|cancel_outcome/i,
    );
  });
});
