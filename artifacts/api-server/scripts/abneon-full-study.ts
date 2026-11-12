/**
 * ABNeon full study (owner 2026-11-12: "many cancels and stops overnight; HBAR / XTZ had no volume, BIKETYSON
 * was all grey and played out — a full study, the volume metrics included"). The live ABNeon (same replay as
 * abneon-live-check: zone bounce with the live touch-volume rule + low bounce; exit: stop under the level,
 * B.U. +10, trailing +20/20 p.p., cancel at a 4H close under the level, 4 days, fee 0.1%) on every BingX USDT
 * coin, and for every trade everything known at the entry:
 *   zone: strength (touch count), width, how deep the dip went into it, entry above the zone, stop size,
 *         room to the next zone above, zones within +10%;
 *   volume (CoinGlass aggregated FUTURES and aggregated SPOT, separately): Welkin / VSA of the touch, the
 *         deepest and the reaction 1H candles and of the 4H signal candle, the 12 / 24 bars before, the bars
 *         between touch and entry, taker delta before / in / at / after, spot CVD, spot ÷ futures volume;
 *   open interest (aggregated): change 4h / 24h / 72h before the entry and from the touch to the entry;
 *   trend: change 24h / 7d / 30d, vs EMA50 / EMA200 4H, drop from the 30-day high, ATR 4H %;
 *   BTC: change 24h / 7d, vs EMA50 4H;
 *   VPVR (30 days of 1H BingX volume): share of the volume in [entry, +10%], POC distance.
 *
 * Out: summary.txt —
 *   1) every reading: 5 equal groups (range, n, average result, % in profit, % with peak ≥ +10%) and the
 *      categorical ones by value; readings ranked by the spread between their best and worst group;
 *   2) cuts that KEEP every one of the owner's winners (her coins, result ≥ +9%) — single readings and pairs —
 *      with trades kept / dropped, their sums and the kept result by month;
 *   3) her coins by name with all readings; 4) the live ABNeon signals (--live, optional) matched by coin and time.
 *   trades.csv — every trade with every reading.
 *
 * No database connection. Optional --live <json>: the agent exports with its read-only production SQL tool
 *   SELECT id, symbol, detected_at, status::text AS status, pnl_percent, cancel_reason FROM tracked_signals
 *    WHERE sentiment_key = 'neon_support_bounce' AND detected_at >= '2026-11-10' ORDER BY detected_at
 * Run (from artifacts/api-server):
 *   STUDY_CG_RPM=30 pnpm dlx tsx scripts/abneon-full-study.ts --days 64 --live live.json --out ../../reports/abneon-full
 */
import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { computeSupportZones, evaluateAbneonSupportBounce, resolveFrozenZone } from "../src/lib/stealth-abneon-detectors.js";
import { touchVolumeNotGrey } from "../src/lib/abneon-volume-gate.js";
import { findLowBounce, stopUnderLevel } from "../src/lib/abneon-low-bounce.js";
import { cgHistory, cgOiAgg, cgStats, volumeReadings, withVolume, type VBar } from "./study-v2/cg.js";
import { type C, type Row, D1, H1, H4, M15, emaSeries, ensureDir, idxAtOrBefore, klines, lastClosed, parseArgs, usdtSymbols, welkin, writeCsv } from "./study-v2/lib.js";

const args = parseArgs();
const DAYS = Number(args.get("days") ?? 64);
const OUT = args.get("out") ?? "abneon-full";
const CACHE = args.get("cache") ?? "../../reports/.cache";
const LIMIT = Number(args.get("limit") ?? 10_000);
const ONLY = args.get("symbols")?.split(",").filter(Boolean) ?? null;
const LIVE = args.get("live");
const HER = (args.get("her") ?? "ELSA,INIT,PIEVERSE,EDGEX,KNOTS,GANG,SI,PRIORS,BIKETYSON,HBAR,XTZ").split(",").map((s) => `${s}-USDT`);
const HER_FROM = Date.parse(args.get("her-from") ?? "2026-10-28T00:00:00Z");
const HER_WIN = 9; // her coins: a trade with result ≥ +9% is a winner the cuts must keep
const HORIZON = 4 * D1, FEE = 0.1, BE = 10, TR_ACT = 20, TR_GAP = 20;

