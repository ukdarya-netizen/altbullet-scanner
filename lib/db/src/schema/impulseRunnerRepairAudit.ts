import {
  boolean,
  integer,
  pgTable,
  real,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

// These existing production audit records must remain part of the declared
// development schema so Publish never interprets them as tables to remove.
export const impulseRunnerAccountingRepairAuditTable = pgTable(
  "impulse_runner_accounting_repair_audit",
  {
    trackedSignalId: integer("tracked_signal_id").primaryKey(),
    priorPnlPercent: real("prior_pnl_percent"),
    priorStatus: text("prior_status"),
    correctedPnlPercent: real("corrected_pnl_percent").notNull(),
    correctedStatus: text("corrected_status").notNull(),
    correctedPeakPrice: real("corrected_peak_price").notNull(),
    correctionRequired: boolean("correction_required").notNull().default(false),
    repairedAt: timestamp("repaired_at").notNull().defaultNow(),
  },
);

export const impulseRunnerOriginalEntryBackfillAuditTable = pgTable(
  "impulse_runner_original_entry_backfill_audit",
  {
    trackedSignalId: integer("tracked_signal_id").primaryKey(),
    priorOriginalEntryPrice: real("prior_original_entry_price"),
    sourceEntryPrice: real("source_entry_price").notNull(),
    backfilledAt: timestamp("backfilled_at").notNull().defaultNow(),
  },
);

export const impulseRunnerAccountingAmbiguityAuditTable = pgTable(
  "impulse_runner_accounting_ambiguity_audit",
  {
    trackedSignalId: integer("tracked_signal_id").primaryKey(),
    originalEntryPrice: real("original_entry_price"),
    runnerExitPrice: real("runner_exit_price"),
    runnerTrailingStopLevel: real("runner_trailing_stop_level"),
    durablePeakPrice: real("durable_peak_price"),
    coreClosedAt: timestamp("core_closed_at"),
    reason: text("reason").notNull(),
    observedAt: timestamp("observed_at").notNull().defaultNow(),
  },
);

export const impulseRunnerTrailingFloorRepairAuditTable = pgTable(
  "impulse_runner_trailing_floor_repair_audit",
  {
    trackedSignalId: integer("tracked_signal_id").primaryKey(),
    priorRunnerExitPrice: real("prior_runner_exit_price").notNull(),
    correctedRunnerExitPrice: real("corrected_runner_exit_price").notNull(),
    durablePeakPrice: real("durable_peak_price").notNull(),
    earnedTrailingFloor: real("earned_trailing_floor"),
    effectiveTrailingFloor: real("effective_trailing_floor"),
    priorPersistedTrailingStop: real("prior_persisted_trailing_stop"),
    priorPnlPercent: real("prior_pnl_percent"),
    correctedPnlPercent: real("corrected_pnl_percent").notNull(),
    repairedAt: timestamp("repaired_at").notNull().defaultNow(),
  },
);
