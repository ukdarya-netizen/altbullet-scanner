/**
 * Tests for the admin password-reset Telegram notification and related validation.
 *
 * Coverage:
 *  1. dispatchPasswordResetNotification sends exactly once when chatId is set.
 *  2. dispatchPasswordResetNotification returns false (no-op) when chatId is absent.
 *  3. dispatchPasswordResetNotification propagates a false result from sendMessage
 *     (Telegram 403/network failure) so that callers can log it.
 *  4. validateNewPassword rejects passwords shorter than 6 characters (the guard
 *     that causes PATCH /api/admin/users/:id to return 400 in the real route).
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

const { parseChatId, dispatchPasswordResetNotification } =
  await import("../src/lib/password-reset-notification.js");

const { validateNewPassword } =
  await import("../src/lib/admin-user-validation.js");

// ── parseChatId ───────────────────────────────────────────────────────────────

describe("parseChatId", () => {
  test("returns null for null input", () => {
    assert.strictEqual(parseChatId(null), null);
  });

  test("returns null for an empty string", () => {
    assert.strictEqual(parseChatId(""), null);
  });

  test("returns null for a non-numeric string", () => {
    assert.strictEqual(parseChatId("abc"), null);
  });

  test("returns null for zero", () => {
    assert.strictEqual(parseChatId("0"), null);
  });

  test("returns null for a negative number", () => {
    assert.strictEqual(parseChatId("-12345"), null);
  });

  test("returns the parsed integer for a valid positive chat ID", () => {
    assert.strictEqual(parseChatId("123456789"), 123456789);
  });
});

// ── dispatchPasswordResetNotification ─────────────────────────────────────────

describe("dispatchPasswordResetNotification", () => {
  test("calls sendMessage exactly once and returns true when delivery succeeds", async () => {
    const calls: [number, string][] = [];
    const stub = async (chatId: number, text: string): Promise<boolean> => {
      calls.push([chatId, text]);
      return true;
    };

    const delivered = await dispatchPasswordResetNotification(
      stub,
      "987654321",
    );

    assert.strictEqual(delivered, true);
    assert.strictEqual(
      calls.length,
      1,
      "sendMessage must be called exactly once",
    );
    assert.strictEqual(calls[0]![0], 987654321);
    assert.ok(
      calls[0]![1].includes("Пароль изменён"),
      `message should mention password reset, got: ${calls[0]![1]}`,
    );
  });

  test("propagates false when sendMessage reports a delivery failure (e.g. Telegram 403)", async () => {
    // sendMessage returns false when Telegram rejects the message (blocked bot,
    // 403, suppressed in dev mode, etc.) rather than throwing.  The caller must
    // receive that false so it can log the undelivered notification.
    const stub = async (): Promise<boolean> => false;

    const delivered = await dispatchPasswordResetNotification(
      stub,
      "987654321",
    );

    assert.strictEqual(
      delivered,
      false,
      "false delivery result must propagate to the caller",
    );
  });

  test("returns false (no-op) when chatId is null without calling sendMessage", async () => {
    const calls: unknown[] = [];
    const stub = async (): Promise<boolean> => {
      calls.push(null);
      return true;
    };

    const delivered = await dispatchPasswordResetNotification(stub, null);

    assert.strictEqual(delivered, false);
    assert.strictEqual(
      calls.length,
      0,
      "sendMessage must not be called for null chatId",
    );
  });

  test("returns false (no-op) when chatId is an empty string without calling sendMessage", async () => {
    const calls: unknown[] = [];
    const stub = async (): Promise<boolean> => {
      calls.push(null);
      return true;
    };

    const delivered = await dispatchPasswordResetNotification(stub, "");

    assert.strictEqual(delivered, false);
    assert.strictEqual(
      calls.length,
      0,
      "sendMessage must not be called for empty chatId",
    );
  });

  test("returns false (no-op) when chatId is zero without calling sendMessage", async () => {
    const calls: unknown[] = [];
    const stub = async (): Promise<boolean> => {
      calls.push(null);
      return true;
    };

    const delivered = await dispatchPasswordResetNotification(stub, "0");

    assert.strictEqual(delivered, false);
    assert.strictEqual(
      calls.length,
      0,
      "sendMessage must not be called when chatId is 0",
    );
  });
});

// ── validateNewPassword — the guard that produces a 400 in the PATCH route ───
//
// PATCH /api/admin/users/:id delegates to validateNewPassword before touching
// the database.  Testing the pure function here is equivalent to asserting
// that the route returns 400 for a short password, without needing a live DB
// or HTTP layer.

describe("validateNewPassword (PATCH /api/admin/users/:id password guard)", () => {
  test("rejects a password shorter than 6 characters", () => {
    const result = validateNewPassword("abc");
    assert.deepEqual(result, {
      valid: false,
      error: "Пароль: минимум 6 символов",
    });
  });

  test("rejects a 5-character password (boundary)", () => {
    const result = validateNewPassword("abcde");
    assert.strictEqual(result.valid, false);
  });

  test("accepts a password of exactly 6 characters", () => {
    const result = validateNewPassword("abc123");
    assert.deepEqual(result, { valid: true });
  });

  test("accepts a long password", () => {
    const result = validateNewPassword("a-very-long-secure-password-123!");
    assert.deepEqual(result, { valid: true });
  });

  test("accepts undefined (no password change requested)", () => {
    const result = validateNewPassword(undefined);
    assert.deepEqual(result, { valid: true });
  });
});
