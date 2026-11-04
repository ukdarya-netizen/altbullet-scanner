import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";

const TEST_SESSION_SECRET = "telegram-admin-auth-test-secret";
process.env.SESSION_SECRET = TEST_SESSION_SECRET;

const { requireAdminToken } = await import("../src/middleware/adminAuth.js");

function runAdminGuard(authorization?: string): {
  nextCalled: boolean;
  statusCode: number | null;
  body: unknown;
} {
  let nextCalled = false;
  let statusCode: number | null = null;
  let body: unknown;

  const req = {
    method: "GET",
    url: "/subscribers",
    header(name: string): string | undefined {
      return name === "Authorization" ? authorization : undefined;
    },
  } as unknown as Request;

  const res = {
    status(code: number): Response {
      statusCode = code;
      return res;
    },
    json(value: unknown): Response {
      body = value;
      return res;
    },
  } as unknown as Response;

  const next: NextFunction = () => {
    nextCalled = true;
  };
  requireAdminToken(req, res, next);
  return { nextCalled, statusCode, body };
}

describe("Subscriber administration authorization", () => {
  test("rejects requests without an admin credential", () => {
    const result = runAdminGuard();
    assert.equal(result.nextCalled, false);
    assert.equal(result.statusCode, 401);
    assert.deepEqual(result.body, { error: "Требуется авторизация" });
  });

  test("rejects a valid non-owner dashboard credential", () => {
    const token = jwt.sign({ role: "user" }, TEST_SESSION_SECRET);
    const result = runAdminGuard(`Bearer ${token}`);
    assert.equal(result.nextCalled, false);
    assert.equal(result.statusCode, 401);
  });

  test("accepts a valid owner dashboard credential", () => {
    const token = jwt.sign({ role: "owner" }, TEST_SESSION_SECRET);
    const result = runAdminGuard(`Bearer ${token}`);
    assert.equal(result.nextCalled, true);
    assert.equal(result.statusCode, null);
  });
});
