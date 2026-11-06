/**
 * Shared code of the v2 pattern studies (owner 2026-11-06): ABNeon and the new Stealth, one run each, with
 * everything agreed — what happened BEFORE the touch / breakout, the candle itself, the candles AFTER it
 * up to the entry (filters), after the entry (for stop / B.U. rules, not filters), entry variants, a grid
 * of stops and exits, the market at the moment (breadth, BTC/ETH, signals across coins), the result
 * against the market, the level's own history and confluence, funding, Binance takers (if reachable),
 * and a check against CAB's live signals.
 *
 * Data: BingX public klines (4h / 1h / 15m) and funding; Binance futures 1h klines for taker buy volume
 * (Replit may be geo-blocked — then those columns stay empty and summary.txt says so). Candles are cached
 * on disk (reports/.cache, not in git): a second run only loads the missing tail.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { computeWyckoff } from "../../src/lib/wyckoff-metrics.js";
import { ictReading } from "../../src/lib/ict.js";

export type C = { time: number; open: number; high: number; low: number; close: number; volume: number };
export type Row = Record<string, string | number | boolean | null>;

export const M15 = 900_000;
export const H1 = 3_600_000;
export const H4 = 4 * H1;
export const D1 = 24 * H1;
export const D7 = 7 * D1;
export const FEE = 0.1;

export function parseArgs(): Map<string, string> {
  const args = new Map<string, string>();
  for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i]!.replace(/^--/, ""), process.argv[i + 1] ?? "");
  return args;
}
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ─── Data with a disk cache ───────────────────────────────────────────────────

const BINGX = "https://open-api.bingx.com";
export const OFFLINE = process.env.STUDY_OFFLINE === "1"; // cache only (local check of the code)

async function bingx(path: string): Promise<any> {
  let last: unknown = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const res = await fetch(BINGX + path);
      const json = (await res.json()) as any;
      if (json.code === 0) return json.data;
      last = new Error(`code ${json.code} ${json.msg}`);
      if (json.code === 109415 || json.code === 109400) break; // paused / unknown symbol: no retry
    } catch (err) {
      last = err;
    }
    await sleep(800 * (attempt + 1));
  }
  throw last;
}

type Cached<T> = { from: number; to: number; items: T[] };
function readCache<T>(file: string): Cached<T> | null {
  try {
    return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Cached<T>) : null;
  } catch {
    return null;
  }
}
function writeCache<T>(file: string, c: Cached<T>) {
  writeFileSync(file, JSON.stringify(c));
}

const STEP = { "15m": M15, "1h": H1, "4h": H4 } as const;
export type Interval = keyof typeof STEP;

async function fetchKlines(symbol: string, interval: Interval, start: number, end: number): Promise<C[]> {
  const step = STEP[interval];
  const rows = new Map<number, C>();
  let cursor = start;
  while (cursor < end) {
    const pageEnd = Math.min(end, cursor + step * 1000);
    const data = (await bingx(
      `/openApi/swap/v3/quote/klines?symbol=${symbol}&interval=${interval}&startTime=${cursor}&endTime=${pageEnd}&limit=1000`,
    )) as Array<Record<string, string | number>>;
    for (const k of data ?? []) {
      const time = Number(k.time);
      rows.set(time, { time, open: Number(k.open), high: Number(k.high), low: Number(k.low), close: Number(k.close), volume: Number(k.volume) });
    }
    cursor = pageEnd;
    await sleep(60);
  }
  return [...rows.values()].filter((c) => c.close > 0).sort((a, b) => a.time - b.time);
}

// Candles are cached as [time, open, high, low, close, volume] arrays (half the size of objects).
type CRow = [number, number, number, number, number, number];
function readCandles(file: string): Cached<C> | null {
  const c = readCache<C | CRow>(file);
  if (!c) return null;
  return { from: c.from, to: c.to, items: c.items.map((x) => (Array.isArray(x) ? { time: x[0], open: x[1], high: x[2], low: x[3], close: x[4], volume: x[5] } : x)) };
}
function writeCandles(file: string, c: Cached<C>) {
  writeCache<CRow>(file, { from: c.from, to: c.to, items: c.items.map((x) => [x.time, x.open, x.high, x.low, x.close, x.volume]) });
}

/** Closed candles from `start` to `now`; the cache is extended with only the missing tail. */
export async function klines(cacheDir: string, symbol: string, interval: Interval, start: number, now: number): Promise<C[]> {
  const step = STEP[interval];
  const file = join(cacheDir, `${symbol}_${interval}.json`);
  const cached = readCandles(file);
  let items: C[];
  if (cached && cached.from <= start) {
    const tailFrom = Math.max(cached.from, (cached.items.at(-1)?.time ?? cached.from) - step);
    const fresh = OFFLINE || tailFrom + step >= now ? [] : await fetchKlines(symbol, interval, tailFrom, now);
    const m = new Map(cached.items.map((c) => [c.time, c]));
    for (const c of fresh) m.set(c.time, c);
    items = [...m.values()].sort((a, b) => a.time - b.time);
    if (fresh.length) writeCandles(file, { from: cached.from, to: now, items });
  } else {
    if (OFFLINE) throw new Error("not_in_cache");
    items = await fetchKlines(symbol, interval, start, now);
    writeCandles(file, { from: start, to: now, items });
  }
  // Only closed candles, only the asked range.
  return items.filter((c) => c.time >= start && c.time + step <= now);
}

