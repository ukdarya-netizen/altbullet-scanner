import { pool } from "@workspace/db";
import { getKlinesRange } from "./bingx.js";
import { computeSupportZones, type ClosedDetectorCandle } from "./stealth-abneon-detectors.js";
import { logger } from "./logger.js";

/**
 * Take levels tracking (owner 2026-11-12, research only — never changes a trade): for every ABNeon
 * (neon_support_bounce) and Stealth Breakout (stealth_breakout) signal, the ABNeon levels (the same zones as the
 * indicator, from the closed DAILY candles before the signal since 2026-11-14 — 4H before) that lie at least +10% above the entry are recorded as
 * take levels L1, L2, L3… (the bottom of each zone — where the price first meets it). Then, on closed 15m candles
 * from the signal to the real close of the trade, the first time the price reached each level is recorded. A level
 * reached after the real close does not count.
 *
 * Table level_take_tracking (one row per tracked signal). Signals from Dubai November 2026 on.
 * Read with SQL: which share reaches L1 / L2 / L3, and what a take at the level would have given vs the real result.
 */
const D1 = 24 * 3_600_000;
/** Owner 2026-11-14: daily zones (as the live ABNeon / Stealth); rows recorded before used 4H. */
const ZONE_DAYS = 700;
const M15 = 900_000;
const FROM_UTC = "2026-10-31 20:00:00+00";
const MIN_PCT = 10;
const MAX_LEVELS = 5;
const BATCH = 15;

type Level = { n: number; price: number; top: number; count: number; pct: number; hitAt: string | null };

const num = (x: string | number) => Number(x);
const toCandle = (k: { time: number; open: string; high: string; low: string; close: string; volume: string }): ClosedDetectorCandle => ({
  time: k.time, open: num(k.open), high: num(k.high), low: num(k.low), close: num(k.close), volume: num(k.volume),
});

let ready: Promise<void> | null = null;
function ensureTable(): Promise<void> {
  ready ??= pool.query(`
    CREATE TABLE IF NOT EXISTS level_take_tracking (
      tracked_id integer PRIMARY KEY,
      symbol text NOT NULL,
      sentiment_key text NOT NULL,
      entry_price double precision NOT NULL,
      detected_at timestamptz NOT NULL,
      levels jsonb NOT NULL,
      tracked_until timestamptz,
      final boolean NOT NULL DEFAULT false,
      status_at_final text,
      pnl_at_final double precision,
      peak_pct double precision,
      error text,
      updated_at timestamptz NOT NULL DEFAULT now()
    )`).then(() => undefined).catch((err) => { ready = null; throw err; });
  return ready;
}

/** ABNeon levels at least +10% above the entry, from the closed daily candles before the signal. */
export function takeLevels(zoneCandlesBefore: readonly ClosedDetectorCandle[], entry: number): Level[] {
  return computeSupportZones(zoneCandlesBefore)
    .filter((z) => z.bottom >= entry * (1 + MIN_PCT / 100))
    .sort((a, b) => a.bottom - b.bottom)
    .slice(0, MAX_LEVELS)
    .map((z, i) => ({ n: i + 1, price: z.bottom, top: z.top, count: z.count, pct: Math.round(((z.bottom / entry) - 1) * 10_000) / 100, hitAt: null }));
}

async function addNew(): Promise<number> {
  const { rows } = await pool.query<{ id: number; symbol: string; sentiment_key: string; entry_price: number; detected_at: Date }>(
    `SELECT t.id, t.symbol, t.sentiment_key, t.entry_price, t.detected_at
       FROM tracked_signals t
       LEFT JOIN level_take_tracking l ON l.tracked_id = t.id
      WHERE t.sentiment_key IN ('neon_support_bounce', 'stealth_breakout')
        AND t.detected_at >= $1::timestamptz AND COALESCE(t.is_short, false) = false
        AND t.entry_price > 0 AND l.tracked_id IS NULL
      ORDER BY t.id LIMIT $2`,
    [FROM_UTC, BATCH],
  );
  for (const r of rows) {
    const det = new Date(r.detected_at).getTime();
    let levels: Level[] = [];
    let error: string | null = null;
    try {
      const raw = await getKlinesRange(r.symbol, "1d", det - (ZONE_DAYS + 1) * D1, det);
      const d1 = raw.map(toCandle).filter((c) => c.time + D1 <= det).slice(-ZONE_DAYS);
      levels = takeLevels(d1, Number(r.entry_price));
    } catch (err) {
      error = String(err).slice(0, 160);
    }
    await pool.query(
      `INSERT INTO level_take_tracking (tracked_id, symbol, sentiment_key, entry_price, detected_at, levels, error)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7) ON CONFLICT (tracked_id) DO NOTHING`,
      [r.id, r.symbol, r.sentiment_key, r.entry_price, r.detected_at, JSON.stringify(levels), error],
    );
  }
  return rows.length;
}

async function advance(): Promise<number> {
  const { rows } = await pool.query<{
    tracked_id: number; symbol: string; entry_price: number; detected_at: Date; levels: Level[]; tracked_until: Date | null;
    status: string; closed_at: Date | null; pnl_percent: number | null; peak_price: number | null;
  }>(
    `SELECT l.tracked_id, l.symbol, l.entry_price, l.detected_at, l.levels, l.tracked_until,
            t.status::text AS status, t.closed_at, t.pnl_percent, t.peak_price
       FROM level_take_tracking l JOIN tracked_signals t ON t.id = l.tracked_id
      WHERE l.final = false AND l.error IS NULL
      ORDER BY l.updated_at LIMIT $1`,
    [BATCH],
  );
  const now = Date.now();
  for (const r of rows) {
    const open = r.status === "active" || r.status === "in_run";
    const end = Math.min(now, r.closed_at ? new Date(r.closed_at).getTime() : now);
    const levels = r.levels.map((x) => ({ ...x }));
    const from = r.tracked_until ? new Date(r.tracked_until).getTime() : new Date(r.detected_at).getTime();
    if (levels.some((x) => x.hitAt === null) && end > from) {
      const cs = (await getKlinesRange(r.symbol, "15m", Math.floor(from / M15) * M15, end)).map(toCandle)
        .filter((c) => c.time + M15 <= end && c.time + M15 > from);
      for (const c of cs) for (const x of levels) if (x.hitAt === null && c.high >= x.price) x.hitAt = new Date(c.time + M15).toISOString();
    }
    const entry = Number(r.entry_price);
    const peakPct = r.peak_price ? Math.round((Number(r.peak_price) / entry - 1) * 10_000) / 100 : null;
    await pool.query(
      `UPDATE level_take_tracking SET levels = $2::jsonb, tracked_until = $3, final = $4,
              status_at_final = $5, pnl_at_final = $6, peak_pct = $7, updated_at = now()
        WHERE tracked_id = $1`,
      [r.tracked_id, JSON.stringify(levels), new Date(end), !open, open ? null : r.status, open ? null : r.pnl_percent, peakPct],
    );
  }
  return rows.length;
}

export async function runLevelTakeTracking(): Promise<{ added: number; advanced: number }> {
  if (process.env.NODE_ENV !== "production") return { added: 0, advanced: 0 };
  await ensureTable();
  const added = await addNew();
  const advanced = await advance();
  if (added || advanced) logger.debug({ added, advanced }, "level take tracking");
  return { added, advanced };
}
