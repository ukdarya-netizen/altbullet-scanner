import jwt from "jsonwebtoken";
import { and, eq } from "drizzle-orm";
import { dashboardUsersTable, db } from "@workspace/db";
import {
  createDashboardAccessMiddleware,
  requireDashboardOwner,
  type DashboardTokenPayload,
} from "../lib/dashboard-access-middleware-core.js";

const JWT_SECRET = process.env["SESSION_SECRET"] ?? "dev-fallback-secret";
const OWNER_EMAIL = (process.env["OWNER_EMAIL"] ?? "").toLowerCase().trim();

export const requireDashboardAccess = createDashboardAccessMiddleware({
  verifyToken: (token) =>
    jwt.verify(token, JWT_SECRET) as DashboardTokenPayload,
  loadUser: async (userId, email) => {
    const [user] = await db
      .select({
        email: dashboardUsersTable.email,
        status: dashboardUsersTable.status,
        subscribedUntil: dashboardUsersTable.subscribedUntil,
      })
      .from(dashboardUsersTable)
      .where(
        and(
          eq(dashboardUsersTable.id, userId),
          eq(dashboardUsersTable.email, email),
        ),
      )
      .limit(1);
    return user ?? null;
  },
  ownerEmail: OWNER_EMAIL,
  adminToken: process.env.ADMIN_TOKEN,
});

export const requireAuthenticatedDashboardAccess =
  createDashboardAccessMiddleware(
    {
      verifyToken: (token) =>
        jwt.verify(token, JWT_SECRET) as DashboardTokenPayload,
      loadUser: async (userId, email) => {
        const [user] = await db
          .select({
            email: dashboardUsersTable.email,
            status: dashboardUsersTable.status,
            subscribedUntil: dashboardUsersTable.subscribedUntil,
          })
          .from(dashboardUsersTable)
          .where(
            and(
              eq(dashboardUsersTable.id, userId),
              eq(dashboardUsersTable.email, email),
            ),
          )
          .limit(1);
        return user ?? null;
      },
      ownerEmail: OWNER_EMAIL,
      adminToken: process.env.ADMIN_TOKEN,
    },
    { allowPublicRoutes: false },
  );

export { requireDashboardOwner };