const fmtT = (t: number) => { const d = new Date(t + 4 * H1), p = (n: number) => String(n).padStart(2, "0"); return `${p(d.getUTCDate())}.${p(d.getUTCMonth() + 1)} ${p(d.getUTCHours())}:00`; };
const r2 = (x: number) => Math.round(x * 100) / 100;
const chg = (a: number | undefined, b: number | undefined) => (a && b ? ((a - b) / b) * 100 : null);

function agg4hMap(agg: Map<number, VBar> | null): Map<number, number> {
  const out = new Map<number, number>();
  if (!agg) return out;
  const sums = new Map<number, { usd: number; n: number }>();
  for (const [t, b] of agg) { const k = Math.floor(t / H4) * H4; const s = sums.get(k) ?? { usd: 0, n: 0 }; s.usd += b.buy + b.sell; s.n++; sums.set(k, s); }
  for (const [k, s] of sums) if (s.n === 4) out.set(k, s.usd);
  return out;
}

type Entry = { kind: "zone" | "low"; at: number; entry: number; level: number; top: number; count: number; colour: string; armTime: number; trigTime: number };

function entries(h4: C[], h1: C[], a4: Map<number, number>, from: number, now: number): Entry[] {
  const out: Entry[] = [];
  let arm: { level: number; time: number } | null = null;
  for (let t = Math.ceil(from / H1) * H1; t <= now; t += H1) {
    const i4 = lastClosed(h4, t, H4), i1 = lastClosed(h1, t, H1);
    if (i4 < 0 || i1 < 0) continue;
    const c4 = h4.slice(Math.max(0, i4 - 639), i4 + 1), c1 = h1.slice(Math.max(0, i1 - 29), i1 + 1);
    const res = evaluateAbneonSupportBounce({ candles4h: c4, candles1h: c1, observedAt: t, marketCapUsd: null, ...(arm ? { frozenLevel: arm.level, armCandleTime: arm.time } : {}), sweepReclaimBars: 3 });
    if (res.status === "qualified" && res.triggerCandleTime != null && res.frozenLevel != null && res.armCandleTime != null) {
      const tv = touchVolumeNotGrey({ candles1h: h1.slice(0, i1 + 1), candles4h: h4.slice(0, i4 + 1), agg4hUsdByTime: a4, armCandleTime: res.armCandleTime, triggerCandleTime: res.triggerCandleTime, zoneTop: res.frozenLevel, nowMs: t });
      if (!tv.ok && tv.reason === "touch_bar_not_closed") { if (!arm) arm = { level: res.frozenLevel, time: res.armCandleTime }; continue; }
      const ti = idxAtOrBefore(h1, res.triggerCandleTime);
      const zone = resolveFrozenZone(h4.slice(0, i4 + 1), res.armCandleTime, res.frozenLevel);
      arm = null;
      if (tv.ok && ti >= 0) out.push({ kind: "zone", at: t, entry: h1[ti]!.close, level: zone.bottom, top: zone.top, count: zone.count, colour: tv.colours.join(""), armTime: res.armCandleTime, trigTime: res.triggerCandleTime });
      continue;
    }
    if (res.status === "armed" && res.frozenLevel != null && res.armCandleTime != null) { if (!arm) arm = { level: res.frozenLevel, time: res.armCandleTime }; continue; }
    if (arm && (res.status === "terminal" || t - arm.time > 24 * H1)) arm = null;
    if (!arm && h4[i4]!.time + H4 === t) {
      const lb = findLowBounce({ candles4h: h4.slice(0, i4 + 1), agg4hUsdByTime: a4 });
      if (lb) out.push({ kind: "low", at: t, entry: lb.triggerClose, level: lb.low, top: lb.low, count: 0, colour: lb.colour, armTime: lb.lowTime, trigTime: t - H1 });
    }
  }
  return out;
}

