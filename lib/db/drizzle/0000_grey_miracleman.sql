CREATE TYPE "public"."oi_watch_status" AS ENUM('watching', 'fired', 'expired', 'confirming');--> statement-breakpoint
CREATE TYPE "public"."signal_type" AS ENUM('volume_spike', 'oi_increase', 'funding_rate', 'strict_alpha', 'alpha', 'super_alpha', 'short_sniper', 'bingx_volume', 'mexc_pump');--> statement-breakpoint
CREATE TYPE "public"."tracked_status" AS ENUM('active', 'in_run', 'profit', 'stop_loss', 'accumulation', 'breakeven', 're_entry', 'cancelled');--> statement-breakpoint
CREATE TABLE "oi_baselines" (
	"symbol" text PRIMARY KEY NOT NULL,
	"oi" real NOT NULL,
	"taken_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oi_daily_snapshots" (
	"id" serial PRIMARY KEY NOT NULL,
	"symbol" text NOT NULL,
	"date" text NOT NULL,
	"oi_usd" real,
	"oi_change_24h" real,
	"price_usd" real,
	"volume_24h" real,
	"taken_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oi_watch" (
	"id" serial PRIMARY KEY NOT NULL,
	"symbol" text NOT NULL,
	"trigger_tf" text NOT NULL,
	"oi_change" real NOT NULL,
	"price_at_entry" real NOT NULL,
	"volume_multiplier" real NOT NULL,
	"sentiment_key" text,
	"status" "oi_watch_status" DEFAULT 'watching' NOT NULL,
	"added_at" timestamp DEFAULT now() NOT NULL,
	"expires_at" timestamp NOT NULL,
	"fired_at" timestamp,
	"avg_volume" real,
	"is_vol_confirmed" boolean DEFAULT false NOT NULL,
	"signal_payload" jsonb
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"id" serial PRIMARY KEY NOT NULL,
	"volume_multiplier" real DEFAULT 2 NOT NULL,
	"oi_change_percent" real DEFAULT 5 NOT NULL,
	"funding_rate_threshold" real DEFAULT 0.0005 NOT NULL,
	"scan_interval_ms" integer DEFAULT 1800000 NOT NULL,
	"telegram_enabled" boolean DEFAULT true NOT NULL,
	"max_symbols" integer DEFAULT 50 NOT NULL,
	"channel_id" text,
	"watchlist" text,
	"last_daily_report_at" timestamp,
	"last_weekly_digest_at" timestamp,
	"last_monthly_digest_at" timestamp,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "signals" (
	"id" serial PRIMARY KEY NOT NULL,
	"symbol" text NOT NULL,
	"type" "signal_type" NOT NULL,
	"value" real NOT NULL,
	"threshold" real NOT NULL,
	"price" real NOT NULL,
	"price_change_percent" real NOT NULL,
	"volume_24h" real NOT NULL,
	"avg_volume" real NOT NULL,
	"open_interest" real,
	"oi_change_percent" real,
	"funding_rate" real,
	"trading_view_url" text NOT NULL,
	"cmc_rank" integer,
	"cmc_source" text,
	"liquidations_usd" real,
	"liquidations_multiple" real,
	"sentiment" text,
	"sentiment_key" text,
	"alpha_score" integer,
	"is_continuing" boolean DEFAULT false,
	"cumulative_oi_change" real,
	"detected_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tracked_signals" (
	"id" serial PRIMARY KEY NOT NULL,
	"symbol" text NOT NULL,
	"signal_id" integer,
	"signal_type" text NOT NULL,
	"sentiment" text,
	"sentiment_key" text,
	"alpha_score" integer,
	"is_short" boolean DEFAULT false NOT NULL,
	"entry_price" real NOT NULL,
	"entry_oi" real,
	"exit_price" real,
	"pnl_percent" real,
	"peak_price" real,
	"trailing_stop_level" real,
	"last_milestone" integer,
	"status" "tracked_status" DEFAULT 'active' NOT NULL,
	"re_entry_count" integer DEFAULT 0 NOT NULL,
	"detected_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"closed_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "subscribers" (
	"chat_id" bigint PRIMARY KEY NOT NULL,
	"username" text,
	"first_name" text,
	"last_name" text,
	"active" boolean DEFAULT true NOT NULL,
	"subscribed_at" timestamp DEFAULT now() NOT NULL,
	"unsubscribed_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "tracked_signals" ADD CONSTRAINT "tracked_signals_signal_id_signals_id_fk" FOREIGN KEY ("signal_id") REFERENCES "public"."signals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "oi_watch_symbol_status_idx" ON "oi_watch" USING btree ("symbol","status");--> statement-breakpoint
CREATE INDEX "oi_watch_status_idx" ON "oi_watch" USING btree ("status");