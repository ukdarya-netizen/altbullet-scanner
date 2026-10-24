import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const source = readFileSync(
  new URL("../src/index.ts", import.meta.url),
  "utf8",
);
const correction = source.match(
  /async function reclassifyOpenPlmPositionsExcludedByP3hGate[\s\S]*?\n}\n/,
)?.[0];

describe("PLM pre-p3h-gate open-position reclassification", () => {
  it("is fenced to the three reviewed production positions", () => {
    assert.ok(correction);
    assert.match(correction, /\(1623, 'CHZ-USDT', 5662\)/);
    assert.match(correction, /\(1628, 'MINA-USDT', 5688\)/);
    assert.match(correction, /\(1635, 'PHA-USDT', 5724\)/);
    assert.match(correction, /sentiment_key = 'price_led_momentum'/);
    assert.match(correction, /status IN \('active', 'in_run'\)/);
    assert.match(correction, /entry_price_3h > 5/);
  });

  it("removes tracking without creating an outcome or delivery", () => {
    assert.ok(correction);
    assert.match(correction, /status = 'reclassified'/);
    assert.match(correction, /cancel_reason = 'entry_gate_reclassified'/);
    for (const field of [
      "exit_price = NULL",
      "pnl_percent = NULL",
      "closed_at = NULL",
      "trailing_stop_level = NULL",
      "last_smart_cancel_check_at = NULL",
    ]) {
      assert.match(correction, new RegExp(field.replaceAll(" ", "\\s+")));
    }
    assert.doesNotMatch(
      correction,
      /broadcast|telegram|outbox|trajectory|health_event|exit_metric|cancel_outcome/i,
    );
  });
});
