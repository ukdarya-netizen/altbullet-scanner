import { pool } from "@workspace/db";

/**
 * Owner 2026-11-11: the new Stealth signals AGT (#3754) and MAGMA (#3753) were closed by mistake at the
 * 13:00 UTC start of 11.11 — the level-v1 closer did not know the new version (stealth-neon-vsa-v3). That
 * closer is fixed; here both rows go back to the state saved in decision_metrics.beforeNeutralClose (status
 * active, no exit, no PnL) so the watcher manages them again. The removed backup is kept as
 * decision_metrics.restoredFromWrongClose. Production only, once (marker), only rows still carrying that
 * close reason.
 */
const MARKER = "stealth_vsa_wrong_close_restore_20261111";
const WRONG_REASON = "stealth_level_v1_replaced_2026_11_07_neutral_close";
const IDS = [3753, 3754];

export async function restoreWrongStealthVsaClose(): Promise<{
  skipped?: string;
  restored: { id: number; symbol: string; status: string }[];
}> {
  if (process.env.NODE_ENV !== "production") return { skipped: "not_production", restored: [] };
  await pool.query(
    `CREATE TABLE IF NOT EXISTS neon_recalc_markers (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`,
  );
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('stealth_vsa_wrong_close_restore'))");
    const done = await client.query("SELECT 1 FROM neon_recalc_markers WHERE name = $1", [MARKER]);
    if (done.rows.length > 0) {
      await client.query("ROLLBACK");
      return { skipped: "already_applied", restored: [] };
    }
    const restored = await client.query<{ id: number; symbol: string; status: string }>(
      `UPDATE tracked_signals
          SET status = (decision_metrics #>> '{beforeNeutralClose,status}')::tracked_status,
              cancel_reason = NULL,
              decision_metrics = (decision_metrics - 'beforeNeutralClose')
                || jsonb_build_object('restoredFromWrongClose', decision_metrics -> 'beforeNeutralClose',
                                      'restoredAt', NOW()),
              updated_at = NOW()
        WHERE id = ANY($1::integer[])
          AND sentiment_key = 'stealth_breakout'
          AND status::text = 'reclassified'
          AND cancel_reason = $2
          AND decision_metrics #>> '{stealthNeonLevel,version}' = 'stealth-neon-vsa-v3'
          AND decision_metrics #>> '{beforeNeutralClose,status}' IN ('active', 'in_run')
        RETURNING id, symbol, status::text AS status`,
      [IDS, WRONG_REASON],
    );
    await client.query("INSERT INTO neon_recalc_markers (name) VALUES ($1) ON CONFLICT DO NOTHING", [MARKER]);
    await client.query("COMMIT");
    return { restored: restored.rows };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
