/**
 * ABNeon study v3 helpers (owner 2026-11-06): the volumes the live CAB works with — CoinGlass aggregated
 * futures (all 28 exchanges), aggregated spot (+ spot CVD), and futures of Binance / Bybit / OKX / Bitget /
 * BingX one by one — 1H history with a disk cache, slow pacing so the live bot keeps its CoinGlass limit;
 * VSA / Welkin readings on any of these volumes; Auto Range [QuantAlgo] deviations (CAB's port).
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { applyCgAlias } from "../../src/lib/cg-symbol-alias.js";
import {
  detectAutoRangePine,
  detectAutoRangePine1d,
  detectAutoRangePine1h,
  detectAutoRangePine15m,
  type AutoRangePineResult,
} from "../../src/lib/auto-range-pine.js";
import { type C, type Row, H1, H4, D1, OFFLINE, idxAtOrBefore, lastClosed, pct, series, sleep, welkin } from "./lib.js";

// ─── CoinGlass history (1H) ──────────────────────────────────────────────────

const CG = "https://open-api-v4.coinglass.com";
// Same lists as CAB (coinglass-exchanges.ts INITIAL_*): every metric uses ALL supported exchanges.
const SPOT_LIST = "Binance,Bitfinex,Bitget,Bybit,Coinbase,Crypto.com,Gate,Kraken,OKX,Upbit";
const FUT_LIST =
  "ApeX Omni,Aster,Binance,BingX,Bitfinex,Bitget,Bitunix,Bybit,CME,Coinbase,Crypto.com,Deribit,Drift,EdgeX,Extended,Gate,HTX,Hyperliquid,Kraken,KuCoin,LBank,Lighter,MEXC,OKX,Paradex,WhiteBIT,dYdX,tradeXYZ";
export const SOURCES = ["aggfut", "aggspot", "binance", "bybit", "okx", "bitget", "bingxcg"] as const;
export type Source = (typeof SOURCES)[number];
const EXCH: Record<string, { name: string; sym: (b: string) => string }> = {
  binance: { name: "Binance", sym: (b) => `${b}USDT` },
  bybit: { name: "Bybit", sym: (b) => `${b}USDT` },
  okx: { name: "OKX", sym: (b) => `${b}-USDT-SWAP` },
  bitget: { name: "Bitget", sym: (b) => `${b}USDT_UMCBL` },
  bingxcg: { name: "BingX", sym: (b) => `${b}-USDT` },
};

/** One 1H bar of a volume source: buy / sell taker USD (spot also carries CVD). */
export type VBar = { time: number; buy: number; sell: number; cvd?: number };
const RPM = Number(process.env.STUDY_CG_RPM ?? 40); // requests per minute for this study only
let lastReq = 0;
export const cgStats = { requests: 0, ok: 0, empty: 0, errors: 0, r429: 0 };

