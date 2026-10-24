ALTER TYPE "public"."tracked_status" ADD VALUE IF NOT EXISTS 'expired' AFTER 'breakeven';
--> statement-breakpoint
UPDATE "tracked_signals"
SET "status" = 'expired',
    "updated_at" = NOW()
WHERE "status" = 'breakeven';
--> statement-breakpoint
UPDATE "signal_trajectory_log"
SET "status" = 'expired'
WHERE "interval_label" = 'close'
  AND "status" = 'breakeven';