export type Funding = { time: number; rate: number };
/** BingX funding history (public). Errors → empty (column stays empty). */
export async function funding(cacheDir: string, symbol: string, start: number, now: number): Promise<Funding[]> {
  const file = join(cacheDir, `${symbol}_funding.json`);
  const cached = readCache<Funding>(file);
  if (cached && cached.from <= start && (OFFLINE || now - cached.to < 8 * H1)) return cached.items;
  if (OFFLINE) return cached?.items ?? [];
  const out = new Map<number, Funding>();
  let cursor = start;
  try {
    for (let guard = 0; guard < 20 && cursor < now; guard++) {
      const data = (await bingx(`/openApi/swap/v2/quote/fundingRate?symbol=${symbol}&startTime=${cursor}&endTime=${now}&limit=1000`)) as Array<Record<string, string | number>>;
      if (!data?.length) break;
      for (const f of data) out.set(Number(f.fundingTime), { time: Number(f.fundingTime), rate: Number(f.fundingRate) * 100 });
      const maxT = Math.max(...data.map((f) => Number(f.fundingTime)));
      if (maxT <= cursor || data.length < 1000) break;
      cursor = maxT + 1;
      await sleep(60);
    }
  } catch {
    return [];
  }
  const items = [...out.values()].sort((a, b) => a.time - b.time);
  writeCache(file, { from: start, to: now, items });
  return items;
}

// Binance futures 1h klines: quote volume and taker buy quote volume (the "takers" CAB gates on, one venue).
export type Taker = { time: number; quote: number; buyQuote: number };
let binanceState: "unknown" | "ok" | "blocked" = "unknown";
export let binanceNote = "не проверялось";
const FAPI = "https://fapi.binance.com";
export async function binanceProbe(): Promise<boolean> {
  if (OFFLINE) {
    binanceState = "blocked";
    binanceNote = "офлайн-прогон";
    return false;
  }
  try {
    const res = await fetch(`${FAPI}/fapi/v1/klines?symbol=ETHUSDT&interval=1h&limit=2`);
    if (res.ok) {
      binanceState = "ok";
      binanceNote = "Binance доступен";
      return true;
    }
    binanceState = "blocked";
    binanceNote = `Binance ответил ${res.status} — тейкеры не записаны`;
  } catch (e) {
    binanceState = "blocked";
    binanceNote = `Binance недоступен (${String(e).slice(0, 80)}) — тейкеры не записаны`;
  }
  return false;
}
export async function takers(cacheDir: string, symbol: string, start: number, now: number): Promise<Map<number, Taker> | null> {
  const file = join(cacheDir, `${symbol}_binance1h.json`);
  const cached = readCache<Taker>(file);
  if (cached && cached.from <= start && (OFFLINE || binanceState !== "ok" || now - cached.to < 2 * H1)) return new Map(cached.items.map((t) => [t.time, t]));
  if (binanceState !== "ok") return null;
  const bsym = symbol.replace("-USDT", "USDT");
  const out = new Map<number, Taker>();
  let cursor = start;
  try {
    while (cursor < now) {
      const res = await fetch(`${FAPI}/fapi/v1/klines?symbol=${bsym}&interval=1h&startTime=${cursor}&endTime=${now}&limit=1000`);
      if (res.status === 400) return null; // not listed on Binance futures
      if (res.status === 429 || res.status === 418) {
        await sleep(30_000);
        continue;
      }
      if (!res.ok) return null;
      const data = (await res.json()) as Array<Array<string | number>>;
      if (!data.length) break;
      for (const k of data) out.set(Number(k[0]), { time: Number(k[0]), quote: Number(k[7]), buyQuote: Number(k[10]) });
      const maxT = Number(data.at(-1)![0]);
      if (maxT <= cursor || data.length < 1000) break;
      cursor = maxT + H1;
      await sleep(250);
    }
  } catch {
    return null;
  }
  const items = [...out.values()].sort((a, b) => a.time - b.time);
  writeCache(file, { from: start, to: now, items });
  return new Map(items.map((t) => [t.time, t]));
}

export async function usdtSymbols(cacheDir: string): Promise<string[]> {
  const file = join(cacheDir, `_contracts.json`);
  let list: string[];
  if (OFFLINE) list = JSON.parse(readFileSync(file, "utf8"));
  else {
    const contracts = (await bingx("/openApi/swap/v2/quote/contracts")) as Array<{ symbol: string }>;
    list = contracts.map((c) => c.symbol).filter((s) => s.endsWith("-USDT") && !s.startsWith("BTC-") && !/^NC(SK|CO|SI|FX)/.test(s));
    writeFileSync(file, JSON.stringify(list));
  }
  return list;
}
export function ensureDir(d: string) {
  mkdirSync(d, { recursive: true });
}

