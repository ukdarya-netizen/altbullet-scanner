import test from "node:test";
import assert from "node:assert/strict";
import {
  evaluateStealthVolumeGate,
  toCoinglassPair,
} from "../src/lib/stealth-volume-gate.js";

const H = 3_600_000;
const T0 = 1_000 * H;
const TRIGGER = T0 + 20 * H;
function bars(
  fut: number | undefined,
  spot: number | undefined,
  open: number,
  close: number,
) {
  const out = [];
  for (let i = 0; i < 20; i++)
    out.push({
      time: T0 + i * H,
      futuresVolumeUsd: fut === undefined ? undefined : 100,
      spotVolumeUsd: spot === undefined ? undefined : 100,
      open: 1,
      close: 1,
    });
  out.push({
    time: TRIGGER,
    futuresVolumeUsd: fut,
    spotVolumeUsd: spot,
    open,
    close,
  });
  return out;
}

test("passes at futures >=3x, spot >=3x and a bullish candle", () => {
  const d = evaluateStealthVolumeGate(
    bars(300, 300, 1, 1.001),
    TRIGGER,
    H,
    "x",
  );
  assert.equal(d.pass, true);
  assert.equal(d.futuresRatio, 3);
  assert.equal(d.spotRatio, 3);
});
test("either volume leg is enough; both below threshold blocks", () => {
  assert.equal(
    evaluateStealthVolumeGate(bars(299, 900, 1, 1.01), TRIGGER, H, "x").pass,
    true,
  );
  assert.equal(
    evaluateStealthVolumeGate(bars(900, 299, 1, 1.01), TRIGGER, H, "x").pass,
    true,
  );
  assert.equal(
    evaluateStealthVolumeGate(bars(299, 299, 1, 1.01), TRIGGER, H, "x").reason,
    "both_volumes_below_threshold",
  );
});
test("a red or flat candle is held; a small green body is fine", () => {
  assert.equal(
    evaluateStealthVolumeGate(bars(900, 900, 1, 0.99), TRIGGER, H, "x").reason,
    "candle_not_bullish",
  );
  assert.equal(
    evaluateStealthVolumeGate(bars(900, 900, 1, 1), TRIGGER, H, "x").pass,
    false,
  );
  assert.equal(
    evaluateStealthVolumeGate(bars(900, 900, 1, 1.002), TRIGGER, H, "x").pass,
    true,
  );
});
test("a missing leg blocks unless the other leg passes; missing candle blocks with an explicit reason", () => {
  const noSpot = evaluateStealthVolumeGate(
    bars(100, undefined, 1, 1.01),
    TRIGGER,
    H,
    "x",
  );
  assert.equal(noSpot.pass, false);
  assert.equal(noSpot.reason, "spot_volume_unavailable");
  const noFut = evaluateStealthVolumeGate(
    bars(undefined, 100, 1, 1.01),
    TRIGGER,
    H,
    "x",
  );
  assert.equal(noFut.pass, false);
  assert.equal(noFut.reason, "futures_volume_unavailable");
  for (const d of [
    evaluateStealthVolumeGate(
      bars(undefined, undefined, 1, 1.01),
      TRIGGER,
      H,
      "x",
    ),
    evaluateStealthVolumeGate(null, TRIGGER, H, null),
    evaluateStealthVolumeGate(bars(900, 900, 1, 1.05), null, H, "x"),
    evaluateStealthVolumeGate(bars(900, 900, 1, 1.05), TRIGGER + 5 * H, H, "x"),
  ]) {
    assert.equal(d.pass, false);
    assert.equal(d.reason, "unavailable");
  }
});
test("pair conversion", () => {
  assert.equal(toCoinglassPair("LDO-USDT"), "LDOUSDT");
});
