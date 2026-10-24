import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { getBingXBidSnapshot } from "./bingx.js";
import { logger } from "./logger.js";

export const LC_STOP_SLOTS = [0, 15, 60, 120] as const;
const MINUTE = 60_000;
const GRACE_MS = 8 * MINUTE;
const SOURCE = "BingX perpetual swap depth /openApi/swap/v2/quote/depth";

export async function ensureLcStopBidSchema(): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS lc_stop_bid_observations (
      tracked_signal_id integer NOT NULL REFERENCES tracked_signals(id),
      slot_minutes integer NOT NULL,
      scheduled_at timestamptz NOT NULL,
      observed_at timestamptz,
      source text NOT NULL,
      status text NOT NULL,
      reason text,
      reference_price double precision,
      bids jsonb,
      PRIMARY KEY (tracked_signal_id, slot_minutes)
    )
  `);
}

/** Best-effort observational sampler, independent of position closing and trading. */
export async function collectLcStopBids(now = new Date()): Promise<void> {
  const result = await db.execute(sql`
    SELECT ts.id, ts.symbol, ts.closed_at, slots.minutes AS slot_minutes
    FROM tracked_signals ts
    CROSS JOIN (VALUES (0), (15), (60), (120)) slots(minutes)
    LEFT JOIN lc_stop_bid_observations obs
      ON obs.tracked_signal_id = ts.id AND obs.slot_minutes = slots.minutes
    WHERE ts.sentiment_key = 'liquidation_cascade'
      AND ts.status = 'stop_loss'
      AND ts.closed_at BETWEEN ${new Date(now.getTime() - 128 * MINUTE)} AND ${now}
      AND ts.closed_at + slots.minutes * interval '1 minute' <= ${now}
      AND obs.tracked_signal_id IS NULL
    ORDER BY ts.closed_at + slots.minutes * interval '1 minute'
    LIMIT 200
  `);
  let calls = 0;
  for (const row of result.rows) {
    const closed = new Date(String(row.closed_at)).getTime();
    if (!Number.isFinite(closed)) continue;
    const slot = Number(row.slot_minutes);
    const due = closed + slot * MINUTE;
    if (now.getTime() < due) continue;
    const expired = now.getTime() - due > GRACE_MS;
    if (!expired && calls >= 8) continue;
    const id = Number(row.id);
    const claimed = await db.execute(sql`
        INSERT INTO lc_stop_bid_observations
          (tracked_signal_id, slot_minutes, scheduled_at, source, status, reason)
        VALUES (${id}, ${slot}, ${new Date(due)}, ${SOURCE},
          ${expired ? "missing" : "pending"},
          ${expired ? "sampling_window_missed" : "fetch_in_progress"})
        ON CONFLICT DO NOTHING RETURNING tracked_signal_id
      `);
    if (claimed.rows.length === 0 || expired) continue;
    calls++;
    try {
      const snapshot = await getBingXBidSnapshot(String(row.symbol));
      await db.execute(sql`
          UPDATE lc_stop_bid_observations
          SET status = ${snapshot ? "observed" : "missing"},
              reason = ${snapshot ? null : "depth_unavailable"},
              observed_at = ${snapshot ? new Date(snapshot.observedAt) : null},
              reference_price = ${snapshot?.referencePrice ?? null},
              bids = ${snapshot ? JSON.stringify(snapshot.bids) : null}::jsonb
          WHERE tracked_signal_id = ${id} AND slot_minutes = ${slot}
        `);
    } catch (err) {
      logger.warn({ err, id, slot }, "LC stop bid observation unavailable");
      await db.execute(sql`
          UPDATE lc_stop_bid_observations
          SET status = 'missing', reason = 'depth_request_failed'
          WHERE tracked_signal_id = ${id} AND slot_minutes = ${slot}
        `);
    }
  }
}

export async function readLcStopBids(ids: number[]) {
  if (!ids.length) return [];
  const result = await db.execute(sql`
    SELECT tracked_signal_id, slot_minutes, scheduled_at, observed_at,
           source, status, reason, reference_price, bids
    FROM lc_stop_bid_observations
    WHERE tracked_signal_id IN (${sql.join(
      ids.map((id) => sql`${id}`),
      sql`, `,
    )})
    ORDER BY tracked_signal_id, slot_minutes
  `);
  return result.rows;
}
