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
 * vsa_entry_metrics — one immutable VSA reading per tracked signal (Stealth and
 * Neon), taken on the last closed 1H candle before the signal. Observation only.
 * Price spread comes from candle OHLC; volume is the aggregated CoinGlass one.
 */
export const vsaEntryMetricsTable = pgTable(
  "vsa_entry_metrics",
  {
    id: serial("id").primaryKey(),
    trackedSignalId: integer("tracked_signal_id").notNull(),
    symbol: text("symbol").notNull(),
    sentimentKey: text("sentiment_key").notNull(),
    /** "live" = taken right after the signal, "backfill" = computed later from history */
    source: text("source").notNull(),
    recordedAt: timestamp("recorded_at").notNull().defaultNow(),
    metrics: jsonb("metrics").notNull(),
  },
  (t) => ({
    signalUnique: uniqueIndex("vsa_entry_metrics_signal_unique").on(
      t.trackedSignalId,
    ),
  }),
);