async function cgGet(path: string, params: Record<string, string>): Promise<any[] | null> {
  const key = process.env.CoinGlassAPI?.trim();
  if (!key || OFFLINE) return null;
  const url = new URL(CG + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  for (let attempt = 0; attempt < 5; attempt++) {
    const wait = lastReq + 60_000 / RPM - Date.now();
    if (wait > 0) await sleep(wait);
    lastReq = Date.now();
    cgStats.requests++;
    try {
      const res = await fetch(url, { headers: { "CG-API-KEY": key, accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
      if (res.status === 429) { cgStats.r429++; await sleep(60_000); continue; }
      if (!res.ok) { cgStats.errors++; return null; }
      const body = (await res.json()) as { code?: string; data?: any[] };
      if (String(body.code) !== "0") { cgStats.empty++; return null; }
      if (!body.data?.length) { cgStats.empty++; return []; }
      cgStats.ok++;
      return body.data;
    } catch {
      cgStats.errors++;
      await sleep(3_000);
    }
  }
  return null;
}

/** 1H bars of one source for [start, now); cached on disk (a coin/source with no data is cached as empty). */
export async function cgHistory(cacheDir: string, symbol: string, src: Source, start: number, now: number): Promise<Map<number, VBar> | null> {
  return cgHistoryTf(cacheDir, symbol, src, start, now, "1h");
}
/** Same as cgHistory on another CoinGlass interval (15m: own cache file; history depth 4500 bars ≈ 46 days). */
export async function cgHistoryTf(cacheDir: string, symbol: string, src: Source, start: number, now: number, interval: "15m" | "1h"): Promise<Map<number, VBar> | null> {
  const step = interval === "15m" ? 900_000 : H1;
  const file = join(cacheDir, interval === "1h" ? `${symbol}_cg_${src}.json` : `${symbol}_cg${interval}_${src}.json`);
  if (existsSync(file)) {
    try {
      const c = JSON.parse(readFileSync(file, "utf8")) as { from: number; to: number; items: VBar[] | null };
      if (c.from <= start && (OFFLINE || now - c.to < Number(process.env.STUDY_CG_MAXAGE_H ?? 6) * H1)) return c.items ? new Map(c.items.map((b) => [b.time, b])) : null;
    } catch { /* refetch */ }
  }
  if (OFFLINE) return null;
  const base = applyCgAlias(symbol.replace(/-?USDT$/i, "").toUpperCase());
  // Long ranges in windows of ≤ 4400 bars (CoinGlass returns at most 4500 per request).
  let rows: any[] | null = [];
  for (let a = start; a < now && rows !== null; a += 4400 * step) {
    const b = Math.min(now, a + 4400 * step);
    const common = { interval, start_time: String(a), end_time: String(b), limit: String(Math.min(4500, Math.ceil((b - a) / step) + 4)) };
    let part: any[] | null;
    if (src === "aggfut") part = await cgGet("/api/futures/aggregated-taker-buy-sell-volume/history", { ...common, symbol: base, exchange_list: FUT_LIST });
    else if (src === "aggspot") part = await cgGet("/api/spot/aggregated-cvd/history", { ...common, symbol: base, exchange_list: SPOT_LIST });
    else part = await cgGet("/api/futures/taker-buy-sell-volume/history", { ...common, exchange: EXCH[src]!.name, symbol: EXCH[src]!.sym(base) });
    rows = part === null ? null : rows.concat(part);
  }
  const toMs = (t: number) => (t < 1e12 ? t * 1000 : t);
  const items: VBar[] | null = rows === null ? null : rows.map((r) => (
    src === "aggfut" ? { time: toMs(Number(r.time)), buy: Number(r.aggregated_buy_volume_usd), sell: Number(r.aggregated_sell_volume_usd) }
    : src === "aggspot" ? { time: toMs(Number(r.time)), buy: Number(r.agg_taker_buy_vol), sell: Number(r.agg_taker_sell_vol), cvd: Number(r.cum_vol_delta) }
    : { time: toMs(Number(r.time)), buy: Number(r.taker_buy_volume_usd), sell: Number(r.taker_sell_volume_usd) }
  )).filter((b) => Number.isFinite(b.buy) && Number.isFinite(b.sell));
  // Network failures are not cached (a later run retries); "no data" is.
  if (rows !== null) writeFileSync(file, JSON.stringify({ from: start, to: now, items }));
  return items ? new Map(items.map((b) => [b.time, b])) : null;
}

/** Aggregated open interest (all exchanges, USD), 1H closes for [start, now); cached like cgHistory. */
export async function cgOiAgg(cacheDir: string, symbol: string, start: number, now: number): Promise<Map<number, number> | null> {
  const file = join(cacheDir, `${symbol}_cg_oiagg.json`);
  if (existsSync(file)) {
    try {
      const c = JSON.parse(readFileSync(file, "utf8")) as { from: number; to: number; items: [number, number][] | null };
      if (c.from <= start && (OFFLINE || now - c.to < Number(process.env.STUDY_CG_MAXAGE_H ?? 6) * H1)) return c.items ? new Map(c.items) : null;
    } catch { /* refetch */ }
  }
  if (OFFLINE) return null;
  const base = applyCgAlias(symbol.replace(/-?USDT$/i, "").toUpperCase());
  let rows: any[] | null = [];
  for (let a = start; a < now && rows !== null; a += 4400 * H1) {
    const b = Math.min(now, a + 4400 * H1);
    const part = await cgGet("/api/futures/open-interest/aggregated-history", {
      symbol: base, interval: "1h", start_time: String(a), end_time: String(b), limit: String(Math.min(4500, Math.ceil((b - a) / H1) + 4)),
    });
    rows = part === null ? null : rows.concat(part);
  }
  const toMs = (t: number) => (t < 1e12 ? t * 1000 : t);
  const items: [number, number][] | null = rows === null ? null
    : rows.map((r) => [toMs(Number(r.time)), Number(r.close)] as [number, number]).filter(([, v]) => Number.isFinite(v) && v > 0);
  if (rows !== null) writeFileSync(file, JSON.stringify({ from: start, to: now, items }));
  return items ? new Map(items) : null;
}

/** BingX OHLC with the volume of a source (USD / close → base units, ratios unchanged); NaN where missing. */
export function withVolume(cs: C[], vb: Map<number, VBar> | null, step: number): C[] {
  if (!vb) return cs.map((c) => ({ ...c, volume: NaN }));
  return cs.map((c) => {
    let usd = 0, n = 0;
    for (let t = c.time; t < c.time + step; t += H1) { const b = vb.get(t); if (b) { usd += b.buy + b.sell; n++; } }
    return { ...c, volume: n === step / H1 && c.close > 0 ? usd / c.close : NaN };
  });
}
export function coverage(vb: Map<number, VBar> | null, from: number, to: number): number {
  if (!vb) return 0;
  let n = 0, k = 0;
  for (let t = Math.floor(from / H1) * H1; t < to; t += H1) { k++; if (vb.has(t)) n++; }
  return k ? n / k : 0;
}
function delta(vb: Map<number, VBar> | null, from: number, to: number): number | null {
  if (!vb) return null;
  let b = 0, s = 0, n = 0;
  for (let t = from; t <= to; t += H1) { const x = vb.get(t); if (x) { b += x.buy; s += x.sell; n++; } }
  return n && b + s > 0 ? (b - s) / (b + s) : null;
}

// ─── VSA / Welkin on any volume ──────────────────────────────────────────────

const finite = (v: number) => Number.isFinite(v) && v > 0;
const isBlueOrMore = (w: string | null) => w === "A" || w === "O" || w === "M" || w === "W";

/**
 * Volume readings of one source around an ABNeon signal. h1v / h4v = BingX OHLC with that source's
 * volume. first = first 1H touch bar, deep = deepest bar, trig = reaction bar, i4 = last closed 4H bar.
 * Blue = Welkin "above average" (A) or more; grey = below average (N).
 */
export function volumeReadings(p: string, h1v: C[], h4v: C[], first: number, deep: number, trig: number, i4: number, vb: Map<number, VBar> | null, entryT: number): Row {
  const out: Row = {};
  const S1 = series(h1v), S4 = series(h4v);
  const ok = (i: number, n: number) => { for (let k = i - n + 1; k <= i; k++) if (k < 0 || !finite(h1v[k]!.volume)) return false; return true; };
  out[`${p}_cov24`] = ok(trig, 24) ? 1 : 0;
  if (!ok(trig, 60)) return out; // not enough of this volume around the signal
  const vr = (i: number) => { const a = S1.volAvg20[i]; return a && finite(h1v[i]!.volume) ? h1v[i]!.volume / a : null; };
  const sr = (i: number) => { const a = S1.sprAvg20[i]; return a ? (h1v[i]!.high - h1v[i]!.low) / a : null; };
  const cp = (b: C) => (b.high > b.low ? (b.close - b.low) / (b.high - b.low) : 0.5);
  const down = (b: C) => b.close < b.open;
  const wk = (cs: C[], i: number) => welkin(cs, i);
  // Before the touch: 12 and 24 bars.
  const pre = (n: number) => [...Array(n).keys()].map((k) => first - n + k).filter((k) => k >= 20);
  const pre12 = pre(12), pre24 = pre(24);
  let run = 0, runMax = 0;
  for (const k of pre24) { if (isBlueOrMore(wk(h1v, k))) { run++; runMax = Math.max(runMax, run); } else run = 0; }
  let stopAgo: number | null = null, stopRatio: number | null = null;
  for (let k = first - 1; k >= first - 24 && k >= 0; k--) {
    const r = S1.vsa.ratio[k] ?? 0;
    if (down(h1v[k]!) && r >= 1.8 && cp(h1v[k]!) >= 0.5) { stopAgo = first - k; stopRatio = r; break; }
  }
  let cx = -1;
  for (let k = Math.max(0, first - 48); k < first; k++) if (finite(h1v[k]!.volume) && (cx < 0 || h1v[k]!.volume > h1v[cx]!.volume)) cx = k;
  Object.assign(out, {
    [`${p}_pre_vol12_vs_prev36`]: (() => { const a = pre12.map((k) => h1v[k]!.volume), b = h1v.slice(Math.max(0, first - 48), first - 12).map((c) => c.volume); const ma = a.reduce((x, y) => x + y, 0) / a.length, mb = b.reduce((x, y) => x + y, 0) / Math.max(1, b.length); return finite(ma) && finite(mb) ? ma / mb : null; })(),
    [`${p}_pre_colored12`]: pre12.filter((k) => ["O", "R", "P"].includes(S1.vsa.color[k] ?? "")).length,
    [`${p}_pre_blue12`]: pre12.filter((k) => isBlueOrMore(wk(h1v, k))).length,
    [`${p}_pre_grey12`]: pre12.filter((k) => wk(h1v, k) === "N").length,
    [`${p}_pre_blue_run24`]: runMax,
    [`${p}_pre_stopping_vol_bars_ago`]: stopAgo,
    [`${p}_pre_stopping_vol_ratio`]: stopRatio,
    [`${p}_pre_climax48_bars_ago`]: cx >= 0 ? first - cx : null,
    [`${p}_pre_climax48_down`]: cx >= 0 ? (down(h1v[cx]!) ? 1 : 0) : null,
    [`${p}_pre_effort_no_result12`]: pre12.filter((k) => (vr(k) ?? 0) >= 1.5 && (sr(k) ?? 9) <= 0.7).length,
    [`${p}_pre_no_supply12`]: pre12.filter((k) => down(h1v[k]!) && (sr(k) ?? 9) <= 0.7 && (vr(k) ?? 9) <= 0.8).length,
  });
  // The candles.
  for (const [name, i] of [["touch1h", first], ["deep1h", deep], ["trig1h", trig]] as const) {
    out[`${p}_${name}_vsa_color`] = S1.vsa.color[i] ?? null;
    out[`${p}_${name}_vsa_ratio`] = S1.vsa.ratio[i] ?? null;
    out[`${p}_${name}_welkin`] = wk(h1v, i);
    out[`${p}_${name}_vol_ratio20`] = vr(i);
  }
  if (i4 >= 25 && finite(h4v[i4]!.volume)) {
    out[`${p}_trig4h_vsa_color`] = S4.vsa.color[i4] ?? null;
    out[`${p}_trig4h_welkin`] = wk(h4v, i4);
    const last6 = [...Array(6).keys()].map((k) => i4 - 5 + k);
    out[`${p}_4h_blue6`] = last6.filter((k) => isBlueOrMore(wk(h4v, k))).length;
    out[`${p}_4h_grey6`] = last6.filter((k) => wk(h4v, k) === "N").length;
    out[`${p}_4h_colored6`] = last6.filter((k) => ["O", "R", "P"].includes(S4.vsa.color[k] ?? "")).length;
    let r4 = 0, r4max = 0;
    for (let k = i4 - 11; k <= i4; k++) { if (k >= 0 && isBlueOrMore(wk(h4v, k))) { r4++; r4max = Math.max(r4max, r4); } else r4 = 0; }
    out[`${p}_4h_blue_run12`] = r4max;
    out[`${p}_4h_stopping6`] = last6.filter((k) => down(h4v[k]!) && (S4.vsa.ratio[k] ?? 0) >= 1.8 && cp(h4v[k]!) >= 0.5).length;
  }
  // After the touch, up to the entry.
  let upV = 0, dnV = 0, stopIn = 0, lowTest = 0, blueIn = 0;
  for (let k = first; k <= trig; k++) {
    const b = h1v[k]!;
    if (!finite(b.volume)) continue;
    if (b.close >= b.open) upV += b.volume; else dnV += b.volume;
    if (down(b) && (S1.vsa.ratio[k] ?? 0) >= 1.8 && cp(b) >= 0.5) stopIn++;
    if (k > deep && k < trig && (vr(k) ?? 9) <= 0.8) lowTest = 1;
    if (isBlueOrMore(wk(h1v, k))) blueIn++;
  }
  Object.assign(out, {
    [`${p}_win_up_vs_down_volume`]: dnV > 0 ? upV / dnV : null,
    [`${p}_win_stopping_bars`]: stopIn,
    [`${p}_win_low_vol_test`]: lowTest,
    [`${p}_win_blue_bars`]: blueIn,
  });
  // Takers.
  const t1 = h1v[first]!.time, tt = h1v[trig]!.time;
  Object.assign(out, {
    [`${p}_tk_pre12_delta`]: delta(vb, t1 - 12 * H1, t1 - H1),
    [`${p}_tk_win_delta`]: delta(vb, t1, tt),
    [`${p}_tk_trig_delta`]: delta(vb, tt, tt),
    [`${p}_tk_24h_delta`]: delta(vb, tt - 23 * H1, tt),
    [`${p}_post_tk3_delta`]: delta(vb, tt + H1, tt + 3 * H1),
  });
  if (vb && h1v[trig]) {
    const c0 = vb.get(tt - 24 * H1)?.cvd, c1 = vb.get(tt)?.cvd;
    let vol24 = 0;
    for (let t = tt - 23 * H1; t <= tt; t += H1) { const x = vb.get(t); if (x) vol24 += x.buy + x.sell; }
    if (c0 != null && c1 != null && vol24 > 0) out[`${p}_cvd24_change_share`] = (c1 - c0) / vol24;
  }
  const next3 = h1v.slice(trig + 1, trig + 4);
  out[`${p}_post_first3_vol_vs_trig`] = next3.length === 3 && next3.every((c) => finite(c.volume)) && finite(h1v[trig]!.volume) ? next3.reduce((a, c) => a + c.volume, 0) / 3 / h1v[trig]!.volume : null;
  void entryT;
  return out;
}

// ─── Auto Range [QuantAlgo] deviations (CAB's closed-candle port) ────────────

type ARC = { time: number; open: number; high: number; low: number; close: number; closed: true };
const toAR = (cs: C[]): ARC[] => cs.map((c) => ({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close, closed: true }));
const memo = new Map<string, AutoRangePineResult | null>();
export function resetRangeMemo() { memo.clear(); }

export function rangeAt(tf: "15m" | "1h" | "4h" | "1d", cs: C[], t: number, bars: number): { res: AutoRangePineResult | null; lastClose: number | null } {
  const step = tf === "15m" ? 900_000 : tf === "1h" ? H1 : tf === "4h" ? H4 : D1;
  const i = lastClosed(cs, t, step);
  if (i < 210) return { res: null, lastClose: null };
  const key = `${tf}|${cs[i]!.time}|${cs.length}`;
  if (!memo.has(key)) {
    const part = toAR(cs.slice(Math.max(0, i - bars + 1), i + 1));
    let res: AutoRangePineResult | null = null;
    try {
      res = tf === "15m" ? detectAutoRangePine15m(part) : tf === "1h" ? detectAutoRangePine1h(part) : tf === "4h" ? detectAutoRangePine(part) : detectAutoRangePine1d(part);
    } catch { res = null; }
    memo.set(key, res);
  }
  return { res: memo.get(key) ?? null, lastClose: cs[i]!.close };
}

/**
 * Range and deviation readings on one timeframe at time t, relative to the ABNeon zone.
 * dev_down = the latest "broke below the range, closed back inside" (indicator's Deviation ↑ label).
 */
export function rangeReadings(tf: "15m" | "1h" | "4h" | "1d", cs: C[], t: number, zoneBottom: number, zoneTop: number, recentMs: number, bars: number): Row {
  const p = `rng${tf}`;
  const { res, lastClose } = rangeAt(tf, cs, t, bars);
  if (!res || res.status !== "ready" || lastClose == null) return { [`${p}_state`]: "none" };
  const active = res.activeConfirmedRange;
  const down = res.latestDownsideBreakout ?? null, up = res.latestUpsideBreakout ?? null;
  const broken = up && down ? (up.breakoutCloseTime >= down.breakoutCloseTime ? up : down) : (up ?? down);
  const r = active ?? broken;
  const devs = (res.deviations ?? []).filter((d) => d.direction === "down" && d.reentryCloseTime <= t);
  const last = devs.at(-1) ?? null;
  const recent = devs.filter((d) => t - d.reentryCloseTime <= recentMs);
  const near = (x: number) => x >= zoneBottom * 0.99 && x <= zoneTop * 1.01;
  return {
    [`${p}_state`]: active ? "active" : r ? (broken === down ? "broken_down" : "broken_up") : "none",
    [`${p}_pos`]: r ? (lastClose < r.lower ? "below" : lastClose > r.upper ? "above" : "inside") : null,
    [`${p}_dist_to_lower_pct`]: r ? pct(lastClose, r.lower) : null,
    [`${p}_height_pct`]: r ? pct(r.upper, r.lower) : null,
    [`${p}_lower_in_zone`]: r ? (near(r.lower) ? 1 : 0) : null,
    [`${p}_dev_down_recent`]: recent.length ? 1 : 0,
    [`${p}_dev_down_count_recent`]: recent.length,
    [`${p}_dev_down_hours_ago`]: last ? (t - last.reentryCloseTime) / H1 : null,
    [`${p}_dev_down_extreme_pct`]: last ? last.extremePct : null,
    [`${p}_dev_down_lower_in_zone`]: last ? (near(last.lower) ? 1 : 0) : null,
  };
}
export { idxAtOrBefore };
