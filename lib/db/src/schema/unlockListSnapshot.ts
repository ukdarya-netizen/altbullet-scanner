import { integer, jsonb, pgTable, timestamp } from "drizzle-orm/pg-core";

/**
 * Last successfully loaded CoinGlass unlock list (single row, id = 1).
 * Also created idempotently by the API server; declared here so the
 * development-to-production publish diff does not treat it as a drop.
 */
export const unlockListSnapshotTable = pgTable("unlock_list_snapshot", {
  id: integer("id").primaryKey(),
  fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull(),
  payload: jsonb("payload").notNull(),
});