function sim(h4: C[], m15: C[], e: Entry, now: number): { pct: number; end: number; how: string } | null {
  const stopP = stopUnderLevel(e.entry, e.level);
  if (stopP === null) return null;
  let stop = stopP, peak = e.entry, how = "стоп";
  const closeAt = (price: number, t: number, h: string) => ({ pct: (price / e.entry - 1) * 100 - FEE, end: t, how: h });
  for (let i = idxAtOrBefore(m15, e.at - 1) + 1; i < m15.length; i++) {
    const c = m15[i]!;
    if (c.time >= e.at + HORIZON) break;
    if ((c.time % H4) === 0 && c.time > e.at) {
      const j = idxAtOrBefore(h4, c.time - H4);
      if (j >= 0 && h4[j]!.time + H4 === c.time && h4[j]!.close < e.level) return closeAt(h4[j]!.close, c.time, "отмена 4H под уровнем");
    }
    if (c.low <= stop) return closeAt(Math.min(stop, c.open), c.time + M15, how);
    peak = Math.max(peak, c.high);
    const pp = (peak / e.entry - 1) * 100;
    if (pp >= BE && stop < e.entry) { stop = e.entry; how = "безубыток"; }
    if (pp >= TR_ACT) { const ts = e.entry * (1 + (pp - TR_GAP) / 100); if (ts > stop) { stop = ts; how = "трейлинг"; } }
  }
  if (e.at + HORIZON > now) return null;
  const j = idxAtOrBefore(m15, e.at + HORIZON - M15);
  return j >= 0 ? closeAt(m15[j]!.close, e.at + HORIZON, "4 дня") : null;
}

