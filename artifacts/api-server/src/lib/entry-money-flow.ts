/**
 * MFI and Chaikin at the entry of every ABNeon, Stealth and Liquidation Cascade signal (owner 2026-11-09):
 * observation only — no decision reads them; to be reviewed later. Impulse Buy is settled and not tracked.
 *
 * Same readings as scripts/mfi-cmf-study.ts, on BingX 1H and 4H candles with AGGREGATED CoinGlass volume
 * (owner rule: aggregated only) of futures (aggfut) and of spot (aggspot), the last CLOSED bar before the signal:
 *   mfi14, cmf20, cho (Chaikin oscillator / 20-bar average volume), cmf_long (1H: 72 bars = 3 days; 4H: 42 = 7 days),
 *   mfi_slope12 / cmf_slope12, mfi|cmf _bull_div / _bear_div (last 12 bars vs the 36 before).
 * A reading that has a missing volume bar in its window is null (never BingX volume).
 * Stored in signal_entry_extras.metrics.moneyFlow; a background pass fills the signals of the last 20 days.
 */
import { pool } from "@workspace/db";
import { getKlinesRange } from "./bingx.js";
import { getAggFuturesVolumeByInterval } from "./coinglass_taker.js";
import { getAllSpotExchanges } from "./coinglass-exchanges.js";
import { getNextCgKey, logCg429 } from "./coinglass_keys.js";
import { cgTimedFetch } from "./cg_latency.js";
import { applyCgAlias } from "./cg-symbol-alias.js";
import { ensureExtrasTable } from "./entry-extras.js";
import { logger } from "./logger.js";

export const MONEY_FLOW_KEYS = ["stealth_breakout", "neon_support_bounce", "liquidation_cascade"] as const;
export const MONEY_FLOW_VERSION = 1;
const H1 = 3_600_000, H4 = 4 * H1;
const BACKFILL_DAYS = 20;
const RETRY_MS = 3 * H1;

type Bar = { time: number; open: number; high: number; low: number; close: number; volume: number };

// ─── indicators (the same formulas as the study) ─────────────────────────────
const tp = (c: Bar) => (c.high + c.low + c.close) / 3;
const clv = (c: Bar) => (c.high > c.low ? (c.close - c.low - (c.high - c.close)) / (c.high - c.low) : 0);
function mfiAt(cs: Bar[], i: number, n = 14): number | null {
  if (i < n) return null;
  let pos = 0, neg = 0;
  for (let k = i - n + 1; k <= i; k++) {
    const v = cs[k]!.volume;
    if (!Number.isFinite(v)) return null;
    const a = tp(cs[k]!), b = tp(cs[k - 1]!);
    if (a > b) pos += a * v; else if (a < b) neg += a * v;
  }
  return neg === 0 ? 100 : 100 - 100 / (1 + pos / neg);
}
function cmfAt(cs: Bar[], i: number, n: number): number | null {
  if (i < n - 1) return null;
  let s = 0, v = 0;
  for (let k = i - n + 1; k <= i; k++) {
    const x = cs[k]!.volume;
    if (!Number.isFinite(x)) return null;
    s += clv(cs[k]!) * x; v += x;
  }
  return v > 0 ? s / v : null;
}
function choAt(cs: Bar[], i: number): number | null {
  const from = Math.max(1, i - 150);
  if (i - from < 60) return null;
  let ad = 0, e3: number | null = null, e10: number | null = null;
  for (let k = from; k <= i; k++) {
    const x = cs[k]!.volume;
    if (!Number.isFinite(x)) return null;
    ad += clv(cs[k]!) * x;
    e3 = e3 === null ? ad : e3 + (2 / 4) * (ad - e3);
    e10 = e10 === null ? ad : e10 + (2 / 11) * (ad - e10);
  }
  let v = 0;
  for (let k = i - 19; k <= i; k++) v += cs[k]!.volume;
  return v > 0 && e3 !== null && e10 !== null ? (e3 - e10) / (v / 20) : null;
}
export function moneyFlowReadings(cs: Bar[], i: number, longN: number): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  const mfi = (k: number) => mfiAt(cs, k), cmf = (k: number) => cmfAt(cs, k, 20);
  out.mfi14 = mfi(i);
  out.cmf20 = cmf(i);
  out.cho = choAt(cs, i);
  out.cmf_long = cmfAt(cs, i, longN);
  const m12 = mfi(i - 12), c12 = cmf(i - 12);
  out.mfi_slope12 = out.mfi14 != null && m12 != null ? out.mfi14 - m12 : null;
  out.cmf_slope12 = out.cmf20 != null && c12 != null ? out.cmf20 - c12 : null;
  for (const k of ["mfi_bull_div", "mfi_bear_div", "cmf_bull_div", "cmf_bear_div"]) out[k] = null;
  if (i >= 60) {
    const rng = (a: number, b: number, f: (k: number) => number | null, pick: "min" | "max") => {
      let r: number | null = null;
      for (let k = a; k <= b; k++) { const x = f(k); if (x === null) return null; r = r === null ? x : pick === "min" ? Math.min(r, x) : Math.max(r, x); }
      return r;
    };
    const lowR = rng(i - 11, i, (k) => cs[k]!.low, "min")!, lowP = rng(i - 47, i - 12, (k) => cs[k]!.low, "min")!;
    const hiR = rng(i - 11, i, (k) => cs[k]!.high, "max")!, hiP = rng(i - 47, i - 12, (k) => cs[k]!.high, "max")!;
    for (const [name, f] of [["mfi", mfi], ["cmf", cmf]] as const) {
      const minR = rng(i - 11, i, f, "min"), minP = rng(i - 47, i - 12, f, "min");
      const maxR = rng(i - 11, i, f, "max"), maxP = rng(i - 47, i - 12, f, "max");
      out[`${name}_bull_div`] = minR === null || minP === null ? null : lowR < lowP && minR > minP ? 1 : 0;
      out[`${name}_bear_div`] = maxR === null || maxP === null ? null : hiR > hiP && maxR < maxP ? 1 : 0;
    }
  }
  return out;
}

