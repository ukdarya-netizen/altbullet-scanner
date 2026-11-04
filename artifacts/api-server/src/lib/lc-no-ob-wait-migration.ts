import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

export const LC_NO_OB_WAIT_REASON = "lc_no_lower_ob_moved_to_wait";
const LC_OB_WAIT_WINDOW_MS = 96 * 60 * 60 * 1000;

// Reviewed production positions that opened with no demand OB below entry.
// Exact tracker/signal/symbol identity keeps later LC signals untouched.
export const LC_NO_OB_WAIT_TARGETS = [
  [1977, 13114, "XAUT-USDT"],
  [1990, 13342, "AR-USDT"],
  [2010, 13684, "XTZ-USDT"],
  [2011, 13694, "PAXG-USDT"],
  [2012, 13708, "LA-USDT"],
  [2014, 13812, "ONDO-USDT"],
  [2019, 14046, "HYPE-USDT"],
  [2025, 14358, "XPL-USDT"],
  [2029, 14594, "CC-USDT"],
  [2045, 15471, "HBAR-USDT"],
  [2058, 15951, "AKE-USDT"],
  [2066, 16004, "PENGU-USDT"],
  [2083, 17036, "LDO-USDT"],
  [2084, 17040, "DASH-USDT"],
  [2085, 17070, "PUMP-USDT"],
  // TIA: OB touched only on 2026-10-01, not before the 09-29 signal (owner chart review).
  [2036, 15206, "TIA-USDT"],
  // ENA: owner chart review confirmed no OB touch before the signal.
  [2068, 16042, "ENA-USDT"],
  // SUI: only a 0.04% graze of the zone top before the signal; not a sweep.
  [2069, 16051, "SUI-USDT"],
  // Owner-approved: no OB/IMB touch in the 48h before the signal.
  [1983, 13304, "MELANIA-USDT"],
  [1986, 13324, "VVV-USDT"],
  [1989, 13340, "ASTER-USDT"],
  [1992, 13366, "ATOM-USDT"],
  [1996, 13420, "UNI-USDT"],
  [1999, 13464, "MORPHO-USDT"],
  [2004, 13570, "ENS-USDT"],
  [2009, 13674, "1000SHIB-USDT"],
  // BEAT: owner chart review shows no real OB/IMB near entry (detector LuxAlgo touch was not an OB).
  [2007, 13587, "BEAT-USDT"],
  // XRP: owner chart review shows no OB below entry (yellow zones are IMB).
  [2034, 14762, "XRP-USDT"],
  // CASHCAT: owner chart review shows the only OB (0.1457-0.148) was never touched; yellow zones are IMB.
  [2049, 15692, "CASHCAT-USDT"],
  [2051, 15892, "GRT-USDT"],
  [2081, 16902, "JTO-USDT"],
] as const;

/**
 * One-time production move: open LC positions without a lower OB become
 * neutral and return to durable OB waiting (zone is re-detected by the wait
 * loop). No PnL, close time or outcome is written. Idempotent: only rows still
 * active/in_run are touched.
 */
export async function moveReviewedNoObLcToWait(): Promise<number> {
  if (process.env.NODE_ENV !== "production") return 0;

  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext('lc_no_ob_wait_move_20261001'))`,
    );
    for (const [trackedId] of LC_NO_OB_WAIT_TARGETS) {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext('lc_reviewed_milestone'), ${trackedId})`,
      );
    }
    const values = sql.join(
      LC_NO_OB_WAIT_TARGETS.map(
        ([t, s, sym]) => sql`(${t}::int, ${s}::int, ${sym}::text)`,
      ),
      sql`, `,
    );
    await tx.execute(sql`
      CREATE TEMP TABLE startup_lc_no_ob_targets ON COMMIT DROP AS
      SELECT t.id AS tracked_id, t.signal_id, t.symbol, t.entry_price
        FROM (VALUES ${values}) AS x(tracked_id, signal_id, symbol)
        JOIN tracked_signals t
          ON t.id = x.tracked_id AND t.signal_id = x.signal_id
         AND t.symbol = x.symbol AND t.sentiment_key = 'liquidation_cascade'
         AND t.status IN ('active', 'in_run')
       FOR UPDATE OF t
    `);
    // Only rows with exactly one fired watch are eligible.
    await tx.execute(sql`
      CREATE TEMP TABLE startup_lc_no_ob_moved ON COMMIT DROP AS
      SELECT x.tracked_id, x.signal_id, x.symbol, x.entry_price,
             w.id AS watch_id, w.detected_at
        FROM startup_lc_no_ob_targets x
        JOIN liq_cascade_watch w
          ON w.signal_id = x.tracked_id AND w.symbol = x.symbol
         AND w.status = 'fired'
       FOR UPDATE OF w
    `);
    const moved = await tx.execute(
      sql`SELECT tracked_id FROM startup_lc_no_ob_moved`,
    );
    if (moved.rows.length === 0) return 0;

    const reason = LC_NO_OB_WAIT_REASON;
    await tx.execute(sql`
      UPDATE tracked_signals t
         SET status = 'reclassified',
             cancel_reason = ${reason},
             exit_price = NULL, pnl_percent = NULL, closed_at = NULL,
             peak_price = NULL, trailing_stop_level = NULL,
             trailing_stop_armed_at = NULL, last_milestone = NULL,
             pending_milestone = NULL, pending_milestone_kind = NULL,
             pending_milestone_price = NULL,
             pending_milestone_trailing_stop = NULL,
             pending_milestone_status = NULL,
             pending_milestone_lease_until = NULL,
             last_smart_cancel_check_at = NULL, updated_at = NOW()
        FROM startup_lc_no_ob_moved m
       WHERE t.id = m.tracked_id
    `);
    await tx.execute(sql`
      UPDATE liq_cascade_watch w
         SET status = 'watching', signal_id = NULL, miss_reason = ${reason},
             last_check_at = NOW()
        FROM startup_lc_no_ob_moved m
       WHERE w.id = m.watch_id
    `);
    await tx.execute(sql`
      INSERT INTO lc_ob_wait
        (watch_id, symbol, detected_at, expires_at, entry_price, zones,
         status, current_price, last_check_at, observation)
      SELECT m.watch_id, m.symbol, m.detected_at,
             m.detected_at + (${LC_OB_WAIT_WINDOW_MS}::bigint * interval '1 millisecond'),
             m.entry_price, '[]'::jsonb, 'waiting', m.entry_price, NOW(),
             jsonb_build_object('source', ${reason}::text,
               'moved_tracked_id', m.tracked_id,
               'moved_signal_id', m.signal_id)
        FROM startup_lc_no_ob_moved m
      ON CONFLICT DO NOTHING
    `);
    await tx.execute(sql`
      UPDATE milestone_notification_deliveries d
         SET status = 'abandoned', lease_until = NULL, claim_token = NULL,
             last_error = ${reason}
       WHERE d.tracked_signal_id IN (SELECT tracked_id FROM startup_lc_no_ob_moved)
         AND d.status IN ('ready', 'failed')
    `);
    return moved.rows.length;
  });
}
