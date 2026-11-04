import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  buildSubscriptionWarningText,
  canReclaimSubscriptionWarning,
  classifySubscriptionWarningSendResult,
  isSubscriptionActive,
  isThreeHourWarningWindow,
  mergeSubscriptionWarningRecipients,
  type SubscriptionWarningRecipient,
} from "../src/lib/subscription-warning.js";

const NOW = new Date("2026-08-19T10:00:00Z");
const HOUR_MS = 60 * 60_000;

function atHoursFromNow(hours: number): Date {
  return new Date(NOW.getTime() + hours * HOUR_MS);
}

describe("Three-hour subscription warning policy", () => {
  test("requires a future end date when one is set", () => {
    assert.equal(
      isSubscriptionActive(true, new Date("2026-08-19T09:59:59.999Z"), NOW),
      false,
      "an expired subscription must be inactive",
    );
    assert.equal(
      isSubscriptionActive(true, new Date("2026-08-19T10:00:00.000Z"), NOW),
      false,
      "access must stop at the exact subscription end instant",
    );
    assert.equal(
      isSubscriptionActive(true, new Date("2026-08-19T10:00:00.001Z"), NOW),
      true,
      "a future subscription must remain active",
    );
    assert.equal(
      isSubscriptionActive(false, new Date("2026-08-20T10:00:00.000Z"), NOW),
      false,
      "manual deactivation must override the end date",
    );
  });

  test("selects the 2–4 hour reliability window centered on three hours", () => {
    assert.equal(
      isThreeHourWarningWindow(atHoursFromNow(3), NOW.getTime()),
      true,
    );
    assert.equal(
      isThreeHourWarningWindow(atHoursFromNow(2.01), NOW.getTime()),
      true,
    );
    assert.equal(
      isThreeHourWarningWindow(atHoursFromNow(3.99), NOW.getTime()),
      true,
    );
    assert.equal(
      isThreeHourWarningWindow(atHoursFromNow(2), NOW.getTime()),
      false,
    );
    assert.equal(
      isThreeHourWarningWindow(atHoursFromNow(4), NOW.getTime()),
      false,
    );
  });

  test("uses the existing photo path with clear three-hour copy", () => {
    const text = buildSubscriptionWarningText();
    assert.match(text, /примерно через 3 часа/);
    assert.doesNotMatch(text, /12 часов/);
    assert.match(text, /@The_Lucy_x/);
  });

  test("deduplicates shared Chat IDs and prefers dashboard expiry", () => {
    const subscriber: SubscriptionWarningRecipient = {
      chatId: 6964248629,
      subscribedUntil: atHoursFromNow(4),
      source: "subscriber",
    };
    const dashboard: SubscriptionWarningRecipient = {
      chatId: 6964248629,
      subscribedUntil: atHoursFromNow(4.5),
      source: "dashboard",
    };
    const botOnly: SubscriptionWarningRecipient = {
      chatId: 123,
      subscribedUntil: atHoursFromNow(4),
      source: "subscriber",
    };

    const recipients = mergeSubscriptionWarningRecipients(
      [subscriber, botOnly],
      [dashboard],
    );
    assert.equal(recipients.size, 2);
    assert.equal(recipients.get(6964248629), dashboard);
    assert.equal(recipients.get(123), botOnly);
  });

  test("retries known failures without reclaiming ambiguous sends", () => {
    assert.equal(canReclaimSubscriptionWarning("failed", null, NOW), true);
    assert.equal(
      canReclaimSubscriptionWarning(
        "processing",
        new Date(NOW.getTime() - 1),
        NOW,
      ),
      false,
    );
    assert.equal(
      canReclaimSubscriptionWarning(
        "processing",
        new Date(NOW.getTime() + 1),
        NOW,
      ),
      false,
    );
    assert.equal(canReclaimSubscriptionWarning("delivered", null, NOW), false);
  });

  test("does not retry timeout or transport outcomes that may have delivered", () => {
    const timeout = classifySubscriptionWarningSendResult({
      ok: false,
      status: null,
      retryable: true,
      description: "request timed out",
    });
    assert.deepEqual(timeout, {
      kind: "ambiguous",
      description: "request timed out",
    });
    assert.equal(
      canReclaimSubscriptionWarning(
        "processing",
        new Date(NOW.getTime() - 1),
        NOW,
      ),
      false,
    );
  });

  test("retries explicit Telegram rejections but accepts successful sends", () => {
    assert.deepEqual(
      classifySubscriptionWarningSendResult({
        ok: false,
        status: 429,
        retryable: true,
        description: "Too Many Requests",
      }),
      {
        kind: "confirmed_failure",
        description: "Too Many Requests",
      },
    );
    assert.deepEqual(
      classifySubscriptionWarningSendResult({
        ok: true,
        status: 200,
        retryable: false,
      }),
      { kind: "delivered" },
    );
  });
});
