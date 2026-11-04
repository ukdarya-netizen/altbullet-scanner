import assert from "node:assert/strict";
import { test } from "node:test";
import {
  getBuStopMilestone,
  getExitProfile,
} from "../src/lib/watcher-config.js";
import {
  resolveActivatedTrailingStopLevel,
  resolveTrailingStopLevel,
} from "../src/lib/trailing-stop.js";
import { nextBitcoinMilestone } from "../src/lib/watcher-formatters.js";

test("BTC protects breakeven at +1%, then peak minus one percentage point", () => {
  for (const symbol of ["BTC-USDT", "BTCUSDT"]) {
    const profile = getExitProfile("liquidation_cascade", symbol);
    assert.deepEqual(profile, {
      firstTarget: 1,
      trailingActivation: 2,
      trailingGap: 1,
    });
    assert.equal(getBuStopMilestone("liquidation_cascade", symbol), 1);
    assert.equal(
      resolveActivatedTrailingStopLevel({
        peakPnlPercent: 1.99,
        trailingActivationPercent: profile.trailingActivation,
        entryPrice: 100,
        peakPrice: 101.99,
        trailingGapPercent: profile.trailingGap,
        persistedTrailingStopLevel: null,
      }),
      null,
    );
    for (const [peakPnl, protectedPnl] of [
      [2, 1],
      [3, 2],
      [4, 3],
    ]) {
      const stop = resolveActivatedTrailingStopLevel({
        peakPnlPercent: peakPnl,
        trailingActivationPercent: profile.trailingActivation,
        entryPrice: 100,
        peakPrice: 100 + peakPnl,
        trailingGapPercent: profile.trailingGap,
        persistedTrailingStopLevel: null,
      });
      assert.equal(stop, 100 + protectedPnl);
    }
    assert.equal(nextBitcoinMilestone(2, 4.5), 3);
    assert.equal(nextBitcoinMilestone(3, 4.5), 4);
  }
});

test("BTC trailing boundary never falls below a durable higher stop", () => {
  assert.equal(
    resolveTrailingStopLevel({
      entryPrice: 100,
      peakPrice: 103,
      trailingGapPercent: 1,
      persistedTrailingStopLevel: 102.5,
    }),
    102.5,
  );
  assert.deepEqual(getExitProfile("liquidation_cascade"), {
    firstTarget: 10,
    trailingActivation: 15,
    trailingGap: 10,
  });
});
