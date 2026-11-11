import { pool } from "@workspace/db";

/**
 * Owner order 2026-11-11: the ABNeon low-bounce signals fired by the first low-bounce rule (no bright volume
 * required on the low candle — CASHCAT, CRV, CT, ZRO, GRASS, LSK, CC on 11.11) are closed neutrally —
 * status 'reclassified', no exit price, no PnL, excluded from statistics. The tracker trigger sends
 * cancel_entry to the trading bot, which closes the exchange position.
 *
 * Runs in production only, once (marker), at the first start of the code with the fixed rule: every
 * low-bounce row that exists at that moment was fired by the old rule. Zone bounces are not touched.
 * Rows that hold a realized partial (runner) keep their outcome.
 */
export const ABNEON_LOW_BOUNCE_NEUTRAL_CLOSE_REASON = "abneon_low_bounce_v1_neutral_close";
const MARKER = "abneon_low_bounce_v1_neutral_close_20261111";

export async function runAbneonLowBounceNeutralClose(): Promise<{
  skipped?: string;
  closed: { id: number; symbol: string; statusBefore: string }[];
}> {
  if (process.env.NODE_ENV !== "production") return { skipped: "not_production", closed: [] };
  await pool.query(
    `CREATE TABLE IF NOT EXISTS neon_recalc_markers (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`,
  );
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('abneon_low_bounce_neutral_close'))");
    const done = await client.query("SELECT 1 FROM neon_recalc_markers WHERE name = $1", [MARKER]);
    if (done.rows.length > 0) {
      await client.query("ROLLBACK");
      return { skipped: "already_applied", closed: [] };
    }
    const before = await client.query<{ id: number; signal_id: number; symbol: string; status: string }>(
      `SELECT id, signal_id, symbol, status::text AS status
         FROM tracked_signals
        WHERE sentiment_key = 'neon_support_bounce'
          AND (decision_metrics->'neonLevel'->>'lowBounce') = 'true'
          AND status::text <> 'reclassified'
          AND core_closed_at IS NULL AND runner_state IS NULL
        ORDER BY id
        FOR UPDATE`,
    );
    const ids = before.rows.map((r) => r.id);
    if (ids.length > 0) {
      await client.query(
        `UPDATE tracked_signals
            SET status = 'reclassified', cancel_reason = $2,
                exit_price = NULL, pnl_percent = NULL, closed_at = NULL,
                trailing_stop_level = NULL, trailing_stop_armed_at = NULL,
                last_smart_cancel_check_at = NULL,
                pending_milestone = NULL, pending_milestone_kind = NULL,
                pending_milestone_price = NULL,
                pending_milestone_trailing_stop = NULL,
                pending_milestone_status = NULL,
                pending_milestone_lease_until = NULL,
                updated_at = NOW()
          WHERE id = ANY($1::integer[])`,
        [ids, ABNEON_LOW_BOUNCE_NEUTRAL_CLOSE_REASON],
      );
      await client.query(
        `UPDATE milestone_notification_deliveries
            SET status = 'abandoned', lease_until = NULL, claim_token = NULL, last_error = $2
          WHERE tracked_signal_id = ANY($1::integer[]) AND status IN ('ready', 'retry', 'failed')`,
        [ids, ABNEON_LOW_BOUNCE_NEUTRAL_CLOSE_REASON],
      );
      const relay = await client.query("SELECT to_regclass('trading_signal_deliveries') AS relation");
      if ((relay.rows[0] as { relation: string | null }).relation !== null) {
        await client.query(
          `UPDATE trading_signal_deliveries
              SET status = 'quarantined', claim_token = NULL, claim_until = NULL, last_error = $2
            WHERE source_signal_id = ANY($1::integer[]) AND status = 'pending'`,
          [before.rows.map((r) => r.signal_id), ABNEON_LOW_BOUNCE_NEUTRAL_CLOSE_REASON],
        );
      }
    }
    await client.query("INSERT INTO neon_recalc_markers (name) VALUES ($1) ON CONFLICT DO NOTHING", [MARKER]);
    await client.query("COMMIT");
    return { closed: before.rows.map((r) => ({ id: r.id, symbol: r.symbol, statusBefore: r.status })) };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
