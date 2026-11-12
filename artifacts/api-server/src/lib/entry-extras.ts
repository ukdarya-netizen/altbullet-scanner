/**
 * Breakout and Impulse Buy parameters at the signal, restored from history (owner 2026-11-04:
 * «восстанавливаем всё для пробоев и IB» while the scanner is paused). One row per signal in
 * signal_entry_extras. Observation only — no decision reads these.
 *
 * Stealth (stealth_breakout): breakout candle = last closed 1H candle before the signal.
 *   range (Pine Auto Range replay on BingX 1H, same detector as live): top, bottom, height %, hours,
 *   close above the top %; candle body %, close position (0 = low, 1 = high), spread vs 20 bars;
 *   aggregated futures volume vs 20 bars; futures and spot taker net buy % of the candle and of the
 *   3 hours before it; aggregated OI change 1h / 4h / 24h to the candle close.
 * Impulse Buy: detection candle = the 30m candle the scanner used (impulse_decision_metrics
 *   .candleClosedAt), else the last closed 30m candle before the signal. Same pack on 30m:
 *   candle shape, volume vs 20 bars, futures and spot taker net buy % (candle, previous hour),
 *   OI change 30m / 1h / 4h / 24h.
 * Liquidation Cascade (owner 2026-11-12: "write all entry metrics as for the other patterns"): detection
 *   candle = the last closed 15m candle before the signal (the candle the capitulation rule judges). Same pack
 *   on 15m: candle shape, aggregated futures volume vs 20 bars and its Welkin colour, futures and spot taker
 *   net buy % (candle, previous hour), OI change 15m / 1h / 4h / 24h.
 * Sources: BingX klines (price), CoinGlass aggregated history (volume, taker, OI).
 */
import { pool } from "@workspace/db";
import { getKlinesRange } from "./bingx.js";
import { applyCgAlias } from "./cg-symbol-alias.js";
import { cgTimedFetch } from "./cg_latency.js";
import { getNextCgKey } from "./coinglass_keys.js";
import { getAllSpotExchanges } from "./coinglass-exchanges.js";
import { getAggFuturesTakerExchanges } from "./coinglass_taker.js";
import { evaluateRange1hBreakout } from "./stealth-range-4h.js";
import { computeSupportZones } from "./stealth-abneon-detectors.js";
import { detectAutoRangePine1h } from "./auto-range-pine.js";
import { logger } from "./logger.js";

export const EXTRAS_KEYS = ["impulse_buy", "stealth_breakout", "liquidation_cascade"] as const;
const H1 = 3_600_000;
const M30 = 30 * 60_000;
const M15 = 15 * 60_000;
const BACKFILL_DAYS = 60;
const RANGE_BARS = 320;
const RETRY_TEMP_MS = 30 * 60_000;
const RETRY_AFTER_MS = 6 * H1;

