ALTER TYPE "public"."signal_type" ADD VALUE IF NOT EXISTS 'whale_watch';--> statement-breakpoint
ALTER TYPE "public"."tracked_status" ADD VALUE IF NOT EXISTS 'bu_stop' BEFORE 'accumulation';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "bid_wall_pool" (
	"id" serial PRIMARY KEY NOT NULL,
	"symbol" text NOT NULL,
	"status" text DEFAULT 'watching' NOT NULL,
	"source" text DEFAULT 'heatmap' NOT NULL,
	"detected_at" timestamp DEFAULT now() NOT NULL,
	"expires_at" timestamp NOT NULL,
	"entry_price" real,
	"wall_bid_usd" real,
	"wall_ask_usd" real,
	"bid_ask_ratio" real,
	"largest_bid_usd" real,
	"largest_bid_price" real,
	"nearest_wall_pct" real,
	"mcap_usd" double precision,
	"thresh_usd" real,
	"large_order_confirmed" boolean,
	"large_order_bid_usd" real,
	"current_price" real,
	"price_change_pct" real,
	"oi_30m" real,
	"oi_1h" real,
	"oi_4h" real,
	"oi_24h" real,
	"spot_vol_1h" real,
	"spot_vol_4h" real,
	"spot_vol_24h" real,
	"spot_vol_mult" real,
	"spot_vol_mcap_pct" real,
	"cvd_30m" boolean,
	"cvd_1h" boolean,
	"cvd_4h" boolean,
	"cycle_count" integer DEFAULT 0 NOT NULL,
	"last_cycle_at" timestamp
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "bid_wall_watch_log" (
	"id" serial PRIMARY KEY NOT NULL,
	"pool_id" integer NOT NULL,
	"symbol" text NOT NULL,
	"ts" timestamp DEFAULT now() NOT NULL,
	"price" real,
	"oi_30m" real,
	"oi_1h" real,
	"oi_4h" real,
	"oi_24h" real,
	"spot_vol_1h" real,
	"spot_vol_4h" real,
	"spot_vol_24h" real,
	"spot_vol_mult" real,
	"spot_vol_mcap_pct" real,
	"cvd_30m" boolean,
	"cvd_1h" boolean,
	"cvd_4h" boolean
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "growth_leader_log" (
	"id" serial PRIMARY KEY NOT NULL,
	"logged_at" timestamp DEFAULT now() NOT NULL,
	"symbol" text NOT NULL,
	"rank" integer,
	"price" real,
	"price_24h" real,
	"price_1h" real,
	"growth_from_entry" real,
	"cycle_count" integer,
	"first_seen_at" real,
	"layers" text[],
	"oi_30m" real,
	"oi_1h" real,
	"oi_4h" real,
	"cvd_1h" boolean,
	"cvd_30m" boolean,
	"spot_vol_mult" real,
	"vol_mult" real,
	"source" text DEFAULT 'scan' NOT NULL,
	"entry_price" real,
	"entry_price_24h" real,
	"entry_oi_30m" real,
	"entry_oi_1h" real,
	"entry_oi_4h" real,
	"net_buy_pct" real,
	"spot_taker_buy_usd" real,
	"spot_taker_sell_usd" real,
	"spot_fp_buy_pct" real,
	"price_3h" real,
	"price_4h" real,
	"funding_rate" real,
	"oi_usd_abs" real,
	"fut_vol_usd_24h" real,
	"retro" boolean DEFAULT false
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "liq_cascade_watch" (
	"id" serial PRIMARY KEY NOT NULL,
	"symbol" text NOT NULL,
	"status" text DEFAULT 'watching' NOT NULL,
	"detected_at" timestamp DEFAULT now() NOT NULL,
	"expires_at" timestamp NOT NULL,
	"price_at_detect" real,
	"price24h_at_detect" real,
	"price1h_at_detect" real,
	"oi30m_at_detect" real,
	"oi1h_at_detect" real,
	"oi4h_at_detect" real,
	"spot_vol24h_at_detect" real,
	"spot_vol_mult_at_detect" real,
	"spot_vol_mcap_pct" real,
	"cvd30m_at_detect" boolean,
	"cvd1h_at_detect" boolean,
	"cvd4h_at_detect" boolean,
	"current_price" real,
	"current_pct_change" real,
	"last_check_at" timestamp,
	"signal_id" integer,
	"miss_reason" text,
	"long_liq1h_at_detect" real,
	"long_liq4h_at_detect" real,
	"long_liq24h_at_detect" real,
	"current_long_liq1h" real,
	"liq_exhausted" boolean,
	"global_long_pct" real,
	"large_bid_usd" real,
	"entry_reason" text DEFAULT 'dump_filter',
	"liq_orders_count_at_detect" integer,
	"liq_orders_usd_at_detect" real
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "market_cap_cache" (
	"symbol" text PRIMARY KEY NOT NULL,
	"mcap_usd" double precision NOT NULL,
	"source" text NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "pattern_debug_log" (
	"id" serial PRIMARY KEY NOT NULL,
	"pattern" text NOT NULL,
	"cycle_number" integer,
	"checked" integer NOT NULL,
	"passed" integer NOT NULL,
	"rejected_at" text,
	"symbol" text,
	"cvd_diag" text,
	"logged_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "prescan_history" (
	"id" serial PRIMARY KEY NOT NULL,
	"symbol" text NOT NULL,
	"ts" timestamp DEFAULT now() NOT NULL,
	"cycle_count" integer,
	"rank" integer,
	"score" real,
	"price_24h" real,
	"price_1h" real,
	"oi_30m" real,
	"oi_1h" real,
	"oi_4h" real,
	"oi_24h" real,
	"vol_mult" real,
	"cvd_30m" boolean,
	"cvd_1h" boolean
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "prescan_tracker" (
	"symbol" text PRIMARY KEY NOT NULL,
	"cycle_count" integer DEFAULT 1 NOT NULL,
	"first_seen_at" real NOT NULL,
	"best_rank" integer DEFAULT 1 NOT NULL,
	"first_price" real NOT NULL,
	"first_price_24h" real NOT NULL,
	"first_score" real NOT NULL,
	"last_fired_at" real DEFAULT 0 NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"last_price" real,
	"last_oi_30m" real,
	"last_oi_1h" real,
	"last_oi_4h" real,
	"last_oi_24h" real,
	"prev_oi_30m" real,
	"prev_oi_4h" real,
	"last_price_1h" real,
	"last_cg_timed_out" boolean,
	"cvd_positive_cycles" integer,
	"taker_positive_cycles" integer,
	"oi_accel_30m" real,
	"oi_4h_consec_growth" integer,
	"last_spot_vol_1h" real,
	"prev_spot_vol_1h" real,
	"last_spot_vol_4h" real,
	"last_spot_net_buy_1h" real,
	"spot_vol_avg_1h" real,
	"spot_vol_cycles" integer DEFAULT 0 NOT NULL,
	"layers" text[] DEFAULT '{}' NOT NULL,
	"first_oi_30m" real,
	"first_oi_1h" real,
	"first_oi_4h" real
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "scan_reject_log" (
	"id" serial PRIMARY KEY NOT NULL,
	"cycle_at" timestamp with time zone NOT NULL,
	"symbol" text NOT NULL,
	"pattern" text NOT NULL,
	"reason" text NOT NULL,
	"oi30m" real,
	"vol_mult" real,
	"price24h" real,
	"prescan_cycles" integer
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "whale_alert_pool" (
	"id" serial PRIMARY KEY NOT NULL,
	"symbol" text NOT NULL,
	"hl_symbol" text NOT NULL,
	"status" text DEFAULT 'watching' NOT NULL,
	"detected_at" timestamp DEFAULT now() NOT NULL,
	"expires_at" timestamp NOT NULL,
	"fired_at" timestamp,
	"whale_address" text,
	"position_value_usd" double precision,
	"position_size_tokens" double precision,
	"whale_entry_price" double precision,
	"liq_price" double precision,
	"alert_time" timestamp,
	"whale_count" integer DEFAULT 1 NOT NULL,
	"total_whale_usd" double precision,
	"entry_price" real,
	"fut_large_order_confirmed" boolean,
	"fut_large_order_bid_usd" real,
	"spot_large_order_confirmed" boolean,
	"spot_large_order_bid_usd" real,
	"current_price" real,
	"price_change_pct" real,
	"oi_30m" real,
	"oi_1h" real,
	"oi_4h" real,
	"oi_24h" real,
	"spot_vol_1h" real,
	"spot_vol_4h" real,
	"spot_vol_24h" real,
	"spot_vol_mult" real,
	"spot_vol_mcap_pct" real,
	"cvd_30m" boolean,
	"cvd_1h" boolean,
	"cvd_4h" boolean,
	"cycle_count" integer DEFAULT 0 NOT NULL,
	"last_cycle_at" timestamp
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "whale_alert_seen" (
	"seen_key" text PRIMARY KEY NOT NULL,
	"ts" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "whale_alert_watch_log" (
	"id" serial PRIMARY KEY NOT NULL,
	"pool_id" integer NOT NULL,
	"symbol" text NOT NULL,
	"ts" timestamp DEFAULT now() NOT NULL,
	"price" real,
	"oi_30m" real,
	"oi_1h" real,
	"oi_4h" real,
	"oi_24h" real,
	"spot_vol_1h" real,
	"spot_vol_4h" real,
	"spot_vol_24h" real,
	"spot_vol_mult" real,
	"spot_vol_mcap_pct" real,
	"cvd_30m" boolean,
	"cvd_1h" boolean,
	"cvd_4h" boolean
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "whale_futures_watchlist" (
	"id" serial PRIMARY KEY NOT NULL,
	"symbol" text NOT NULL,
	"detected_at" timestamp DEFAULT now() NOT NULL,
	"expires_at" timestamp NOT NULL,
	"price_at_detection" real NOT NULL,
	"oi_30m_at_detection" real,
	"oi_1h_at_detection" real,
	"status" text DEFAULT 'watching' NOT NULL,
	"type" text DEFAULT 'futures' NOT NULL,
	"fired_at" timestamp,
	"last_checked_at" timestamp,
	"check_count" integer DEFAULT 0 NOT NULL,
	"price_24h_pct" real,
	"price_48h_pct" real,
	"price_7d_max_pct" real,
	"spot_vol_24h" real,
	"market_cap_usd" real,
	"spot_vol_7d_baseline" real,
	"spot_vol_7d_cycles" integer DEFAULT 0 NOT NULL,
	"last_spot_vol_24h" real,
	"accum_days" integer DEFAULT 0 NOT NULL,
	"accum_confirmed_at" timestamp,
	"last_cvd_positive_at" timestamp,
	"cvd_positive_count" integer DEFAULT 0 NOT NULL,
	"cvd_total_checks" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "whale_onchain_pool" (
	"id" serial PRIMARY KEY NOT NULL,
	"symbol" text NOT NULL,
	"coin_symbol" text NOT NULL,
	"direction" text NOT NULL,
	"usd_amount" double precision NOT NULL,
	"exchange" text NOT NULL,
	"status" text DEFAULT 'watching' NOT NULL,
	"transfer_ts" timestamp,
	"detected_at" timestamp DEFAULT now() NOT NULL,
	"expires_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "whale_watchlist" (
	"id" serial PRIMARY KEY NOT NULL,
	"symbol" text NOT NULL,
	"first_seen_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"accumulated_cvd_usd" real DEFAULT 0 NOT NULL,
	"accum_periods" integer DEFAULT 0 NOT NULL,
	"avg_buy_price" real,
	"market_cap_usd" real,
	"vol24h_usd" real,
	"price_at_entry" real,
	"last_price" real,
	"alerted_at" timestamp,
	"breakout_fired_at" timestamp,
	"status" text DEFAULT 'watching' NOT NULL,
	CONSTRAINT "whale_watchlist_symbol_unique" UNIQUE("symbol")
);
--> statement-breakpoint
ALTER TABLE "oi_watch" ADD COLUMN IF NOT EXISTS "oi_30m" real;--> statement-breakpoint
ALTER TABLE "oi_watch" ADD COLUMN IF NOT EXISTS "oi_1h" real;--> statement-breakpoint
ALTER TABLE "oi_watch" ADD COLUMN IF NOT EXISTS "oi_24h" real;--> statement-breakpoint
ALTER TABLE "oi_watch" ADD COLUMN IF NOT EXISTS "price_1h_change" real;--> statement-breakpoint
ALTER TABLE "oi_watch" ADD COLUMN IF NOT EXISTS "price_24h_change" real;--> statement-breakpoint
ALTER TABLE "oi_watch" ADD COLUMN IF NOT EXISTS "current_vol_mult" real;--> statement-breakpoint
ALTER TABLE "oi_watch" ADD COLUMN IF NOT EXISTS "vol_status_reason" text;--> statement-breakpoint
ALTER TABLE "oi_watch" ADD COLUMN IF NOT EXISTS "entry_vol_mult" real;--> statement-breakpoint
ALTER TABLE "oi_watch" ADD COLUMN IF NOT EXISTS "entry_cg_turnover" real;--> statement-breakpoint
ALTER TABLE "oi_watch" ADD COLUMN IF NOT EXISTS "last_oi_check" real;--> statement-breakpoint
ALTER TABLE "oi_watch" ADD COLUMN IF NOT EXISTS "prev_oi_check" real;--> statement-breakpoint
ALTER TABLE "oi_watch" ADD COLUMN IF NOT EXISTS "prev_oi_check2" real;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN IF NOT EXISTS "watchlist_added_at" text DEFAULT '{}';--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN IF NOT EXISTS "whale_watch_stages_json" text;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN IF NOT EXISTS "last_restart_notified_at" timestamp;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN IF NOT EXISTS "last_positions_report_at" timestamp;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN IF NOT EXISTS "scanner_last_scan_at" timestamp;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN IF NOT EXISTS "scanner_scan_started_at" timestamp;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN IF NOT EXISTS "last_coinalyze_batch_at" timestamp;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN IF NOT EXISTS "last_coinalyze_30m_at" timestamp;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN IF NOT EXISTS "last_coinglass_outage_at" timestamp;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN IF NOT EXISTS "retro_started_at" timestamp;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN IF NOT EXISTS "coinalyze_batch_json" text;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN IF NOT EXISTS "smart_cancel_bid_wall_usd" real DEFAULT 50000;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN IF NOT EXISTS "smart_cancel_oi_pct" real DEFAULT 5;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN IF NOT EXISTS "moonshot_vol_mult" real DEFAULT 5;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN IF NOT EXISTS "moonshot_price_change" real DEFAULT 15;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN IF NOT EXISTS "moonshot_oi_change" real DEFAULT 10;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN IF NOT EXISTS "moonshot_ask_wall_usd" real DEFAULT 50000;--> statement-breakpoint
ALTER TABLE "signals" ADD COLUMN IF NOT EXISTS "entry_cvd_30m" boolean;--> statement-breakpoint
ALTER TABLE "signals" ADD COLUMN IF NOT EXISTS "entry_cvd_1h" boolean;--> statement-breakpoint
ALTER TABLE "signals" ADD COLUMN IF NOT EXISTS "entry_cvd_4h" boolean;--> statement-breakpoint
ALTER TABLE "tracked_signals" ADD COLUMN IF NOT EXISTS "last_hourly_at" timestamp;--> statement-breakpoint
ALTER TABLE "tracked_signals" ADD COLUMN IF NOT EXISTS "last_periodic_update_at" timestamp;--> statement-breakpoint
ALTER TABLE "tracked_signals" ADD COLUMN IF NOT EXISTS "last_vol_build_at" timestamp;--> statement-breakpoint
ALTER TABLE "tracked_signals" ADD COLUMN IF NOT EXISTS "last_oi_build_at" timestamp;--> statement-breakpoint
ALTER TABLE "tracked_signals" ADD COLUMN IF NOT EXISTS "last_smart_cancel_check_at" timestamp;--> statement-breakpoint
ALTER TABLE "tracked_signals" ADD COLUMN IF NOT EXISTS "original_entry_price" real;--> statement-breakpoint
ALTER TABLE "tracked_signals" ADD COLUMN IF NOT EXISTS "dip_buy_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "tracked_signals" ADD COLUMN IF NOT EXISTS "price_24h_at_fire" real;--> statement-breakpoint
ALTER TABLE "tracked_signals" ADD COLUMN IF NOT EXISTS "prescan_cycles" integer;--> statement-breakpoint
ALTER TABLE "tracked_signals" ADD COLUMN IF NOT EXISTS "oi_watch_entry_price" real;--> statement-breakpoint
ALTER TABLE "tracked_signals" ADD COLUMN IF NOT EXISTS "cancel_reason" text;--> statement-breakpoint
ALTER TABLE "tracked_signals" ADD COLUMN IF NOT EXISTS "entry_cvd_30m" boolean;--> statement-breakpoint
ALTER TABLE "tracked_signals" ADD COLUMN IF NOT EXISTS "entry_cvd_1h" boolean;--> statement-breakpoint
ALTER TABLE "tracked_signals" ADD COLUMN IF NOT EXISTS "entry_cvd_4h" boolean;--> statement-breakpoint
ALTER TABLE "tracked_signals" ADD COLUMN IF NOT EXISTS "market_cap_usd" real;--> statement-breakpoint
ALTER TABLE "tracked_signals" ADD COLUMN IF NOT EXISTS "entry_oi_30m" real;--> statement-breakpoint
ALTER TABLE "tracked_signals" ADD COLUMN IF NOT EXISTS "entry_oi_1h" real;--> statement-breakpoint
ALTER TABLE "tracked_signals" ADD COLUMN IF NOT EXISTS "entry_oi_4h" real;--> statement-breakpoint
ALTER TABLE "tracked_signals" ADD COLUMN IF NOT EXISTS "entry_spot_vol_mult" real;--> statement-breakpoint
ALTER TABLE "tracked_signals" ADD COLUMN IF NOT EXISTS "entry_fut_vol_mult" real;--> statement-breakpoint
ALTER TABLE "tracked_signals" ADD COLUMN IF NOT EXISTS "entry_spot_vol_24h" real;--> statement-breakpoint
ALTER TABLE "tracked_signals" ADD COLUMN IF NOT EXISTS "entry_spot_mcap_pct" real;--> statement-breakpoint
ALTER TABLE "tracked_signals" ADD COLUMN IF NOT EXISTS "entry_spot_taker_net_buy" real;--> statement-breakpoint
ALTER TABLE "tracked_signals" ADD COLUMN IF NOT EXISTS "entry_spot_net_buy_1h" real;--> statement-breakpoint
ALTER TABLE "tracked_signals" ADD COLUMN IF NOT EXISTS "entry_source" text;--> statement-breakpoint
ALTER TABLE "tracked_signals" ADD COLUMN IF NOT EXISTS "entry_rsi_1h" real;--> statement-breakpoint
ALTER TABLE "tracked_signals" ADD COLUMN IF NOT EXISTS "entry_funding_rate" real;--> statement-breakpoint
ALTER TABLE "tracked_signals" ADD COLUMN IF NOT EXISTS "entry_btc_24h" real;--> statement-breakpoint
ALTER TABLE "tracked_signals" ADD COLUMN IF NOT EXISTS "entry_whale_index" real;--> statement-breakpoint
ALTER TABLE "tracked_signals" ADD COLUMN IF NOT EXISTS "stop_loss_price" real;--> statement-breakpoint
ALTER TABLE "tracked_signals" ADD COLUMN IF NOT EXISTS "stop_loss_pct" real;--> statement-breakpoint
ALTER TABLE "tracked_signals" ADD COLUMN IF NOT EXISTS "stop_source" text;--> statement-breakpoint
ALTER TABLE "tracked_signals" ADD COLUMN IF NOT EXISTS "take_targets" jsonb;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bid_wall_pool_symbol_status_idx" ON "bid_wall_pool" USING btree ("symbol","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bid_wall_pool_detected_at_idx" ON "bid_wall_pool" USING btree ("detected_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bid_wall_log_symbol_ts_idx" ON "bid_wall_watch_log" USING btree ("symbol","ts");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bid_wall_log_pool_id_idx" ON "bid_wall_watch_log" USING btree ("pool_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "growth_leader_log_logged_at_idx" ON "growth_leader_log" USING btree ("logged_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "growth_leader_log_symbol_idx" ON "growth_leader_log" USING btree ("symbol");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "liq_cascade_watch_symbol_status_idx" ON "liq_cascade_watch" USING btree ("symbol","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "liq_cascade_watch_detected_at_idx" ON "liq_cascade_watch" USING btree ("detected_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pattern_debug_pattern_idx" ON "pattern_debug_log" USING btree ("pattern");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pattern_debug_logged_at_idx" ON "pattern_debug_log" USING btree ("logged_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pattern_debug_symbol_idx" ON "pattern_debug_log" USING btree ("symbol");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "prescan_history_symbol_ts_idx" ON "prescan_history" USING btree ("symbol","ts");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "prescan_history_ts_idx" ON "prescan_history" USING btree ("ts");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "scan_reject_log_sym_idx" ON "scan_reject_log" USING btree ("symbol","cycle_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "scan_reject_log_cycle_idx" ON "scan_reject_log" USING btree ("cycle_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "whale_alert_pool_symbol_status_idx" ON "whale_alert_pool" USING btree ("symbol","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "whale_alert_pool_detected_at_idx" ON "whale_alert_pool" USING btree ("detected_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "whale_alert_pool_symbol_watching_uq" ON "whale_alert_pool" USING btree ("symbol") WHERE status = 'watching';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "whale_alert_log_symbol_ts_idx" ON "whale_alert_watch_log" USING btree ("symbol","ts");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "whale_alert_log_pool_id_idx" ON "whale_alert_watch_log" USING btree ("pool_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wf_symbol_status_idx" ON "whale_futures_watchlist" USING btree ("symbol","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "whale_onchain_pool_symbol_status_idx" ON "whale_onchain_pool" USING btree ("symbol","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "whale_onchain_pool_detected_at_idx" ON "whale_onchain_pool" USING btree ("detected_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "whale_onchain_pool_symbol_dir_watching_uq" ON "whale_onchain_pool" USING btree ("symbol","direction") WHERE status = 'watching';