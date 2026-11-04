import { pool } from "@workspace/db";

export const BALANCED_GRIND_DASHBOARD_CLOSE_REASON =
  "balanced_grind_dashboard_neutral_close";

// Reviewed production lineages, not a symbol-wide or pattern-wide update.
// A later signal for one of these symbols must never be closed by this repair.
export const BALANCED_GRIND_DASHBOARD_CLOSE_TARGETS = [
  [1908, 10118, "TURTLE-USDT"],
  [1931, 10962, "HAEDAL-USDT"],
  [1971, 12636, "PUMPBTC-USDT"],
] as const;

type QueryClient = {
  query: (text: string, values?: unknown[]) => Promise<{ rows: unknown[] }>;
};
type LockedRow = {
  id: number;
  signal_id: number | null;
  symbol: string;
  status: string;
  cancel_reason: string | null;
  runner_state: string | null;
  core_closed_at: Date | null;
  source_id: number | null;
  source_symbol: string | null;
  source_pattern: string | null;
  pattern: string | null;
};

const targetIds = BALANCED_GRIND_DASHBOARD_CLOSE_TARGETS.map(([id]) => id);

// Read from production before the first dashboard-only rollout. That rollout
// neutralized the positions but cleared these already-observed historical
// fields. Restore only missing values for its exact administrative outcome.
const reviewedHistoricalObservations = [
  [1908, 0.04567, 5],
  [1931, 0.02247, 5],
  [1971, 0.01196, null],
] as const;

/**
 * Runs inside a transaction on the supplied connection. Exported separately
 * so integration tests can exercise the exact SQL against temporary tables.
 */
