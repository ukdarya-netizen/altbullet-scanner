import type { NextFunction, Request, RequestHandler, Response } from "express";
import crypto from "node:crypto";
import { getDashboardAccessStatus } from "./dashboard-access-policy.js";

export type DashboardTokenPayload = {
  userId?: number;
  email?: string;
  admin?: boolean;
};

export type DashboardAccessUser = {
  email: string;
  status: string;
  subscribedUntil: Date | null;
};

export type DashboardAccessDependencies = {
  verifyToken: (token: string) => DashboardTokenPayload;
  loadUser: (
    userId: number,
    email: string,
  ) => Promise<DashboardAccessUser | null>;
  ownerEmail: string;
  adminToken?: string;
};

export type DashboardAccessMiddlewareOptions = {
  allowPublicRoutes?: boolean;
};

const PUBLIC_API_ROUTES = new Set([
  "GET /healthz",
  "POST /bootstrap-errors",
  "POST /auth/register",
  "POST /auth/login",
  "GET /auth/me",
  "POST /auth/heartbeat",
  "POST /auth/reset-confirm",
  "POST /admin/verify-pin",
  "POST /telegram/webhook",
]);

export function isPublicApiRequest(method: string, path: string): boolean {
  return (
    method.toUpperCase() === "OPTIONS" ||
    PUBLIC_API_ROUTES.has(`${method.toUpperCase()} ${path}`)
  );
}

export const requireDashboardOwner: RequestHandler = (_req, res, next) => {
  if (res.locals.dashboardIsOwner !== true) {
    res.status(403).json({ error: "Owner access required" });
    return;
  }
  next();
};

function secureTokenEquals(expected: string, provided: string): boolean {
  const expectedBuffer = Buffer.from(expected);
  const providedBuffer = Buffer.from(provided);
  return (
    expectedBuffer.length === providedBuffer.length &&
    crypto.timingSafeEqual(expectedBuffer, providedBuffer)
  );
}

export function createDashboardAccessMiddleware(
  dependencies: DashboardAccessDependencies,
  options: DashboardAccessMiddlewareOptions = {},
) {
  return async function dashboardAccessMiddleware(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    res.locals.dashboardIsOwner = false;

    if (
      options.allowPublicRoutes !== false &&
      isPublicApiRequest(req.method, req.path)
    ) {
      next();
      return;
    }

    const legacyAdminToken = req.header("X-Admin-Token");
    if (
      dependencies.adminToken &&
      legacyAdminToken &&
      secureTokenEquals(dependencies.adminToken, legacyAdminToken)
    ) {
      next();
      return;
    }

    const authorization = req.header("Authorization");
    if (!authorization?.startsWith("Bearer ")) {
      res.status(401).json({ error: "Не авторизован" });
      return;
    }

    let payload: DashboardTokenPayload;
    try {
      payload = dependencies.verifyToken(authorization.slice(7));
    } catch {
      res.status(401).json({ error: "Токен недействителен" });
      return;
    }

    // PIN-issued admin JWTs are deliberately separate from subscriber accounts.
    if (payload.admin === true) {
      next();
      return;
    }

    const userId = Number(payload.userId);
    const email =
      typeof payload.email === "string"
        ? payload.email.toLowerCase().trim()
        : "";
    if (!Number.isSafeInteger(userId) || userId <= 0 || !email) {
      res.status(401).json({ error: "Токен недействителен" });
      return;
    }

    try {
      const user = await dependencies.loadUser(userId, email);
      if (!user) {
        res.status(401).json({ error: "Пользователь не найден" });
        return;
      }

      const accessStatus = getDashboardAccessStatus({
        isOwner:
          dependencies.ownerEmail !== "" &&
          user.email.toLowerCase().trim() === dependencies.ownerEmail,
        status: user.status,
        subscribedUntil: user.subscribedUntil,
        now: new Date(),
      });
      if (accessStatus === "expired") {
        res.status(403).json({
          error: "Подписка истекла. Свяжитесь с администратором для продления.",
          code: "subscription_expired",
        });
        return;
      }
      if (accessStatus !== "approved") {
        res.status(403).json({
          error: "Доступ недоступен",
          code: "access_denied",
        });
        return;
      }

      res.locals.dashboardIsOwner =
        dependencies.ownerEmail !== "" &&
        user.email.toLowerCase().trim() === dependencies.ownerEmail;
      next();
    } catch (error) {
      req.log?.error?.({ err: error }, "dashboard access lookup failed");
      res.status(503).json({ error: "Проверка доступа временно недоступна" });
    }
  };
}
