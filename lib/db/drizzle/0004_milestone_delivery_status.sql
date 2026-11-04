ALTER TABLE "tracked_signals" ADD COLUMN IF NOT EXISTS "pending_milestone" integer;
--> statement-breakpoint
ALTER TABLE "tracked_signals" ADD COLUMN IF NOT EXISTS "pending_milestone_kind" text;
--> statement-breakpoint
ALTER TABLE "tracked_signals" ADD COLUMN IF NOT EXISTS "pending_milestone_price" real;
--> statement-breakpoint
ALTER TABLE "tracked_signals" ADD COLUMN IF NOT EXISTS "pending_milestone_trailing_stop" real;
--> statement-breakpoint
ALTER TABLE "tracked_signals" ADD COLUMN IF NOT EXISTS "pending_milestone_status" text;
--> statement-breakpoint
ALTER TABLE "tracked_signals" ADD COLUMN IF NOT EXISTS "pending_milestone_lease_until" timestamp;
--> statement-breakpoint
UPDATE "tracked_signals"
SET "pending_milestone" = NULL,
	"pending_milestone_kind" = NULL,
	"pending_milestone_price" = NULL,
	"pending_milestone_trailing_stop" = NULL,
	"pending_milestone_status" = NULL,
	"pending_milestone_lease_until" = NULL
WHERE "pending_milestone" IS NOT NULL
	AND "pending_milestone_status" IS NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "milestone_notification_deliveries" (
	"id" serial PRIMARY KEY NOT NULL,
	"tracked_signal_id" integer NOT NULL,
	"milestone" integer NOT NULL,
	"milestone_kind" text NOT NULL,
	"target" text NOT NULL,
	"status" text DEFAULT 'ready' NOT NULL,
	"lease_until" timestamp,
	"delivered_at" timestamp,
	"last_error" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "milestone_notification_delivery_unique" ON "milestone_notification_deliveries" USING btree ("tracked_signal_id","milestone_kind","milestone","target");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "milestone_notification_delivery_state_idx" ON "milestone_notification_deliveries" USING btree ("status","lease_until");