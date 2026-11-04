ALTER TABLE "bu_stop_followup_snapshots"
  ADD COLUMN IF NOT EXISTS "status" text NOT NULL DEFAULT 'bu_stop';
--> statement-breakpoint
ALTER TABLE "bu_stop_followup_snapshots"
  ADD COLUMN IF NOT EXISTS "closed_at" timestamp;
--> statement-breakpoint
ALTER TABLE "bu_stop_followup_snapshots"
  ADD COLUMN IF NOT EXISTS "exit_price" real;
--> statement-breakpoint
ALTER TABLE "bu_stop_followup_snapshots"
  ADD COLUMN IF NOT EXISTS "is_short" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
UPDATE "bu_stop_followup_snapshots" bfs
SET "status" = ts."status"::text,
    "closed_at" = COALESCE(bfs."closed_at", ts."closed_at"),
    "exit_price" = COALESCE(bfs."exit_price", ts."exit_price"),
    "is_short" = ts."is_short"
FROM "tracked_signals" ts
WHERE bfs."tracked_signal_id" = ts."id"
  AND (
    bfs."closed_at" IS NULL
    OR bfs."exit_price" IS NULL
    OR bfs."is_short" IS DISTINCT FROM ts."is_short"
  );
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bu_stop_followup_status_closed_idx"
  ON "bu_stop_followup_snapshots" ("status", "closed_at");