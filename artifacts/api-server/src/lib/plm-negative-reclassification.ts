import { pool } from "@workspace/db";

/**
 * Owner 2026-10-24: closed PLM trades with negative PnL in October 2026
 * (Dubai close month) are removed from statistics. Exact production ids reviewed on 2026-10-24; rows are never
 * deleted: they become neutral `reclassified` rows (no exit fill, no PnL) and
 * the original row is kept as JSON in plm_negative_trade_backup.
 */
export const PLM_NEGATIVE_RECLASSIFICATION_REASON =
  "plm_negative_removed_from_statistics";

export const PLM_NEGATIVE_TRADE_IDS = [
  2057, 2070, 2296, 2306, 2336, 2545, 2546, 2548, 2549, 2573, 2574, 2583, 2598,
  2724, 2735,
] as const;

const CLOSED_STATUSES = ["stop_loss", "cancelled", "expired"];

export async function reclassifyPlmNegativeTrades(): Promise<number> {
  if (process.env.NODE_ENV !== "production") return 0;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext('plm_negative_reclassification'))",
    );
    await client.query(`CREATE TABLE IF NOT EXISTS plm_negative_trade_backup (
      tracked_id integer PRIMARY KEY,
      original jsonb NOT NULL,
      reclassified_at timestamptz NOT NULL DEFAULT now()
    )`);
    const ids = [...PLM_NEGATIVE_TRADE_IDS];
    await client.query(
      `INSERT INTO plm_negative_trade_backup (tracked_id, original)
       SELECT t.id, to_jsonb(t) FROM tracked_signals t
        WHERE t.id = ANY($1::integer[])
          AND t.sentiment_key = 'price_led_momentum'
          AND t.status::text = ANY($2::text[])
          AND t.pnl_percent < 0
       ON CONFLICT (tracked_id) DO NOTHING`,
      [ids, CLOSED_STATUSES],
    );
    const updated = await client.query(
      `UPDATE tracked_signals
          SET status = 'reclassified', cancel_reason = $3,
              exit_price = NULL, pnl_percent = NULL, closed_at = NULL,
              updated_at = NOW()
        WHERE id = ANY($1::integer[])
          AND sentiment_key = 'price_led_momentum'
          AND status::text = ANY($2::text[])
          AND pnl_percent < 0
        RETURNING id`,
      [ids, CLOSED_STATUSES, PLM_NEGATIVE_RECLASSIFICATION_REASON],
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
