import {
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * wyckoff_entry_metrics — one immutable Wyckoff reading per tracked signal
 * (Stealth, Neon, Impulse Buy, Liquidation Cascade) on 1H candles up to the
 * entry candle. Observation only.
 */
export const wyckoffEntryMetricsTable = pgTable(
  "wyckoff_entry_metrics",
  {
    id: serial("id").primaryKey(),
    trackedSignalId: integer("tracked_signal_id").notNull(),
    symbol: text("symbol").notNull(),
    sentimentKey: text("sentiment_key").notNull(),
    source: text("source").notNull(),
    recordedAt: timestamp("recorded_at").notNull().defaultNow(),
    metrics: jsonb("metrics").notNull(),
  },
  (t) => ({
    signalUnique: uniqueIndex("wyckoff_entry_metrics_signal_unique").on(
      t.trackedSignalId,
    ),
  }),
);
