import assert from "node:assert/strict";
import test from "node:test";
import {
  isEligibleAbneonPrimaryTelegramEvent,
  isEligibleLiquidationCascadePrimaryTelegramEvent,
  isMutedTelegramMethod,
  isTelegramMuted,
  isWatchdogTelegramPhotoEvent,
} from "../src/lib/telegram-mute.js";

test("restart and explicitly classified signal sends bypass the global mute", () => {
  assert.equal(isTelegramMuted("restart-notice"), false);
  assert.equal(isTelegramMuted("restart-notification:123"), false);

  assert.equal(isTelegramMuted("manual-check:123"), true);
  assert.equal(isTelegramMuted("signal:123"), true);
  assert.equal(isTelegramMuted("watchdog:scanner"), true);
  assert.equal(isTelegramMuted(undefined), true);

  assert.equal(isMutedTelegramMethod("sendMessage", "signal:123"), true);
  assert.equal(isMutedTelegramMethod("sendMessage", "signal:123", true), false);
  assert.equal(isMutedTelegramMethod("sendPhoto", "position:123"), true);
  assert.equal(isMutedTelegramMethod("sendPhoto", "position:123", true), false);
  assert.equal(isMutedTelegramMethod("sendPhoto", "restart-notice"), false);
});

test("only watchdog photo alerts bypass the global mute", () => {
  for (const eventKey of [
    "watchdog:123",
    "watchdog-restart:123",
    "watchdog-restart-limit:123",
  ]) {
    assert.equal(isWatchdogTelegramPhotoEvent(eventKey), true);
    assert.equal(isMutedTelegramMethod("sendPhoto", eventKey), false);
    assert.equal(isMutedTelegramMethod("sendMessage", eventKey), true);
  }

  assert.equal(isWatchdogTelegramPhotoEvent("watchdog-like:123"), false);
  assert.equal(isMutedTelegramMethod("sendPhoto", "watchdog-like:123"), true);
  assert.equal(isMutedTelegramMethod("sendPhoto", "position:123"), true);
});

test("only fresh ABNeon primary signals with a linked eligible tracker bypass mute", () => {
  const event = {
    eventKey: "signal:42",
    sentimentKey: "neon_support_bounce",
    status: "active",
    detectedAt: new Date(1_000),
    updatedAt: new Date(1_000),
    nowMs: 1_000,
  };
  assert.equal(isEligibleAbneonPrimaryTelegramEvent(event), true);
  assert.equal(
    isMutedTelegramMethod("sendPhoto", event.eventKey, false, true),
    false,
  );
  assert.equal(
    isMutedTelegramMethod("sendMessage", "position:42", false, true),
    true,
  );
  assert.equal(
    isEligibleAbneonPrimaryTelegramEvent({
      ...event,
      sentimentKey: "liquidation_cascade",
    }),
    false,
  );
  assert.equal(
    isEligibleAbneonPrimaryTelegramEvent({
      ...event,
      sentimentKey: "stealth_breakout",
    }),
    false,
  );
  assert.equal(
    isEligibleAbneonPrimaryTelegramEvent({
      ...event,
      status: "reclassified",
    }),
    false,
  );
  assert.equal(
    isEligibleAbneonPrimaryTelegramEvent({
      ...event,
      detectedAt: new Date(0),
      nowMs: 11 * 60_000,
    }),
    false,
  );
});

test("only fresh Liquidation Cascade primary signals bypass the scoped mute", () => {
  const event = {
    eventKey: "signal:52",
    sentimentKey: "liquidation_cascade",
    status: "active",
    detectedAt: new Date(1_000),
    updatedAt: new Date(1_000),
    nowMs: 1_000,
  };
  assert.equal(isEligibleLiquidationCascadePrimaryTelegramEvent(event), true);
  assert.equal(
    isMutedTelegramMethod(
      "sendPhoto",
      event.eventKey,
      false,
      false,
      false,
      false,
      false,
      true,
    ),
    false,
  );
  assert.equal(isMutedTelegramMethod("sendPhoto", event.eventKey), true);
  assert.equal(
    isMutedTelegramMethod(
      "sendMessage",
      "position:52",
      false,
      false,
      false,
      false,
      false,
      true,
    ),
    true,
  );
  assert.equal(
    isEligibleLiquidationCascadePrimaryTelegramEvent({
      ...event,
      status: "cancelled",
    }),
    false,
  );
  assert.equal(
    isEligibleLiquidationCascadePrimaryTelegramEvent({
      ...event,
      detectedAt: new Date(0),
      nowMs: 11 * 60_000,
    }),
    false,
  );
  assert.equal(
    isEligibleLiquidationCascadePrimaryTelegramEvent({
      ...event,
      sentimentKey: "stealth_breakout",
    }),
    false,
  );
});
