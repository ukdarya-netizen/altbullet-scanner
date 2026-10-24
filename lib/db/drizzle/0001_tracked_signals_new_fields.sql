ALTER TABLE "tracked_signals" ADD COLUMN "price_24h_at_fire" real;--> statement-breakpoint
ALTER TABLE "tracked_signals" ADD COLUMN "prescan_cycles" integer;--> statement-breakpoint
ALTER TABLE "tracked_signals" ADD COLUMN "oi_watch_entry_price" real;--> statement-breakpoint
ALTER TABLE "tracked_signals" ADD COLUMN "cancel_reason" text;
