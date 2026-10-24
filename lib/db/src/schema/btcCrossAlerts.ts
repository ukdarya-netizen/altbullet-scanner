import {
  check,
  date,
  doublePrecision,
  index,
  integer,
  pgTable,
  primaryKey,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const btcCrossAlertStateTable = pgTable(
  "btc_cross_alert_state",
  {
    id: integer("id").primaryKey().default(1),
    anchorDay: date("anchor_day", { mode: "string" }),
    anchorBtcPrice: doublePrecision("anchor_btc_price"),
    anchorBtcDominance: doublePrecision("anchor_btc_dominance"),
    activationDay: date("activation_day", { mode: "string" }),
    lastEvaluatedDay: date("last_evaluated_day", { mode: "string" }),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check("btc_cross_alert_state_singleton_chk", sql`${table.id} = 1`),
    check(
      "btc_cross_alert_state_anchor_chk",
      sql`(${table.anchorDay} IS NULL AND ${table.anchorBtcPrice} IS NULL AND ${table.anchorBtcDominance} IS NULL)
      OR (${table.anchorDay} IS NOT NULL AND ${table.anchorBtcPrice} > 0
      AND ${table.anchorBtcDominance} > 0 AND ${table.anchorBtcDominance} <= 100)`,
    ),
  ],
);

export const btcCrossAlertEventsTable = pgTable(
  "btc_cross_alert_events",
  {
    id: serial("id").primaryKey(),
    day: date("day", { mode: "string" }).notNull(),
    direction: text("direction").notNull(),
    btcPrice: doublePrecision("btc_price").notNull(),
    btcDominance: doublePrecision("btc_dominance").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "btc_cross_alert_events_direction_chk",
      sql`${table.direction} IN ('btc_outperformed', 'dominance_outperformed')`,
    ),
    check("btc_cross_alert_events_price_chk", sql`${table.btcPrice} > 0`),
    check(
      "btc_cross_alert_events_dominance_chk",
      sql`${table.btcDominance} > 0 AND ${table.btcDominance} <= 100`,
    ),
    uniqueIndex("btc_cross_alert_events_day_uq").on(table.day),
    index("btc_cross_alert_events_day_desc_idx").on(table.day.desc()),
  ],
);

export const btcCrossAlertOwnerStateTable = pgTable(
  "btc_cross_alert_owner_state",
  {
    ownerKey: text("owner_key").notNull(),
    eventId: integer("event_id")
      .notNull()
      .references(() => btcCrossAlertEventsTable.id, { onDelete: "cascade" }),
    readAt: timestamp("read_at", { withTimezone: true }),
  },
  (table) => [
    primaryKey({
      name: "btc_cross_alert_owner_event_pk",
      columns: [table.ownerKey, table.eventId],
    }),
    index("btc_cross_alert_owner_unread_idx").on(table.ownerKey, table.readAt),
  ],
);

export const insertBtcCrossAlertEventSchema = createInsertSchema(
  btcCrossAlertEventsTable,
).omit({ id: true, createdAt: true });
export type InsertBtcCrossAlertEvent = z.infer<
  typeof insertBtcCrossAlertEventSchema
>;
export type BtcCrossAlertEvent = typeof btcCrossAlertEventsTable.$inferSelect;