// ─── Math ─────────────────────────────────────────────────────────────────────

export const pct = (a: number | null | undefined, b: number | null | undefined): number | null =>
  a != null && b != null && b > 0 && Number.isFinite(a) && Number.isFinite(b) ? (a / b - 1) * 100 : null;
export function emaSeries(values: number[], n: number): (number | null)[] {
  const out: (number | null)[] = [];
  const k = 2 / (n + 1);
  let e: number | null = null;
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    if (i < n - 1) { sum += values[i]!; out.push(null); continue; }
    if (i === n - 1) { sum += values[i]!; e = sum / n; out.push(e); continue; }
    e = values[i]! * k + e! * (1 - k);
    out.push(e);
  }
  return out;
}
/** Wilder ATR in % of close, for every bar. */
export function atrPctSeries(cs: C[], n = 14): (number | null)[] {
  const out: (number | null)[] = [];
  let atr: number | null = null;
  let sum = 0;
  for (let i = 0; i < cs.length; i++) {
    const c = cs[i]!;
    const tr = i === 0 ? c.high - c.low : Math.max(c.high - c.low, Math.abs(c.high - cs[i - 1]!.close), Math.abs(c.low - cs[i - 1]!.close));
    if (i < n) { sum += tr; out.push(null); if (i === n - 1) atr = sum / n; continue; }
    atr = (atr! * (n - 1) + tr) / n;
    out.push(c.close > 0 ? (atr / c.close) * 100 : null);
  }
  return out;
}
/** Index of the last bar with time ≤ t (−1 if none). Series sorted by time. */
export function idxAtOrBefore(cs: { time: number }[], t: number): number {
  let lo = 0, hi = cs.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cs[mid]!.time <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}
/** Index of the last CLOSED bar at time t (bar.time + step ≤ t). */
export const lastClosed = (cs: { time: number }[], t: number, step: number) => idxAtOrBefore(cs, t - step);
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
function slopePctPerBar(ys: number[]): number | null {
  const n = ys.length;
  const m = mean(ys);
  if (n < 3 || !m) return null;
  const xm = (n - 1) / 2;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) { num += (i - xm) * (ys[i]! - m); den += (i - xm) ** 2; }
  return den ? (num / den / m) * 100 : null;
}

// ─── Candle readings (VSA, Welkin, anatomy) ──────────────────────────────────

/** Owner's «VSA Wyckoff Volume»: Wilder MA(20) seeded with 0, the bar inside its own MA. */
export function vsaSeries(cs: C[]): { ratio: (number | null)[]; color: (string | null)[] } {
  const ratio: (number | null)[] = [], color: (string | null)[] = [];
  let ma = 0;
  for (let i = 0; i < cs.length; i++) {
    const v = cs[i]!.volume;
    ma = ma + (v - ma) / 20;
    if (!(ma > 0) || i < 60) { ratio.push(null); color.push(null); continue; }
    const r = v / ma;
    ratio.push(r);
    color.push(r >= 2.2 ? "P" : r >= 1.8 ? "R" : r >= 1.2 ? "O" : r >= 0.8 ? "G" : r >= 0.4 ? "B" : "S");
  }
  return { ratio, color };
}
/** Owner's «Welkin VSA»: SMA(20) ± σ including the bar. */
export function welkin(cs: C[], i: number): string | null {
  if (i < 19) return null;
  let s = 0;
  for (let k = i - 19; k <= i; k++) s += cs[k]!.volume;
  const avg = s / 20;
  let q = 0;
  for (let k = i - 19; k <= i; k++) q += (cs[k]!.volume - avg) ** 2;
  const sd = Math.sqrt(q / 20);
  const v = cs[i]!.volume;
  if (v > avg + 4 * sd) return "W";
  if (v > avg + 3 * sd) return "M";
  if (v > avg + 2 * sd) return "O";
  if (v > avg) return "A";
  const prev = i > 0 ? cs[i - 1]!.volume : 0;
  if (prev > 0 && v / prev >= 1.25) return "Y";
  if (v < avg) return "N";
  return "=";
}

/** Per-series precomputation (one per coin and timeframe). */
export type Series = { cs: C[]; vsa: ReturnType<typeof vsaSeries>; atr: (number | null)[]; volAvg20: (number | null)[]; sprAvg20: (number | null)[] };
export function series(cs: C[]): Series {
  const volAvg20: (number | null)[] = [], sprAvg20: (number | null)[] = [];
  let vs = 0, ss = 0;
  for (let i = 0; i < cs.length; i++) {
    // average of the 20 bars BEFORE i
    volAvg20.push(i >= 20 ? vs / 20 : null);
    sprAvg20.push(i >= 20 ? ss / 20 : null);
    vs += cs[i]!.volume; ss += cs[i]!.high - cs[i]!.low;
    if (i >= 20) { vs -= cs[i - 20]!.volume; ss -= cs[i - 20]!.high - cs[i - 20]!.low; }
  }
  return { cs, vsa: vsaSeries(cs), atr: atrPctSeries(cs), volAvg20, sprAvg20 };
}
const volRatio = (s: Series, i: number) => { const a = s.volAvg20[i]; return a && a > 0 ? s.cs[i]!.volume / a : null; };
const sprRatio = (s: Series, i: number) => { const a = s.sprAvg20[i]; return a && a > 0 ? (s.cs[i]!.high - s.cs[i]!.low) / a : null; };
const closePos = (b: C) => (b.high > b.low ? (b.close - b.low) / (b.high - b.low) : null);
const isDown = (b: C) => b.close < b.open;

