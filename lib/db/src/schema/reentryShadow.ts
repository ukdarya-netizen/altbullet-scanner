import {
  index,
  integer,
  pgTable,
  real,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/** Immutable, non-actionable observations of the retired re-entry detector. */
export const reentryShadowEventsTable = pgTable(
  "reentry_shadow_events",
  {
    id: serial("id").primaryKey(),
    trackedSignalId: integer("tracked_signal_id").notNull(),
    eventKey: text("event_key").notNull(),
    source: text("source").notNull(),
    detectorVersion: text("detector_version").notNull(),
    symbol: text("symbol").notNull(),
    pattern: text("pattern").notNull(),
    candidateAt: timestamp("candidate_at", { withTimezone: true }).notNull(),
    proposedReentryPrice: real("proposed_reentry_price").notNull(),
    originalEntryPrice: real("original_entry_price").notNull(),
    currentPnlPct: real("current_pnl_pct"),
    volumeMultiplier: real("volume_multiplier"),
    spotVolumeMultiplier: real("spot_volume_multiplier"),
    oiEvidence: real("oi_evidence"),
    cvdEvidence: text("cvd_evidence"),
    context: text("context"),
    outcome4hPct: real("outcome_4h_pct"),
    outcome4hObservedAt: timestamp("outcome_4h_observed_at", {
      withTimezone: true,
    }),
    outcome8hPct: real("outcome_8h_pct"),
    outcome8hObservedAt: timestamp("outcome_8h_observed_at", {
      withTimezone: true,
    }),
    outcome24hPct: real("outcome_24h_pct"),
    outcome24hObservedAt: timestamp("outcome_24h_observed_at", {
      withTimezone: true,
    }),
  },
  (table) => [
    uniqueIndex("reentry_shadow_event_key_uniq").on(table.eventKey),
    index("reentry_shadow_candidate_at_idx").on(table.candidateAt),
    index("reentry_shadow_pattern_idx").on(table.pattern),
  ],
);

export type ReentryShadowEvent = typeof reentryShadowEventsTable.$inferSelect;
export type InsertReentryShadowEvent =
  typeof reentryShadowEventsTable.$inferInsert;