// ─── data ────────────────────────────────────────────────────────────────────
/** Aggregated spot taker volume (USD) per 1H bar, the last `limit` bars (≤ 4500). */
async function aggSpotVolume1h(symbol: string, limit: number): Promise<Map<number, number> | null> {
  const apiKey = getNextCgKey();
  if (!apiKey) return null;
  const base = applyCgAlias(symbol.replace(/-?USDT$/i, "").toUpperCase());
  const url = new URL("https://open-api-v4.coinglass.com/api/spot/aggregated-taker-buy-sell-volume/history");
  url.searchParams.set("symbol", base);
  url.searchParams.set("exchange_list", getAllSpotExchanges());
  url.searchParams.set("interval", "1h");
  url.searchParams.set("limit", String(Math.min(4500, limit)));
  try {
    const res = await cgTimedFetch(url.toString(), { headers: { "CG-API-KEY": apiKey, Accept: "application/json" }, signal: AbortSignal.timeout(20_000) }, { priority: "low" });
    if (res.status === 429) { logCg429(apiKey, { symbol: base }); return null; }
    if (!res.ok) return null;
    const data = (await res.json()) as { code: string; data?: { time: number; aggregated_buy_volume_usd: number | string; aggregated_sell_volume_usd: number | string }[] };
    if (data.code !== "0" || !data.data?.length) return null;
    const m = new Map<number, number>();
    for (const r of data.data) {
      const t = r.time < 1e12 ? r.time * 1000 : r.time;
      const v = Number(r.aggregated_buy_volume_usd) + Number(r.aggregated_sell_volume_usd);
      if (Number.isFinite(v)) m.set(t, v);
    }
    return m;
  } catch {
    return null;
  }
}
const toBars = (raw: { time: number | string; open: string | number; high: string | number; low: string | number; close: string | number }[]): Bar[] =>
  raw
    .map((k) => ({ time: Number(k.time), open: Number(k.open), high: Number(k.high), low: Number(k.low), close: Number(k.close), volume: NaN }))
    .filter((k) => Number.isFinite(k.close) && k.close > 0)
    .sort((a, b) => a.time - b.time);
/** Bars with the aggregated USD volume / close (NaN where any 1H part is missing). */
function withVol(bars: Bar[], usd1h: Map<number, number> | null, step: number): Bar[] {
  return bars.map((b) => {
    if (!usd1h) return { ...b, volume: NaN };
    let s = 0;
    for (let t = b.time; t < b.time + step; t += H1) { const v = usd1h.get(t); if (v === undefined) return { ...b, volume: NaN }; s += v; }
    return { ...b, volume: s / b.close };
  });
}