/** One candle: anatomy, volume vs the 20 before, VSA colour, Welkin. */
export function anatomy(prefix: string, s: Series | null, i: number): Row {
  if (!s || i < 0 || i >= s.cs.length) return {};
  const b = s.cs[i]!;
  const range = b.high - b.low;
  return {
    [`${prefix}_body_pct`]: pct(b.close, b.open),
    [`${prefix}_range_pct`]: b.open > 0 ? (range / b.open) * 100 : null,
    [`${prefix}_close_pos`]: closePos(b),
    [`${prefix}_lower_wick_share`]: range > 0 ? (Math.min(b.open, b.close) - b.low) / range : null,
    [`${prefix}_upper_wick_share`]: range > 0 ? (b.high - Math.max(b.open, b.close)) / range : null,
    [`${prefix}_vol_ratio20`]: volRatio(s, i),
    [`${prefix}_spread_ratio20`]: sprRatio(s, i),
    [`${prefix}_vsa_ratio`]: s.vsa.ratio[i] ?? null,
    [`${prefix}_vsa_color`]: s.vsa.color[i] ?? null,
    [`${prefix}_welkin`]: welkin(s.cs, i),
  };
}

/**
 * The run INTO a level on 1H: bars [i0 − n, i0) where i0 = the touch bar. Fall / rise speed, red streak,
 * volume trend, VSA events (stopping volume, climax, effort without result, no supply), compression.
 */
export function approach(prefix: string, s: Series, i0: number, dir: "down" | "up"): Row {
  if (i0 < 50) return {};
  const cs = s.cs;
  const at = (h: number) => (i0 - h >= 0 ? cs[i0 - h]!.close : null);
  const ref = cs[i0]!.open; // price as the touch bar opened
  let streak = 0;
  for (let k = i0 - 1; k >= 0 && (dir === "down" ? isDown(cs[k]!) : cs[k]!.close > cs[k]!.open); k--) streak++;
  const last12 = [...Array(12).keys()].map((k) => i0 - 12 + k);
  const vols12 = last12.map((k) => cs[k]!.volume);
  const colored12 = last12.filter((k) => ["O", "R", "P"].includes(s.vsa.color[k] ?? "")).length;
  const grey12 = last12.filter((k) => welkin(cs, k) === "N").length;
  // Stopping volume (down move): a down bar, VSA ≥ 1.8, closing in its upper half — within 24 bars before.
  // For an up move (breakout) the mirror: an up bar, VSA ≥ 1.8, closing in its lower half (supply coming in).
  let stopAgo: number | null = null, stopRatio: number | null = null;
  for (let k = i0 - 1; k >= i0 - 24; k--) {
    const b = cs[k]!, r = s.vsa.ratio[k] ?? 0, cp = closePos(b) ?? 0.5;
    const hit = dir === "down" ? isDown(b) && r >= 1.8 && cp >= 0.5 : !isDown(b) && r >= 1.8 && cp <= 0.5;
    if (hit) { stopAgo = i0 - k; stopRatio = r; break; }
  }
  // Climax: the largest-volume bar of the 48 before.
  let cx = -1;
  for (let k = i0 - 48; k < i0; k++) if (cx < 0 || cs[k]!.volume > cs[cx]!.volume) cx = k;
  const cxb = cs[cx]!;
  const effortNoResult = last12.filter((k) => (volRatio(s, k) ?? 0) >= 1.5 && (sprRatio(s, k) ?? 9) <= 0.7).length;
  const noSupply = last12.filter((k) => (dir === "down" ? isDown(cs[k]!) : !isDown(cs[k]!)) && (sprRatio(s, k) ?? 9) <= 0.7 && (volRatio(s, k) ?? 9) <= 0.8).length;
  const atrSum = (from: number, to: number) => {
    const xs: number[] = [];
    for (let k = from; k < to; k++) { const c = cs[k]!, p = cs[k - 1]!; xs.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close))); }
    return mean(xs);
  };
  const a24 = atrSum(i0 - 24, i0), a168 = i0 > 170 ? atrSum(i0 - 168, i0) : null;
  // The impulse before: biggest rise (fall) inside the last 7 days before the touch.
  const w = cs.slice(Math.max(0, i0 - 168), i0);
  let hiK = 0;
  for (let k = 1; k < w.length; k++) if (w[k]!.high > w[hiK]!.high) hiK = k;
  const minBeforeHi = Math.min(...w.slice(0, hiK + 1).map((c) => c.low));
  return {
    [`${prefix}_move_4h_pct`]: pct(ref, at(4)),
    [`${prefix}_move_12h_pct`]: pct(ref, at(12)),
    [`${prefix}_move_24h_pct`]: pct(ref, at(24)),
    [`${prefix}_move_72h_pct`]: pct(ref, at(72)),
    [`${prefix}_streak_bars`]: streak,
    [`${prefix}_vol_slope12_pct_per_bar`]: slopePctPerBar(vols12),
    [`${prefix}_vol12_vs_prev36`]: (() => { const a = mean(vols12), b = mean(cs.slice(i0 - 48, i0 - 12).map((c) => c.volume)); return a != null && b ? a / b : null; })(),
    [`${prefix}_colored12`]: colored12,
    [`${prefix}_grey12`]: grey12,
    [`${prefix}_stopping_vol_bars_ago`]: stopAgo,
    [`${prefix}_stopping_vol_ratio`]: stopRatio,
    [`${prefix}_climax48_bars_ago`]: i0 - cx,
    [`${prefix}_climax48_ratio`]: s.vsa.ratio[cx] ?? null,
    [`${prefix}_climax48_down`]: isDown(cxb) ? 1 : 0,
    [`${prefix}_climax48_close_pos`]: closePos(cxb),
    [`${prefix}_effort_no_result12`]: effortNoResult,
    [`${prefix}_no_supply12`]: noSupply,
    [`${prefix}_atr24_vs_atr168`]: a24 != null && a168 ? a24 / a168 : null,
    [`${prefix}_impulse_7d_pct`]: pct(w[hiK]!.high, minBeforeHi),
    [`${prefix}_impulse_peak_hours_ago`]: w.length - hiK,
  };
}

