import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

export const LIQ_CASCADE_OPEN_RECLASSIFICATION_REASON =
  "liq_cascade_observation_reclassified";

// These are the reviewed production lineages. Keep this list exact: matching
// by symbol alone could touch a later, valid cascade.
export const LIQ_CASCADE_OPEN_RECLASSIFICATION_TARGETS = [
  [1805, 8782, "XMR-USDT"],
  [1825, 8868, "ENA-USDT"],
  [1826, 8870, "BSV-USDT"],
  [1827, 8888, "VET-USDT"],
  [1828, 8894, "1000BONK-USDT"],
  // Owner-reviewed 2026-10-05: fired ~10h after detection on a stale reaction.
  [2147, 17331, "MAGMA-USDT"],
  // Owner rule 2026-10-06: LC needs aggregated futures volume >= 5x on the
  // closed 15m detection candle. These open positions had 1.25-4.96x.
  [2138, 17307, "RESOLV-USDT"],
  [2148, 17334, "SKYAI-USDT"],
  [2149, 17335, "MAGMA-USDT"],
  [2156, 17391, "STRK-USDT"],
] as const;

// Only the original five were reviewed against the spike/recovery gates below.
const SPIKE_GATE_REVIEWED_TRACKED_IDS: ReadonlySet<number> = new Set([
  1805, 1825, 1826, 1827, 1828,
]);

/**
 * One-time production correction for reviewed LC spike entries. Source
 * signals, delivered Telegram rows, and the tracker lineage remain intact;
 * only currently-open trading state is neutralized.
 */
