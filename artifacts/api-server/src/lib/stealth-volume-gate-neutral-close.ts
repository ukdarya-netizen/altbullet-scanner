import { pool } from "@workspace/db";

export const STEALTH_VOLUME_GATE_NEUTRAL_CLOSE_REASON =
  "stealth_volume_gate_neutral_close";

// Owner-ordered 2026-10-03: open positions whose breakout-candle real volume
// (CoinGlass) was failed the impulse rule at entry (volume >= 5x and green body >= 3%).
export const STEALTH_VOLUME_GATE_NEUTRAL_CLOSE_TARGETS = [
  [2101, 17152, 7288, "EDU-USDT", "auto_range_1h"],
  [2110, 17191, 7341, "NMR-USDT", "auto_range_1h"],
  [2120, 17226, 7920, "KNC-USDT", "auto_range_1h"],
  [2132, 17257, 8192, "SYN-USDT", "auto_range_1h"],
  [2097, 17142, 7195, "XRP-USDT", "auto_range_1h"],
  [2099, 17148, 7272, "NXPC-USDT", "auto_range_1h"],
  [2102, 17162, 7392, "CC-USDT", "auto_range_1h"],
  [2103, 17167, 7490, "TRADOOR-USDT", "auto_range_1h"],
  [2113, 17202, 7196, "LSK-USDT", "auto_range_1h"],
  [2117, 17216, 7216, "MEW-USDT", "auto_range_1h"],
  [2118, 17218, 7232, "INIT-USDT", "auto_range_1h"],
  [2121, 17228, 7668, "BEAM-USDT", "auto_range_4h"],
  [2123, 17236, 7587, "ANIME-USDT", "auto_range_1h"],
  [2124, 17238, 7415, "AGLD-USDT", "auto_range_1h"],
  [2126, 17243, 7441, "C-USDT", "auto_range_1h"],
  [2133, 17258, 7978, "PARTI-USDT", "auto_range_4h"],
  [2122, 17234, 7891, "LPT-USDT", "auto_range_1h"],
  // Owner order 2026-10-17: fired 12-20h after the breakout candle on a range
  // the chart indicator did not show (HANA, ARIA) or chased far above the level.
  [2552, 19027, 41710, "XNY-USDT", "auto_range_1h"],
  [2553, 19029, 41626, "HANA-USDT", "auto_range_1h"],
  [2554, 19031, 41756, "A-USDT", "auto_range_1h"],
  [2557, 19037, 41779, "ARIA-USDT", "auto_range_1h"],
] as const;

type QueryClient = {
  query: (text: string, values?: unknown[]) => Promise<{ rows: unknown[] }>;
};
type LockedRow = {
  id: number;
  signal_id: number;
  symbol: string;
  tracker_pattern: string;
  status: string;
  cancel_reason: string | null;
  runner_state: string | null;
  core_closed_at: Date | null;
  source_id: number | null;
  source_symbol: string | null;
  source_pattern: string | null;
  arm_id: number | null;
  arm_symbol: string | null;
  level_source: string | null;
  arm_status: string | null;
  terminal_reason: string | null;
};
type NeutralCloseResult = {
  moved: number;
  alreadyClosed: number[];
  partialRunners: number[];
  missing: number[];
};

const terminalStatuses = new Set([
  "profit",
  "stop_loss",
  "cancelled",
  "breakeven",
  "bu_stop",
  "expired",
]);

/**
 * Review and neutralize only exact old Resistance positions. Already-realized
 * outcomes and partial runners retain their PnL. Peak and milestone history
 * are observations, not outcomes, and are never cleared.
 */