let tableReady: Promise<void> | null = null;
export function ensureExtrasTable(): Promise<void> {
  tableReady ??= (async () => {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS signal_entry_extras (
        id                serial PRIMARY KEY,
        tracked_signal_id integer NOT NULL,
        symbol            text NOT NULL,
        sentiment_key     text NOT NULL,
        recorded_at       timestamp NOT NULL DEFAULT now(),
        metrics           jsonb NOT NULL
      )`);
    await pool.query("CREATE UNIQUE INDEX IF NOT EXISTS signal_entry_extras_signal_unique ON signal_entry_extras (tracked_signal_id)");
  })().catch((err) => { tableReady = null; throw err; });
  return tableReady;
}

export type Row = Record<string, unknown> & { time: number };
type CgResult = { rows: Row[] | null; error: string | null; temporary: boolean };

const num = (v: unknown): number | null => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const r2 = (v: number | null) => (v === null || !Number.isFinite(v) ? null : Math.round(v * 100) / 100);

async function fetchCg(path: string, params: Record<string, string>, interval: string, limit: number, priority: "high" | "low"): Promise<CgResult> {
  const key = getNextCgKey();
  if (!key) return { rows: null, error: "нет ключа CoinGlass", temporary: true };
  const url = new URL(`https://open-api-v4.coinglass.com/api/${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set("interval", interval);
  url.searchParams.set("limit", String(Math.min(4500, Math.max(1, Math.round(limit)))));
  try {
    const res = await cgTimedFetch(url.toString(), {
      headers: { "CG-API-KEY": key, Accept: "application/json" },
      signal: AbortSignal.timeout(priority === "low" ? 60_000 : 20_000),
    }, { priority, endpoint: path });
    if (res.status === 429) return { rows: null, error: "CoinGlass 429 (лимит запросов)", temporary: true };
    if (!res.ok) return { rows: null, error: `CoinGlass HTTP ${res.status}`, temporary: true };
    const body = (await res.json()) as { code?: string; msg?: string; data?: Row[] };
    if (body.code !== "0") return { rows: null, error: `CoinGlass код ${body.code}: ${String(body.msg ?? "").slice(0, 60)}`, temporary: false };
    if (!body.data?.length) return { rows: null, error: "CoinGlass: нет данных по монете", temporary: false };
    return { rows: body.data.map((r) => { const t = Number(r.time); return { ...r, time: t < 1e12 ? t * 1000 : t }; }), error: null, temporary: false };
  } catch (err) {
    const timeout = err instanceof Error && /abort|timeout/i.test(`${err.name} ${err.message}`);
    return { rows: null, error: timeout ? "CoinGlass таймаут" : `CoinGlass: ${err instanceof Error ? err.message.slice(0, 60) : String(err)}`, temporary: true };
  }
}

export type Candle = { time: number; open: number; high: number; low: number; close: number };
async function klines(symbol: string, interval: "1h" | "30m" | "15m", from: number, to: number): Promise<Candle[]> {
  const raw = await getKlinesRange(symbol, interval, from, to).catch(() => []);
  return raw
    .map((k) => ({ time: Number(k.time), open: Number(k.open), high: Number(k.high), low: Number(k.low), close: Number(k.close) }))
    .filter((k) => Number.isFinite(k.close) && k.close > 0)
    .sort((a, b) => a.time - b.time);
}

/** Candle shape: body %, close position in the bar, spread vs the average of the 20 bars before. */
function shape(candles: Candle[], at: number) {
  const i = candles.findIndex((c) => c.time === at);
  if (i < 0) return null;
  const c = candles[i]!;
  const prev = candles.slice(Math.max(0, i - 20), i);
  const avgSpread = prev.length ? prev.reduce((s, x) => s + (x.high - x.low), 0) / prev.length : 0;
  return {
    open: c.open, high: c.high, low: c.low, close: c.close,
    bodyPct: r2(((c.close - c.open) / c.open) * 100),
    rangePct: r2(((c.high - c.low) / c.low) * 100),
    closePosition: c.high > c.low ? r2((c.close - c.low) / (c.high - c.low)) : null,
    spreadRatio: avgSpread > 0 ? r2((c.high - c.low) / avgSpread) : null,
  };
}

const BUY = "aggregated_buy_volume_usd", SELL = "aggregated_sell_volume_usd";
/** Net buy % = (buy − sell) / (buy + sell) over the bars starting at `from`, `n` bars long. */
function netBuy(rows: Row[] | null, from: number, n: number, step: number): number | null {
  if (!rows) return null;
  let b = 0, s = 0, found = 0;
  for (let k = 0; k < n; k++) {
    const r = rows.find((x) => x.time === from + k * step);
    if (!r) continue;
    found++; b += num(r[BUY]) ?? 0; s += num(r[SELL]) ?? 0;
  }
  return found === n && b + s > 0 ? r2(((b - s) / (b + s)) * 100) : null;
}

/** Aggregated futures volume of the bar vs the average of the 20 bars before it. */
function volRatio(rows: Row[] | null, at: number, step: number) {
  if (!rows) return { volumeUsd: null, volRatio20: null };
  const vol = (t: number) => { const r = rows.find((x) => x.time === t); return r ? (num(r[BUY]) ?? 0) + (num(r[SELL]) ?? 0) : null; };
  const cur = vol(at);
  const prev: number[] = [];
  for (let k = 1; k <= 20; k++) { const v = vol(at - k * step); if (v === null) break; prev.push(v); }
  const avg = prev.length === 20 ? prev.reduce((a, b) => a + b, 0) / 20 : 0;
  return { volumeUsd: cur === null ? null : Math.round(cur), volRatio20: cur !== null && avg > 0 ? r2(cur / avg) : null };
}

/** OI change % from the close of the bar `back` bars earlier to the close of the bar starting at `at`. */
function oiChange(rows: Row[] | null, at: number, back: number, step: number): number | null {
  if (!rows) return null;
  const close = (t: number) => num(rows.find((x) => x.time === t)?.close);
  const last = close(at), prev = close(at - back * step);
  return last !== null && prev !== null && prev > 0 ? r2(((last - prev) / prev) * 100) : null;
}


/** Owner's Welkin VSA colour of the bar on aggregated futures volume (20 bars, the bar included, population σ). */
function welkinOf(rows: Row[] | null, at: number, step: number): string | null {
  if (!rows) return null;
  const vol = (t: number) => { const r = rows.find((x) => x.time === t); return r ? (num(r[BUY]) ?? 0) + (num(r[SELL]) ?? 0) : null; };
  const vs: number[] = [];
  for (let k = 19; k >= 0; k--) { const v = vol(at - k * step); if (v === null) return null; vs.push(v); }
  const avg = vs.reduce((a, b) => a + b, 0) / 20;
  const sd = Math.sqrt(vs.reduce((a, v) => a + (v - avg) ** 2, 0) / 20);
  const v = vs[19]!, prev = vs[18]!;
  if (v > avg + 4 * sd) return "W";
  if (v > avg + 3 * sd) return "M";
  if (v > avg + 2 * sd) return "O";
  if (v > avg) return "A";
  if (prev > 0 && v / prev >= 1.25) return "Y";
  return "N";
}

/** Pure: the stored parameters from candles and CoinGlass rows (exported for tests). */
export function buildExtras(a: { isIb: boolean; isLc?: boolean; at: number; candles: Candle[]; fut: Row[] | null; spot: Row[] | null; oi: Row[] | null; reasons: string[]; fromScanner: boolean }) {
  const { isIb, candles, fut, spot, oi } = a;
  const isLc = a.isLc === true;
  const step = isLc ? M15 : isIb ? M30 : H1;
  let at = a.at;
  const extra: Record<string, unknown> = {};
  if (isLc) {
    Object.assign(extra, {
      candleFrom: "last_closed_15m",
      welkin: welkinOf(fut, at, M15),
      futTakerNetBuyPctPrev1h: netBuy(fut, at - 4 * M15, 4, M15),
      spotTakerNetBuyPctPrev1h: netBuy(spot, at - 4 * M15, 4, M15),
      oi15m: oiChange(oi, at, 1, M15),
      oi1h: oiChange(oi, at, 4, M15),
      oi4h: oiChange(oi, at, 16, M15),
      oi24h: oiChange(oi, at, 96, M15),
    });
  } else if (isIb) {
    Object.assign(extra, {
      candleFrom: a.fromScanner ? "scanner_candle" : "last_closed_30m",
      futTakerNetBuyPctPrev1h: netBuy(fut, at - 2 * M30, 2, M30),
      spotTakerNetBuyPctPrev1h: netBuy(spot, at - 2 * M30, 2, M30),
      oi30m: oiChange(oi, at, 1, M30),
      oi1h: oiChange(oi, at, 2, M30),
      oi4h: oiChange(oi, at, 8, M30),
      oi24h: oiChange(oi, at, 48, M30),
    });
  } else {
    // The scanner may have caught the breakout a candle or two late: look back up to 2 hours;
    // everything below is then measured on the breakout candle itself.
    let d = evaluateRange1hBreakout(candles.filter((c) => c.time <= at));
    let offset = 0;
    for (let k = 1; k <= 2 && d.rangeTop === null; k++) {
      const e = evaluateRange1hBreakout(candles.filter((c) => c.time <= a.at - k * H1));
      if (e.rangeTop !== null) { d = e; offset = k; }
    }
    at = a.at - offset * H1;
    const top = d.rangeTop, bottom = d.rangeBottom;
    const close = candles.find((c) => c.time === at)?.close ?? null;
    Object.assign(extra, {
      breakoutFound: top !== null,
      breakoutHoursBeforeSignalCandle: top !== null ? offset : null,
      rangeReason: top === null ? d.reason : null,
      rangeTop: top,
      rangeBottom: bottom,
      rangeHeightPct: top !== null && bottom ? r2(((top - bottom) / bottom) * 100) : null,
      rangeHours: r2(d.rangeHours),
      closeAboveTopPct: top && close !== null ? r2(((close - top) / top) * 100) : null,
      futTakerNetBuyPctPrev3h: netBuy(fut, at - 3 * H1, 3, H1),
      spotTakerNetBuyPctPrev3h: netBuy(spot, at - 3 * H1, 3, H1),
      oi1h: oiChange(oi, at, 1, H1),
      oi4h: oiChange(oi, at, 4, H1),
      oi24h: oiChange(oi, at, 24, H1),
    });
  }
  return {
    timeframe: isLc ? "15m" : isIb ? "30m" : "1h",
    candleTime: new Date(at).toISOString(),
    candle: shape(candles.filter((c) => c.time <= at), at),
    ...volRatio(fut, at, step),
    futTakerNetBuyPct: netBuy(fut, at, 1, step),
    spotTakerNetBuyPct: netBuy(spot, at, 1, step),
    ...extra,
    missing: a.reasons.length ? a.reasons : null,
    source: "bingx_price+coinglass_agg_history",
  };
}

const failures = new Map<number, { reason: string; at: number; temporary: boolean }>();
const inflight = new Set<number>();

type SignalRef = { id: number; symbol: string; sentimentKey: string; detectedAt: Date; ibCandleClosedAt?: string | null };

/** Restores the breakout / impulse parameters of one signal. Never throws. */
export async function recordEntryExtras(t: SignalRef, priority: "high" | "low" = "low"): Promise<"written" | "failed" | "skipped"> {
  if (!EXTRAS_KEYS.includes(t.sentimentKey as (typeof EXTRAS_KEYS)[number]) || inflight.has(t.id)) return "skipped";
  inflight.add(t.id);
  try {
    await ensureExtrasTable();
    const isIb = t.sentimentKey === "impulse_buy";
    const isLc = t.sentimentKey === "liquidation_cascade";
    const step = isLc ? M15 : isIb ? M30 : H1;
    const interval = isLc ? "15m" : isIb ? "30m" : "1h";
    const fromIdm = t.ibCandleClosedAt ? Date.parse(t.ibCandleClosedAt) - M30 : NaN;
    const at = isLc
      ? Math.floor(t.detectedAt.getTime() / M15) * M15 - M15
      : isIb
        ? (Number.isFinite(fromIdm) ? fromIdm : Math.floor(t.detectedAt.getTime() / M30) * M30 - M30)
        : Math.floor(t.detectedAt.getTime() / H1) * H1 - H1;
    const base = applyCgAlias(t.symbol.replace(/-?USDT$/i, "").toUpperCase());
    const bars = Math.ceil((Date.now() - at) / step) + (isLc ? 120 : 60);
    const candles = await klines(t.symbol, interval, at - (isIb || isLc ? 60 : RANGE_BARS) * step, at + step);
    const fut = await fetchCg("futures/aggregated-taker-buy-sell-volume/history", { symbol: base, exchange_list: getAggFuturesTakerExchanges() }, interval, bars, priority);
    const spot = await fetchCg("spot/aggregated-taker-buy-sell-volume/history", { symbol: base, exchange_list: getAllSpotExchanges() }, interval, bars, priority);
    const oi = await fetchCg("futures/open-interest/aggregated-history", { symbol: base }, interval, bars, priority);

    const reasons: string[] = [];
    const candle = shape(candles.filter((c) => c.time <= at), at);
    if (!candle) reasons.push(`нет свечи BingX ${interval}`);
    for (const [name, r] of [["объём/тейкер фьючерсов", fut], ["тейкер спота", spot], ["OI", oi]] as const) {
      if (r.error) reasons.push(`${name}: ${r.error}`);
    }
    // Write only when the candle and futures flow exist and nothing failed temporarily (retried later).
    const temporary = [fut, spot, oi].some((r) => r.temporary);
    if (!candle || !fut.rows || temporary) {
      failures.set(t.id, { reason: reasons.join("; ") || "неизвестно", at: Date.now(), temporary: temporary || !candle });
      return "failed";
    }
    const metrics = buildExtras({ isIb, isLc, at, candles, fut: fut.rows, spot: spot.rows, oi: oi.rows, reasons, fromScanner: Number.isFinite(fromIdm) });
    await pool.query(
      `INSERT INTO signal_entry_extras (tracked_signal_id, symbol, sentiment_key, metrics)
       VALUES ($1, $2, $3, $4::jsonb) ON CONFLICT (tracked_signal_id) DO UPDATE SET metrics = signal_entry_extras.metrics || EXCLUDED.metrics`,
      [t.id, t.symbol, t.sentimentKey, JSON.stringify(metrics)]);
    failures.delete(t.id);
    return "written";
  } catch (err) {
    failures.set(t.id, { reason: `ошибка: ${err instanceof Error ? err.message.slice(0, 160) : String(err)}`, at: Date.now(), temporary: false });
    logger.warn({ err, symbol: t.symbol }, "entry extras restore failed (non-critical)");
    return "failed";
  } finally {
    inflight.delete(t.id);
  }
}

/** One pass: Impulse Buy and Stealth signals of the last 60 days without extras, last 30 days first. */
/** Last error of a whole pass (e.g. SQL) — shown on «Аналитика» so a stuck pass is visible. */
let lastPassError: string | null = null;
export async function runEntryExtrasBackfillCycle(limit = 40, gapMs = 2_000, priority: "high" | "low" = "low") {
  try {
    const r = await extrasPass(limit, gapMs, priority);
    lastPassError = null;
    return r;
  } catch (err) {
    lastPassError = err instanceof Error ? err.message.slice(0, 200) : String(err);
    throw err;
  }
}
async function extrasPass(limit: number, gapMs: number, priority: "high" | "low") {
  await ensureExtrasTable();
  const cooling = [...failures.entries()]
    .filter(([, f]) => Date.now() - f.at < (f.temporary ? RETRY_TEMP_MS : RETRY_AFTER_MS))
    .map(([id]) => id);
  const { rows } = await pool.query(
    `SELECT t.id, t.symbol, t.sentiment_key, t.detected_at, t.impulse_decision_metrics->>'candleClosedAt' AS ib_candle
     FROM tracked_signals t
     LEFT JOIN signal_entry_extras x ON x.tracked_signal_id = t.id
     WHERE t.sentiment_key = ANY($1::text[]) AND t.detected_at > now() - ($2::int * interval '1 day')
       AND t.detected_at < now() - interval '5 minutes'
       AND (x.tracked_signal_id IS NULL OR NOT (x.metrics ? 'candle')) AND NOT (t.id = ANY($3::int[]))
     ORDER BY t.detected_at > now() - interval '30 days' DESC, t.detected_at DESC
     LIMIT $4`, [[...EXTRAS_KEYS], BACKFILL_DAYS, cooling, limit]);
  let tried = 0, written = 0, failed = 0;
  for (const r of rows) {
    tried++;
    const res = await recordEntryExtras({ id: r.id, symbol: r.symbol, sentimentKey: r.sentiment_key, detectedAt: new Date(r.detected_at), ibCandleClosedAt: r.ib_candle }, priority);
    if (res === "written") written++;
    if (res === "failed") failed++;
    await new Promise((resolve) => setTimeout(resolve, gapMs));
  }
  if (tried) logger.info({ tried, written, failed }, "entry extras restore pass");
  return { tried, written, failed };
}

export async function entryExtrasCoverage() {
  await ensureExtrasTable();
  const { rows } = await pool.query(
    `SELECT t.sentiment_key AS key, count(x.tracked_signal_id) FILTER (WHERE x.metrics ? 'candle')::int AS extras
     FROM tracked_signals t LEFT JOIN signal_entry_extras x ON x.tracked_signal_id = t.id
     WHERE t.sentiment_key = ANY($1::text[]) AND t.detected_at > now() - ($2::int * interval '1 day')
     GROUP BY 1`, [[...EXTRAS_KEYS], BACKFILL_DAYS]);
  const reasons: Record<string, number> = {};
  for (const f of failures.values()) reasons[f.reason] = (reasons[f.reason] ?? 0) + 1;
  if (lastPassError) reasons[`проход целиком упал: ${lastPassError}`] = 1;
  return { byKey: Object.fromEntries(rows.map((r) => [r.key, r.extras])) as Record<string, number>, failedNow: failures.size + (lastPassError ? 1 : 0), reasons };
}

// ── Neon levels at the Stealth breakout (owner 2026-11-05) ─────────────────────────────────────
/**
 * Did the Stealth breakout candle cross a Neon S/R zone (same zones as ABNeon: 4H pivots, 700 bars)?
 * crossed = a zone whose top the candle opened at/below and closed above. Also the nearest zone
 * above the close (overhead resistance). Written into signal_entry_extras.metrics.neonLevel.
 * BingX price only — no CoinGlass.
 */
const H4 = 4 * H1;
export function neonLevelAtBreakout(
  h4: { time: number; open: number; high: number; low: number; close: number }[],
  candle: { open: number; close: number },
) {
  const zones = computeSupportZones(h4.map((k) => ({ ...k, volume: 0 })));
  if (zones.length === 0) return { zones: 0, crossed: null, crossedZone: null, nextAbovePct: null, nextBelowPct: null };
  const crossedZones = zones.filter((z) => z.top >= candle.open && z.top < candle.close).sort((a, b) => b.top - a.top);
  const above = zones.filter((z) => z.bottom > candle.close).sort((a, b) => a.bottom - b.bottom)[0];
  const below = zones.filter((z) => z.top <= candle.close).sort((a, b) => b.top - a.top)[0];
  const r = (v: number) => Math.round(v * 100) / 100;
  return {
    zones: zones.length,
    crossed: crossedZones.length > 0,
    crossedZone: crossedZones[0] ? { bottom: crossedZones[0].bottom, top: crossedZones[0].top, count: crossedZones[0].count } : null,
    /** Distance from the close up to the nearest zone above, % (overhead resistance). */
    nextAbovePct: above ? r(((above.bottom - candle.close) / candle.close) * 100) : null,
    /** Distance from the close down to the nearest zone at/below, % (support under the breakout). */
    nextBelowPct: below ? r(((candle.close - below.top) / candle.close) * 100) : null,
  };
}

const neonFailures = new Map<number, number>();
export async function runNeonLevelBackfillCycle(limit = 25, gapMs = 1_000) {
  await ensureExtrasTable();
  const cooling = [...neonFailures.entries()].filter(([, at]) => Date.now() - at < RETRY_AFTER_MS).map(([id]) => id);
  const { rows } = await pool.query(
    `SELECT x.tracked_signal_id AS id, x.symbol, x.metrics->>'candleTime' AS candle_time,
            (x.metrics->'candle'->>'open')::float8 AS open, (x.metrics->'candle'->>'close')::float8 AS close
       FROM signal_entry_extras x
      WHERE x.sentiment_key = 'stealth_breakout' AND NOT (x.metrics ? 'neonLevel')
        AND x.metrics->'candle'->>'close' IS NOT NULL
        AND NOT (x.tracked_signal_id = ANY($1::int[]))
      ORDER BY x.tracked_signal_id DESC LIMIT $2`, [cooling, limit]);
  let tried = 0, written = 0;
  for (const r of rows) {
    tried++;
    try {
      const at = Date.parse(r.candle_time);
      const closeAt = at + H1;
      const raw = await getKlinesRange(r.symbol, "4h", closeAt - 700 * H4, closeAt).catch(() => []);
      const h4 = raw
        .map((k) => ({ time: Number(k.time), open: Number(k.open), high: Number(k.high), low: Number(k.low), close: Number(k.close) }))
        .filter((k) => k.time + H4 <= closeAt && Number.isFinite(k.close))
        .sort((a, b) => a.time - b.time);
      if (h4.length < 20) { neonFailures.set(r.id, Date.now()); continue; }
      const lvl = neonLevelAtBreakout(h4, { open: Number(r.open), close: Number(r.close) });
      await pool.query(
        `UPDATE signal_entry_extras SET metrics = metrics || jsonb_build_object('neonLevel', $2::jsonb) WHERE tracked_signal_id = $1`,
        [r.id, JSON.stringify({ ...lvl, source: "bingx_4h_neon_zones" })]);
      written++;
    } catch (err) {
      neonFailures.set(r.id, Date.now());
      logger.warn({ err, symbol: r.symbol }, "neon level at breakout failed (non-critical)");
    }
    await new Promise((resolve) => setTimeout(resolve, gapMs));
  }
  if (tried) logger.info({ tried, written }, "neon level at Stealth breakout pass");
  return { tried, written };
}

// ── Inside the range before the breakout (owner 2026-11-05) ────────────────────────────────────
type HBar = { time: number; open: number; high: number; low: number; close: number; volume: number };
/**
 * Pure: how price behaved inside the live range before the breakout candle.
 * bars = closed 1H BingX bars (ascending) up to and including the breakout candle.
 */
export function rangeInsideReading(bars: HBar[], top: number, bottom: number, rangeHours: number, breakoutAt: number) {
  const start = breakoutAt - Math.max(1, Math.round(rangeHours)) * H1;
  const inside = bars.filter((b) => b.time >= start && b.time < breakoutAt);
  if (inside.length < 6 || !(top > bottom)) return { bars: inside.length, reason: "мало свечей внутри диапазона" };
  const h = top - bottom;
  const r2 = (v: number | null) => (v === null || !Number.isFinite(v) ? null : Math.round(v * 100) / 100);
  const third = Math.max(1, Math.floor(inside.length / 3));
  const first = inside.slice(0, third), last = inside.slice(-third);
  const minLow = (a: HBar[]) => Math.min(...a.map((b) => b.low));
  const avg = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
  const last6 = inside.slice(-6);
  const spreadAll = avg(inside.map((b) => b.high - b.low));
  const spread6 = avg(last6.map((b) => b.high - b.low));
  const volFirst = avg(first.map((b) => b.volume)), volLast = avg(last.map((b) => b.volume));
  // Pine deviations of the same range timeframe inside the range window.
  // Deviations need the indicator's deviation window (the live breakout replay turns it off).
  const pine = detectAutoRangePine1h(bars.filter((b) => b.time < breakoutAt).map((b) => ({ ...b, closed: true })));
  const devs = (pine.deviations ?? []).filter((d) => d.breakoutCloseTime > start && d.reentryCloseTime <= breakoutAt);
  const down = devs.filter((d) => d.direction === "down"), up = devs.filter((d) => d.direction === "up");
  const lastDown = down.length ? Math.max(...down.map((d) => d.reentryCloseTime)) : null;
  return {
    bars: inside.length,
    /** 1H highs within 0.5% under the top (or above it) that closed back inside: pressing the top. */
    touchesTop: inside.filter((b) => b.high >= top * 0.995 && b.close <= top).length,
    /** Wicks above the top that closed back inside (false breaks up before the real one). */
    wicksAboveTop: inside.filter((b) => b.high > top && b.close <= top).length,
    /** Wicks below the bottom that closed back inside. */
    wicksBelowBottom: inside.filter((b) => b.low < bottom && b.close >= bottom).length,
    /** Lowest low of the last third vs the first third, % (positive = rising lows). */
    lowsRisePct: r2(((minLow(last) - minLow(first)) / minLow(first)) * 100),
    /** Share of 1H closes in the upper half of the range. */
    upperHalfShare: r2(inside.filter((b) => b.close >= bottom + h / 2).length / inside.length),
    /** Average position of the last 6 closes in the range (0 = bottom, 1 = top). */
    last6hPosition: r2(avg(last6.map((b) => (b.close - bottom) / h))),
    /** Bar range of the last 6 hours vs the whole range (< 1 = compression before the break). */
    compression6h: spreadAll ? r2(spread6! / spreadAll) : null,
    /** BingX volume of the last third vs the first third (< 1 = volume drying up). */
    volumeLastVsFirst: volFirst ? r2(volLast! / volFirst) : null,
    /** Indicator deviations (Pine Auto Range, 1H): closed outside and re-entered, inside the window. */
    deviationsDown: down.length,
    deviationsUp: up.length,
    maxDeviationDownPct: down.length ? r2(Math.max(...down.map((d) => d.extremePct))) : null,
    maxDeviationUpPct: up.length ? r2(Math.max(...up.map((d) => d.extremePct))) : null,
    hoursSinceDeviationDown: lastDown === null ? null : r2((breakoutAt - lastDown) / H1),
  };
}

const insideFailures = new Map<number, number>();
export async function runRangeInsideBackfillCycle(limit = 25, gapMs = 1_000) {
  await ensureExtrasTable();
  const cooling = [...insideFailures.entries()].filter(([, at]) => Date.now() - at < RETRY_AFTER_MS).map(([id]) => id);
  const { rows } = await pool.query(
    `SELECT x.tracked_signal_id AS id, x.symbol, t.decision_metrics->'stealthRange4h' AS rng
       FROM signal_entry_extras x JOIN tracked_signals t ON t.id = x.tracked_signal_id
      WHERE x.sentiment_key = 'stealth_breakout' AND t.stealth_detection_method = 'range_1h_breakout'
        AND COALESCE((x.metrics->'rangeInside'->>'version')::int, 1) < 2
        AND NOT (x.tracked_signal_id = ANY($1::int[]))
      ORDER BY x.tracked_signal_id DESC LIMIT $2`, [cooling, limit]);
  let tried = 0, written = 0;
  for (const r of rows) {
    tried++;
    try {
      const top = Number(r.rng?.rangeTop), bottom = Number(r.rng?.rangeBottom), hours = Number(r.rng?.rangeHours);
      const at = Date.parse(r.rng?.candleOpenAt ?? "");
      if (!(top > 0 && bottom > 0 && hours > 0 && Number.isFinite(at))) { insideFailures.set(r.id, Date.now()); continue; }
      const raw = await getKlinesRange(r.symbol, "1h", at - (hours + 320) * H1, at + H1).catch(() => []);
      const bars = raw
        .map((k) => ({ time: Number(k.time), open: Number(k.open), high: Number(k.high), low: Number(k.low), close: Number(k.close), volume: Number(k.volume) }))
        .filter((k) => k.time <= at && Number.isFinite(k.close))
        .sort((a, b) => a.time - b.time);
      const reading = rangeInsideReading(bars, top, bottom, hours, at);
      await pool.query(
        `UPDATE signal_entry_extras SET metrics = metrics || jsonb_build_object('rangeInside', $2::jsonb) WHERE tracked_signal_id = $1`,
        [r.id, JSON.stringify({ ...reading, version: 2, rangeTop: top, rangeBottom: bottom, rangeHours: hours, source: "bingx_1h_live_range" })]);
      written++;
    } catch (err) {
      insideFailures.set(r.id, Date.now());
      logger.warn({ err, symbol: r.symbol }, "range inside reading failed (non-critical)");
    }
    await new Promise((resolve) => setTimeout(resolve, gapMs));
  }
  if (tried) logger.info({ tried, written }, "range inside before Stealth breakout pass");
  return { tried, written };
}
