import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyTimeoutExit,
  photoPathForTimeoutDelivery,
  timeoutExitPhotoKind,
} from "../src/lib/timeout-exit-policy.js";

test("lifetime close prioritizes trailing and protected BE over market PnL", () => {
  assert.equal(
    classifyTimeoutExit({
      pnlPercent: 12,
      protectedBe: true,
      trailingActive: true,
    }),
    "profit",
  );
  assert.equal(
    classifyTimeoutExit({
      pnlPercent: -8,
      protectedBe: true,
      trailingActive: false,
    }),
    "bu_stop",
  );
  assert.equal(
    classifyTimeoutExit({
      pnlPercent: 4,
      protectedBe: true,
      trailingActive: false,
    }),
    "bu_stop",
  );
});

test("only unprotected prices from entry to under +5% expire", () => {
  for (const pnlPercent of [-0.001, -3, -10]) {
    assert.equal(
      classifyTimeoutExit({
        pnlPercent,
        protectedBe: false,
        trailingActive: false,
      }),
      "stop_loss",
    );
  }
  for (const pnlPercent of [0, 1, 4.999]) {
    assert.equal(
      classifyTimeoutExit({
        pnlPercent,
        protectedBe: false,
        trailingActive: false,
      }),
      "expired",
    );
  }
  for (const pnlPercent of [5, 8, 10]) {
    assert.equal(
      classifyTimeoutExit({
        pnlPercent,
        protectedBe: false,
        trailingActive: false,
      }),
      "profit",
    );
  }
});

test("a profitable lifetime close uses the closed-at-expiry image, not exit advice", () => {
  assert.equal(timeoutExitPhotoKind("profit"), "expired");
  assert.equal(timeoutExitPhotoKind("expired"), "expired");
  assert.equal(timeoutExitPhotoKind("bu_stop"), "bu_stop");
  assert.equal(timeoutExitPhotoKind("stop_loss"), "stop_loss");
});

test("previously queued profitable timeout photos are corrected at delivery", () => {
  const oldPath = "/app/assets/position_exit.png";
  assert.equal(
    photoPathForTimeoutDelivery("position:1836:timeout:profit", oldPath),
    "/app/assets/position_expired.png",
  );
  for (const eventKey of [
    "position:1836:timeout:expired",
    "position:1836:bu_stop",
    "signal:1836:timeout:profit",
  ]) {
    assert.equal(photoPathForTimeoutDelivery(eventKey, oldPath), oldPath);
  }
  assert.equal(
    photoPathForTimeoutDelivery(
      "position:1836:timeout:profit",
      "/app/assets/position_expired.png",
    ),
    "/app/assets/position_expired.png",
  );
});
