ALTER TABLE tracked_signals
  ADD COLUMN IF NOT EXISTS decision_metrics jsonb;