import { pool } from "@workspace/db";
import { NEON_CLOSED_NOT_ENTERED } from "./neon-no-wait-recalc-data.js";

const MARKER = "neon_open_removal_2026_10_25_v3";
const TRACKED_BACKUP = "tracked_signals_backup_neon_open_removal_20261025";
const SIGNALS_BACKUP = "signals_backup_neon_open_removal_20261025";

// Owner order 2026-10-25: ABNeon positions (open and closed) that would not have been
// entered under the no-wait rule (first evaluation rejected by a rule that still
// applies) are removed from signals entirely. Tuple: tracked id, signal id, symbol, expected status.
export const NEON_OPEN_REMOVAL_TARGETS: ReadonlyArray<
  readonly [number, number, string, string]
> = [
  [2773, 19547, "CVX-USDT", "active"],
  [2831, 19730, "SUI-USDT", "active"],
  [2833, 19735, "NIL-USDT", "active"],
  [2847, 19773, "AXL-USDT", "active"],
  [2856, 19807, "1000PEPE-USDT", "active"],
  [2863, 19832, "WAXP-USDT", "active"],
  [2864, 19835, "DNA-USDT", "active"],
  ...NEON_CLOSED_NOT_ENTERED,
];

export type NeonOpenRemovalResult = {
  removed: number;
  skipped: number[];
  alreadyApplied: boolean;
};

export async function removeNeonOpenNoWaitPositions(): Promise<NeonOpenRemovalResult> {
  if (process.env.NODE_ENV !== "production") {
    return { removed: 0, skipped: [], alreadyApplied: false };
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext('neon_open_removal'))",
    );
    await client.query(
      `CREATE TABLE IF NOT EXISTS neon_recalc_markers (
         name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now()
       )`,
    );
    const done = await client.query(
      "SELECT 1 FROM neon_recalc_markers WHERE name = $1",
      [MARKER],
    );
    if (done.rows.length > 0) {
      await client.query("COMMIT");
      return { removed: 0, skipped: [], alreadyApplied: true };
    }
    const locked = await client.query(
      `SELECT id, signal_id, symbol, sentiment_key, status::text AS status,
              runner_state, core_closed_at
         FROM tracked_signals WHERE id = ANY($1::integer[]) FOR UPDATE`,
      [NEON_OPEN_REMOVAL_TARGETS.map(([id]) => id)],
    );
    const rows = locked.rows as Array<{
      id: number;
      signal_id: number;
      symbol: string;
      sentiment_key: string;
      status: string;
      runner_state: string | null;
      core_closed_at: Date | null;
    }>;
    const trackedIds: number[] = [];
    const signalIds: number[] = [];
    const skipped: number[] = [];
    for (const [id, signalId, symbol] of NEON_OPEN_REMOVAL_TARGETS) {
      const row = rows.find((r) => r.id === id);
      if (
        !row ||
        row.signal_id !== signalId ||
        row.symbol !== symbol ||
        row.sentiment_key !== "neon_support_bounce" ||
        row.status === "reclassified" ||
        row.runner_state !== null ||
        row.core_closed_at !== null
      ) {
        skipped.push(id);
        continue;
      }
      trackedIds.push(id);
      signalIds.push(signalId);
    }
    if (trackedIds.length > 0) {
      await client.query(
        `CREATE TABLE IF NOT EXISTS ${TRACKED_BACKUP}
           (LIKE tracked_signals INCLUDING DEFAULTS)`,
      );
      await client.query(
        `CREATE TABLE IF NOT EXISTS ${SIGNALS_BACKUP}
           (LIKE signals INCLUDING DEFAULTS)`,
      );
      await client.query(
        `INSERT INTO ${TRACKED_BACKUP}
         SELECT * FROM tracked_signals t WHERE t.id = ANY($1::integer[])
            AND NOT EXISTS (SELECT 1 FROM ${TRACKED_BACKUP} b WHERE b.id = t.id)`,
        [trackedIds],
      );
      await client.query(
        `INSERT INTO ${SIGNALS_BACKUP}
         SELECT * FROM signals g WHERE g.id = ANY($1::integer[])
            AND NOT EXISTS (SELECT 1 FROM ${SIGNALS_BACKUP} b WHERE b.id = g.id)`,
        [signalIds],
      );
      // Queued messages / relay jobs must not outlive the removed position.
      await client.query(
        `UPDATE milestone_notification_deliveries
            SET status = 'abandoned', lease_until = NULL, claim_token = NULL,
                last_error = 'neon_open_removal_2026_10_25'
          WHERE tracked_signal_id = ANY($1::integer[])
            AND status IN ('ready', 'retry', 'failed')`,
        [trackedIds],
      );
      await client.query(
        `UPDATE trading_signal_deliveries
            SET status = 'quarantined', claim_token = NULL, claim_until = NULL,
                last_error = 'neon_open_removal_2026_10_25'
          WHERE source_signal_id = ANY($1::integer[])
            AND status NOT IN ('delivered', 'quarantined')`,
        [signalIds],
      );
      await client.query(
        "DELETE FROM signal_whale_seeds WHERE tracked_signal_id = ANY($1::integer[]) OR signal_id = ANY($2::integer[])",
        [trackedIds, signalIds],
      );
      await client.query(
        "DELETE FROM altbullet_take_profit_shadow WHERE tracked_signal_id = ANY($1::integer[]) OR signal_id = ANY($2::integer[])",
        [trackedIds, signalIds],
      );
      await client.query(
        "DELETE FROM altbullet_indicator_snapshots WHERE signal_id = ANY($1::integer[])",
        [signalIds],
      );
      await client.query(
        "DELETE FROM lc_stop_bid_observations WHERE tracked_signal_id = ANY($1::integer[])",
        [trackedIds],
      );
      const del = await client.query(
        "DELETE FROM tracked_signals WHERE id = ANY($1::integer[])",
        [trackedIds],
      );
      if (del.rowCount !== trackedIds.length) {
        throw new Error("Neon open removal: tracker delete incomplete");
      }
      await client.query(
        `DELETE FROM signals s WHERE s.id = ANY($1::integer[])
            AND NOT EXISTS (SELECT 1 FROM stealth_breakout_armed_setups a
                             WHERE a.fired_signal_id = s.id)`,
        [signalIds],
      );
    }
    await client.query("INSERT INTO neon_recalc_markers (name) VALUES ($1)", [
      MARKER,
    ]);
    await client.query("COMMIT");
    return { removed: trackedIds.length, skipped, alreadyApplied: false };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