/** Everything known at the entry (closed candles only). */
function readings(e: Entry, h4: C[], h1: C[], aggF: Map<number, VBar> | null, aggS: Map<number, VBar> | null, oi: Map<number, number> | null, btc4: C[]): Row {
  const r: Row = {};
  const i4 = lastClosed(h4, e.at, H4), trig = idxAtOrBefore(h1, e.trigTime);
  let first = h1.findIndex((c) => c.time >= e.armTime && c.low <= e.top * 1.02);
  if (first < 0 || first > trig) first = Math.max(0, idxAtOrBefore(h1, e.armTime));
  let deep = first;
  for (let k = first; k <= trig; k++) if (h1[k]!.low < h1[deep]!.low) deep = k;
  const low = h1[deep]!.low;
  // zone
  r.zone_count = e.count;
  r.zone_width_pct = e.kind === "zone" ? r2(((e.top - e.level) / e.level) * 100) : null;
  r.dip_into_zone_pct = e.kind === "zone" && e.top > e.level ? r2(((e.top - low) / (e.top - e.level)) * 100) : null;
  r.dip_below_zone = low < e.level ? 1 : 0;
  r.entry_above_top_pct = r2(((e.entry - e.top) / e.top) * 100);
  const sp = stopUnderLevel(e.entry, e.level);
  r.stop_pct = sp ? r2((1 - sp / e.entry) * 100) : null;
  const zones = computeSupportZones(h4.slice(Math.max(0, i4 - 639), i4 + 1));
  const above = zones.filter((z) => z.bottom > e.entry).sort((a, b) => a.bottom - b.bottom);
  r.room_next_zone_pct = above.length ? r2(((above[0]!.bottom - e.entry) / e.entry) * 100) : null;
  r.zones_within_10pct = above.filter((z) => z.bottom <= e.entry * 1.1).length;
  r.touch_colour_4h = e.colour;
  r.touch_bright_4h = /[OMW]/.test(e.colour) ? 1 : 0;
  // volume: aggregated futures and spot, separately
  for (const [p, vb] of [["fut", aggF], ["spot", aggS]] as const) {
    if (!vb) { r[`${p}_have`] = 0; continue; }
    r[`${p}_have`] = 1;
    const h1v = withVolume(h1, vb, H1), h4v = withVolume(h4, vb, H4);
    const vr = volumeReadings(p, h1v, h4v, first, deep, trig, i4, vb, e.at);
    // only what is known at the entry: the "after the entry" readings are dropped
    for (const [k, v] of Object.entries(vr)) if (!k.startsWith(`${p}_post_`)) r[k] = typeof v === "number" ? r2(v * 100) / 100 : v;
    r[`${p}_sig4h_welkin`] = welkin(h4v, i4);
    r[`${p}_prev4h_welkin`] = i4 > 0 ? welkin(h4v, i4 - 1) : null;
  }
  if (aggF && aggS) {
    let f = 0, s = 0;
    for (let t = h1[trig]!.time - 23 * H1; t <= h1[trig]!.time; t += H1) { const a = aggF.get(t), b = aggS.get(t); if (a) f += a.buy + a.sell; if (b) s += b.buy + b.sell; }
    r.spot_vs_fut_vol24 = f > 0 ? r2(s / f) : null;
  }
  // open interest (aggregated, 1H closes)
  if (oi) {
    const at = h1[trig]!.time;
    const v = (t: number) => oi.get(t);
    r.oi_chg4h = r2(chg(v(at), v(at - 4 * H1)) ?? NaN);
    r.oi_chg24h = r2(chg(v(at), v(at - 24 * H1)) ?? NaN);
    r.oi_chg72h = r2(chg(v(at), v(at - 72 * H1)) ?? NaN);
    r.oi_chg_touch_to_entry = r2(chg(v(at), v(h1[first]!.time - H1)) ?? NaN);
    for (const k of ["oi_chg4h", "oi_chg24h", "oi_chg72h", "oi_chg_touch_to_entry"]) if (!Number.isFinite(r[k] as number)) r[k] = null;
  }
  // trend
  const c4 = h4.slice(0, i4 + 1).map((c) => c.close);
  const e50 = emaSeries(c4, 50).at(-1), e200 = emaSeries(c4, 200).at(-1);
  r.vs_ema50_4h_pct = e50 ? r2(((e.entry - e50) / e50) * 100) : null;
  r.vs_ema200_4h_pct = e200 ? r2(((e.entry - e200) / e200) * 100) : null;
  r.chg24h_pct = r2(chg(e.entry, h4[i4 - 6]?.close) ?? NaN);
  r.chg7d_pct = r2(chg(e.entry, h4[i4 - 42]?.close) ?? NaN);
  r.chg30d_pct = r2(chg(e.entry, h4[i4 - 180]?.close) ?? NaN);
  let hi30 = 0;
  for (let k = Math.max(0, i4 - 179); k <= i4; k++) hi30 = Math.max(hi30, h4[k]!.high);
  r.from_30d_high_pct = r2(((e.entry - hi30) / hi30) * 100);
  let atr = 0;
  for (let k = i4 - 13; k <= i4; k++) if (k > 0) atr += Math.max(h4[k]!.high - h4[k]!.low, Math.abs(h4[k]!.high - h4[k - 1]!.close), Math.abs(h4[k]!.low - h4[k - 1]!.close));
  r.atr4h_pct = r2((atr / 14 / e.entry) * 100);
  for (const k of ["chg24h_pct", "chg7d_pct", "chg30d_pct"]) if (!Number.isFinite(r[k] as number)) r[k] = null;
  // BTC
  const b4 = lastClosed(btc4, e.at, H4);
  if (b4 > 200) {
    const bc = btc4.slice(0, b4 + 1).map((c) => c.close), be50 = emaSeries(bc, 50).at(-1);
    r.btc_chg24h_pct = r2(chg(bc.at(-1), bc.at(-7)) ?? NaN);
    r.btc_chg7d_pct = r2(chg(bc.at(-1), bc.at(-43)) ?? NaN);
    r.btc_vs_ema50_4h_pct = be50 ? r2(((bc.at(-1)! - be50) / be50) * 100) : null;
  }
  // VPVR: 30 days of 1H BingX volume, 50 price bins
  const vp = h1.slice(Math.max(0, trig - 719), trig + 1);
  if (vp.length >= 300) {
    const lo = Math.min(...vp.map((c) => c.low)), hi = Math.max(...vp.map((c) => c.high));
    if (hi > lo) {
      const N = 50, bins = new Array<number>(N).fill(0), w = (hi - lo) / N;
      for (const c of vp) { const mid = (c.high + c.low + c.close) / 3; bins[Math.min(N - 1, Math.floor((mid - lo) / w))]! += c.volume * mid; }
      const tot = bins.reduce((a, b) => a + b, 0);
      let poc = 0;
      bins.forEach((v, i) => { if (v > bins[poc]!) poc = i; });
      let up10 = 0;
      bins.forEach((v, i) => { const m = lo + (i + 0.5) * w; if (m >= e.entry && m <= e.entry * 1.1) up10 += v; });
      r.vpvr_share_next10_pct = tot > 0 ? r2((up10 / tot) * 100) : null;
      r.vpvr_poc_dist_pct = r2(((lo + (poc + 0.5) * w - e.entry) / e.entry) * 100);
    }
  }
  return r;
}