/** Takers (Binance 1h) over bars [from, to] by time: buy share and delta share. */
export function takerShare(tk: Map<number, Taker> | null, fromTime: number, toTime: number): { buy: number | null; delta: number | null } {
  if (!tk) return { buy: null, delta: null };
  let q = 0, b = 0, n = 0;
  for (let t = fromTime; t <= toTime; t += H1) {
    const x = tk.get(t);
    if (x) { q += x.quote; b += x.buyQuote; n++; }
  }
  if (!n || !(q > 0)) return { buy: null, delta: null };
  return { buy: b / q, delta: (2 * b - q) / q };
}

export function fundingAt(f: Funding[], t: number): { last: number | null; avg3: number | null } {
  const i = idxAtOrBefore(f, t);
  if (i < 0) return { last: null, avg3: null };
  const xs = f.slice(Math.max(0, i - 2), i + 1).map((x) => x.rate);
  return { last: f[i]!.rate, avg3: mean(xs) };
}

export function session(t: number): Row {
  const d = new Date(t);
  const h = d.getUTCHours();
  return {
    hour_utc: h,
    session: h < 8 ? "asia" : h < 13 ? "london" : h < 21 ? "newyork" : "late",
    weekday: ["sun", "mon", "tue", "wed", "thu", "fri", "sat"][d.getUTCDay()]!,
  };
}

/** Round-number confluence: within 1% of 1 / 2 / 2.5 / 5 × 10^k. */
export function nearRound(p: number): number | null {
  if (!(p > 0)) return null;
  const k = Math.floor(Math.log10(p));
  let best = Infinity;
  for (const e of [k - 1, k, k + 1]) for (const m of [1, 2, 2.5, 5]) best = Math.min(best, Math.abs(p / (m * 10 ** e) - 1) * 100);
  return best;
}
/** Previous UTC week high / low from 4H bars before t. */
export function prevWeek(h4: C[], t: number): { high: number | null; low: number | null } {
  const d = new Date(t);
  const dow = (d.getUTCDay() + 6) % 7; // Monday = 0
  const weekStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - dow * D1;
  const bars = h4.filter((c) => c.time >= weekStart - D7 && c.time < weekStart);
  if (!bars.length) return { high: null, low: null };
  return { high: Math.max(...bars.map((c) => c.high)), low: Math.min(...bars.map((c) => c.low)) };
}

// ─── Outcomes: horizons, MFE / MAE, timing, the grid of stops × exits ────────

export type Rule = "trk" | "be5trk" | "tp5" | "tp8" | "tp10" | "tp15";
export const RULES: Rule[] = ["trk", "be5trk", "tp5", "tp8", "tp10", "tp15"];

/**
 * One trade on 15m candles from `from` (entry already filled at `entry`), stop price `stop`, rule, horizon.
 * trk = CAB tracker (B.U. after +8%, trailing from +15% at 10 p.p.); be5trk = same with B.U. after +5%;
 * tpX = fixed take. Stop first when both are hit in one candle. Result % net of the fee; closed at the
 * horizon if nothing hit (that is the end of the test window, not a time exit of the strategy).
 */
