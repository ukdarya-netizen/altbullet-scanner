import { pool } from "@workspace/db";

/**
 * Owner 2026-10-29: ABNeon confirms only on the closed 1H candle (15m
 * confirmation is off). Open ABNeon (neon_support_bounce) positions that were
 * confirmed on a closed 15m candle would not pass the new rule and are closed
 * without affecting statistics. Exact production ids reviewed on 2026-10-29:
 * all `active`, trigger candle of the fired shadow candidate not on an hour
 * boundary. Rows get status `cancelled` with neutral PnL; originals are kept
 * as JSON in neon_15m_confirmation_close_backup. Positions confirmed on a 1H
 * candle (2872, 2874, 2887, 2923, 2924, 2929, 2940) and later signals are
 * never touched.
 */
export const NEON_15M_CONFIRMATION_CLOSE_REASON =
  "neon_15m_confirmation_not_passing_1h_rule";

export const NEON_15M_CONFIRMATION_CLOSE_IDS = [
  2881, 2885, 2886, 2894, 2904, 2905, 2906, 2907, 2911, 2920, 2937, 2939,
] as const;

export async function neutralizeNeon15mConfirmationSignals(): Promise<number> {
  if (process.env.NODE_ENV !== "production") return 0;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext('neon_15m_confirmation_neutral_close'))",
    );
    await client.query(`CREATE TABLE IF NOT EXISTS neon_15m_confirmation_close_backup (
      tracked_id integer PRIMARY KEY,
      original jsonb NOT NULL,
      neutralized_at timestamptz NOT NULL DEFAULT now()
    )`);
    const ids = [...NEON_15M_CONFIRMATION_CLOSE_IDS];
    await client.query(
      `INSERT INTO neon_15m_confirmation_close_backup (tracked_id, original)
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
      [ids, NEON_15M_CONFIRMATION_CLOSE_REASON],
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
