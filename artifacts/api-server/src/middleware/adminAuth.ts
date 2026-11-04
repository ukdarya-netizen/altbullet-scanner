import type { Request, Response, NextFunction } from "express";
import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import { logger } from "../lib/logger.js";

const JWT_SECRET = process.env["SESSION_SECRET"] ?? "dev-fallback-secret";

// ── Admin auth middleware ────────────────────────────────────────────────
// Защита чувствительных/тяжёлых эндпоинтов. Принимает:
//   1. X-Admin-Token заголовок совпадающий с ADMIN_TOKEN env var (legacy)
//   2. Authorization: Bearer <jwt> где jwt.role === "owner" (dashboard auth)
// Сравнение legacy токена через crypto.timingSafeEqual (timing-safe).
export function requireAdminToken(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  // ── Option 1: Legacy ADMIN_TOKEN ──
  const expected = process.env.ADMIN_TOKEN;
  const provided = req.header("X-Admin-Token");
  if (expected && provided) {
    try {
      const expectedBuf = Buffer.from(expected);
      const providedBuf = Buffer.from(provided);
      if (
        expectedBuf.length === providedBuf.length &&
        crypto.timingSafeEqual(expectedBuf, providedBuf)
      ) {
        return next();
      }
    } catch {
      // fall through to JWT check
    }
  }

  // ── Option 2: Dashboard JWT with role=owner ──
  const auth = req.header("Authorization");
  if (auth?.startsWith("Bearer ")) {
    try {
      const payload = jwt.verify(auth.slice(7), JWT_SECRET) as {
        role?: string;
      };
      if (payload.role === "owner") {
        return next();
      }
    } catch {
      // invalid/expired JWT — fall through
    }
  }

  logger.warn({ url: req.url, method: req.method }, "Admin access denied");
  res.status(401).json({ error: "Требуется авторизация" });
}
