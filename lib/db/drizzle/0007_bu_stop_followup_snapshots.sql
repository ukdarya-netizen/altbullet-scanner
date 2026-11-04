CREATE TABLE IF NOT EXISTS "bu_stop_followup_snapshots" (
  "id" serial PRIMARY KEY NOT NULL,
  "tracked_signal_id" integer NOT NULL,
  "symbol" text NOT NULL,
  "hour_after_close" integer NOT NULL,
  "observed_at" timestamp with time zone NOT NULL,
  "price" real NOT NULL,
  "move_pct" real NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "bu_stop_followup_signal_hour_uniq"
  ON "bu_stop_followup_snapshots" ("tracked_signal_id", "hour_after_close");

CREATE INDEX IF NOT EXISTS "bu_stop_followup_observed_at_idx"
  ON "bu_stop_followup_snapshots" ("observed_at");

CREATE INDEX IF NOT EXISTS "bu_stop_followup_symbol_idx"
  ON "bu_stop_followup_snapshots" ("symbol");