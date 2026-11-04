import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  real,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/** Immutable boundary records for fired, missed, and non-executed pattern decisions. */
export const patternDecisionSnapshotsTable = pgTable(
  "pattern_decision_snapshots",
  {
    id: serial("id").primaryKey(),
    eventKey: text("event_key").notNull(),
    trackedSignalId: integer("tracked_signal_id"),
    missedSignalId: integer("missed_signal_id"),
    signalId: integer("signal_id"),
    symbol: text("symbol").notNull(),
    patternKey: text("pattern_key").notNull(),
    decisionKind: text("decision_kind").notNull(), // fired | missed | rejected | blocked | watching | expired | deferred
    decisionReason: text("decision_reason"),
    decisionAt: timestamp("decision_at", { withTimezone: true }).notNull(),
    isShort: boolean("is_short").notNull().default(false),
    entryPrice: real("entry_price"),
    entryMetrics: jsonb("entry_metrics").notNull(),
    provenance: jsonb("provenance").notNull(),
    completeness: jsonb("completeness").notNull(),
    source: text("source").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    trajectoryStatus: text("trajectory_status").notNull().default("pending"),
    trajectoryAttempts: integer("trajectory_attempts").notNull().default(0),
    trajectoryLastAttemptAt: timestamp("trajectory_last_attempt_at", {
      withTimezone: true,
    }),
    trajectoryNextAttemptAt: timestamp("trajectory_next_attempt_at", {
      withTimezone: true,
    }),
    trajectoryCompletedAt: timestamp("trajectory_completed_at", {
      withTimezone: true,
    }),
    trajectoryLastError: text("trajectory_last_error"),
    trajectoryCandleCount: integer("trajectory_candle_count")
      .notNull()
      .default(0),
    trajectoryClaimToken: text("trajectory_claim_token"),
    trajectoryClaimedAt: timestamp("trajectory_claimed_at", {
      withTimezone: true,
    }),
    trajectoryClaimExpiresAt: timestamp("trajectory_claim_expires_at", {
      withTimezone: true,
    }),
  },
  (t) => ({
    eventKeyUnique: uniqueIndex(
      "pattern_decision_snapshots_event_key_unique",
    ).on(t.eventKey),
    decisionAtIdx: index("pattern_decision_snapshots_decision_at_idx").on(
      t.decisionAt,
    ),
    trajectoryDueIdx: index("pattern_decision_snapshots_trajectory_due_idx").on(
      t.trajectoryStatus,
      t.trajectoryNextAttemptAt,
    ),
    trajectoryClaimIdx: index(
      "pattern_decision_snapshots_trajectory_claim_idx",
    ).on(t.trajectoryClaimExpiresAt),
    trackedSignalIdx: index("pattern_decision_snapshots_tracked_signal_idx").on(
      t.trackedSignalId,
    ),
  }),
);

/** Exchange OHLCV retained for deterministic TP/SL, MFE and MAE replay. */
export const patternBackfillCandlesTable = pgTable(
  "pattern_backfill_candles",
  {
    id: serial("id").primaryKey(),
    decisionSnapshotId: integer("decision_snapshot_id").notNull(),
    interval: text("interval").notNull().default("15m"),
    candleAt: timestamp("candle_at", { withTimezone: true }).notNull(),
    open: real("open").notNull(),
    high: real("high").notNull(),
    low: real("low").notNull(),
    close: real("close").notNull(),
    volume: real("volume"),
    source: text("source").notNull(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    snapshotCandleUnique: uniqueIndex(
      "pattern_backfill_candles_snapshot_candle_unique",
    ).on(t.decisionSnapshotId, t.candleAt),
    snapshotIntervalIdx: index(
      "pattern_backfill_candles_snapshot_interval_idx",
    ).on(t.decisionSnapshotId, t.interval),
  }),
);

export type PatternDecisionSnapshot =
  typeof patternDecisionSnapshotsTable.$inferSelect;

/** Durable pre-breakout lifecycle for the separate Expansion Breakout path. */
export const expansionBreakoutSetupsTable = pgTable(
  "expansion_breakout_setups",
  {
    id: serial("id").primaryKey(),
    symbol: text("symbol").notNull(),
    structureKey: text("structure_key").notNull(),
    source: text("source").notNull(),
    frozenLevel: real("frozen_level").notNull(),
    atr: real("atr").notNull(),
    provenance: jsonb("provenance").notNull(),
    armedAt: timestamp("armed_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    status: text("status").notNull().default("armed"),
    rawCrossObservedAt: timestamp("raw_cross_observed_at", {
      withTimezone: true,
    }),
    rawCrossCandleAt: timestamp("raw_cross_candle_at", { withTimezone: true }),
    rawCrossPrice: real("raw_cross_price"),
    reclaimCount: integer("reclaim_count").notNull().default(0),
    decisionAt: timestamp("decision_at", { withTimezone: true }),
    terminalReason: text("terminal_reason"),
    decisionJson: jsonb("decision_json"),
    firedSignalId: integer("fired_signal_id"),
    fireClaimedAt: timestamp("fire_claimed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    symbolIdx: index("expansion_breakout_setups_symbol_idx").on(t.symbol),
    statusIdx: index("expansion_breakout_setups_status_idx").on(
      t.status,
      t.expiresAt,
    ),
    rawCrossIdx: index("expansion_breakout_setups_raw_cross_idx").on(
      t.rawCrossObservedAt,
    ),
  }),
);
