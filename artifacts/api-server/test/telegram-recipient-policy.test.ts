import assert from "node:assert/strict";
import test from "node:test";
import {
  isOperationalTelegramRecipient,
  mergeTelegramPersonalRecipients,
  normalizeTelegramRecipientId,
  resolveOperationalTelegramRecipientId,
  resolveTelegramPersonalRecipientSnapshot,
} from "../src/lib/telegram-recipient-policy.js";

test("normalizes valid Dashboard Telegram chat IDs only", () => {
  assert.equal(normalizeTelegramRecipientId(" 123 "), 123);
  assert.equal(normalizeTelegramRecipientId("-100456"), -100456);
  assert.equal(normalizeTelegramRecipientId("not-a-chat-id"), null);
  assert.equal(normalizeTelegramRecipientId("0"), null);
});

test("identifies only the operational owner recipient", () => {
  assert.equal(isOperationalTelegramRecipient(7818695412, 7818695412), true);
  assert.equal(isOperationalTelegramRecipient("7818695412", 7818695412), true);
  assert.equal(isOperationalTelegramRecipient(100, 7818695412), false);
  assert.equal(
    isOperationalTelegramRecipient("@The_Lucy_x", 7818695412),
    false,
  );
});

test("merges Dashboard users and bot subscribers without duplicate delivery", () => {
  const recipients = mergeTelegramPersonalRecipients({
    subscriberChatIds: [101, 202],
    dashboardChatIds: ["202", "303", null, "invalid"],
  });

  assert.deepEqual(recipients, [101, 202, 303]);
});

test("does not inject the operational recipient into paid broadcast snapshots", () => {
  assert.equal(resolveOperationalTelegramRecipientId(undefined), 7818695412);
  assert.equal(resolveOperationalTelegramRecipientId(" 555 "), 555);
  assert.equal(resolveOperationalTelegramRecipientId("invalid"), 7818695412);

  const snapshot = resolveTelegramPersonalRecipientSnapshot({
    subscriberLookupOk: true,
    subscriberChatIds: [],
    dashboardLookupOk: true,
    dashboardChatIds: [],
    strict: true,
  });
  assert.deepEqual(snapshot, { value: [], resolved: true });
});

test("recipient lookup failure never falls back to a cached personal snapshot", () => {
  assert.throws(
    () =>
      resolveTelegramPersonalRecipientSnapshot({
        subscriberLookupOk: false,
        subscriberChatIds: [],
        dashboardLookupOk: true,
        dashboardChatIds: [""],
        strict: true,
      }),
    /Active Telegram recipient lookup failed/,
  );
});
