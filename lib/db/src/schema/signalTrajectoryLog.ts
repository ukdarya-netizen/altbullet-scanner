import {
  bigint,
  integer,
  pgTable,
  real,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * signal_trajectory_log — trajectory snapshots for every fired signal.
 *
 * One row per (signal_id, interval_label). Snapshots are written by
 * FastCycle (every 2 min) once elapsed time since detectedAt crosses
 * the interval threshold. ON CONFLICT DO NOTHING makes writes idempotent.
 *
 * Intervals: 15m / 30m / 1h / 2h / 4h / 8h / 24h / 48h / 72h
 *
 * Purpose: pattern calibration — entry conditions → time-bucketed outcomes.
 */
export const signalTrajectoryLogTable = pgTable(
  "signal_trajectory_log",
  {
    id: serial("id").primaryKey(),
    /** tracked_signals.id of the originating signal */
    signalId: integer("signal_id").notNull(),
    symbol: text("symbol").notNull(),
    sentimentKey: text("sentiment_key").notNull(),
    /** '15m' | '30m' | '1h' | '2h' | '4h' | '8h' | '24h' | '48h' | '72h' */
    intervalLabel: text("interval_label").notNull(),
    snapshotAt: timestamp("snapshot_at").notNull().defaultNow(),
    /** Actual elapsed ms from detectedAt at time of snapshot */
    elapsedMs: bigint("elapsed_ms", { mode: "number" }).notNull(),
    /** Current price at snapshot time */
    priceAt: real("price_at").notNull(),
    /** Signed % change from entry price */
    pctFromEntry: real("pct_from_entry").notNull(),
    /** Max % achieved from entry up to this snapshot */
    peakPct: real("peak_pct").notNull(),
    /** Signal status at snapshot time: active / in_run / closed / stop_loss / etc. */
    status: text("status").notNull(),
  },
  (t) => ({
    signalIntervalUnique: uniqueIndex(
      "signal_trajectory_log_signal_interval_unique",
    ).on(t.signalId, t.intervalLabel),
  }),
);
