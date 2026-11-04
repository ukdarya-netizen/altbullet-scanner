import {
  doublePrecision,
  index,
  integer,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { signalsTable, trackedSignalsTable } from "./signals";

export const altBulletTakeProfitShadowTable = pgTable(
  "altbullet_take_profit_shadow",
  {
    id: serial("id").primaryKey(),
    signalId: integer("signal_id")
      .notNull()
      .references(() => signalsTable.id),
    trackedSignalId: integer("tracked_signal_id").references(
      () => trackedSignalsTable.id,
    ),
    symbol: text("symbol").notNull(),
    sentimentKey: text("sentiment_key"),
    indicatorVersion: text("indicator_version").notNull(),
    experimentVersion: text("experiment_version").notNull(),
    variant: text("variant").notNull(),
    status: text("status").notNull(),
    eligibilityReason: text("eligibility_reason"),
    referenceEntryPrice: doublePrecision("reference_entry_price"),
    resistancePrice: doublePrecision("resistance_price"),
    atr14: doublePrecision("atr14"),
    targetPrice: doublePrecision("target_price"),
    targetPct: doublePrecision("target_pct"),
    targetAtr: doublePrecision("target_atr"),
    snapshotRequestedAt: timestamp("snapshot_requested_at"),
    snapshotCapturedAt: timestamp("snapshot_captured_at").notNull(),
    enrolledAt: timestamp("enrolled_at").notNull().defaultNow(),
    firstObservedAt: timestamp("first_observed_at"),
    firstObservedPrice: doublePrecision("first_observed_price"),
    lastObservedAt: timestamp("last_observed_at"),
    lastObservedPrice: doublePrecision("last_observed_price"),
    maxObservedAt: timestamp("max_observed_at"),
    maxObservedPrice: doublePrecision("max_observed_price"),
    hitAt: timestamp("hit_at"),
    hitPrice: doublePrecision("hit_price"),
    terminalAt: timestamp("terminal_at"),
    terminalStatus: text("terminal_status"),
    terminalPnlPercent: doublePrecision("terminal_pnl_percent"),
    outcome: text("outcome"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("altbullet_tp_shadow_signal_variant_unique").on(
      table.signalId,
      table.experimentVersion,
      table.variant,
    ),
    index("altbullet_tp_shadow_tracking_idx").on(
      table.status,
      table.trackedSignalId,
    ),
    index("altbullet_tp_shadow_version_idx").on(
      table.indicatorVersion,
      table.experimentVersion,
    ),
  ],
);

export type AltBulletTakeProfitShadow =
  typeof altBulletTakeProfitShadowTable.$inferSelect;
