import { pool } from "@workspace/db";

export const STEALTH_OPEN_NEUTRAL_CLOSE_REASON =
  "stealth_owner_neutral_close_2026_10_07";
/** Owner order 2026-10-07: every Stealth position open up to this tracker id. */
export const STEALTH_OPEN_NEUTRAL_CLOSE_MAX_TRACKED_ID = 2284;

type QueryClient = {
  query: (text: string, values?: unknown[]) => Promise<{ rows: unknown[] }>;
};
export type StealthOpenNeutralCloseResult = {
  moved: number;
  partialRunners: number[];
};

/**
 * Moves open Stealth positions to neutral observation (no exit price, no PnL,
 * outside outcome statistics). Positions with a realized core/runner part keep
 * their realized PnL and are left untouched.
 */
export async function neutralizeOpenStealthInTransaction(
  client: QueryClient,
): Promise<StealthOpenNeutralCloseResult> {
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtext('stealth_open_neutral_close'))",
  );
  const reason = STEALTH_OPEN_NEUTRAL_CLOSE_REASON;
  const locked = (await client.query(
    `SELECT id, signal_id, runner_state, core_closed_at
       FROM tracked_signals
      WHERE sentiment_key = 'stealth_breakout'
        AND status IN ('active', 'in_run')
        AND id <= $1
      FOR UPDATE`,
    [STEALTH_OPEN_NEUTRAL_CLOSE_MAX_TRACKED_ID],
  )) as {
    rows: {
      id: number;
      signal_id: number;
      runner_state: string | null;
      core_closed_at: Date | null;
    }[];
  };
  const partialRunners = locked.rows
    .filter((r) => r.core_closed_at !== null || r.runner_state !== null)
    .map((r) => r.id);
  const eligible = locked.rows.filter((r) => !partialRunners.includes(r.id));
  if (eligible.length === 0) return { moved: 0, partialRunners };
  const trackedIds = eligible.map((r) => r.id);
  const signalIds = eligible.map((r) => r.signal_id);

  await client.query(
    `UPDATE tracked_signals
        SET status = 'reclassified', cancel_reason = $2,
            exit_price = NULL, pnl_percent = NULL, closed_at = NULL,
            trailing_stop_level = NULL, trailing_stop_armed_at = NULL,
            last_smart_cancel_check_at = NULL,
            pending_milestone = NULL, pending_milestone_kind = NULL,
            pending_milestone_price = NULL, pending_milestone_trailing_stop = NULL,
            pending_milestone_status = NULL, pending_milestone_lease_until = NULL,
            updated_at = NOW()
      WHERE id = ANY($1::integer[]) AND status IN ('active', 'in_run')`,
    [trackedIds, reason],
  );
  await client.query(
    `UPDATE stealth_breakout_armed_setups
        SET status = 'reclassified', terminal_reason = $2, updated_at = NOW()
      WHERE fired_signal_id = ANY($1::integer[]) AND status = 'fired'`,
    [signalIds, reason],
  );
  await client.query(
    `UPDATE milestone_notification_deliveries
        SET status = 'abandoned', lease_until = NULL, claim_token = NULL,
            last_error = $2
      WHERE tracked_signal_id = ANY($1::integer[])
        AND status IN ('ready', 'retry', 'failed')`,
    [trackedIds, reason],
  );
  await client.query(
    `WITH abandoned AS (
       UPDATE telegram_photo_deliveries p
          SET status = 'abandoned', lease_until = NULL, claim_token = NULL,
              last_error = $3, updated_at = NOW()
        WHERE (p.status IN ('ready', 'retry', 'failed')
               OR (p.status = 'processing' AND p.send_attempted_at IS NULL))
          AND EXISTS (
            SELECT 1 FROM unnest($1::integer[], $2::integer[])
              AS x(tracked_id, signal_id)
             WHERE p.dedup_key = 'signal:' || x.signal_id::text
                OR p.dedup_key LIKE 'position:' || x.tracked_id::text || ':%'
                OR p.dedup_key LIKE 'milestone:v3:' || x.tracked_id::text || ':%'
          )
       RETURNING p.dedup_key
     )
     UPDATE telegram_delivery_events e
        SET status = 'attention',
            attention_at = COALESCE(e.attention_at, NOW()),
            last_error = $3, updated_at = NOW()
      WHERE e.event_key IN (SELECT dedup_key FROM abandoned)
        AND e.status <> 'delivered'`,
    [trackedIds, signalIds, reason],
  );
  const relayTable = await client.query(
    "SELECT to_regclass('trading_signal_deliveries') AS relation",
  );
  if ((relayTable.rows[0] as { relation: string | null }).relation !== null) {
    await client.query(
      `UPDATE trading_signal_deliveries
          SET status = 'quarantined', claim_token = NULL, claim_until = NULL,
              last_error = $2
        WHERE source_signal_id = ANY($1::integer[]) AND status = 'pending'`,
      [signalIds, reason],
    );
  }
  return { moved: eligible.length, partialRunners };
}

export async function neutralizeOpenStealthSignals(): Promise<StealthOpenNeutralCloseResult> {
  if (process.env.NODE_ENV !== "production")
    return { moved: 0, partialRunners: [] };
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await neutralizeOpenStealthInTransaction(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
