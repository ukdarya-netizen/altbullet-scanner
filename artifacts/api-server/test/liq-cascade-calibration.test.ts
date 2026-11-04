import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  calculateForwardPricePct,
  shouldBlockLiqCascadeSpotTaker,
  shouldHoldLiqCascadeForRecovery,
} from "../src/lib/liq-cascade-calibration.js";

describe("Liquidation Cascade calibration rules", () => {
  test("blocks only confirmed negative spot-taker flow", () => {
    assert.equal(
      shouldBlockLiqCascadeSpotTaker({ available: true, netBuyPct: -0.01 }),
      true,
    );
    assert.equal(
      shouldBlockLiqCascadeSpotTaker({ available: true, netBuyPct: 0 }),
      false,
    );
    assert.equal(
      shouldBlockLiqCascadeSpotTaker({ available: false, netBuyPct: -5 }),
      false,
    );
    assert.equal(shouldBlockLiqCascadeSpotTaker(null), false);
  });

  test("holds a weak liq_spike during a confirmed one-hour decline", () => {
    assert.equal(
      shouldHoldLiqCascadeForRecovery("liq_spike", 0.74, -0.51),
      true,
    );
    assert.equal(
      shouldHoldLiqCascadeForRecovery("liq_spike", 0.75, -0.51),
      false,
    );
    assert.equal(
      shouldHoldLiqCascadeForRecovery("liq_spike", 0.74, -0.5),
      false,
    );
    assert.equal(shouldHoldLiqCascadeForRecovery("liq_spike", 0.74, 0), false);
    assert.equal(shouldHoldLiqCascadeForRecovery("liq_spike", null, -2), false);
    assert.equal(
      shouldHoldLiqCascadeForRecovery("liq_spike", 0.4, null),
      false,
    );
    assert.equal(shouldHoldLiqCascadeForRecovery("liq_spike", 0.4, NaN), false);
    assert.equal(
      shouldHoldLiqCascadeForRecovery("liq_order_stream", 0.4, -2),
      false,
    );
  });

  test("calculates forward price performance only from valid positive prices", () => {
    assert.equal(calculateForwardPricePct(100, 112), 12);
    assert.equal(calculateForwardPricePct(100, 88), -12);
    assert.equal(calculateForwardPricePct(0, 112), null);
    assert.equal(calculateForwardPricePct(100, null), null);
  });
});
