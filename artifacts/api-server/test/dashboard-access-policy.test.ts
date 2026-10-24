import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  canResubmitExpiredDashboardAccount,
  getDashboardAccessStatus,
  shouldRestoreExpiredDashboardAccount,
} from "../src/lib/dashboard-access-policy.js";

describe("expired dashboard access requests", () => {
  const now = new Date("2026-08-19T12:00:00.000Z");

  test("allows a regular approved account to request access again after expiry", () => {
    assert.equal(
      canResubmitExpiredDashboardAccount({
        isOwner: false,
        status: "approved",
        subscribedUntil: new Date("2026-08-19T11:59:59.000Z"),
        now,
      }),
      true,
    );
  });

  test("allows a regular expired account to request access again after expiry", () => {
    assert.equal(
      canResubmitExpiredDashboardAccount({
        isOwner: false,
        status: "expired",
        subscribedUntil: new Date("2026-08-19T11:59:59.000Z"),
        now,
      }),
      true,
    );
  });

  test("does not reopen active, pending, blocked, owner, or undated accounts", () => {
    for (const params of [
      {
        isOwner: false,
        status: "approved",
        subscribedUntil: new Date("2026-08-19T12:00:01.000Z"),
      },
      { isOwner: false, status: "pending", subscribedUntil: now },
      { isOwner: false, status: "blocked", subscribedUntil: now },
      { isOwner: true, status: "approved", subscribedUntil: now },
      { isOwner: false, status: "approved", subscribedUntil: null },
    ]) {
      assert.equal(
        canResubmitExpiredDashboardAccount({ ...params, now }),
        false,
      );
    }
  });

  test("shows an approved account with a past end date as expired, not active", () => {
    assert.equal(
      getDashboardAccessStatus({
        isOwner: false,
        status: "approved",
        subscribedUntil: new Date("2026-08-19T11:59:59.000Z"),
        now,
      }),
      "expired",
    );
    assert.equal(
      getDashboardAccessStatus({
        isOwner: false,
        status: "blocked",
        subscribedUntil: new Date("2026-08-19T11:59:59.000Z"),
        now,
      }),
      "blocked",
    );
  });

  test("restores an expired account when an admin sets a future or unlimited expiry", () => {
    assert.equal(
      shouldRestoreExpiredDashboardAccount({
        status: "expired",
        subscribedUntil: new Date("2026-08-20T12:00:01.000Z"),
        now,
      }),
      true,
    );
    assert.equal(
      shouldRestoreExpiredDashboardAccount({
        status: "expired",
        subscribedUntil: null,
        now,
      }),
      true,
    );
    assert.equal(
      shouldRestoreExpiredDashboardAccount({
        status: "expired",
        subscribedUntil: new Date("2026-08-19T11:59:59.000Z"),
        now,
      }),
      false,
    );
  });
});
