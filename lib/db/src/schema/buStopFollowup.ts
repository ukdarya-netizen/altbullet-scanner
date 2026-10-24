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
 * Hourly post-exit trajectory for every terminal tracked signal.
 *
 * The legacy table name is retained so existing B.E. observations remain
 * available without copying or double-counting them.
 */
export const buStopFollowupSnapshotsTable = pgTable(
  "bu_stop_followup_snapshots",
  {
    id: serial("id").primaryKey(),
    trackedSignalId: integer("tracked_signal_id").notNull(),
    symbol: text("symbol").notNull(),
    status: text("status").notNull().default("bu_stop"),
    closedAt: timestamp("closed_at"),
    exitPrice: real("exit_price"),
    isShort: boolean("is_short").notNull().default(false),
    hourAfterClose: integer("hour_after_close").notNull(),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
    price: real("price").notNull(),
    movePct: real("move_pct").notNull(),
  },
  (table) => [
    uniqueIndex("bu_stop_followup_signal_hour_uniq").on(
      table.trackedSignalId,
      table.hourAfterClose,
    ),
    index("bu_stop_followup_observed_at_idx").on(table.observedAt),
    index("bu_stop_followup_symbol_idx").on(table.symbol),
    index("bu_stop_followup_status_closed_idx").on(
      table.status,
      table.closedAt,
    ),
  ],
);

export type BuStopFollowupSnapshot =
  typeof buStopFollowupSnapshotsTable.$inferSelect;
export const postCloseFollowupSnapshotsTable = buStopFollowupSnapshotsTable;
export type PostCloseFollowupSnapshotRow =
  typeof postCloseFollowupSnapshotsTable.$inferSelect;