type T = { symbol: string; e: Entry; res: { pct: number; end: number; how: string } | null; up: number; rd: Row };

async function main() {
  const now = Math.floor(Date.now() / M15) * M15, from = now - DAYS * D1;
  ensureDir(OUT); ensureDir(CACHE);
  const listed = ONLY ?? (await usdtSymbols(CACHE)).slice(0, LIMIT);
  const symbols = [...new Set([...HER, ...listed])];
  const btc4 = await klines(CACHE, "BTC-USDT", "4h", from - 400 * H4, now);
  const errors: Record<string, string> = {};
  const all: T[] = [];
  let done = 0;
  for (const symbol of symbols) {
    try {
      const h4 = await klines(CACHE, symbol, "4h", from - 720 * H4, now);
      const h1 = await klines(CACHE, symbol, "1h", from - 800 * H1, now);
      const m15 = await klines(CACHE, symbol, "15m", from - 8 * M15, now);
      if (h4.length < 60 || h1.length < 60 || m15.length < 100) { errors[symbol] = "short_history"; continue; }
      const aggF = await cgHistory(CACHE, symbol, "aggfut", from - 720 * H4, now);
      const a4 = agg4hMap(aggF);
      const es = entries(h4, h1, a4, from, now);
      if (!es.length) continue;
      const aggS = await cgHistory(CACHE, symbol, "aggspot", from - 30 * D1, now);
      const oi = await cgOiAgg(CACHE, symbol, from - 10 * D1, now);
      let busyUntil = -Infinity;
      for (const e of es) {
        if (e.at < busyUntil) continue;
        const res = sim(h4, m15, e, now);
        busyUntil = res ? res.end : e.at + HORIZON;
        let hi = e.entry;
        for (let i = idxAtOrBefore(m15, e.at - 1) + 1; i < m15.length && m15[i]!.time < Math.min(e.at + HORIZON, now); i++) hi = Math.max(hi, m15[i]!.high);
        let rd: Row = {};
        try { rd = readings(e, h4, h1, aggF, aggS, oi, btc4); } catch (err) { rd = { readings_error: String(err).slice(0, 80) }; }
        all.push({ symbol, e, res, up: (hi / e.entry - 1) * 100, rd });
      }
    } catch (err) { errors[symbol] = String(err).slice(0, 160); }
    if (++done % 25 === 0) console.error(`монеты ${done}/${symbols.length}, сделок ${all.length} · CoinGlass ${cgStats.requests} (429: ${cgStats.r429})`);
  }

  const closed = all.filter((x) => x.res);
  const isHerWin = (x: T) => HER.includes(x.symbol) && x.e.at >= HER_FROM && (x.res?.pct ?? -1) >= HER_WIN;
  const herWins = closed.filter(isHerWin);
  const keys = [...new Set(closed.flatMap((x) => Object.keys(x.rd)))].sort();
  const num = keys.filter((k) => closed.filter((x) => typeof x.rd[k] === "number").length >= 100);
  const cat = keys.filter((k) => !num.includes(k) && closed.some((x) => typeof x.rd[k] === "string"));
  const grp = (xs: T[]) => {
    if (!xs.length) return "n 0";
    const v = xs.map((x) => x.res!.pct), s = v.reduce((a, b) => a + b, 0);
    return `n ${xs.length} · ср ${r2(s / v.length)}% · сумма ${Math.round(s)}% · в плюсе ${Math.round((100 * v.filter((y) => y > 0).length) / v.length)}% · пик≥10 ${Math.round((100 * xs.filter((x) => x.up >= 10).length) / xs.length)}%`;
  };
  const avg = (xs: T[]) => (xs.length ? xs.reduce((a, x) => a + x.res!.pct, 0) / xs.length : NaN);
  const L: string[] = [];
  const base = avg(closed);
  L.push(`ABNeon полный разбор · ${new Date(from).toISOString().slice(0, 10)} … ${new Date(now).toISOString().slice(0, 10)} · монет ${symbols.length}, ошибок ${Object.keys(errors).length}`);
  L.push(`Живой ABNeon (зона + отскок от минимума), выход: стоп под уровнем, Б.У. +10, трейл +20/20, отмена 4H под уровнем, 4 дня, комиссия 0.1%.`);
  L.push(`Все закрытые: ${grp(closed)}`);
  L.push(`  зона: ${grp(closed.filter((x) => x.e.kind === "zone"))}`);
  L.push(`  минимум: ${grp(closed.filter((x) => x.e.kind === "low"))}`);
  L.push(`Твои победители (твои монеты с ${fmtT(HER_FROM)}, итог ≥ +${HER_WIN}%), их сохраняет каждый порог ниже: ${herWins.map((x) => `${x.symbol.replace("-USDT", "")} ${fmtT(x.e.at)} +${r2(x.res!.pct)}%`).join(" · ") || "нет"}`);
  L.push(`CoinGlass: запросов ${cgStats.requests}, ok ${cgStats.ok}, пусто ${cgStats.empty}, ошибок ${cgStats.errors}, 429: ${cgStats.r429}`);

  // 1) every reading by quintile, ranked by spread
  type Q = { k: string; spread: number; lines: string[] };
  const qs: Q[] = [];
  for (const k of num) {
    const xs = closed.filter((x) => typeof x.rd[k] === "number").sort((a, b) => (a.rd[k] as number) - (b.rd[k] as number));
    const parts: T[][] = [];
    for (let q = 0; q < 5; q++) parts.push(xs.slice(Math.floor((q * xs.length) / 5), Math.floor(((q + 1) * xs.length) / 5)));
    const avgs = parts.filter((p) => p.length).map(avg);
    const lines = parts.filter((p) => p.length).map((p) => `   [${p[0]!.rd[k]} … ${p.at(-1)!.rd[k]}] ${grp(p)}`);
    qs.push({ k, spread: Math.max(...avgs) - Math.min(...avgs), lines: [` ${k} (есть у ${xs.length}, нет у ${closed.length - xs.length}) — разброс средних ${r2(Math.max(...avgs) - Math.min(...avgs))} п.п.`, ...lines] });
  }
  for (const k of cat) {
    const vals = [...new Set(closed.map((x) => String(x.rd[k] ?? "нет")))];
    if (vals.length > 30) continue;
    const parts = vals.map((v) => ({ v, xs: closed.filter((x) => String(x.rd[k] ?? "нет") === v) })).filter((p) => p.xs.length >= 30);
    if (parts.length < 2) continue;
    const avgs = parts.map((p) => avg(p.xs));
    qs.push({ k, spread: Math.max(...avgs) - Math.min(...avgs), lines: [` ${k} — разброс средних ${r2(Math.max(...avgs) - Math.min(...avgs))} п.п.`, ...parts.sort((a, b) => avg(b.xs) - avg(a.xs)).map((p) => `   ${p.v.padEnd(10)} ${grp(p.xs)}`)] });
  }
  qs.sort((a, b) => b.spread - a.spread);
  L.push(``, `1) Каждый показатель: 5 равных групп (диапазон значений). Сверху — где разница между лучшей и худшей группой больше.`);
  for (const q of qs) L.push(...q.lines);

  // 2) cuts that keep all her winners
  type Cut = { label: string; pass: (x: T) => boolean };
  const singles: { cut: Cut; kept: T[]; dropped: T[]; gain: number }[] = [];
  for (const k of num) {
    const xs = closed.filter((x) => typeof x.rd[k] === "number");
    if (xs.length < closed.length * 0.5) continue;
    const vals = [...new Set(xs.map((x) => x.rd[k] as number))].sort((a, b) => a - b);
    const step = Math.max(1, Math.floor(vals.length / 40));
    for (let i = 0; i < vals.length; i += step) {
      const v = vals[i]!;
      for (const dir of ["≥", "≤"] as const) {
        const pass = (x: T) => typeof x.rd[k] !== "number" || (dir === "≥" ? (x.rd[k] as number) >= v : (x.rd[k] as number) <= v);
        if (!herWins.every(pass)) continue;
        const kept = closed.filter(pass), dropped = closed.filter((x) => !pass(x));
        if (dropped.length < closed.length * 0.1 || kept.length < 100) continue;
        singles.push({ cut: { label: `${k} ${dir} ${v}`, pass }, kept, dropped, gain: avg(kept) - base });
      }
    }
  }
  for (const k of cat) {
    const vals = [...new Set(closed.map((x) => String(x.rd[k] ?? "нет")))];
    if (vals.length > 30) continue;
    for (const v of vals) {
      const pass = (x: T) => String(x.rd[k] ?? "нет") !== v;
      if (!herWins.every(pass)) continue;
      const kept = closed.filter(pass), dropped = closed.filter((x) => !pass(x));
      if (dropped.length < closed.length * 0.05 || kept.length < 100) continue;
      singles.push({ cut: { label: `${k} ≠ ${v}`, pass }, kept, dropped, gain: avg(kept) - base });
    }
  }
  // best cut per reading
  const bestPer = new Map<string, (typeof singles)[number]>();
  for (const s of singles) { const k = s.cut.label.split(" ")[0]!; const b = bestPer.get(k); if (!b || s.gain > b.gain) bestPer.set(k, s); }
  const top = [...bestPer.values()].sort((a, b) => b.gain - a.gain).slice(0, 30);
  const byMonth = (xs: T[]) => {
    const m = new Map<string, number[]>();
    for (const x of xs) { const k = new Date(x.e.at).toISOString().slice(0, 7); m.set(k, [...(m.get(k) ?? []), x.res!.pct]); }
    return [...m.entries()].sort().map(([k, v]) => `${k} n${v.length} ${r2(v.reduce((a, b) => a + b, 0) / v.length)}%`).join(" · ");
  };
  L.push(``, `2) Пороги, которые СОХРАНЯЮТ всех твоих победителей (сейчас ср ${r2(base)}% на ${closed.length} сделках). Лучший порог на каждый показатель:`);
  for (const s of top) L.push(`  ${s.cut.label}: оставляет ${grp(s.kept)} | отсекает ${grp(s.dropped)}\n     оставленные по месяцам: ${byMonth(s.kept)}`);
  const pairs: { label: string; kept: T[]; dropped: T[]; gain: number }[] = [];
  for (let i = 0; i < top.length; i++) for (let j = i + 1; j < top.length; j++) {
    const a = top[i]!, b = top[j]!;
    const pass = (x: T) => a.cut.pass(x) && b.cut.pass(x);
    const kept = closed.filter(pass);
    if (kept.length < 100) continue;
    pairs.push({ label: `${a.cut.label} И ${b.cut.label}`, kept, dropped: closed.filter((x) => !pass(x)), gain: avg(kept) - base });
  }
  pairs.sort((a, b) => b.gain - a.gain);
  L.push(``, `   Пары порогов (тоже сохраняют всех твоих победителей), лучшие 15:`);
  for (const p of pairs.slice(0, 15)) L.push(`  ${p.label}: оставляет ${grp(p.kept)} | отсекает ${grp(p.dropped)}\n     оставленные по месяцам: ${byMonth(p.kept)}`);

  // 3) her coins
  L.push(``, `3) Твои монеты с ${fmtT(HER_FROM)} (Дубай), все показатели:`);
  for (const x of all.filter((y) => HER.includes(y.symbol) && y.e.at >= HER_FROM)) {
    L.push(`  ${x.symbol.replace("-USDT", "")} ${fmtT(x.e.at)} ${x.e.kind === "zone" ? "зона" : "минимум"} · ${x.res ? `${x.res.pct >= 0 ? "+" : ""}${r2(x.res.pct)}% (${x.res.how})` : "идёт"} · пик +${r2(x.up)}%`);
    L.push(`     ${Object.entries(x.rd).filter(([, v]) => v !== null && v !== "").map(([k, v]) => `${k}=${v}`).join(" · ")}`);
  }
  // 4) live signals
  if (LIVE && existsSync(LIVE)) {
    const live = JSON.parse(readFileSync(LIVE, "utf8")) as Record<string, unknown>[];
    L.push(``, `4) Живые сигналы ABNeon (${live.length}) и показатели прогона на ту же монету и время (±3 ч):`);
    for (const s of live) {
      const t = Date.parse(String(s.detected_at).replace(" ", "T") + (/[zZ+]/.test(String(s.detected_at)) ? "" : "Z"));
      const m = all.find((x) => x.symbol === s.symbol && Math.abs(x.e.at - t) <= 3 * H1);
      L.push(`  #${s.id} ${s.symbol} ${fmtT(t)} · ${s.status}${s.pnl_percent != null ? ` ${r2(Number(s.pnl_percent))}%` : ""}${s.cancel_reason ? ` (${s.cancel_reason})` : ""}${m ? ` · прогон: ${m.res ? `${r2(m.res.pct)}% ${m.res.how}` : "идёт"}` : " · в прогоне не найден"}`);
      if (m) L.push(`     ${Object.entries(m.rd).filter(([, v]) => v !== null && v !== "").map(([k, v]) => `${k}=${v}`).join(" · ")}`);
    }
  }
  writeFileSync(join(OUT, "summary.txt"), L.join("\n") + "\n");
  writeCsv(join(OUT, "trades.csv"), all.map((x) => ({ symbol: x.symbol, kind: x.e.kind, entry_utc: new Date(x.e.at).toISOString(), entry: x.e.entry, level: x.e.level, result_pct: x.res ? r2(x.res.pct) : null, how: x.res?.how ?? "open", peak_4d_pct: r2(x.up), her_winner: isHerWin(x) ? 1 : 0, ...x.rd })));
  writeFileSync(join(OUT, "errors.json"), JSON.stringify(errors, null, 1));
  console.log(L.slice(0, 8).join("\n"));
}

main().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });
