import assert from "node:assert/strict";
import { test } from "node:test";
import type { NextFunction, Request, Response } from "express";
import {
  createDashboardAccessMiddleware,
  isPublicApiRequest,
  requireDashboardOwner,
} from "../src/lib/dashboard-access-middleware-core.js";

function request(
  path: string,
  authorization?: string,
  adminToken?: string,
): Request {
  return {
    method: "GET",
    path,
    header(name: string) {
      if (name.toLowerCase() === "authorization") return authorization;
      if (name.toLowerCase() === "x-admin-token") return adminToken;
      return undefined;
    },
    log: { error() {} },
  } as unknown as Request;
}

function response() {
  const state: { statusCode: number; body?: unknown } = { statusCode: 200 };
  const locals: Record<string, unknown> = {};
  const res = {
    locals,
    status(statusCode: number) {
      state.statusCode = statusCode;
      return res;
    },
    json(body: unknown) {
      state.body = body;
      return res;
    },
  } as unknown as Response;
  return { res, state, locals };
}

test("only explicitly public API routes bypass the global access gate", () => {
  assert.equal(isPublicApiRequest("GET", "/healthz"), true);
  assert.equal(isPublicApiRequest("POST", "/bootstrap-errors"), true);
  assert.equal(isPublicApiRequest("POST", "/auth/login"), true);
  assert.equal(isPublicApiRequest("POST", "/telegram/webhook"), true);
  assert.equal(isPublicApiRequest("GET", "/signals/summary"), false);
  assert.equal(isPublicApiRequest("GET", "/tracker"), false);
  assert.equal(isPublicApiRequest("GET", "/download/source"), false);
});

test("anonymous data requests are rejected", async () => {
  const middleware = createDashboardAccessMiddleware({
    verifyToken: () => {
      throw new Error("should not verify");
    },
    loadUser: async () => null,
    ownerEmail: "",
  });
  const { res, state } = response();
  let nextCalled = false;
  await middleware(request("/signals/summary"), res, (() => {
    nextCalled = true;
  }) as NextFunction);
  assert.equal(nextCalled, false);
  assert.equal(state.statusCode, 401);
});

test("authenticated-only access does not bypass a public heartbeat path", async () => {
  const middleware = createDashboardAccessMiddleware(
    {
      verifyToken: () => ({ userId: 1, email: "user@example.com" }),
      loadUser: async () => ({
        email: "user@example.com",
        status: "approved",
        subscribedUntil: null,
      }),
      ownerEmail: "",
    },
    { allowPublicRoutes: false },
  );
  const { res, state } = response();
  let nextCalled = false;
  await middleware(request("/auth/heartbeat"), res, (() => {
    nextCalled = true;
  }) as NextFunction);
  assert.equal(nextCalled, false);
  assert.equal(state.statusCode, 401);
});

test("expired dashboard users are rejected with subscription code", async () => {
  const middleware = createDashboardAccessMiddleware({
    verifyToken: () => ({ userId: 27, email: "expired@example.com" }),
    loadUser: async () => ({
      email: "expired@example.com",
      status: "expired",
      subscribedUntil: new Date(Date.now() - 60_000),
    }),
    ownerEmail: "",
  });
  const { res, state } = response();
  let nextCalled = false;
  await middleware(request("/tracker", "Bearer valid"), res, (() => {
    nextCalled = true;
  }) as NextFunction);
  assert.equal(nextCalled, false);
  assert.equal(state.statusCode, 403);
  assert.deepEqual(state.body, {
    error: "Подписка истекла. Свяжитесь с администратором для продления.",
    code: "subscription_expired",
  });
});

test("approved current users reach protected data handlers", async () => {
  const middleware = createDashboardAccessMiddleware({
    verifyToken: () => ({ userId: 12, email: "active@example.com" }),
    loadUser: async () => ({
      email: "active@example.com",
      status: "approved",
      subscribedUntil: new Date(Date.now() + 60_000),
    }),
    ownerEmail: "",
  });
  const { res, state } = response();
  let nextCalled = false;
  await middleware(request("/signals/summary", "Bearer valid"), res, (() => {
    nextCalled = true;
  }) as NextFunction);
  assert.equal(nextCalled, true);
  assert.equal(state.statusCode, 200);
});

test("breakout audit routes require an active dashboard membership", async () => {
  const middleware = createDashboardAccessMiddleware(
    {
      verifyToken: () => ({ userId: 12, email: "active@example.com" }),
      loadUser: async () => ({
        email: "active@example.com",
        status: "approved",
        subscribedUntil: new Date(Date.now() + 60_000),
      }),
      ownerEmail: "",
    },
    { allowPublicRoutes: false },
  );
  for (const path of [
    "/scanner/breakout-analysis",
    "/scanner/breakout-analysis/BTC-USDT",
    "/scanner/breakout-replay",
  ]) {
    const member = response();
    let nextCalled = false;
    await middleware(request(path, "Bearer valid"), member.res, (() => {
      nextCalled = true;
    }) as NextFunction);
    assert.equal(nextCalled, true, `active member can request ${path}`);
    assert.equal(member.state.statusCode, 200);

    const anonymous = response();
    await middleware(request(path), anonymous.res, (() => {
      throw new Error(`anonymous user reached ${path}`);
    }) as NextFunction);
    assert.equal(anonymous.state.statusCode, 401);
  }
});

test("owner expiry is bypassed but blocked owner is denied", async () => {
  let status = "approved";
  const middleware = createDashboardAccessMiddleware({
    verifyToken: () => ({ userId: 1, email: "owner@example.com" }),
    loadUser: async () => ({
      email: "owner@example.com",
      status,
      subscribedUntil: new Date(0),
    }),
    ownerEmail: "owner@example.com",
  });

  const approved = response();
  let approvedNext = false;
  await middleware(request("/tracker", "Bearer valid"), approved.res, (() => {
    approvedNext = true;
  }) as NextFunction);
  assert.equal(approvedNext, true);
  assert.equal(approved.locals.dashboardIsOwner, true);

  status = "blocked";
  const blocked = response();
  let blockedNext = false;
  await middleware(request("/tracker", "Bearer valid"), blocked.res, (() => {
    blockedNext = true;
  }) as NextFunction);
  assert.equal(blockedNext, false);
  assert.equal(blocked.state.statusCode, 403);
  assert.equal(blocked.locals.dashboardIsOwner, false);
});

test("PIN-issued admin JWTs do not receive owner scanner access", async () => {
  const middleware = createDashboardAccessMiddleware({
    verifyToken: () => ({ admin: true }),
    loadUser: async () => {
      throw new Error("admin JWT must not load a DB user");
    },
    ownerEmail: "owner@example.com",
  });
  const { res, locals } = response();
  let nextCalled = false;
  await middleware(request("/scanner/candidates", "Bearer admin"), res, (() => {
    nextCalled = true;
  }) as NextFunction);
  assert.equal(nextCalled, true);
  assert.equal(locals.dashboardIsOwner, false);
});

test("legacy admin token does not receive owner scanner access", async () => {
  const middleware = createDashboardAccessMiddleware({
    verifyToken: () => {
      throw new Error("legacy token must not verify a JWT");
    },
    loadUser: async () => null,
    ownerEmail: "owner@example.com",
    adminToken: "legacy-secret",
  });
  const { res, locals } = response();
  let nextCalled = false;
  await middleware(
    request("/scanner/candidates", undefined, "legacy-secret"),
    res,
    (() => {
      nextCalled = true;
    }) as NextFunction,
  );
  assert.equal(nextCalled, true);
  assert.equal(locals.dashboardIsOwner, false);
});

test("owner-only diagnostic guard returns 403 for non-owner locals", () => {
  const { res, state, locals } = response();
  let nextCalled = false;
  requireDashboardOwner(request("/scanner/symbol-history"), res, (() => {
    nextCalled = true;
  }) as NextFunction);
  assert.equal(nextCalled, false);
  assert.equal(state.statusCode, 403);
  assert.deepEqual(state.body, { error: "Owner access required" });

  locals.dashboardIsOwner = true;
  requireDashboardOwner(request("/scanner/symbol-history"), res, (() => {
    nextCalled = true;
  }) as NextFunction);
  assert.equal(nextCalled, true);
});
