import { pool } from "@workspace/db";

export const OP_NEON_NEUTRAL_CLOSE_REASON =
  "owner_neutral_close_op_neon_2026_10_14";

// Owner order 2026-10-14: OP and AVA neon_support_bounce were breakouts, not a level
// bounce. Close neutrally: no exit price, no PnL, outside outcome statistics.
export const OP_NEON_NEUTRAL_CLOSE_TARGETS = [
  [2454, 18797, "OP-USDT", "neon_support_bounce"],
  [2459, 18810, "AVA-USDT", "neon_support_bounce"],
  // Owner order 2026-10-14: late Neon signals sent after the bounce impulse.
  [2472, 18835, "ESP-USDT", "neon_support_bounce"],
  [2474, 18841, "ZEREBRO-USDT", "neon_support_bounce"],
  [2475, 18845, "ZEREBRO-USDT", "neon_support_bounce"],
  [2476, 18847, "SEI-USDT", "neon_support_bounce"],
  [2477, 18853, "CRV-USDT", "neon_support_bounce"],
  [2478, 18855, "CAKE-USDT", "neon_support_bounce"],
  [2479, 18857, "LSK-USDT", "neon_support_bounce"],
  // Owner order 2026-10-15: open Neon rows that would not pass the restored
  // detector (srv2-only levels, or fired hours/days after the bounce with entry
  // below the support band).
  [2485, 18870, "HUMA-USDT", "neon_support_bounce"],
  [2486, 18873, "1000BONK-USDT", "neon_support_bounce"],
  [2489, 18879, "AAVE-USDT", "neon_support_bounce"],
  [2490, 18881, "CFX-USDT", "neon_support_bounce"],
  [2492, 18887, "SENT-USDT", "neon_support_bounce"],
  [2493, 18891, "FET-USDT", "neon_support_bounce"],
  [2495, 18895, "LUMIA-USDT", "neon_support_bounce"],
  [2504, 18917, "ARB-USDT", "neon_support_bounce"],
  // Owner order 2026-10-16: fired on the consolidation/reclaim after the bounce
  // (entry beyond +1% of the level), not on the bounce itself.
  [2507, 18923, "LPT-USDT", "neon_support_bounce"],
  [2517, 18943, "SYRUP-USDT", "neon_support_bounce"],
  [2524, 18957, "GIGGLE-USDT", "neon_support_bounce"],
  [2529, 18970, "ZEN-USDT", "neon_support_bounce"],
  [2531, 18973, "VIRTUAL-USDT", "neon_support_bounce"],
  [2532, 18975, "DIA-USDT", "neon_support_bounce"],
  [2534, 18979, "DASH-USDT", "neon_support_bounce"],
  [2539, 18993, "PONS-USDT", "neon_support_bounce"],
  [2540, 18995, "ASTR-USDT", "neon_support_bounce"],
  // Owner order 2026-10-22: open Impulse Buy row that would not pass the new
  // spot vol/mcap 6–15% cut. The Neon zone rule applies to new signals only.
  [2737, 19459, "WAVES-USDT", "impulse_buy"],
] as const;

type LockedRow = {
  id: number;
  signal_id: number;
  symbol: string;
  tracker_pattern: string;
  status: string;
  runner_state: string | null;
  core_closed_at: Date | null;
};

export type OpNeonCloseResult = {
  moved: number;
  skippedTerminal: number[];
  partialRunners: number[];
  missing: number[];
};

/**
 * Neutralizes only the exact reviewed row that are still open. Rows that
 * already ended or hold a realized partial (runner) keep their outcome.
 */
export async function neutralizeOpOpenNeonPosition(): Promise<OpNeonCloseResult> {
  const empty = {
    moved: 0,
    skippedTerminal: [],
    partialRunners: [],
    missing: [],
  };
  if (process.env.NODE_ENV !== "production") return empty;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext('op_neon_neutral_close'))",
    );
    const targets = OP_NEON_NEUTRAL_CLOSE_TARGETS;
    const locked = await client.query(
      `SELECT t.id, t.signal_id, t.symbol, t.sentiment_key AS tracker_pattern,
              t.status::text AS status, t.runner_state, t.core_closed_at
         FROM tracked_signals t
        WHERE t.id = ANY($1::integer[])
        FOR UPDATE OF t`,
      [targets.map(([id]) => id)],
    );
    const rows = locked.rows as LockedRow[];
    const eligible: LockedRow[] = [];
    const skippedTerminal: number[] = [];
    const partialRunners: number[] = [];
    const missing: number[] = [];
    for (const [trackedId, signalId, symbol, pattern] of targets) {
      const row = rows.find((r) => r.id === trackedId);
      if (!row) {
        missing.push(trackedId);
        continue;
      }
      if (
        row.signal_id !== signalId ||
        row.symbol !== symbol ||
        row.tracker_pattern !== pattern
      ) {
        throw new Error(
          `OP neon neutral close: lineage mismatch for ${trackedId}`,
        );
      }
      if (row.status !== "active" && row.status !== "in_run") {
        skippedTerminal.push(trackedId);
        continue;
      }
      if (row.core_closed_at !== null || row.runner_state !== null) {
        partialRunners.push(trackedId);
        continue;
      }
      eligible.push(row);
    }
    if (eligible.length === 0) {
      await client.query("COMMIT");
      return { moved: 0, skippedTerminal, partialRunners, missing };
    }
    const trackedIds = eligible.map((r) => r.id);
    const signalIds = eligible.map((r) => r.signal_id);
    const reason = OP_NEON_NEUTRAL_CLOSE_REASON;
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
      throw new Error("OP neon neutral close: tracker update incomplete");

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
    await client.query("COMMIT");
    return { moved: eligible.length, skippedTerminal, partialRunners, missing };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

// Owner order 2026-10-22: the single-pivot Neon zone rule is for new signals
// only. These three rows were closed by mistake; return them to active in the
// tracker only (no Telegram, no relay changes).
export const NEON_ZONE_RULE_RESTORE_TARGETS = [
  [2738, 19467, "MAGIC-USDT"],
  [2742, 19478, "ZIL-USDT"],
  [2745, 19487, "HUMA-USDT"],
] as const;

export async function restoreNeonRowsClosedByZoneRule(): Promise<number> {
  if (process.env.NODE_ENV !== "production") return 0;
  const result = await pool.query(
    `UPDATE tracked_signals
        SET status = 'active', cancel_reason = NULL, updated_at = NOW()
      WHERE status = 'reclassified'
        AND cancel_reason = $1
        AND sentiment_key = 'neon_support_bounce'
        AND exit_price IS NULL AND closed_at IS NULL
        AND (id, signal_id, symbol) IN (
          SELECT * FROM unnest($2::integer[], $3::integer[], $4::text[])
        )
      RETURNING id`,
    [
      OP_NEON_NEUTRAL_CLOSE_REASON,
      NEON_ZONE_RULE_RESTORE_TARGETS.map(([id]) => id),
      NEON_ZONE_RULE_RESTORE_TARGETS.map(([, signalId]) => signalId),
      NEON_ZONE_RULE_RESTORE_TARGETS.map(([, , symbol]) => symbol),
    ],
  );
  return result.rowCount ?? 0;
}
