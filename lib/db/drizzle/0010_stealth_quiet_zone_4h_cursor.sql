ALTER TABLE stealth_breakout_armed_setups
  ALTER COLUMN armed_after_1h_at DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS armed_after_4h_at timestamptz;
--> statement-breakpoint

UPDATE stealth_breakout_armed_setups
   SET armed_after_4h_at = COALESCE(armed_after_4h_at, armed_after_1h_at)
 WHERE armed_after_4h_at IS NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS stealth_breakout_armed_4h_cursor_idx
  ON stealth_breakout_armed_setups (symbol, armed_after_4h_at);