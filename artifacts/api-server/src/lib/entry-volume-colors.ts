/**
 * Owner's «VSA Wyckoff Volume» indicator (TradingView, Pine v4), reproduced one to one, on the
 * 48 hourly bars before every Impulse Buy and Stealth signal (owner 2026-11-04: «перед началом
 * роста часто цветные бары» — check it on our signals, by name).
 *
 * Indicator: volumeMA = Wilder MA, length 20, seeded with 0 on the first bar:
 *   ma := ma[1] + (volume − ma[1]) / 20   (the current bar's volume is inside its own MA)
 * colour of a bar by volume / ma:
 *   ≥ 2.2 purple (P) · ≥ 1.8 red (R) · ≥ 1.2 orange (O) · ≥ 0.8 green (G) · ≥ 0.4 blue (B) · else silver (S)
 * Two volumes: BingX futures (the pair we trade) and aggregated futures of all exchanges (CoinGlass).
 * Entry candle = last closed 1H candle before the signal (same as VSA). «before» = the 48 bars
 * before the entry candle; the entry candle's own colour is stored separately.
 * Observation only — no decision reads these.
 */
import { pool } from "@workspace/db";
import { getKlinesRange } from "./bingx.js";
import * as cgTaker from "./coinglass_taker.js";
import { logger } from "./logger.js";

export const VOLUME_COLOR_KEYS = ["impulse_buy", "stealth_breakout"] as const;
const H1 = 3_600_000;
const WINDOW = 48;
const WARMUP = 400;
const BACKFILL_DAYS = 60;
const RETRY_TEMP_MS = 30 * 60_000;
const RETRY_AFTER_MS = 6 * H1;

export const COLOR_RATIOS = { ultra: 2.2, veryHigh: 1.8, high: 1.2, normal: 0.8, low: 0.4 } as const;

