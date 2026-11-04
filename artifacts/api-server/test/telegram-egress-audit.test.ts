import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  resolveTelegramEgressAuditContext,
  sanitizeTelegramAuditContent,
} from "../src/lib/telegram-egress-audit.js";

describe("Telegram egress audit", () => {
  test("captures exact text and recipient from Telegram request bodies", () => {
    const context = resolveTelegramEgressAuditContext(
      "sendMessage",
      { chat_id: 1118254191, text: "ordinary signal text" },
      {
        source: "telegram-photo-outbox.deliverTextParts",
        deliveryPath: "outbox",
        eventKey: "signal:42",
      },
    );

    assert.deepEqual(context, {
      source: "telegram-photo-outbox.deliverTextParts",
      chatId: 1118254191,
      content: "ordinary signal text",
      contentKind: "text",
      deliveryPath: "outbox",
      eventKey: "signal:42",
    });
  });

  test("identifies direct service bypasses separately from outbox traffic", () => {
    const context = resolveTelegramEgressAuditContext(
      "sendPhoto",
      { chat_id: "1656560468", caption: "Подписка деактивирована" },
      {
        source: "telegram.sendDeactivatedNotification",
        deliveryPath: "service-bypass",
      },
    );

    assert.equal(context.chatId, "1656560468");
    assert.equal(context.content, "Подписка деактивирована");
    assert.equal(context.contentKind, "caption");
    assert.equal(context.deliveryPath, "service-bypass");
  });

  test("redacts password reset codes but preserves other message text", () => {
    const sanitized = sanitizeTelegramAuditContent(
      "🔑 Код сброса пароля: <code>123456</code>\nДействителен 15 минут.",
    );

    assert.equal(
      sanitized.content,
      "🔑 Код сброса пароля: <code>[REDACTED]</code>\nДействителен 15 минут.",
    );
    assert.equal(sanitized.content.includes("123456"), false);
    assert.equal(sanitized.truncated, false);
    assert.match(sanitized.sha256, /^[a-f0-9]{64}$/);
  });
});
