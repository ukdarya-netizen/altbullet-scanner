import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * Cross-worker ownership for jobs that must never overlap.
 *
 * Schema changes are applied by the normal development/publish schema flow.
 * Runtime code only claims, renews, and releases rows in this table.
 */
export const schedulerLeasesTable = pgTable("scheduler_leases", {
  leaseName: text("lease_name").primaryKey(),
  ownerToken: text("owner_token").notNull(),
  acquiredAt: timestamp("acquired_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  heartbeatAt: timestamp("heartbeat_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});

export type SchedulerLease = typeof schedulerLeasesTable.$inferSelect;