export async function neutralizeReviewedStealthVolumeGateInTransaction(
  client: QueryClient,
): Promise<NeutralCloseResult> {
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtext('stealth_volume_gate_neutral_close'))",
  );
  const targets = STEALTH_VOLUME_GATE_NEUTRAL_CLOSE_TARGETS;
  const locked = await client.query(
    `SELECT t.id, t.signal_id, t.symbol, t.sentiment_key AS tracker_pattern,
            t.status::text AS status,
            t.cancel_reason, t.runner_state, t.core_closed_at,
            s.id AS source_id, s.symbol AS source_symbol,
            s.sentiment_key AS source_pattern,
            a.id AS arm_id, a.symbol AS arm_symbol, a.level_source,
            a.status::text AS arm_status,
            a.terminal_reason
       FROM tracked_signals t
       LEFT JOIN signals s ON s.id = t.signal_id
       LEFT JOIN stealth_breakout_armed_setups a ON a.fired_signal_id = t.signal_id
         AND a.id = ANY($2::integer[])
      WHERE t.id = ANY($1::integer[])
      FOR UPDATE OF t`,
    [targets.map(([id]) => id), targets.map(([, , armId]) => armId)],
  );
  const rows = locked.rows as LockedRow[];
  if (rows.length > targets.length) {
    throw new Error(
      `Stealth volume-gate neutral close: duplicate reviewed lineages (${rows.length} rows)`,
    );
  }

  const eligible: LockedRow[] = [];
  const alreadyClosed: number[] = [];
  const partialRunners: number[] = [];
  const missing: number[] = [];
  for (const [trackedId, signalId, armId, symbol, levelSource] of targets) {
    const row = rows.find((candidate) => candidate.id === trackedId);
    if (!row) {
      missing.push(trackedId);
      continue;
    }
    if (row.signal_id !== signalId || row.symbol !== symbol) {
      throw new Error(
        `Stealth volume-gate neutral close: tracker identity mismatch for ${trackedId}`,
      );
    }
    if (terminalStatuses.has(row.status)) {
      alreadyClosed.push(trackedId);
      continue;
    }
    if (
      row.status === "reclassified" &&
      row.cancel_reason === STEALTH_VOLUME_GATE_NEUTRAL_CLOSE_REASON &&
      (row.arm_id === null ||
        (row.arm_id === armId &&
          row.arm_status === "reclassified" &&
          row.terminal_reason === STEALTH_VOLUME_GATE_NEUTRAL_CLOSE_REASON))
    ) {
      continue;
    }
    if (
      row.source_id !== signalId ||
      row.source_symbol !== symbol ||
      row.source_pattern !== "stealth_breakout" ||
      row.tracker_pattern !== "stealth_breakout" ||
      row.arm_id !== armId ||
      row.arm_symbol !== symbol ||
      row.level_source !== levelSource
    ) {
      throw new Error(
        `Stealth volume-gate neutral close: lineage mismatch for ${trackedId}`,
      );
    }
    if (row.status !== "active" && row.status !== "in_run") {
      throw new Error(
        `Stealth volume-gate neutral close: unexpected state for ${trackedId}: ${row.status}`,
      );
    }
    if (row.arm_status !== "fired") {
      throw new Error(
        `Stealth volume-gate neutral close: arm not fired for ${trackedId}: ${row.arm_status}`,
      );
    }
    if (row.core_closed_at !== null || row.runner_state !== null) {
      partialRunners.push(trackedId);
      continue;
    }
    eligible.push(row);
  }
  if (eligible.length === 0)
    return { moved: 0, alreadyClosed, partialRunners, missing };

  const trackedIds = eligible.map((row) => row.id);
  const signalIds = eligible.map((row) => row.signal_id);
  const armIds = eligible.map((row) => row.arm_id);
  const reason = STEALTH_VOLUME_GATE_NEUTRAL_CLOSE_REASON;
  const updated = await client.query(
    `UPDATE tracked_signals
        SET status = 'reclassified', cancel_reason = $2,
            exit_price = NULL, pnl_percent = NULL, closed_at = NULL,
            trailing_stop_level = NULL, trailing_stop_armed_at = NULL,
            last_smart_cancel_check_at = NULL,
            pending_milestone = NULL, pending_milestone_kind = NULL,
            pending_milestone_price = NULL, pending_milestone_trailing_stop = NULL,
            pending_milestone_status = NULL, pending_milestone_lease_until = NULL,
            updated_at = NOW()
      WHERE id = ANY($1::integer[]) AND status IN ('active', 'in_run')
      RETURNING id`,
    [trackedIds, reason],
  );
  if (updated.rows.length !== eligible.length)
    throw new Error(
      "Stealth volume-gate neutral close: tracker update incomplete",
    );

  const arms = await client.query(
    `UPDATE stealth_breakout_armed_setups
        SET status = 'reclassified', terminal_reason = $2, updated_at = NOW()
      WHERE id = ANY($1::integer[]) AND status = 'fired'
      RETURNING id`,
    [armIds, reason],
  );
  if (arms.rows.length !== eligible.length)
    throw new Error("Stealth volume-gate neutral close: arm update incomplete");

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

  // A queued relay must not open a trade after its dashboard position closes.
  // Already accepted external trades are not changed by this operation.
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
  return { moved: eligible.length, alreadyClosed, partialRunners, missing };
}

export async function neutralizeReviewedStealthVolumeGateSignals(): Promise<NeutralCloseResult> {
  if (process.env.NODE_ENV !== "production")
    return { moved: 0, alreadyClosed: [], partialRunners: [], missing: [] };
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result =
      await neutralizeReviewedStealthVolumeGateInTransaction(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
