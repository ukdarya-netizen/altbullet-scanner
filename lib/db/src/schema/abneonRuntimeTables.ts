import { boolean, doublePrecision, integer, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

// Owner 2026-11-12: created at runtime by api-server (abneon-month-volume-neutral-close.ts,
// abneon-lucy-level-neutral-close.ts, level-takes-tracking.ts). Declared exactly as created there so a Replit
// publish never proposes dropping or altering them.
export const abneonMonthVolumeReviewTable = pgTable("abneon_month_volume_review", {
  trackedId: integer("tracked_id").primaryKey(),
  symbol: text("symbol").notNull(),
  statusBefore: text("status_before").notNull(),
  detectedAt: timestamp("detected_at", { withTimezone: true }),
  futVsMonth: doublePrecision("fut_vs_month"),
  spotVsMonth: doublePrecision("spot_vs_month"),
  verdict: text("verdict").notNull(),
  action: text("action").notNull(),
  attempts: integer("attempts").notNull().default(1),
  reviewedAt: timestamp("reviewed_at", { withTimezone: true }).notNull().defaultNow(),
});

export const abneonLucyLevelReviewTable = pgTable("abneon_lucy_level_review", {
  trackedId: integer("tracked_id").primaryKey(),
  symbol: text("symbol").notNull(),
  statusBefore: text("status_before").notNull(),
  detectedAt: timestamp("detected_at", { withTimezone: true }),
  verdict: text("verdict").notNull(),
  detail: text("detail"),
  entryAboveTopPct: doublePrecision("entry_above_top_pct"),
  colours: text("colours"),
  action: text("action").notNull(),
  attempts: integer("attempts").notNull().default(1),
  reviewedAt: timestamp("reviewed_at", { withTimezone: true }).notNull().defaultNow(),
});

export const levelTakeTrackingTable = pgTable("level_take_tracking", {
  trackedId: integer("tracked_id").primaryKey(),
  symbol: text("symbol").notNull(),
  sentimentKey: text("sentiment_key").notNull(),
  entryPrice: doublePrecision("entry_price").notNull(),
  detectedAt: timestamp("detected_at", { withTimezone: true }).notNull(),
  levels: jsonb("levels").notNull(),
  trackedUntil: timestamp("tracked_until", { withTimezone: true }),
  final: boolean("final").notNull().default(false),
  statusAtFinal: text("status_at_final"),
  pnlAtFinal: doublePrecision("pnl_at_final"),
  peakPct: doublePrecision("peak_pct"),
  error: text("error"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
