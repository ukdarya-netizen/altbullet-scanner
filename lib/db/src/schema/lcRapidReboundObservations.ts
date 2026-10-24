import {
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const lcRapidReboundObservationsTable = pgTable(
  "lc_rapid_rebound_observations",
  {
    // Independent archive: intentionally no FK to the mutable watch table.
    watchId: integer("watch_id").primaryKey(),
    symbol: text("symbol").notNull(),
    detectedAt: timestamp("detected_at", { withTimezone: true }).notNull(),
    watchReason: text("watch_reason"),
    snapshotSource: text("snapshot_source")
      .notNull()
      .default("bingx_perpetual_coinglass_liquidation"),
    detectSnapshot: jsonb("detect_snapshot")
      .$type<Record<string, unknown>>()
      .notNull(),
    status: text("status").notNull().default("pending"),
    wickState: text("wick_state").notNull().default("unknown"),
    wickConfirmedAt: timestamp("wick_confirmed_at", { withTimezone: true }),
    wickLow: doublePrecision("wick_low"),
    wickClose: doublePrecision("wick_close"),
    volumeMultiple: doublePrecision("volume_multiple"),
    wickWindow: jsonb("wick_window").$type<Array<
      Record<string, unknown>
    > | null>(),
    forwardAnchorAt: timestamp("forward_anchor_at", { withTimezone: true }),
    forwardAnchorPrice: doublePrecision("forward_anchor_price"),
    forwardWindow: jsonb("forward_window").$type<Array<
      Record<string, unknown>
    > | null>(),
    coverage: jsonb("coverage").$type<Record<string, unknown> | null>(),
    forwardOutcomes: jsonb("forward_outcomes").$type<Record<
      string,
      unknown
    > | null>(),
    nextRetryAt: timestamp("next_retry_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    claimToken: text("claim_token"),
    attempts: integer("attempts").notNull().default(0),
    failureAttempts: integer("failure_attempts").notNull().default(0),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("lc_rapid_rebound_due_idx").on(
      table.status,
      table.nextRetryAt,
      table.leaseUntil,
    ),
    index("lc_rapid_rebound_detected_idx").on(table.detectedAt.desc()),
  ],
);

export type LcRapidReboundObservation =
  typeof lcRapidReboundObservationsTable.$inferSelect;
export const insertLcRapidReboundObservationSchema = createInsertSchema(
  lcRapidReboundObservationsTable,
);
export type InsertLcRapidReboundObservation = z.infer<
  typeof insertLcRapidReboundObservationSchema
>;
