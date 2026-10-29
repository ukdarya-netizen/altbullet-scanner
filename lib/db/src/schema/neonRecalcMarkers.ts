import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

// One-off production data fixes record their run here (created at runtime by
// the fixes). Declared so a Replit publish never proposes dropping it: on
// 29.10 a missing marker let the 25.10 ABNeon recalc run a second time.
export const neonRecalcMarkersTable = pgTable("neon_recalc_markers", {
  name: text("name").primaryKey(),
  appliedAt: timestamp("applied_at", { withTimezone: true }).notNull().defaultNow(),
});
