CREATE TABLE IF NOT EXISTS "subscription_warning_deliveries" (
	"id" serial PRIMARY KEY NOT NULL,
	"chat_id" bigint NOT NULL,
	"warning_kind" text NOT NULL,
	"subscribed_until" timestamp NOT NULL,
	"status" text DEFAULT 'processing' NOT NULL,
	"claim_token" text,
	"lease_until" timestamp,
	"delivered_at" timestamp,
	"last_error" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "subscription_warning_delivery_unique" ON "subscription_warning_deliveries" USING btree ("chat_id","warning_kind","subscribed_until");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "subscription_warning_delivery_state_idx" ON "subscription_warning_deliveries" USING btree ("status","lease_until");