export async function neutralizeReviewedBalancedGrindInTransaction(
  client: QueryClient,
): Promise<number> {
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtext('balanced_grind_dashboard_neutral_close'))",
  );

  const locked = await client.query(
    `SELECT t.id, t.signal_id, t.symbol, t.status::text AS status,
            t.cancel_reason, t.runner_state, t.core_closed_at,
            t.sentiment_key AS pattern,
            s.id AS source_id, s.symbol AS source_symbol,
            s.sentiment_key AS source_pattern
       FROM tracked_signals t
       LEFT JOIN signals s ON s.id = t.signal_id
      WHERE t.id = ANY($1::integer[])
      ORDER BY t.id
      FOR UPDATE OF t`,
    [targetIds],
  );
  const rows = locked.rows as LockedRow[];
  for (const [id, signalId, symbol] of BALANCED_GRIND_DASHBOARD_CLOSE_TARGETS) {
    const row = rows.find((candidate) => candidate.id === id);
    // Retention may have removed an already-terminal position. Missing rows
    // are not recreated, and must not stop the rest of the app from booting.
    if (!row) continue;
    if (
      row.signal_id !== signalId ||
      row.source_id !== signalId ||
      row.symbol !== symbol ||
      row.source_symbol !== symbol ||
      row.pattern !== "balanced_grind" ||
      row.source_pattern !== "balanced_grind"
    ) {
      throw new Error(`BG neutral close: lineage mismatch for tracker ${id}`);
    }
    if (
      row.status !== "active" &&
      row.status !== "in_run" &&
      row.status !== "reclassified" &&
      row.status !== "profit" &&
      row.status !== "stop_loss" &&
      row.status !== "cancelled" &&
      row.status !== "breakeven" &&
      row.status !== "bu_stop" &&
      row.status !== "expired"
    ) {
      throw new Error(`BG neutral close: unexpected status for tracker ${id}`);
    }
    if (
      (row.status === "active" || row.status === "in_run") &&
      (row.runner_state !== null || row.core_closed_at !== null)
    ) {
      throw new Error(`BG neutral close: partial runner for tracker ${id}`);
    }
  }

  for (const [id, peakPrice, milestone] of reviewedHistoricalObservations) {
    const row = rows.find((candidate) => candidate.id === id);
    if (
      row?.status !== "reclassified" ||
      row.cancel_reason !== BALANCED_GRIND_DASHBOARD_CLOSE_REASON
    ) {
      continue;
    }
    await client.query(
      `UPDATE tracked_signals
          SET peak_price = COALESCE(peak_price, $2::real),
              last_milestone = COALESCE(last_milestone, $3::integer),
              updated_at = NOW()
        WHERE id = $1
          AND status = 'reclassified'
          AND cancel_reason = $4
          AND (peak_price IS NULL
               OR ($3::integer IS NOT NULL AND last_milestone IS NULL))`,
      [id, peakPrice, milestone, BALANCED_GRIND_DASHBOARD_CLOSE_REASON],
    );
  }

  const eligibleIds = rows
    .filter((row) => row.status === "active" || row.status === "in_run")
    .map((row) => row.id);
  if (eligibleIds.length === 0) return 0;

  // A neutral administrative close has no exit fill, no PnL, and no closedAt.
  // Natural terminal outcomes that happened before this correction are untouched.
  const updated = await client.query(
    `UPDATE tracked_signals
        SET status = 'reclassified',
            cancel_reason = $2,
            exit_price = NULL,
            pnl_percent = NULL,
            closed_at = NULL,
            pending_milestone = NULL,
            pending_milestone_kind = NULL,
            pending_milestone_price = NULL,
            pending_milestone_trailing_stop = NULL,
            pending_milestone_status = NULL,
            pending_milestone_lease_until = NULL,
            updated_at = NOW()
      WHERE id = ANY($1::integer[])
        AND sentiment_key = 'balanced_grind'
        AND status IN ('active', 'in_run')
      RETURNING id`,
    [eligibleIds, BALANCED_GRIND_DASHBOARD_CLOSE_REASON],
  );
  if (updated.rows.length !== eligibleIds.length) {
    throw new Error(
      "BG neutral close: concurrent change prevented full update",
    );
  }

  await client.query(
    `UPDATE milestone_notification_deliveries
        SET status = 'abandoned', lease_until = NULL, claim_token = NULL,
            last_error = $2
      WHERE tracked_signal_id = ANY($1::integer[])
        AND status IN ('ready', 'retry', 'failed')`,
    [eligibleIds, BALANCED_GRIND_DASHBOARD_CLOSE_REASON],
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
    [
      eligibleIds,
      eligibleIds.map(
        (id) =>
          BALANCED_GRIND_DASHBOARD_CLOSE_TARGETS.find(
            ([trackedId]) => trackedId === id,
          )![1],
      ),
      BALANCED_GRIND_DASHBOARD_CLOSE_REASON,
    ],
  );
  // Relay schema is intentionally optional at startup. Its normal dispatch
  // rechecks the tracker status, so absence of this table must not block the
  // neutral closure or the primary scanner.
  const relayTable = await client.query(
    "SELECT to_regclass('trading_signal_deliveries') AS relation",
  );
  if ((relayTable.rows[0] as { relation: string | null }).relation !== null) {
    await client.query(
      `UPDATE trading_signal_deliveries
        SET status = 'quarantined', claim_token = NULL, claim_until = NULL,
            last_error = $2
      WHERE source_signal_id = ANY($1::integer[])
        AND status = 'pending'`,
      [
        eligibleIds.map(
          (id) =>
            BALANCED_GRIND_DASHBOARD_CLOSE_TARGETS.find(
              ([trackedId]) => trackedId === id,
            )![1],
        ),
        BALANCED_GRIND_DASHBOARD_CLOSE_REASON,
      ],
    );
  }
  return updated.rows.length;
}

/**
 * Called once at production boot, before starting the watcher and relay.
 * Multiple workers serialize via the advisory lock; later boots are no-ops.
 */
export async function neutralizeReviewedBalancedGrindDashboardSignals(): Promise<number> {
  if (process.env.NODE_ENV !== "production") return 0;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const count = await neutralizeReviewedBalancedGrindInTransaction(client);
    await client.query("COMMIT");
    return count;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
