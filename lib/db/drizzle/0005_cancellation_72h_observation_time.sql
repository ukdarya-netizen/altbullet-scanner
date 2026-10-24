ALTER TABLE "tracked_signals"
  ADD COLUMN IF NOT EXISTS "price_72h_after_exit_observed_at" timestamp;