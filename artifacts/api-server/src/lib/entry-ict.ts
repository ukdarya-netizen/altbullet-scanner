/**
 * ICT at the entry of every CAB signal (owner 2026-11-05): Impulse Buy, Stealth, ABNeon and
 * Liquidation Cascade, on BingX 15m and 1H candles (lib/ict.ts — the same module as in Nihilist).
 * Entry bar = the last closed bar of each timeframe before the signal. Window for sweeps / MSS / FVG:
 * the last 24 bars on 1H, the last 48 bars on 15m. Pattern level (where the swept liquidity sat):
 *  - Stealth: the live range (top / bottom);
 *  - ABNeon: the frozen support zone top (the bottom is not stored);
 *  - Impulse Buy, Liquidation Cascade: none.
 * Stored in signal_entry_extras.metrics.ict (rows are created for ABNeon / LC). Observation only.
 */
import { pool } from "@workspace/db";
import { getKlinesRange } from "./bingx.js";
import { ensureExtrasTable } from "./entry-extras.js";
import { ictReading, type IctBar } from "./ict.js";
import { logger } from "./logger.js";

export const ICT_KEYS = ["impulse_buy", "stealth_breakout", "neon_support_bounce", "liquidation_cascade"] as const;
const BACKFILL_DAYS = 60;
const RETRY_MS = 6 * 3_600_000;
const TF = { "1h": { ms: 3_600_000, bars: 320, window: 24 }, "15m": { ms: 900_000, bars: 420, window: 48 } } as const;

async function bars(symbol: string, tf: keyof typeof TF, entryStart: number): Promise<IctBar[]> {
  const { ms, bars: n } = TF[tf];
  const raw = await getKlinesRange(symbol, tf, entryStart - n * ms, entryStart + ms).catch(() => []);
  return raw
    .map((k) => ({ time: Number(k.time), open: Number(k.open), high: Number(k.high), low: Number(k.low), close: Number(k.close), volume: Number(k.volume) }))
    .filter((k) => k.time <= entryStart && Number.isFinite(k.close))
    .sort((a, b) => a.time - b.time);
}

export async function computeIct(symbol: string, detectedAt: number, levelTop: number | null, levelBottom: number | null) {
  const out: Record<string, unknown> = { version: 1, source: "bingx", levelTop, levelBottom };
  for (const tf of ["1h", "15m"] as const) {
    const { ms, window } = TF[tf];
    const entryStart = Math.floor(detectedAt / ms) * ms - ms;
    const b = await bars(symbol, tf, entryStart);
    const e = b.findIndex((x) => x.time === entryStart);
    out[tf === "1h" ? "h1" : "m15"] = e < 0 ? { reason: "нет свечи входа" } : ictReading(b, e, { w0: e - window + 1, levelTop, levelBottom });
  }
  return out;
}

const failures = new Map<number, number>();

export async function runIctBackfillCycle(limit = 25, gapMs = 1_000) {
  await ensureExtrasTable();
  const cooling = [...failures.entries()].filter(([, at]) => Date.now() - at < RETRY_MS).map(([id]) => id);
  // The ABNeon zone comes from the shadow candidates table when it exists (production).
  const hasCandidates = Boolean((await pool.query("SELECT to_regclass('public.stealth_abneon_shadow_candidates') AS r")).rows[0]?.r);
  const neonLevelSql = hasCandidates
    ? `(SELECT c.frozen_level FROM stealth_abneon_shadow_candidates c
              WHERE c.fired_signal_id = t.signal_id AND c.detection_method = 'abneon_support_bounce'
              ORDER BY c.updated_at DESC LIMIT 1)`
    : "NULL::float8";
  const { rows } = await pool.query(
    `SELECT t.id, t.symbol, t.sentiment_key, t.detected_at,
            t.decision_metrics->'stealthRange4h'->>'rangeTop' AS range_top,
            t.decision_metrics->'stealthRange4h'->>'rangeBottom' AS range_bottom,
            ${neonLevelSql} AS neon_level
       FROM tracked_signals t
       LEFT JOIN signal_entry_extras x ON x.tracked_signal_id = t.id
      WHERE t.sentiment_key = ANY($1::text[]) AND t.detected_at > now() - ($2::int * interval '1 day')
        AND t.detected_at < now() - interval '5 minutes'
        AND (x.tracked_signal_id IS NULL OR NOT (x.metrics ? 'ict'))
        AND NOT (t.id = ANY($3::int[]))
      ORDER BY t.detected_at DESC LIMIT $4`, [[...ICT_KEYS], BACKFILL_DAYS, cooling, limit]);
  let tried = 0, written = 0;
  for (const r of rows) {
    tried++;
    try {
      const isStealth = r.sentiment_key === "stealth_breakout";
      const top = isStealth ? Number(r.range_top) : r.sentiment_key === "neon_support_bounce" ? Number(r.neon_level) : NaN;
      const bottom = isStealth ? Number(r.range_bottom) : NaN;
      const ict = await computeIct(r.symbol, new Date(r.detected_at).getTime(), top > 0 ? top : null, bottom > 0 ? bottom : null);
      await pool.query(
        `INSERT INTO signal_entry_extras (tracked_signal_id, symbol, sentiment_key, metrics)
         VALUES ($1, $2, $3, jsonb_build_object('ict', $4::jsonb))
         ON CONFLICT (tracked_signal_id) DO UPDATE SET metrics = signal_entry_extras.metrics || jsonb_build_object('ict', $4::jsonb)`,
        [r.id, r.symbol, r.sentiment_key, JSON.stringify(ict)]);
      written++;
    } catch (err) {
      failures.set(r.id, Date.now());
      logger.warn({ err, symbol: r.symbol }, "ICT reading failed (non-critical)");
    }
    await new Promise((resolve) => setTimeout(resolve, gapMs));
  }
  if (tried) logger.info({ tried, written }, "ICT at entry pass");
  return { tried, written };
}
