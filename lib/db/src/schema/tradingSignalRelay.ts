import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

export const tradingSignalRelaySettingsTable = pgTable(
  "trading_signal_relay_settings",
  {
    singleton: boolean("singleton").primaryKey(),
    activatedAt: timestamp("activated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
);

export const tradingSignalDeliveriesTable = pgTable(
  "trading_signal_deliveries",
  {
    sourceSignalId: integer("source_signal_id").primaryKey(),
    signalAt: timestamp("signal_at", { withTimezone: true }).notNull(),
    payload: jsonb("payload").notNull(),
    status: text("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    claimToken: text("claim_token"),
    claimUntil: timestamp("claim_until", { withTimezone: true }),
    lastHttpStatus: integer("last_http_status"),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("trading_signal_deliveries_due_idx").on(
      table.status,
      table.nextAttemptAt,
    ),
  ],
);
