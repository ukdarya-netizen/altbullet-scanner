import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const source = readFileSync(
  new URL("../src/index.ts", import.meta.url),
  "utf8",
);
const correction = source.match(
  /async function reclassifyOpenImpulseBuyPositionsExcludedByCurrentGates[\s\S]*?\n}\n/,
)?.[0];

describe("Impulse Buy pre-gate open-position reclassification", () => {
  it("is fenced to the two approved open positions and current live gates", () => {
    assert.ok(correction);
    assert.match(correction, /\(1598, 'ONDO-USDT'\)/);
    assert.match(correction, /\(1600, 'APT-USDT'\)/);
    assert.match(correction, /sentiment_key = 'impulse_buy'/);
    assert.match(correction, /status IN \('active', 'in_run'\)/);
    assert.match(correction, /entry_spot_vol_mult > 2 OR entry_oi_4h > 20/);
  });

  it("removes tracking without creating a trading outcome or delivery", () => {
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
