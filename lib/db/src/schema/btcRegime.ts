import {
  index,
  pgTable,
  real,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const btcRegimeObservationsTable = pgTable(
  "btc_regime_observations",
  {
    id: serial("id").primaryKey(),
    bucketAt: timestamp("bucket_at", { withTimezone: true }).notNull(),
    observedAt: timestamp("observed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    price: real("price"),
    whaleIndex: real("whale_index"),
    whaleIndexCandleAt: timestamp("whale_index_candle_at", {
      withTimezone: true,
    }),
    whaleIndexSource: text("whale_index_source"),
    obBidUsd: real("ob_bid_usd"),
    obAskUsd: real("ob_ask_usd"),
    obRatio: real("ob_ratio"),
    obSource: text("ob_source"),
    obCoverage: text("ob_coverage"),
    fetchStatus: text("fetch_status").notNull().default("partial"),
    snf1hPct: real("snf_1h_pct"),
    snf4hPct: real("snf_4h_pct"),
    snf24hPct: real("snf_24h_pct"),
    snf7dPct: real("snf_7d_pct"),
    snfFetchedAt: timestamp("snf_fetched_at", { withTimezone: true }),
    snfSource: text("snf_source"),
    forward1hPct: real("forward_1h_pct"),
    forward4hPct: real("forward_4h_pct"),
    forward24hPct: real("forward_24h_pct"),
    forward1hStatus: text("forward_1h_status").notNull().default("pending"),
    forward4hStatus: text("forward_4h_status").notNull().default("pending"),
    forward24hStatus: text("forward_24h_status").notNull().default("pending"),
    forward1hResolvedAt: timestamp("forward_1h_resolved_at", {
      withTimezone: true,
    }),
    forward4hResolvedAt: timestamp("forward_4h_resolved_at", {
      withTimezone: true,
    }),
    forward24hResolvedAt: timestamp("forward_24h_resolved_at", {
      withTimezone: true,
    }),
  },
  (t) => [
    uniqueIndex("btc_regime_bucket_uniq").on(t.bucketAt),
    index("btc_regime_bucket_desc_idx").on(t.bucketAt.desc()),
  ],
);

export type BtcRegimeObservation =
  typeof btcRegimeObservationsTable.$inferSelect;
