import { pool } from "@workspace/db";

export const IMPULSE_BUY_FILTER_CLOSE_REASON =
  "impulse_buy_new_filters_neutral_close";

// Reviewed production lineages (open IB positions that the current filters
// would have rejected). Not a pattern-wide update.
export const WHALE_WATCH_REVIEW_CLOSE_REASON =
  "whale_watch_reviewed_neutral_close";

export const IMPULSE_BUY_FILTER_CLOSE_TARGETS = [
  [2024, 14350, "LINK-USDT", "impulse_buy"],
  [2059, 15956, "ZEN-USDT", "impulse_buy"],
  // GRAM: reviewed Whale Watch position.
  [2092, 17100, "GRAMTON-USDT", "whale_watch"],
  // Owner 2026-10-10: Whale Futures moved to a different trading system; the
  // position opened under the previous system is closed neutrally.
  [2303, 18185, "C-USDT", "whale_watch"],
  // Owner 2026-10-11: Spot Volume is now mandatory and >= 2x. These open IB
  // positions were fired with Spot Volume 1.0x.
  [2316, 18247, "APT-USDT", "impulse_buy"],
  [2317, 18249, "TIA-USDT", "impulse_buy"],
] as const;

// Closed IB trades that the 2026-10-11 filters would have rejected (BAT: Spot
// Volume 0.92x). Removed from open/statistics views by neutral reclassification;
// the original outcome is preserved in decision history.
export const IMPULSE_BUY_FILTER_CLOSED_TARGETS = [
  [2311, 18233, "BAT-USDT"],
] as const;

const closeReason = (pattern: string) =>
  pattern === "whale_watch"
    ? WHALE_WATCH_REVIEW_CLOSE_REASON
    : IMPULSE_BUY_FILTER_CLOSE_REASON;

type QueryClient = {
  query: (text: string, values?: unknown[]) => Promise<{ rows: unknown[] }>;
};
type LockedRow = {
  id: number;
  symbol: string;
  status: string;
  pattern: string | null;
  signal_id: number | null;
  runner_state: string | null;
  core_closed_at: Date | null;
};

export async function neutralizeReviewedImpulseBuyInTransaction(
  client: QueryClient,
): Promise<number> {
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtext('impulse_buy_filter_neutral_close'))",
  );
  const ids = IMPULSE_BUY_FILTER_CLOSE_TARGETS.map(([id]) => id);
  const locked = await client.query(
    `SELECT id, symbol, status::text AS status, sentiment_key AS pattern,
            signal_id, runner_state, core_closed_at
       FROM tracked_signals WHERE id = ANY($1::integer[]) ORDER BY id
        FOR UPDATE`,
    [ids],
  );
  const rows = locked.rows as LockedRow[];
  await reclassifyClosedImpulseBuy(client);
  const eligible: Array<(typeof IMPULSE_BUY_FILTER_CLOSE_TARGETS)[number]> = [];
  for (const target of IMPULSE_BUY_FILTER_CLOSE_TARGETS) {
    const [id, signalId, symbol, pattern] = target;
    const row = rows.find((r) => r.id === id);
    if (!row) continue;
    if (
      row.symbol !== symbol ||
      row.pattern !== pattern ||
      row.signal_id !== signalId
    ) {
      throw new Error(`IB neutral close: lineage mismatch for tracker ${id}`);
    }
    if (row.status !== "active" && row.status !== "in_run") continue;
    if (row.runner_state !== null || row.core_closed_at !== null) continue;
    eligible.push(target);
  }
  if (eligible.length === 0) return 0;

  let total = 0;
  for (const pattern of ["impulse_buy", "whale_watch"]) {
    const group = eligible.filter((t) => t[3] === pattern);
    if (group.length === 0) continue;
    total += await closeGroup(client, group, pattern, closeReason(pattern));
  }
  return total;
}

async function reclassifyClosedImpulseBuy(client: QueryClient): Promise<void> {
  for (const [id, signalId, symbol] of IMPULSE_BUY_FILTER_CLOSED_TARGETS) {
    await client.query(
      `UPDATE tracked_signals
          SET status = 'reclassified', cancel_reason = $4,
              exit_price = NULL, pnl_percent = NULL, closed_at = NULL,
              updated_at = NOW()
        WHERE id = $1 AND signal_id = $2 AND symbol = $3
          AND sentiment_key = 'impulse_buy'
          AND status::text IN ('stop_loss', 'bu_stop', 'profit', 'expired', 'cancelled')`,
      [id, signalId, symbol, IMPULSE_BUY_FILTER_CLOSE_REASON],
    );
  }
}

export async function closeGroup(
  client: QueryClient,
  group: Array<(typeof IMPULSE_BUY_FILTER_CLOSE_TARGETS)[number]>,
  pattern: string,
  reason: string,
): Promise<number> {
  const eligibleIds = group.map(([id]) => id);
  const signalIds = group.map(([, signalId]) => signalId);
  // Neutral administrative close: no exit fill, no PnL, no closed_at.
  const updated = await client.query(
    `UPDATE tracked_signals
        SET status = 'reclassified', cancel_reason = $2,
            exit_price = NULL, pnl_percent = NULL, closed_at = NULL,
            pending_milestone = NULL, pending_milestone_kind = NULL,
            pending_milestone_price = NULL,
            pending_milestone_trailing_stop = NULL,
            pending_milestone_status = NULL,
            pending_milestone_lease_until = NULL, updated_at = NOW()
      WHERE id = ANY($1::integer[]) AND sentiment_key = $3
        AND status IN ('active', 'in_run')
      RETURNING id`,
    [eligibleIds, reason, pattern],
  );
  if (updated.rows.length !== eligibleIds.length) {
    throw new Error("IB neutral close: concurrent change prevented update");
  }
  await client.query(
    `UPDATE milestone_notification_deliveries
        SET status = 'abandoned', lease_until = NULL, claim_token = NULL,
            last_error = $2
      WHERE tracked_signal_id = ANY($1::integer[])
        AND status IN ('ready', 'retry', 'failed')`,
    [eligibleIds, reason],
  );
  await client.query(
    `WITH abandoned AS (
       UPDATE telegram_photo_deliveries p
          SET status = 'abandoned', lease_until = NULL, claim_token = NULL,
              last_error = $3, updated_at = NOW()
        WHERE (p.status IN ('ready', 'retry', 'failed')
               OR (p.status = 'processing' AND p.send_attempted_at IS NULL))
          AND EXISTS (
            SELECT 1 FROM unnest($1::integer[], $2::integer[]) AS x(tracked_id, signal_id)
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
    [eligibleIds, signalIds, reason],
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
  return updated.rows.length;
}

/** Production boot only; advisory lock makes repeat boots no-ops. */
export async function neutralizeReviewedImpulseBuySignals(): Promise<number> {
  if (process.env.NODE_ENV !== "production") return 0;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '5s'");
    const count = await neutralizeReviewedImpulseBuyInTransaction(client);
    await client.query("COMMIT");
    return count;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
