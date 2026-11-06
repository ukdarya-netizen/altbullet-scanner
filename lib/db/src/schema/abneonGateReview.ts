import { doublePrecision, integer, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

// Created at runtime by one-off production fixes (abneon-gate-neutral-close.ts,
// abneon-nov-stops-neutral.ts). Declared so a Replit publish never proposes dropping them.
export const abneonGateReviewTable = pgTable("abneon_gate_review", {
  trackedId: integer("tracked_id").primaryKey(),
  symbol: text("symbol").notNull(),
  statusBefore: text("status_before").notNull(),
  pnlPercentBefore: doublePrecision("pnl_percent_before"),
  detectedAt: timestamp("detected_at", { withTimezone: true }),
  armedAt: timestamp("armed_at", { withTimezone: true }),
  triggerAt: timestamp("trigger_at", { withTimezone: true }),
  zoneTop: doublePrecision("zone_top"),
  blueOf12: integer("blue_of_12"),
  verdict: text("verdict").notNull(),
  action: text("action").notNull(),
  reviewedAt: timestamp("reviewed_at", { withTimezone: true }).notNull().defaultNow(),
});

export const abneonNovStopsBackupTable = pgTable("abneon_nov_stops_backup", {
  id: integer("id").primaryKey(),
  original: jsonb("original").notNull(),
  backedUpAt: timestamp("backed_up_at", { withTimezone: true }).notNull().defaultNow(),
});
