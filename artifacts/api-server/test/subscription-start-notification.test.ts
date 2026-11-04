import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { shouldNotifySubscriptionStarted } from "../src/lib/subscription-start-notification.js";

const NOW = new Date("2026-08-20T10:00:00Z");
const FUTURE = new Date("2026-09-20T10:00:00Z");
const LATER_FUTURE = new Date("2026-10-20T10:00:00Z");
const PAST = new Date("2026-08-19T10:00:00Z");

describe("subscription start notification policy", () => {
  test("notifies when an approved dashboard account gains access", () => {
    assert.equal(
      shouldNotifySubscriptionStarted({
        previous: { active: false, subscribedUntil: null },
        next: { active: true, subscribedUntil: null },
        becameApproved: true,
        now: NOW,
      }),
      true,
    );
  });

  test("notifies when a first paid end date is assigned", () => {
    assert.equal(
      shouldNotifySubscriptionStarted({
        previous: { active: true, subscribedUntil: null },
        next: { active: true, subscribedUntil: FUTURE },
        becameApproved: false,
        now: NOW,
      }),
      true,
    );
  });

  test("notifies when an expired subscription is renewed", () => {
    assert.equal(
      shouldNotifySubscriptionStarted({
        previous: { active: false, subscribedUntil: PAST },
        next: { active: true, subscribedUntil: FUTURE },
        becameApproved: false,
        now: NOW,
      }),
      true,
    );
  });

  test("does not repeat the image when an active end date is merely changed", () => {
    assert.equal(
      shouldNotifySubscriptionStarted({
        previous: { active: true, subscribedUntil: FUTURE },
        next: { active: true, subscribedUntil: LATER_FUTURE },
        becameApproved: false,
        now: NOW,
      }),
      false,
    );
  });

  test("does not announce access when the new end date has already passed", () => {
    assert.equal(
      shouldNotifySubscriptionStarted({
        previous: { active: false, subscribedUntil: null },
        next: { active: false, subscribedUntil: PAST },
        becameApproved: false,
        now: NOW,
      }),
      false,
    );
  });
});
