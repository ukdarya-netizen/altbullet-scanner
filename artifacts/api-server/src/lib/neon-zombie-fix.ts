import { pool } from "@workspace/db";

const MARKER = "neon_zombie_replay_2026_10_29_v2";
const BACKUP_TABLE = "tracked_signals_backup_neon_zombie_20261029_v2";

/**
 * Owner order 2026-10-29: seven ABNeon rows restated by the 25.10 no-wait
 * recalc were left open and the watcher closed them only on 29.10 at that
 * day's prices. Values below are the replay on BingX 15m candles with the
 * live ABNeon rules and the 4-day lifetime
 * (scripts/neon-recalc-zombie-replay.ts, commit acddbf4). v1 found nothing to
 * change: the 25.10 recalc had run again at that start (its marker table was
 * dropped by a publish) and reopened the rows, and the watcher closed them a
 * second time at 29.10 prices. v2 changes a row only while it carries the
 * restated entry price and a close dated 29.10 or later, so it is a no-op once
 * applied even without the marker; originals go to the backup table first.
 */
const ROWS: ReadonlyArray<{
  id: number; status: "stop_loss" | "bu_stop"; exitPrice: number; pnl: number; closedAt: string;
  peak: number; lastMilestone: number | null; entry: number;
}> = [
  { id: 2763, status: "stop_loss", exitPrice: 0.007441, pnl: -7.725694, closedAt: "2026-10-25 07:00:00", peak: 0.008399, lastMilestone: null, entry: 0.008064 },
  { id: 2768, status: "stop_loss", exitPrice: 0.000617, pnl: -2.589201, closedAt: "2026-10-25 08:00:00", peak: 0.0006611, lastMilestone: null, entry: 0.0006334 },
  { id: 2771, status: "stop_loss", exitPrice: 17.782, pnl: -0.095511, closedAt: "2026-10-24 13:00:00", peak: 18.732, lastMilestone: null, entry: 17.799 },
  { id: 2778, status: "stop_loss", exitPrice: 0.3051, pnl: -6.725772, closedAt: "2026-10-25 12:00:00", peak: 0.3425, lastMilestone: null, entry: 0.3271 },
  { id: 2783, status: "stop_loss", exitPrice: 0.05096, pnl: -6.185567, closedAt: "2026-10-25 14:00:00", peak: 0.05734, lastMilestone: null, entry: 0.05432 },
  { id: 2796, status: "bu_stop", exitPrice: 0.16329, pnl: 0, closedAt: "2026-10-25 15:00:00", peak: 0.18748, lastMilestone: 10, entry: 0.16329 },
  { id: 2868, status: "stop_loss", exitPrice: 0.01356, pnl: -1.667875, closedAt: "2026-10-25 14:00:00", peak: 0.01488, lastMilestone: null, entry: 0.01379 },
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
           AND status::text IN ('stop_loss', 'bu_stop', 'expired', 'profit')
           AND closed_at >= '2026-10-29 00:00'::timestamp
           AND abs(entry_price / $8::float8 - 1) < 1e-6`,
        [r.id, r.status, r.exitPrice, r.pnl, r.closedAt, r.peak, r.lastMilestone, r.entry],
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
