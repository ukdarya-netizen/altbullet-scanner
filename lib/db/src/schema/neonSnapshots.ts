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
 * neon_snapshots — one immutable row per (tracked signal, 10-minute slot since
 * detection) for Neon Support Bounce positions. Observation only: nothing
 * here feeds a trading decision. `metrics` holds aggregated CoinGlass values
 * (OI, futures taker, spot CVD, spot volume); a missing value is stored as
 * null, never reconstructed.
 */
export const neonSnapshotsTable = pgTable(
  "neon_snapshots",
  {
    id: serial("id").primaryKey(),
    trackedSignalId: integer("tracked_signal_id").notNull(),
    symbol: text("symbol").notNull(),
    /** 0..432: whole 10-minute slots elapsed since detection when the row was taken */
    slotIndex: integer("slot_index").notNull(),
    snapshotAt: timestamp("snapshot_at").notNull().defaultNow(),
    elapsedMs: bigint("elapsed_ms", { mode: "number" }).notNull(),
    priceAt: real("price_at").notNull(),
    pctFromEntry: real("pct_from_entry").notNull(),
    peakPct: real("peak_pct").notNull(),
    status: text("status").notNull(),
    metrics: jsonb("metrics").notNull(),
  },
  (t) => ({
    signalSlotUnique: uniqueIndex("neon_snapshots_signal_slot_unique").on(
      t.trackedSignalId,
      t.slotIndex,
    ),
  }),
);