export function trade(m15: C[], from: number, entry: number, stop: number, rule: Rule, horizon = D7): { pct: number | null; hours: number | null } {
  if (!(stop > 0) || stop >= entry) return { pct: null, hours: null };
  let s = stop, peak = entry;
  const tp = rule.startsWith("tp") ? entry * (1 + Number(rule.slice(2)) / 100) : null;
  const beAt = rule === "be5trk" ? 5 : 8;
  let i = idxAtOrBefore(m15, from - 1) + 1;
  let last: C | null = null;
  for (; i < m15.length; i++) {
    const c = m15[i]!;
    if (c.time >= from + horizon) break;
    last = c;
    if (c.low <= s) return { pct: (Math.min(s, c.open) / entry - 1) * 100 - FEE, hours: (c.time + M15 - from) / H1 };
    if (tp && c.high >= tp) return { pct: (tp / entry - 1) * 100 - FEE, hours: (c.time + M15 - from) / H1 };
    if (!tp) {
      peak = Math.max(peak, c.high);
      const pp = (peak / entry - 1) * 100;
      if (pp >= beAt) s = Math.max(s, entry);
      if (pp >= 15) s = Math.max(s, entry * (1 + (pp - 10) / 100));
    }
  }
  if (!last || from + horizon > Date.now()) return { pct: null, hours: null };
  return { pct: (last.close / entry - 1) * 100 - FEE, hours: horizon / H1 };
}

/** Path facts after the entry: classes at 24h / 72h / 7d, MFE / MAE, time to +5 / +10 / −8. */
export function path(m15: C[], from: number, entry: number, atrPct: number | null): Row {
  const stop8 = entry * 0.92;
  const cls = (h: number) => {
    let out: string | null = null;
    for (let i = idxAtOrBefore(m15, from - 1) + 1; i < m15.length; i++) {
      const c = m15[i]!;
      if (c.time >= from + h) break;
      if (c.low <= stop8) { out = "STOP"; break; }
      if (c.high >= entry * 1.1) { out = "GOOD"; break; }
    }
    return out ?? (from + h <= Date.now() ? "MID" : "OPEN");
  };
  let peak72 = 0, worst72 = 0, peak7 = 0, worst7 = 0, peakT: number | null = null, worstT: number | null = null;
  let t5: number | null = null, t10: number | null = null, tStop: number | null = null, close24: number | null = null, close72: number | null = null, close7: number | null = null;
  for (let i = idxAtOrBefore(m15, from - 1) + 1; i < m15.length; i++) {
    const c = m15[i]!;
    if (c.time >= from + D7) break;
    const hi = (c.high / entry - 1) * 100, lo = (c.low / entry - 1) * 100, h = (c.time + M15 - from) / H1;
    if (c.time < from + 72 * H1) {
      if (hi > peak72) { peak72 = hi; peakT = h; }
      if (lo < worst72) { worst72 = lo; worstT = h; }
      close72 = (c.close / entry - 1) * 100;
    }
    if (c.time < from + D1) close24 = (c.close / entry - 1) * 100;
    peak7 = Math.max(peak7, hi); worst7 = Math.min(worst7, lo);
    close7 = (c.close / entry - 1) * 100;
    if (t5 === null && hi >= 5) t5 = h;
    if (t10 === null && hi >= 10) t10 = h;
    if (tStop === null && lo <= -8) tStop = h;
  }
  const done = (h: number) => from + h <= Date.now();
  return {
    out24: cls(D1), out72: cls(72 * H1), out7d: cls(D7),
    peak72_pct: peak72, worst72_pct: worst72, peak7d_pct: peak7, worst7d_pct: worst7,
    peak72_atr: atrPct ? peak72 / atrPct : null, worst72_atr: atrPct ? worst72 / atrPct : null,
    peak72_hours: peakT, worst72_hours: worstT,
    worst_before_peak72: peakT != null && worstT != null ? (worstT < peakT ? 1 : 0) : null,
    hours_to_plus5: t5, hours_to_plus10: t10, hours_to_minus8: tStop,
    close24_pct: done(D1) ? close24 : null, close72_pct: done(72 * H1) ? close72 : null, close7d_pct: done(D7) ? close7 : null,
  };
}

/** Grid: every stop × every rule for one entry variant. Columns x_<entry>_<stop>_<rule>. */
export function grid(prefix: string, m15: C[], from: number | null, entry: number | null, stops: Record<string, number | null>): Row {
  const out: Row = {};
  for (const [sk, sp] of Object.entries(stops)) {
    out[`${prefix}_stopdist_${sk}_pct`] = entry && sp ? pct(sp, entry) : null;
    for (const r of RULES) {
      const res = from != null && entry && sp ? trade(m15, from, entry, sp, r) : { pct: null };
      out[`${prefix}_${sk}_${r}`] = res.pct;
    }
  }
  return out;
}

// ─── Market across all coins ─────────────────────────────────────────────────