export async function reclassifyReviewedOpenLiqCascadeSpikes(): Promise<number> {
  if (process.env.NODE_ENV !== "production") return 0;

  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext('liq_cascade_open_reclassification_20260923'))`,
    );
    // Milestone sends for these reviewed positions hold the same per-position
    // lock through the Telegram request. Acquire it before locking trackers so
    // a send and this correction cannot deadlock or cross the cutover.
    for (const [trackedId] of LIQ_CASCADE_OPEN_RECLASSIFICATION_TARGETS) {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext('lc_reviewed_milestone'), ${trackedId})`,
      );
    }
    await tx.execute(sql`
      CREATE TEMP TABLE startup_lc_reclassification_targets (
        tracked_id integer PRIMARY KEY,
        signal_id integer NOT NULL UNIQUE,
        symbol text NOT NULL
      ) ON COMMIT DROP
    `);
    await tx.execute(sql`
      INSERT INTO startup_lc_reclassification_targets (tracked_id, signal_id, symbol)
      VALUES ${sql.join(
        LIQ_CASCADE_OPEN_RECLASSIFICATION_TARGETS.map(
          ([trackedId, signalId, symbol]) =>
            sql`(${trackedId}, ${signalId}, ${symbol})`,
        ),
        sql`, `,
      )}
    `);

    // Lock tracker/source identity independently of the watch. After the first
    // run the watch is deliberately unlinked, so making this an all-five
    // tracker+watch join would break idempotence on every later startup.
    const locked = await tx.execute(sql`
      SELECT t.id, t.signal_id, t.symbol, t.status::text AS status,
             t.runner_state, t.core_closed_at, t.entry_price_1h,
             t.entry_liq_ratio, t.entry_liq_reason,
             s.id AS source_signal_id, s.symbol AS source_symbol,
             s.sentiment_key AS source_sentiment_key
        FROM startup_lc_reclassification_targets x
        JOIN tracked_signals t
          ON t.id = x.tracked_id
         AND t.signal_id = x.signal_id
         AND t.symbol = x.symbol
         AND t.sentiment_key = 'liquidation_cascade'
        JOIN signals s
          ON s.id = x.signal_id
         AND s.symbol = x.symbol
         AND s.sentiment_key = 'liquidation_cascade'
       FOR UPDATE OF t, s
    `);
    const rows = locked.rows as Array<{
      id: number;
      signal_id: number;
      symbol: string;
      status: string;
      runner_state: string | null;
      core_closed_at: Date | null;
      entry_price_1h: number | null;
      entry_liq_ratio: number | null;
      entry_liq_reason: string | null;
      source_signal_id: number;
      source_symbol: string;
      source_sentiment_key: string | null;
    }>;
    if (rows.length !== LIQ_CASCADE_OPEN_RECLASSIFICATION_TARGETS.length) {
      throw new Error(
        `LC open reclassification: expected ${LIQ_CASCADE_OPEN_RECLASSIFICATION_TARGETS.length} exact tracker/signal matches, found ${rows.length}`,
      );
    }

    const eligible = rows.filter(
      (row) => row.status === "active" || row.status === "in_run",
    );
    if (eligible.length === 0) return 0;
    if (
      eligible.some(
        (row) => row.runner_state === "open" && row.core_closed_at !== null,
      )
    ) {
      throw new Error(
        "LC open reclassification: partial runner exit detected; refusing correction",
      );
    }
    for (const row of rows) {
      if (!SPIKE_GATE_REVIEWED_TRACKED_IDS.has(row.id)) {
        if (
          row.source_signal_id !== row.signal_id ||
          row.source_symbol !== row.symbol ||
          row.source_sentiment_key !== "liquidation_cascade"
        ) {
          throw new Error(
            `LC open reclassification: reviewed identity mismatch for ${row.id}/${row.symbol}`,
          );
        }
        continue;
      }
      if (
        row.entry_liq_reason !== "liq_spike" ||
        row.entry_price_1h === null ||
        row.entry_price_1h >= -0.5 ||
        row.entry_liq_ratio === null ||
        row.entry_liq_ratio >= 0.75 ||
        row.source_signal_id !== row.signal_id ||
        row.source_symbol !== row.symbol ||
        row.source_sentiment_key !== "liquidation_cascade"
      ) {
        throw new Error(
          `LC open reclassification: reviewed identity/gate mismatch for ${row.id}/${row.symbol}`,
        );
      }
    }
    const watchRowsResult = await tx.execute(sql`
      SELECT w.id AS watch_id, w.signal_id, w.symbol, w.status AS watch_status,
             w.expires_at AS watch_expires_at
        FROM liq_cascade_watch w
        JOIN startup_lc_reclassification_targets x
          ON x.tracked_id = w.signal_id
         AND x.symbol = w.symbol
        JOIN tracked_signals t
          ON t.id = x.tracked_id
         AND t.status IN ('active', 'in_run')
       WHERE w.status = 'fired'
       FOR UPDATE OF w
    `);
    const watchRows = watchRowsResult.rows as Array<{
      watch_id: number;
      signal_id: number;
      symbol: string;
      watch_status: string;
      watch_expires_at: Date;
    }>;
    if (
      watchRows.length !== eligible.length ||
      new Set(watchRows.map((row) => row.signal_id)).size !== eligible.length
    ) {
      throw new Error(
        `LC open reclassification: expected exactly one fired watch per eligible target, found ${watchRows.length} for ${eligible.length}`,
      );
    }
    for (const row of watchRows) {
      const target = eligible.find(
        (candidate) => candidate.id === row.signal_id,
      );
      if (
        !target ||
        row.watch_status !== "fired" ||
        row.symbol !== target.symbol
      ) {
        throw new Error(
          `LC open reclassification: fired watch identity mismatch for tracker ${row.signal_id}`,
        );
      }
    }

    const reason = LIQ_CASCADE_OPEN_RECLASSIFICATION_REASON;
    const tracked = await tx.execute(sql`
      UPDATE tracked_signals t
         SET status = 'reclassified',
             cancel_reason = ${reason},
             exit_price = NULL,
             pnl_percent = NULL,
             closed_at = NULL,
             peak_price = NULL,
             trailing_stop_level = NULL,
             trailing_stop_armed_at = NULL,
             last_milestone = NULL,
             pending_milestone = NULL,
             pending_milestone_kind = NULL,
             pending_milestone_price = NULL,
             pending_milestone_trailing_stop = NULL,
             pending_milestone_status = NULL,
             pending_milestone_lease_until = NULL,
             last_smart_cancel_check_at = NULL,
             updated_at = NOW()
        FROM startup_lc_reclassification_targets x
       WHERE t.id = x.tracked_id
         AND t.signal_id = x.signal_id
         AND t.symbol = x.symbol
         AND t.sentiment_key = 'liquidation_cascade'
         AND t.status IN ('active', 'in_run')
       RETURNING t.id
    `);
    if (tracked.rows.length !== eligible.length) {
      throw new Error(
        "LC open reclassification: tracker update was incomplete",
      );
    }
    await tx.execute(sql`
      CREATE TEMP TABLE startup_lc_reclassified (
        tracked_id integer PRIMARY KEY
      ) ON COMMIT DROP
    `);
    await tx.execute(sql`
      INSERT INTO startup_lc_reclassified (tracked_id)
      VALUES ${sql.join(
        tracked.rows.map((row) => sql`(${Number(row.id)})`),
        sql`, `,
      )}
    `);

    // Write the observation while the fired watch still carries its exact
    // tracker link; this avoids an ambiguous symbol-only join after unlinking.
    await tx.execute(sql`
      INSERT INTO liq_cascade_candidate_observations
        (event_key, watch_id, signal_id, symbol, detected_at, observed_at,
         bucket_at, stage, reason, price, metrics)
      SELECT
        'liq-watch-observation:' || w.id::text || ':reclassified',
        w.id, NULL, t.symbol, w.detected_at, NOW(),
         date_trunc('hour', NOW()),
         CASE WHEN w.expires_at > NOW() THEN 'watching' ELSE 'expired' END,
         ${LIQ_CASCADE_OPEN_RECLASSIFICATION_REASON},
        w.current_price,
        jsonb_build_object('tracked_id', t.id, 'source_signal_id', t.signal_id,
          'restored_status', CASE WHEN w.expires_at > NOW()
            THEN 'watching' ELSE 'expired' END, 'expires_at', w.expires_at)
      FROM liq_cascade_watch w
      JOIN tracked_signals t ON w.signal_id = t.id
      JOIN startup_lc_reclassified r ON r.tracked_id = t.id
      WHERE w.status = 'fired' AND w.symbol = t.symbol
      ON CONFLICT (event_key) DO NOTHING
    `);

    const now = new Date();
    await tx.execute(sql`
      UPDATE liq_cascade_watch w
         SET status = CASE WHEN w.expires_at > ${now} THEN 'watching' ELSE 'expired' END,
             signal_id = NULL,
             miss_reason = CASE
               WHEN w.expires_at > ${now} THEN ${reason}
               ELSE 'liq_cascade_observation_reclassified_expired'
             END,
             last_check_at = NOW()
        FROM startup_lc_reclassified r
        JOIN tracked_signals t ON t.id = r.tracked_id
       WHERE w.signal_id = r.tracked_id
         AND w.symbol = t.symbol
         AND t.id = r.tracked_id
         AND w.status = 'fired'
    `);

    // Delivered/ambiguous Telegram rows are deliberately untouched below.
    await tx.execute(sql`
      UPDATE milestone_notification_deliveries d
         SET status = 'abandoned', lease_until = NULL, claim_token = NULL,
             last_error = ${reason}
       WHERE d.tracked_signal_id IN (
         SELECT tracked_id FROM startup_lc_reclassified
       ) AND d.status IN ('ready', 'failed')
    `);
    await tx.execute(sql`
      WITH abandoned AS (
        UPDATE telegram_photo_deliveries p
           SET status = 'abandoned',
               lease_until = NULL,
               claim_token = NULL,
               last_error = ${reason},
               updated_at = NOW()
         WHERE (
           p.status IN ('ready', 'retry')
           OR (p.status = 'processing' AND p.send_attempted_at IS NULL)
         )
           AND EXISTS (
             SELECT 1
               FROM startup_lc_reclassified r
               JOIN startup_lc_reclassification_targets x
                 ON x.tracked_id = r.tracked_id
              WHERE p.dedup_key = 'signal:' || x.signal_id::text
                 OR p.dedup_key LIKE 'position:' || x.tracked_id::text || ':%'
                 OR p.dedup_key LIKE 'milestone:v3:' || x.tracked_id::text || ':%'
           )
        RETURNING p.dedup_key
      )
      UPDATE telegram_delivery_events e
         SET status = 'attention',
             attention_at = COALESCE(e.attention_at, NOW()),
             last_error = ${reason},
             updated_at = NOW()
       WHERE e.event_key IN (SELECT dedup_key FROM abandoned)
         AND e.status <> 'delivered'
    `);
    return eligible.length;
  });
}