let tableReady: Promise<void> | null = null;
export function ensureVolumeColorsTable(): Promise<void> {
  tableReady ??= (async () => {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS signal_volume_colors (
        id                serial PRIMARY KEY,
        tracked_signal_id integer NOT NULL,
        symbol            text NOT NULL,
        sentiment_key     text NOT NULL,
        recorded_at       timestamp NOT NULL DEFAULT now(),
        metrics           jsonb NOT NULL
      )`);
    await pool.query("CREATE UNIQUE INDEX IF NOT EXISTS signal_volume_colors_signal_unique ON signal_volume_colors (tracked_signal_id)");
  })().catch((err) => { tableReady = null; throw err; });
  return tableReady;
}

export function colorOf(ratio: number): string {
  const r = COLOR_RATIOS;
  return ratio >= r.ultra ? "P" : ratio >= r.veryHigh ? "R" : ratio >= r.high ? "O" : ratio >= r.normal ? "G" : ratio >= r.low ? "B" : "S";
}

/**
 * Pure: colours of the window. `bars` = consecutive 1H bars (ascending) from the start of the
 * available history up to and including the entry candle; `vol(t)` = volume of the bar or null.
 */
export function colorWindow(barTimes: number[], vol: (t: number) => number | null, entry: number) {
  let ma = 0;
  const ratio = new Map<number, number>();
  for (const t of barTimes) {
    const v = vol(t);
    if (v === null) return null; // a hole in the volume history — the MA would differ from the chart
    ma = ma + (v - ma) / 20;
    ratio.set(t, ma > 0 ? v / ma : 0);
  }
  const entryRatio = ratio.get(entry);
  if (entryRatio === undefined) return null;
  const before: string[] = [];
  for (let k = WINDOW; k >= 1; k--) {
    const r = ratio.get(entry - k * H1);
    before.push(r === undefined ? "-" : colorOf(r));
  }
  const last = (n: number) => before.slice(-n);
  const count = (arr: string[], c: string) => arr.filter((x) => x === c).length;
  const sinceLast = (set: string) => { for (let k = 1; k <= WINDOW; k++) if (set.includes(before[WINDOW - k]!)) return k; return null; };
  const out: Record<string, unknown> = {
    entryColor: colorOf(entryRatio),
    entryRatio: Math.round(entryRatio * 100) / 100,
    /** 48 bars before the entry candle, oldest → newest (the last letter = the bar right before the entry). */
    colors48: before.join(""),
    historyBars: barTimes.length,
    hoursSincePurple: sinceLast("P"),
    hoursSinceRedOrPurple: sinceLast("PR"),
    hoursSinceOrangeOrHigher: sinceLast("PRO"),
  };
  for (const n of [6, 12, 24, 48]) {
    const w = last(n);
    out[`last${n}h`] = { P: count(w, "P"), R: count(w, "R"), O: count(w, "O"), G: count(w, "G"), B: count(w, "B"), S: count(w, "S"), colored: count(w, "P") + count(w, "R") + count(w, "O") };
  }
  return out;
}

const failures = new Map<number, { reason: string; at: number; temporary: boolean }>();
const inflight = new Set<number>();

type SignalRef = { id: number; symbol: string; sentimentKey: string; detectedAt: Date };

export async function recordVolumeColors(t: SignalRef, priority: "high" | "low" = "low"): Promise<"written" | "failed" | "skipped"> {
  if (!VOLUME_COLOR_KEYS.includes(t.sentimentKey as (typeof VOLUME_COLOR_KEYS)[number]) || inflight.has(t.id)) return "skipped";
  inflight.add(t.id);
  try {
    await ensureVolumeColorsTable();
    const entry = Math.floor(t.detectedAt.getTime() / H1) * H1 - H1;
    const from = entry - (WARMUP + WINDOW) * H1;
    const raw = await getKlinesRange(t.symbol, "1h", from, entry + H1).catch(() => []);
    const bars = raw.filter((k) => k.time <= entry && Number.isFinite(Number(k.volume))).sort((a, b) => a.time - b.time);
    const reasons: string[] = [];
    let temporary = false;
    if (!bars.some((k) => k.time === entry)) { reasons.push("нет свечи входа BingX 1H"); }
    const bingxVol = new Map(bars.map((k) => [k.time, Number(k.volume)]));
    const barTimes = bars.map((k) => k.time);
    // Only consecutive bars: a gap in BingX history starts a new series (as on the chart after a gap).
    let startIdx = 0;
    for (let i = 1; i < barTimes.length; i++) if (barTimes[i]! - barTimes[i - 1]! !== H1) startIdx = i;
    const series = barTimes.slice(startIdx);
    const bingx = reasons.length ? null : colorWindow(series, (x) => bingxVol.get(x) ?? null, entry);
    if (!reasons.length && !bingx) reasons.push("BingX: дыра в истории объёма");

    const hours = Math.ceil((Date.now() - from) / H1) + 2;
    const agg = hours <= 4500
      ? await cgTaker.getAggFuturesVolumeByInterval(t.symbol, "1h", hours, Date.now(), priority, priority === "low" ? 60_000 : 20_000).catch(() => null)
      : null;
    let aggOut: Record<string, unknown> | null = null;
    if (!agg) {
      const e = cgTaker.lastAggVolumeError ?? "кэш/ключ";
      temporary = !/нет данных|код/.test(e);
      reasons.push(`объём всех бирж CoinGlass: ${e}`);
    } else {
      // Aggregated history starts later than BingX for some coins: use its own consecutive tail.
      const aggTimes = series.filter((x) => agg.has(x));
      let s = 0;
      for (let i = 1; i < aggTimes.length; i++) if (aggTimes[i]! - aggTimes[i - 1]! !== H1) s = i;
      aggOut = colorWindow(aggTimes.slice(s), (x) => agg.get(x) ?? null, entry);
      if (!aggOut) reasons.push("CoinGlass: нет объёма свечи входа");
    }
    if (!bingx && !aggOut) {
      failures.set(t.id, { reason: reasons.join("; ") || "неизвестно", at: Date.now(), temporary });
      return "failed";
    }
    if (temporary) {
      // BingX is ready but CoinGlass only failed for now: retry later so both are written together.
      failures.set(t.id, { reason: reasons.join("; "), at: Date.now(), temporary: true });
      return "failed";
    }
    await pool.query(
      `INSERT INTO signal_volume_colors (tracked_signal_id, symbol, sentiment_key, metrics)
       VALUES ($1, $2, $3, $4::jsonb) ON CONFLICT (tracked_signal_id) DO NOTHING`,
      [t.id, t.symbol, t.sentimentKey, JSON.stringify({
        entryCandle: new Date(entry).toISOString(),
        bingx, agg: aggOut,
        missing: reasons.length ? reasons : null,
        indicator: "VSA Wyckoff Volume (20, 2.2, 1.8, 1.2, 0.8, 0.4), Wilder MA",
      })]);
    failures.delete(t.id);
    return "written";
  } catch (err) {
    failures.set(t.id, { reason: `ошибка: ${err instanceof Error ? err.message.slice(0, 160) : String(err)}`, at: Date.now(), temporary: false });
    logger.warn({ err, symbol: t.symbol }, "volume colours restore failed (non-critical)");
    return "failed";
  } finally {
    inflight.delete(t.id);
  }
}

export async function runVolumeColorsBackfillCycle(limit = 40, gapMs = 2_000, priority: "high" | "low" = "low") {
  await ensureVolumeColorsTable();
  const cooling = [...failures.entries()]
    .filter(([, f]) => Date.now() - f.at < (f.temporary ? RETRY_TEMP_MS : RETRY_AFTER_MS))
    .map(([id]) => id);
  const { rows } = await pool.query(
    `SELECT t.id, t.symbol, t.sentiment_key, t.detected_at
     FROM tracked_signals t
     LEFT JOIN signal_volume_colors c ON c.tracked_signal_id = t.id
     WHERE t.sentiment_key = ANY($1::text[]) AND t.detected_at > now() - ($2::int * interval '1 day')
       AND t.detected_at < now() - interval '5 minutes'
       AND c.tracked_signal_id IS NULL AND NOT (t.id = ANY($3::int[]))
     ORDER BY t.detected_at > now() - interval '30 days' DESC, t.detected_at DESC
     LIMIT $4`, [[...VOLUME_COLOR_KEYS], BACKFILL_DAYS, cooling, limit]);
  let tried = 0, written = 0, failed = 0;
  for (const r of rows) {
    tried++;
    const res = await recordVolumeColors({ id: r.id, symbol: r.symbol, sentimentKey: r.sentiment_key, detectedAt: new Date(r.detected_at) }, priority);
    if (res === "written") written++;
    if (res === "failed") failed++;
    await new Promise((resolve) => setTimeout(resolve, gapMs));
  }
  if (tried) logger.info({ tried, written, failed }, "volume colours restore pass");
  return { tried, written, failed };
}

export async function volumeColorsCoverage() {
  await ensureVolumeColorsTable();
  const { rows } = await pool.query(
    `SELECT t.sentiment_key AS key, count(c.tracked_signal_id)::int AS n
     FROM tracked_signals t LEFT JOIN signal_volume_colors c ON c.tracked_signal_id = t.id
     WHERE t.sentiment_key = ANY($1::text[]) AND t.detected_at > now() - ($2::int * interval '1 day')
     GROUP BY 1`, [[...VOLUME_COLOR_KEYS], BACKFILL_DAYS]);
  const reasons: Record<string, number> = {};
  for (const f of failures.values()) reasons[f.reason] = (reasons[f.reason] ?? 0) + 1;
  return { byKey: Object.fromEntries(rows.map((r) => [r.key, r.n])) as Record<string, number>, failedNow: failures.size, reasons };
}
