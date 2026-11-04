import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  getDashboardLinkedBotAccessStatus,
  getMemberAccessStatus,
  getMemberBotAccessStatus,
} from "../src/lib/member-access-status.js";

describe("admin member access status", () => {
  const now = new Date("2026-08-28T12:00:00.000Z");

  test("distinguishes active, expired, inactive, and blocked bot-only members", () => {
    assert.equal(
      getMemberBotAccessStatus(
        {
          active: false,
          subscribedUntil: new Date("2026-08-27T12:00:00.000Z"),
          botBlockedAt: new Date("2026-08-26T12:00:00.000Z"),
        },
        now,
      ),
      "blocked",
    );
    assert.equal(
      getMemberBotAccessStatus(
        {
          active: true,
          subscribedUntil: new Date("2026-08-29T12:00:00.000Z"),
        },
        now,
      ),
      "active",
    );
    assert.equal(
      getMemberBotAccessStatus(
        {
          active: true,
          subscribedUntil: new Date("2026-08-28T12:00:00.000Z"),
        },
        now,
      ),
      "expired",
    );
    assert.equal(
      getMemberBotAccessStatus(
        {
          active: false,
          subscribedUntil: new Date("2026-08-29T12:00:00.000Z"),
        },
        now,
      ),
      "inactive",
    );
  });

  test("uses the Dashboard status when a Dashboard account exists", () => {
    for (const [dashboardStatus, expected] of [
      ["approved", "active"],
      ["expired", "expired"],
      ["pending", "pending"],
      ["blocked", "blocked"],
    ] as const) {
      assert.equal(
        getMemberAccessStatus({
          source: "both",
          dashboardStatus,
          botAccessStatus: "active",
        }),
        expected,
      );
    }
  });

  test("a confirmed bot block overrides approved Dashboard access", () => {
    assert.equal(
      getMemberAccessStatus({
        source: "both",
        dashboardStatus: "approved",
        botAccessStatus: "blocked",
      }),
      "blocked",
    );
  });

  test("treats a Dashboard account with Chat ID as real bot access", () => {
    assert.equal(getDashboardLinkedBotAccessStatus("approved", true), "active");
    assert.equal(getDashboardLinkedBotAccessStatus("expired", true), "expired");
    assert.equal(
      getDashboardLinkedBotAccessStatus("pending", true),
      "inactive",
    );
    assert.equal(
      getDashboardLinkedBotAccessStatus("blocked", true),
      "inactive",
    );
    assert.equal(getDashboardLinkedBotAccessStatus("approved", false), null);
  });

  test("falls back to subscriber access for bot-only members", () => {
    for (const status of [
      "active",
      "expired",
      "inactive",
      "blocked",
    ] as const) {
      assert.equal(
        getMemberAccessStatus({
          source: "bot",
          dashboardStatus: null,
          botAccessStatus: status,
        }),
        status,
      );
    }
  });
});
