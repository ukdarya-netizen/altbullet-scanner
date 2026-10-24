import { pool } from "@workspace/db";
import { closeGroup } from "./impulse-buy-filter-neutral-close.js";

/**
 * Owner 2026-10-13: every pre-OB-bounce Whale Futures position (legacy
 * whale_futures / whale_futures_early keys and whale_watch rows before the
 * Smart Money OB-bounce, tracker id < 2320) leaves statistics through neutral
 * reclassification. The original outcome is kept in a backup table.
 * Also: Stealth O-USDT 2305 was reviewed as having no breakout; closed neutrally.
 */
export const LEGACY_WHALE_REASON = "legacy_whale_futures_excluded_from_stats";
export const STEALTH_NO_BREAKOUT_REASON = "stealth_no_breakout_reviewed";
const FIRST_OB_BOUNCE_TRACKER_ID = 2320;
const NO_BREAKOUT_TARGETS = [
  [2305, 18197, "O-USDT"],
  [2445, 18775, "ON-USDT"],
] as const;

type QueryClient = {
  query: (text: string, values?: unknown[]) => Promise<{ rows: unknown[] }>;
};

export async function neutralizeLegacyWhaleInTransaction(
  client: QueryClient,
): Promise<{ whale: number; noBreakout: number }> {
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtext('legacy_whale_neutral_close'))",
  );
  await client.query(`
    CREATE TABLE IF NOT EXISTS legacy_whale_reclassify_backup (
      tracked_signal_id integer PRIMARY KEY,
      sentiment_key text NOT NULL,
      status text NOT NULL,
      pnl_percent double precision,
      exit_price double precision,
      closed_at timestamptz,
      cancel_reason text,
      saved_at timestamptz NOT NULL DEFAULT now()
    )`);
  const where = `(sentiment_key IN ('whale_futures', 'whale_futures_early')
       OR (sentiment_key = 'whale_watch' AND id < ${FIRST_OB_BOUNCE_TRACKER_ID}))
     AND status::text IN ('stop_loss', 'bu_stop', 'profit', 'expired', 'cancelled')`;
  await client.query(
    `INSERT INTO legacy_whale_reclassify_backup
       (tracked_signal_id, sentiment_key, status, pnl_percent, exit_price, closed_at, cancel_reason)
     SELECT id, sentiment_key, status::text, pnl_percent, exit_price, closed_at, cancel_reason
       FROM tracked_signals WHERE ${where}
     ON CONFLICT (tracked_signal_id) DO NOTHING`,
  );
  const whale = await client.query(
    `UPDATE tracked_signals
        SET status = 'reclassified', cancel_reason = $1,
            exit_price = NULL, pnl_percent = NULL, closed_at = NULL,
            updated_at = NOW()
      WHERE ${where}
      RETURNING id`,
    [LEGACY_WHALE_REASON],
  );

  // Owner 2026-10-13: ZRO and DUSK Neon Support (fired without the two-timeframe
  // zone confluence) leave statistics through neutral close.
  const NEON_NO_CONFLUENCE_TARGETS = [
    [2450, 18787, "ZRO-USDT"],
    [2452, 18793, "DUSK-USDT"],
  ] as const;
  for (const [id, signalId, symbol] of NEON_NO_CONFLUENCE_TARGETS) {
    const rows = (
      await client.query(
        `SELECT id FROM tracked_signals
          WHERE id = $1 AND signal_id = $2 AND symbol = $3
            AND sentiment_key = 'neon_support_bounce'
            AND status IN ('active', 'in_run')
            AND runner_state IS NULL AND core_closed_at IS NULL
            FOR UPDATE`,
        [id, signalId, symbol],
      )
    ).rows;
    if (rows.length > 0) {
      await closeGroup(
        client,
        [[id, signalId, symbol, "neon_support_bounce"]] as never,
        "neon_support_bounce",
        "neon_no_confluence_reviewed",
      );
    }
  }

  let noBreakout = 0;
  for (const [id, signalId, symbol] of NO_BREAKOUT_TARGETS) {
    const row = (
      await client.query(
        `SELECT id FROM tracked_signals
          WHERE id = $1 AND signal_id = $2 AND symbol = $3
            AND sentiment_key = 'stealth_breakout'
            AND status IN ('active', 'in_run')
            AND runner_state IS NULL AND core_closed_at IS NULL
            FOR UPDATE`,
        [id, signalId, symbol],
      )
    ).rows;
    if (row.length === 0) continue;
    noBreakout += await closeGroup(
      client,
      [[id, signalId, symbol, "stealth_breakout"]] as never,
      "stealth_breakout",
      STEALTH_NO_BREAKOUT_REASON,
    );
  }
  return { whale: whale.rows.length, noBreakout };
}

/** Production boot only; advisory lock and status filters make repeats no-ops. */
export async function neutralizeLegacyWhaleSignals(): Promise<{
  whale: number;
  noBreakout: number;
}> {
  if (process.env.NODE_ENV !== "production") return { whale: 0, noBreakout: 0 };
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '5s'");
    const result = await neutralizeLegacyWhaleInTransaction(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
