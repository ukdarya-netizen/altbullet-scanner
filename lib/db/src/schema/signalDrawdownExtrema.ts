import {
  bigint,
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
 * Observed adverse excursion for a tracked signal.
 *
 * This is a mutable summary: FastCycle atomically keeps the lowest observed
 * direction-aware PnL and the exact observation that produced it. It is
 * intentionally separate from signal_trajectory_log, whose interval rows are
 * immutable calibration snapshots.
 */
export const signalDrawdownExtremaTable = pgTable(
  "signal_drawdown_extrema",
  {
    id: serial("id").primaryKey(),
    signalId: integer("signal_id").notNull(),
    symbol: text("symbol").notNull(),
    sentimentKey: text("sentiment_key").notNull(),
    /** Lowest direction-aware PnL observed while the position was open. */
    minPctFromEntry: real("min_pct_from_entry").notNull(),
    /** Market price at minPctFromEntry, not a reconstructed close price. */
    priceAtMin: real("price_at_min").notNull(),
    minObservedAt: timestamp("min_observed_at", {
      withTimezone: true,
    }).notNull(),
    /** Actual elapsed time from detectedAt at the minimum observation. */
    minElapsedMs: bigint("min_elapsed_ms", { mode: "number" }).notNull(),
    /** Current collection source, e.g. fast_cycle. */
    source: text("source").notNull(),
    /** Signal state at the moment the minimum was observed. */
    statusAtMin: text("status_at_min").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("signal_drawdown_extrema_signal_uniq").on(table.signalId),
    index("signal_drawdown_extrema_observed_at_idx").on(table.minObservedAt),
    index("signal_drawdown_extrema_pattern_idx").on(table.sentimentKey),
  ],
);

export type SignalDrawdownExtrema =
  typeof signalDrawdownExtremaTable.$inferSelect;
