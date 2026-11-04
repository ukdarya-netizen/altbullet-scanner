import {
  boolean,
  index,
  integer,
  pgTable,
  real,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * Immutable, observational lifecycle for the entry-anchored profit-lock
 * candidate: activate at +10% and protect +5% from entry.
 *
 * This table must never be read by the live exit path.
 */
export const signalProfitLockShadowEventsTable = pgTable(
  "signal_profit_lock_shadow_events",
  {
    id: serial("id").primaryKey(),
    signalId: integer("signal_id").notNull(),
    symbol: text("symbol").notNull(),
    sentimentKey: text("sentiment_key").notNull(),
    isShort: boolean("is_short").notNull().default(false),
    activationPct: real("activation_pct").notNull(),
    lockedProfitPct: real("locked_profit_pct").notNull(),
    /** activated | hit | 6h | 24h | 72h | close */
    eventType: text("event_type").notNull(),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
    currentPrice: real("current_price").notNull(),
    currentPnlPct: real("current_pnl_pct").notNull(),
    peakPrice: real("peak_price").notNull(),
    peakPnlPct: real("peak_pnl_pct").notNull(),
    lockedStopPrice: real("locked_stop_price").notNull(),
    actualStatus: text("actual_status"),
    actualExitPrice: real("actual_exit_price"),
    actualPnlPct: real("actual_pnl_pct"),
  },
  (table) => [
    uniqueIndex("signal_profit_lock_shadow_event_uniq").on(
      table.signalId,
      table.activationPct,
      table.lockedProfitPct,
      table.eventType,
    ),
    index("signal_profit_lock_shadow_pattern_idx").on(table.sentimentKey),
    index("signal_profit_lock_shadow_event_at_idx").on(table.observedAt),
    index("signal_profit_lock_shadow_type_at_idx").on(
      table.eventType,
      table.observedAt,
    ),
  ],
);

export type SignalProfitLockShadowEvent =
  typeof signalProfitLockShadowEventsTable.$inferSelect;
