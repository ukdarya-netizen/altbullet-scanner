import { pool } from "@workspace/db";

/**
 * Owner 2026-10-29: open ABNeon positions that the new fire-time flow gate
 * (futures taker net > 0 on the reaction 1H candle and spot CVD 1h > 0,
 * unknown = fail) would not have passed are closed without affecting
 * statistics. Exact production ids reviewed on 2026-10-29, all `active`.
 * 2940 is excluded by the owner (its 1H taker sum is not established).
 * Rows get status `cancelled` with neutral PnL; originals are kept as JSON in
 * neon_flow_gate_close_backup.
 */
export const NEON_FLOW_GATE_CLOSE_REASON = "neon_flow_gate_not_passing";

export const NEON_FLOW_GATE_CLOSE_IDS = [
  2872, 2874, 2887, 2923, 2924, 2929,
] as const;

export async function neutralizeNeonFlowGateSignals(): Promise<number> {
  if (process.env.NODE_ENV !== "production") return 0;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext('neon_flow_gate_neutral_close'))",
    );
    await client.query(`CREATE TABLE IF NOT EXISTS neon_flow_gate_close_backup (
      tracked_id integer PRIMARY KEY,
      original jsonb NOT NULL,
      neutralized_at timestamptz NOT NULL DEFAULT now()
    )`);
    const ids = [...NEON_FLOW_GATE_CLOSE_IDS];
    await client.query(
      `INSERT INTO neon_flow_gate_close_backup (tracked_id, original)
       SELECT t.id, to_jsonb(t) FROM tracked_signals t
        WHERE t.id = ANY($1::integer[])
          AND t.sentiment_key = 'neon_support_bounce'
          AND t.status IN ('active', 'in_run')
       ON CONFLICT (tracked_id) DO NOTHING`,
      [ids],
    );
    const updated = await client.query(
      `UPDATE tracked_signals
          SET status = 'cancelled', cancel_reason = $2,
              exit_price = NULL, pnl_percent = NULL,
              closed_at = NOW(), updated_at = NOW()
        WHERE id = ANY($1::integer[])
          AND sentiment_key = 'neon_support_bounce'
          AND status IN ('active', 'in_run')
        RETURNING id`,
      [ids, NEON_FLOW_GATE_CLOSE_REASON],
    );
    await client.query("COMMIT");
    return updated.rows.length;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
