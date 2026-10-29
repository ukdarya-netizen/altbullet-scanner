import assert from "node:assert/strict";
import test from "node:test";
import { evaluateNeonFlowGate, reactionTakerNetUsd } from "../src/lib/neon-flow-gate.js";

const H = 3_600_000, M = 900_000, T = 1_800_000_000_000 - (1_800_000_000_000 % H);
const bar = (i: number, buy: number, sell: number) => ({ time: T + i * M, buy, sell });

test("taker net is summed over the four closed 15m bars of the reaction hour", () => {
  const bars = [bar(-1, 999, 0), bar(0, 10, 4), bar(1, 5, 6), bar(2, 3, 1), bar(3, 2, 2), bar(4, 0, 999)];
  assert.equal(reactionTakerNetUsd(bars, T, T + 2 * H), 7);
  assert.equal(reactionTakerNetUsd(bars.slice(0, 4), T, T + 2 * H), null, "a missing bar is unknown");
  assert.equal(reactionTakerNetUsd(bars, T, T + 3 * M + 1), null, "the 4th bar is not closed yet");
  assert.equal(reactionTakerNetUsd(null, T, T + 2 * H), null);
});

test("both buyers are required; unknown data is no signal", () => {
  assert.deepEqual(evaluateNeonFlowGate({ takerNetUsd: 7, spotCvd1h: true }), { pass: true, takerNetUsd: 7, spotCvd1h: true });
  assert.equal((evaluateNeonFlowGate({ takerNetUsd: 0, spotCvd1h: true }) as { reason: string }).reason, "taker_net_sell");
  assert.equal((evaluateNeonFlowGate({ takerNetUsd: null, spotCvd1h: true }) as { reason: string }).reason, "taker_unknown");
  assert.equal((evaluateNeonFlowGate({ takerNetUsd: 5, spotCvd1h: false }) as { reason: string }).reason, "spot_cvd_negative");
  assert.equal((evaluateNeonFlowGate({ takerNetUsd: 5, spotCvd1h: null }) as { reason: string }).reason, "spot_cvd_unknown");
});