export async function computeMoneyFlow(symbol: string, detectedAt: number): Promise<Record<string, unknown>> {
  const e1 = Math.floor(detectedAt / H1) * H1 - H1; // last closed 1H bar
  const e4 = Math.floor(detectedAt / H4) * H4 - H4; // last closed 4H bar
  const raw1 = await getKlinesRange(symbol, "1h", e1 - 170 * H1, e1 + H1).catch(() => []);
  const raw4 = await getKlinesRange(symbol, "4h", e4 - 170 * H4, e4 + H4).catch(() => []);
  const b1 = toBars(raw1).filter((b) => b.time <= e1), b4 = toBars(raw4).filter((b) => b.time <= e4);
  const need = Math.ceil((Date.now() - (e4 - 170 * H4)) / H1) + 4;
  const fut = need <= 4500 ? await getAggFuturesVolumeByInterval(symbol, "1h", need, Date.now(), "low", 60_000).catch(() => null) : null;
  const spot = need <= 4500 ? await aggSpotVolume1h(symbol, need) : null;
  const out: Record<string, unknown> = { version: MONEY_FLOW_VERSION, source: "bingx_ohlc+coinglass_aggregated_volume", futVolume: fut ? "ok" : "missing", spotVolume: spot ? "ok" : "missing" };
  for (const [name, vol] of [["aggfut", fut], ["aggspot", spot]] as const) {
    for (const [tf, bars, step, e, longN] of [["1h", b1, H1, e1, 72], ["4h", b4, H4, e4, 42]] as const) {
      const cs = withVol(bars, vol, step);
      const i = cs.findIndex((b) => b.time === e);
      out[`${name}_${tf}`] = i < 0 ? { reason: "нет свечи входа" } : vol ? moneyFlowReadings(cs, i, longN) : { reason: "нет агрегированного объёма" };
    }
  }
  return out;
}

const failures = new Map<number, number>();

export async function runMoneyFlowBackfillCycle(limit = 20, gapMs = 1_500) {
  await ensureExtrasTable();
  const cooling = [...failures.entries()].filter(([, at]) => Date.now() - at < RETRY_MS).map(([id]) => id);
  const { rows } = await pool.query(
    `SELECT t.id, t.symbol, t.sentiment_key, t.detected_at
       FROM tracked_signals t
       LEFT JOIN signal_entry_extras x ON x.tracked_signal_id = t.id
      WHERE t.sentiment_key = ANY($1::text[]) AND t.detected_at > now() - ($2::int * interval '1 day')
        AND t.detected_at < now() - interval '2 minutes'
        AND (x.tracked_signal_id IS NULL OR COALESCE((x.metrics->'moneyFlow'->>'version')::int, 0) < $3
             OR x.metrics->'moneyFlow'->>'futVolume' = 'missing')
        AND NOT (t.id = ANY($4::int[]))
      ORDER BY t.detected_at DESC LIMIT $5`,
    [[...MONEY_FLOW_KEYS], BACKFILL_DAYS, MONEY_FLOW_VERSION, cooling, limit]);
  let tried = 0, written = 0;
  for (const r of rows) {
    tried++;
    try {
      const mf = await computeMoneyFlow(r.symbol, new Date(r.detected_at).getTime());
      await pool.query(
        `INSERT INTO signal_entry_extras (tracked_signal_id, symbol, sentiment_key, metrics)
         VALUES ($1, $2, $3, jsonb_build_object('moneyFlow', $4::jsonb))
         ON CONFLICT (tracked_signal_id) DO UPDATE SET metrics = signal_entry_extras.metrics || jsonb_build_object('moneyFlow', $4::jsonb)`,
        [r.id, r.symbol, r.sentiment_key, JSON.stringify(mf)]);
      written++;
      if (mf.futVolume === "missing") failures.set(r.id, Date.now());
    } catch (err) {
      failures.set(r.id, Date.now());
      logger.warn({ err, symbol: r.symbol }, "money-flow reading failed (non-critical)");
    }
    await new Promise((resolve) => setTimeout(resolve, gapMs));
  }
  if (tried) logger.info({ tried, written }, "MFI / Chaikin at entry pass");
  return { tried, written };
}
