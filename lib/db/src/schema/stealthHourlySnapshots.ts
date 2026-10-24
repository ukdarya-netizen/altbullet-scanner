import {
  bigint,
  integer,
  jsonb,
  pgTable,
  real,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * stealth_hourly_snapshots — one immutable row per (tracked signal, hour since
 * detection) for open Stealth Breakout positions. Observation only: nothing
 * here feeds a trading decision. `metrics` holds aggregated CoinGlass values
 * (OI, futures taker, spot CVD, spot volume); a missing value is stored as
 * null, never reconstructed.
 */
export const stealthHourlySnapshotsTable = pgTable(
  "stealth_hourly_snapshots",
  {
    id: serial("id").primaryKey(),
    trackedSignalId: integer("tracked_signal_id").notNull(),
    symbol: text("symbol").notNull(),
    /** 1..72: whole hours elapsed since detection when the row was taken */
    hourIndex: integer("hour_index").notNull(),
    snapshotAt: timestamp("snapshot_at").notNull().defaultNow(),
    elapsedMs: bigint("elapsed_ms", { mode: "number" }).notNull(),
    priceAt: real("price_at").notNull(),
    pctFromEntry: real("pct_from_entry").notNull(),
    peakPct: real("peak_pct").notNull(),
    status: text("status").notNull(),
    metrics: jsonb("metrics").notNull(),
  },
  (t) => ({
    signalHourUnique: uniqueIndex(
      "stealth_hourly_snapshots_signal_hour_unique",
    ).on(t.trackedSignalId, t.hourIndex),
  }),
);
