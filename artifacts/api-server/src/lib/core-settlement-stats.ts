import { sql } from "drizzle-orm";

/**
 * Owner order 2026-10-17: an Impulse Buy core settles as its own closed trade
 * the moment the core closes (core PnL, core close time); the runner is a
 * separate later trade with its pure runner PnL. This derived relation is
 * tracked_signals plus one pseudo "profit" row per closed core (negative id so
 * it never collides with a real row). Use it in place of `tracked_signals` in
 * aggregate statistics queries only. The core row carries the core result
 * regardless of the runner's final status.
 */
export const TRACKED_SIGNALS_WITH_CORE_SQL = sql.raw(`(
  SELECT * FROM tracked_signals
  UNION ALL
  SELECT (jsonb_populate_record(t, jsonb_build_object(
    'id', -t.id,
    'status', CASE WHEN t.core_pnl_percent < 0 THEN 'stop_loss' ELSE 'profit' END,
    'pnl_percent', t.core_pnl_percent,
    'exit_price', t.core_exit_price,
    'closed_at', t.core_closed_at,
    'runner_state', NULL,
    'core_closed_at', NULL
  ))).*
  FROM tracked_signals t
  WHERE t.policy_version = 'impulse_runner_v1'
    AND t.core_closed_at IS NOT NULL
    AND t.core_pnl_percent IS NOT NULL
)`);
