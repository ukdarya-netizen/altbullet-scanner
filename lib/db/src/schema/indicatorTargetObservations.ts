import {
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const indicatorTargetObservationExperimentsTable = pgTable(
  "indicator_target_observation_experiments",
  {
    experimentVersion: text("experiment_version").primaryKey(),
    startAt: timestamp("start_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex("indicator_target_observation_experiment_start_unique").on(
      table.experimentVersion,
      table.startAt,
    ),
  ],
);

export const indicatorTargetObservationsTable = pgTable(
  "indicator_target_observations",
  {
    id: serial("id").primaryKey(),
    // Intentionally no foreign keys: tracker/signal cleanup must not remove or
    // block deletion of this independent 72h evidence archive.
    signalId: integer("signal_id").notNull(),
    trackedSignalId: integer("tracked_signal_id").notNull(),
    experimentVersion: text("experiment_version").notNull(),
    targetPct: doublePrecision("target_pct").notNull(),
    hypothesisLabel: text("hypothesis_label").notNull(),
    symbol: text("symbol").notNull(),
    pattern: text("pattern").notNull(),
    isShort: boolean("is_short").notNull().default(false),
    entryPrice: doublePrecision("entry_price").notNull(),
    targetPrice: doublePrecision("target_price").notNull(),
    signalAt: timestamp("signal_at", { withTimezone: true }).notNull(),
    tradeClosedAt: timestamp("trade_closed_at", { withTimezone: true }),
    tradeStatus: text("trade_status"),
    entryMetricsSnapshot: jsonb("entry_metrics_snapshot")
      .$type<Record<string, unknown>>()
      .notNull(),
    indicatorProvenanceStatus: text("indicator_provenance_status").notNull(),
    indicatorProvenance: jsonb("indicator_provenance").$type<
      Record<string, unknown>
    >(),
    abneonSnapshotStatus: text("abneon_snapshot_status")
      .notNull()
      .default("awaiting_entry_snapshot"),
    abneonIndicatorVersion: text("abneon_indicator_version"),
    abneonSnapshotCapturedAt: timestamp("abneon_snapshot_captured_at", {
      withTimezone: true,
    }),
    abneonSnapshotContext: jsonb("abneon_snapshot_context").$type<
      Record<string, unknown>
    >(),
    status: text("status").notNull().default("awaiting_hit"),
    hitAt: timestamp("hit_at", { withTimezone: true }),
    hitPrice: doublePrecision("hit_price"),
    hitSource: text("hit_source"),
    hitCandleOpenedAt: timestamp("hit_candle_opened_at", {
      withTimezone: true,
    }),
    followupStatus: text("followup_status").notNull().default("not_started"),
    followupDeadline: timestamp("followup_deadline", { withTimezone: true }),
    nextRetryAt: timestamp("next_retry_at", { withTimezone: true }),
    historyRetryStartedAt: timestamp("history_retry_started_at", {
      withTimezone: true,
    }),
    priceAt72h: doublePrecision("price_at_72h"),
    priceAt72hObservedAt: timestamp("price_at_72h_observed_at", {
      withTimezone: true,
    }),
    priceAt72hChangePct: doublePrecision("price_at_72h_change_pct"),
    maxFavorablePct: doublePrecision("max_favorable_pct"),
    minFavorablePct: doublePrecision("min_favorable_pct"),
    followupSampleCount: integer("followup_sample_count"),
    followupExpectedSampleCount: integer("followup_expected_sample_count"),
    followupFirstSampleAt: timestamp("followup_first_sample_at", {
      withTimezone: true,
    }),
    followupLastSampleAt: timestamp("followup_last_sample_at", {
      withTimezone: true,
    }),
    observationSource: text("observation_source"),
    observationError: text("observation_error"),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    claimToken: text("claim_token"),
    attempts: integer("attempts").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("indicator_target_observation_tracked_target_unique").on(
      table.trackedSignalId,
      table.experimentVersion,
      table.targetPct,
    ),
    index("indicator_target_observation_due_retry_fair_idx").on(
      table.status,
      table.followupStatus,
      table.nextRetryAt,
      table.leaseUntil,
      table.updatedAt,
    ),
    index("indicator_target_observation_history_retry_idx").on(
      table.status,
      table.tradeClosedAt,
      table.historyRetryStartedAt,
      table.leaseUntil,
    ),
    index("indicator_target_observation_tracker_idx").on(table.trackedSignalId),
  ],
);

export type IndicatorTargetObservation =
  typeof indicatorTargetObservationsTable.$inferSelect;