const MARKET_MIN = Number(process.env.STUDY_MARKET_MIN ?? 20); // coins needed for a market reading
/** Built in pass 1 from every coin's 1H and 4H candles. */
export class Market {
  private ret = new Map<number, { s: number; n: number }>(); // hourly mean log-return of alts
  private above = new Map<number, { a: number; n: number }>(); // 4H close > EMA50(4H)
  addCoin(h1: C[], h4: C[]) {
    for (let i = 1; i < h1.length; i++) {
      const p = h1[i - 1]!, c = h1[i]!;
      if (c.time - p.time !== H1 || !(p.close > 0)) continue;
      const r = Math.log(c.close / p.close);
      if (!Number.isFinite(r) || Math.abs(r) > 1) continue; // broken prints
      const x = this.ret.get(c.time) ?? { s: 0, n: 0 };
      x.s += r; x.n++;
      this.ret.set(c.time, x);
    }
    const e = emaSeries(h4.map((c) => c.close), 50);
    for (let i = 0; i < h4.length; i++) {
      if (e[i] == null) continue;
      const x = this.above.get(h4[i]!.time) ?? { a: 0, n: 0 };
      x.n++; if (h4[i]!.close > e[i]!) x.a++;
      this.above.set(h4[i]!.time, x);
    }
  }
  /** Equal-weight alt index change in % between two times (hour bars that OPEN in [t1, t2)). */
  change(t1: number, t2: number): number | null {
    let s = 0, n = 0;
    for (let t = Math.ceil(t1 / H1) * H1; t < t2; t += H1) {
      const x = this.ret.get(t);
      if (x && x.n >= MARKET_MIN) { s += x.s / x.n; n++; }
    }
    return n ? (Math.exp(s) - 1) * 100 : null;
  }
  /** Share of coins whose last closed 4H candle is above its EMA50 (%). */
  breadth(t: number): number | null {
    const bar = Math.floor(t / H4) * H4 - H4; // last closed 4H bar start
    const x = this.above.get(bar);
    return x && x.n >= MARKET_MIN ? (100 * x.a) / x.n : null;
  }
}

/** BTC / ETH context at time t from their 1H and 4H candles. */
export function majors(name: string, h1: C[], h4: C[], t: number): Row {
  const i1 = lastClosed(h1, t, H1), i4 = lastClosed(h4, t, H4);
  if (i1 < 30 || i4 < 60) return {};
  const close = h1[i1]!.close;
  const e20 = emaSeries(h1.slice(Math.max(0, i1 - 200), i1 + 1).map((c) => c.close), 20).at(-1) ?? null;
  const e50 = emaSeries(h4.slice(Math.max(0, i4 - 300), i4 + 1).map((c) => c.close), 50).at(-1) ?? null;
  return {
    [`${name}_1h_vs_ema20_pct`]: pct(close, e20),
    [`${name}_4h_pct`]: pct(close, h1[i1 - 4]?.close),
    [`${name}_24h_pct`]: pct(close, h1[i1 - 24]?.close),
    [`${name}_vs_ema50_4h_pct`]: pct(h4[i4]!.close, e50),
  };
}

/** After all rows exist: market at the entry, signals across coins, result against the market. */
export function addMarket(rows: Row[], m: Market, timeKey = "entry_time_ms", firedKey: string | null = "fired") {
  // Signals of this pattern across all coins (only those the bot would take: fired = 1).
  const times = rows.filter((r) => (firedKey ? r[firedKey] === 1 : true)).map((r) => ({ time: Number(r[timeKey]) })).sort((a, b) => a.time - b.time);
  for (const r of rows) {
    const t = Number(r[timeKey]);
    r.mkt_breadth_ema50_4h = m.breadth(t);
    r.mkt_4h_pct = m.change(t - 4 * H1, t);
    r.mkt_24h_pct = m.change(t - D1, t);
    r.alts_vs_btc_24h = r.mkt_24h_pct != null && typeof r.btc_24h_pct === "number" ? (r.mkt_24h_pct as number) - r.btc_24h_pct : null;
    r.signals_all_coins_prev4h = idxAtOrBefore(times, t - 1) - idxAtOrBefore(times, t - 4 * H1 - 1);
    r.signals_all_coins_prev24h = idxAtOrBefore(times, t - 1) - idxAtOrBefore(times, t - D1 - 1);
    const m24 = m.change(t, t + D1), m72 = m.change(t, t + 72 * H1), m7 = m.change(t, t + D7);
    r.mkt_next24h_pct = m24; r.mkt_next72h_pct = m72; r.mkt_next7d_pct = m7;
    r.excess24_pct = typeof r.close24_pct === "number" && m24 != null ? (r.close24_pct as number) - m24 : null;
    r.excess72_pct = typeof r.close72_pct === "number" && m72 != null ? (r.close72_pct as number) - m72 : null;
    r.excess7d_pct = typeof r.close7d_pct === "number" && m7 != null ? (r.close7d_pct as number) - m7 : null;
  }
}

// ─── Live signals of CAB (exported read-only by the agent) ───────────────────

