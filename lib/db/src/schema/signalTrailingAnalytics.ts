import {
  bigint,
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
 * Immutable audit of the trailing configuration that actually governed a
 * tracked position. This is deliberately not a trading-state table.
 */
export const signalTrailingEventsTable = pgTable(
  "signal_trailing_events",
  {
    id: serial("id").primaryKey(),
    signalId: integer("signal_id").notNull(),
    symbol: text("symbol").notNull(),
    sentimentKey: text("sentiment_key").notNull(),
    eventType: text("event_type").notNull(), // activated | hit
    isShort: boolean("is_short").notNull().default(false),
    activationPct: real("activation_pct").notNull(),
    trailingGapPct: real("trailing_gap_pct").notNull(),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
    peakPrice: real("peak_price").notNull(),
    peakPnlPct: real("peak_pnl_pct").notNull(),
    currentPrice: real("current_price").notNull(),
    currentPnlPct: real("current_pnl_pct").notNull(),
    trailingStopPrice: real("trailing_stop_price").notNull(),
    theoreticalExitPnlPct: real("theoretical_exit_pnl_pct").notNull(),
    actualStatus: text("actual_status"),
    actualExitPrice: real("actual_exit_price"),
    actualPnlPct: real("actual_pnl_pct"),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    /** Difference between the first observed hit and the recorded close. */
    latencyMs: bigint("latency_ms", { mode: "number" }),
    /** The market transport that observed the first valid crossing. */
    priceSource: text("price_source").notNull().default("fast_cycle"),
  },
  (table) => [
    uniqueIndex("signal_trailing_events_signal_type_uniq").on(
      table.signalId,
      table.eventType,
    ),
    index("signal_trailing_events_pattern_idx").on(table.sentimentKey),
    index("signal_trailing_events_observed_at_idx").on(table.observedAt),
  ],
);

/**
 * Immutable shadow observations for candidate trailing profiles. One signal
 * gets one row for each candidate and lifecycle checkpoint, so conclusions can
 * be replayed without changing a real exit.
 */
export const signalTrailingShadowEventsTable = pgTable(
  "signal_trailing_shadow_events",
  {
    id: serial("id").primaryKey(),
    signalId: integer("signal_id").notNull(),
    symbol: text("symbol").notNull(),
    sentimentKey: text("sentiment_key").notNull(),
    isShort: boolean("is_short").notNull().default(false),
    activationPct: real("activation_pct").notNull(),
    trailingGapPct: real("trailing_gap_pct").notNull(),
    eventType: text("event_type").notNull(), // activated | hit | 6h | 24h | 72h | close
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
    currentPrice: real("current_price").notNull(),
    currentPnlPct: real("current_pnl_pct").notNull(),
    peakPrice: real("peak_price").notNull(),
    peakPnlPct: real("peak_pnl_pct").notNull(),
    virtualStopPrice: real("virtual_stop_price").notNull(),
    actualStatus: text("actual_status"),
    actualExitPrice: real("actual_exit_price"),
    actualPnlPct: real("actual_pnl_pct"),
  },
  (table) => [
    uniqueIndex("signal_trailing_shadow_event_uniq").on(
      table.signalId,
      table.activationPct,
      table.trailingGapPct,
      table.eventType,
    ),
    index("signal_trailing_shadow_pattern_idx").on(table.sentimentKey),
    index("signal_trailing_shadow_event_at_idx").on(table.observedAt),
  ],
);

export type SignalTrailingEvent = typeof signalTrailingEventsTable.$inferSelect;
export type SignalTrailingShadowEvent =
  typeof signalTrailingShadowEventsTable.$inferSelect;
