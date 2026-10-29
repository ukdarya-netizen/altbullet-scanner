import { pool } from "@workspace/db";

const MARKER = "neon_zombie_replay_2026_10_29_v1";
const BACKUP_TABLE = "tracked_signals_backup_neon_zombie_20261029";

/**
 * Owner order 2026-10-29: seven ABNeon rows restated by the 25.10 no-wait
 * recalc were left open and the watcher closed them only on 29.10 at that
 * day's prices. Values below are the replay on BingX 15m candles with the
 * live ABNeon rules and the 4-day lifetime
 * (scripts/neon-recalc-zombie-replay.ts, commit acddbf4). A row changes only
 * while it is still closed exactly as the watcher closed it (status and
 * closed_at); originals are copied to a backup table in the same transaction.
 */
const ROWS: ReadonlyArray<{
  id: number; status: "stop_loss" | "bu_stop"; exitPrice: number; pnl: number; closedAt: string;
  peak: number; lastMilestone: number | null; wasStatus: string; wasClosedAt: string;
}> = [
  { id: 2763, status: "stop_loss", exitPrice: 0.007441, pnl: -7.725694, closedAt: "2026-10-25 07:00:00", peak: 0.008399, lastMilestone: null, wasStatus: "stop_loss", wasClosedAt: "2026-10-29 05:59:17.412" },
  { id: 2768, status: "stop_loss", exitPrice: 0.000617, pnl: -2.589201, closedAt: "2026-10-25 08:00:00", peak: 0.0006611, lastMilestone: null, wasStatus: "stop_loss", wasClosedAt: "2026-10-29 05:59:32.183" },
  { id: 2771, status: "stop_loss", exitPrice: 17.782, pnl: -0.095511, closedAt: "2026-10-24 13:00:00", peak: 18.732, lastMilestone: null, wasStatus: "stop_loss", wasClosedAt: "2026-10-29 05:59:20.414" },
  { id: 2778, status: "stop_loss", exitPrice: 0.3051, pnl: -6.725772, closedAt: "2026-10-25 12:00:00", peak: 0.3425, lastMilestone: null, wasStatus: "stop_loss", wasClosedAt: "2026-10-29 05:59:28.927" },
  { id: 2783, status: "stop_loss", exitPrice: 0.05096, pnl: -6.185567, closedAt: "2026-10-25 14:00:00", peak: 0.05734, lastMilestone: null, wasStatus: "stop_loss", wasClosedAt: "2026-10-29 05:59:25.923" },
  { id: 2796, status: "bu_stop", exitPrice: 0.16329, pnl: 0, closedAt: "2026-10-25 15:00:00", peak: 0.18748, lastMilestone: 10, wasStatus: "bu_stop", wasClosedAt: "2026-10-29 05:57:28.56" },
  { id: 2868, status: "stop_loss", exitPrice: 0.01356, pnl: -1.667875, closedAt: "2026-10-25 14:00:00", peak: 0.01488, lastMilestone: null, wasStatus: "expired", wasClosedAt: "2026-10-29 05:59:23.169" },
];

export async function applyNeonZombieReplayFix(): Promise<{ applied: number[]; skipped: number[]; alreadyApplied: boolean }> {
  if (process.env.NODE_ENV !== "production") return { applied: [], skipped: [], alreadyApplied: false };
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('neon_zombie_replay_fix'))");
    await client.query(
      `CREATE TABLE IF NOT EXISTS neon_recalc_markers (
         name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`,
    );
    if ((await client.query("SELECT 1 FROM neon_recalc_markers WHERE name = $1", [MARKER])).rowCount) {
      await client.query("COMMIT");
      return { applied: [], skipped: [], alreadyApplied: true };
    }
    await client.query(`CREATE TABLE IF NOT EXISTS ${BACKUP_TABLE} (LIKE tracked_signals INCLUDING DEFAULTS)`);
    await client.query(
      `INSERT INTO ${BACKUP_TABLE} SELECT * FROM tracked_signals t WHERE t.id = ANY($1::integer[])
         AND NOT EXISTS (SELECT 1 FROM ${BACKUP_TABLE} b WHERE b.id = t.id)`,
      [ROWS.map((r) => r.id)],
    );
    const applied: number[] = [];
    const skipped: number[] = [];
    for (const r of ROWS) {
      const res = await client.query(
        `UPDATE tracked_signals SET status = $2::tracked_status, exit_price = $3, pnl_percent = $4,
           closed_at = $5::timestamp, peak_price = GREATEST($6, entry_price), last_milestone = $7,
           trailing_stop_level = NULL, updated_at = now()
         WHERE id = $1 AND sentiment_key = 'neon_support_bounce'
           AND status::text = $8 AND closed_at = $9::timestamp`,
        [r.id, r.status, r.exitPrice, r.pnl, r.closedAt, r.peak, r.lastMilestone, r.wasStatus, r.wasClosedAt],
      );
      (res.rowCount ? applied : skipped).push(r.id);
    }
    await client.query("INSERT INTO neon_recalc_markers (name) VALUES ($1)", [MARKER]);
    await client.query("COMMIT");
    return { applied, skipped, alreadyApplied: false };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