export type LiveSignal = { id: string; symbol: string; key: string; method: string; price: number; time: number };
/** Postgres timestamps: "2026-11-06 04:01:00.123", "...+00", "...+03:00" or ISO; no zone = UTC. */
function parseTs(x: string): number {
  let s = x.trim().replace(" ", "T");
  if (/[+-]\d\d$/.test(s)) s += ":00";
  else if (!/(Z|[+-]\d\d:?\d\d)$/.test(s)) s += "Z";
  return Date.parse(s);
}
export function readLive(file: string | undefined): LiveSignal[] | null {
  if (!file || !existsSync(file)) return null;
  const lines = readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean);
  const head = lines.shift()!.split(",").map((h) => h.trim());
  const col = (n: string) => head.indexOf(n);
  return lines.map((l) => {
    const v = l.split(",");
    return {
      id: v[col("id")] ?? "",
      symbol: v[col("symbol")] ?? "",
      key: v[col("sentiment_key")] ?? "",
      method: v[col("stealth_detection_method")] ?? "",
      price: Number(v[col("price")]),
      time: parseTs(v[col("detected_at")] ?? ""),
    };
  }).filter((x) => x.symbol && Number.isFinite(x.time));
}
/**
 * Marks backtest rows that a live signal matches (same coin, live time within [t − before, t + after])
 * and writes live_compare.csv: each live signal and the backtest row it matched (or none).
 */
export function compareLive(rows: Row[], live: LiveSignal[], before: number, after: number, outFile: string): string {
  const bySym = new Map<string, Row[]>();
  for (const r of rows) (bySym.get(String(r.symbol)) ?? bySym.set(String(r.symbol), []).get(String(r.symbol))!).push(r);
  const lines = ["live_id,symbol,live_time,live_method,live_price,matched,bt_time,bt_fired,bt_entry,minutes_apart"];
  let matched = 0;
  for (const s of live) {
    const cands = (bySym.get(s.symbol) ?? []).filter((r) => { const t = Number(r.entry_time_ms); return s.time >= t - before && s.time <= t + after; });
    const best = cands.sort((a, b) => Math.abs(Number(a.entry_time_ms) - s.time) - Math.abs(Number(b.entry_time_ms) - s.time))[0];
    if (best) { matched++; best.live_signal = 1; best.live_signal_id = s.id; }
    lines.push([s.id, s.symbol, new Date(s.time).toISOString(), s.method, s.price, best ? 1 : 0, best ? best.time_utc : "", best ? best.fired ?? "" : "", best ? best.entry : "", best ? Math.round((s.time - Number(best.entry_time_ms)) / 60000) : ""].join(","));
  }
  for (const r of rows) if (r.live_signal == null) r.live_signal = 0;
  writeFileSync(outFile, lines.join("\n"));
  return `живых сигналов ${live.length}, нашлись в бэктесте ${matched} (${live.length ? Math.round((100 * matched) / live.length) : 0}%)`;
}

export function writeCsv(file: string, rows: Row[]) {
  const keys = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const fmt = (v: unknown) => (v == null ? "" : typeof v === "number" ? (Number.isFinite(v) ? String(+v.toFixed(5)) : "") : typeof v === "boolean" ? (v ? "1" : "0") : String(v).replace(/,/g, ";"));
  writeFileSync(file, [keys.join(","), ...rows.map((r) => keys.map((k) => fmt(r[k])).join(","))].join("\n"));
}

/** Wyckoff (CAB rules) and ICT (the CAB / Nihilist module) on bar i of a series — same readings as v1. */
export function wyIct(prefix: string, cs: C[], i: number, levelTop: number | null, levelBottom: number | null): Row {
  if (i < 30) return {};
  const lo = Math.max(0, i - 300);
  const part = cs.slice(lo, i + 1);
  const wy = computeWyckoff(part.map((c) => ({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close })), new Map(part.map((c) => [c.time, c.volume])), cs[i]!.time);
  const ib = part.map((c) => ({ ...c }));
  const e = ib.length - 1;
  const ict = e >= 30 ? (ictReading(ib, e, { w0: e - 23, levelTop, levelBottom }) as Record<string, any>) : null;
  return {
    [`${prefix}_wy_phase`]: wy.phase,
    [`${prefix}_wy_position`]: wy.entryPositionInRange,
    [`${prefix}_wy_range_height_pct`]: wy.rangeHeightPct,
    [`${prefix}_wy_spring`]: wy.events.filter((x) => x.type === "spring").length,
    [`${prefix}_wy_sos`]: wy.events.filter((x) => x.type === "sign_of_strength").length,
    [`${prefix}_ict_sweep14`]: ict?.sweep14?.swept ?? null,
    [`${prefix}_ict_mss`]: ict?.sweep14?.mss ?? null,
    [`${prefix}_ict_structure`]: ict?.structure ?? null,
    [`${prefix}_ict_premium_discount`]: ict?.premiumDiscount ?? null,
    [`${prefix}_ict_fvg_bear_above`]: ict?.fvgBearAboveCount ?? null,
  };
}
