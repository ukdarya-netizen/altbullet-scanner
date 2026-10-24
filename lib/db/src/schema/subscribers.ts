import {
  pgTable,
  bigint,
  text,
  timestamp,
  boolean,
  serial,
  integer,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const subscribersTable = pgTable("subscribers", {
  chatId: bigint("chat_id", { mode: "number" }).primaryKey(),
  username: text("username"),
  firstName: text("first_name"),
  lastName: text("last_name"),
  active: boolean("active").notNull().default(true),
  subscribedAt: timestamp("subscribed_at").notNull().defaultNow(),
  unsubscribedAt: timestamp("unsubscribed_at"),
  subscribedUntil: timestamp("subscribed_until"), // дата окончания подписки (задаётся вручную)
  botBlockedAt: timestamp("bot_blocked_at"),
  botBlockedReason: text("bot_blocked_reason"),
});

export const insertSubscriberSchema = createInsertSchema(subscribersTable);
export type InsertSubscriber = z.infer<typeof insertSubscriberSchema>;
export type Subscriber = typeof subscribersTable.$inferSelect;

/**
 * Durable inbox for Telegram webhook updates. A completed update is never
 * dispatched again, even if Telegram retries it or a second worker receives it.
 */
export const telegramUpdatesTable = pgTable("telegram_updates", {
  updateId: bigint("update_id", { mode: "number" }).primaryKey(),
  status: text("status").notNull().default("processing"),
  claimToken: text("claim_token"),
  receivedAt: timestamp("received_at").notNull().defaultNow(),
  completedAt: timestamp("completed_at"),
  lastError: text("last_error"),
});

/**
 * Durable, per-subscription delivery state for Telegram expiry warnings.
 * The expiry timestamp is part of the natural key: changing or renewing a
 * subscription creates a separate warning opportunity without clearing history.
 */
export const subscriptionWarningDeliveriesTable = pgTable(
  "subscription_warning_deliveries",
  {
    id: serial("id").primaryKey(),
    chatId: bigint("chat_id", { mode: "number" }).notNull(),
    warningKind: text("warning_kind").notNull(),
    subscribedUntil: timestamp("subscribed_until").notNull(),
    status: text("status").notNull().default("processing"),
    claimToken: text("claim_token"),
    leaseUntil: timestamp("lease_until"),
    deliveredAt: timestamp("delivered_at"),
    lastError: text("last_error"),
    attempts: integer("attempts").notNull().default(0),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("subscription_warning_delivery_unique").on(
      table.chatId,
      table.warningKind,
      table.subscribedUntil,
    ),
    index("subscription_warning_delivery_state_idx").on(
      table.status,
      table.leaseUntil,
    ),
  ],
);
