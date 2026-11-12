/**
 * ABNeon by the trading rules of a support bounce (owner 2026-11-12: "обычный отскок уровня по правилам, только мы
 * смотрим ещё и объёмы"). Every BingX USDT coin, the same ABNeon 4H zones as the live detector.
 *
 *   Rules (R4 / R8 / R12): the zone is tested (1H low reaches the zone top +2%; a sweep below the zone is allowed —
 *     liquidity grab); the entry is the FIRST reaction right after the test: a green 1H candle closing back at or
 *     above the zone bottom, at most W hours (4 / 8 / 12) after the lowest low of the test (a later lower low is a
 *     new test); the touch 4H candle or one of the next two not grey by Lucy's VSA rule (20-bar Welkin, grey under
 *     the 120-bar average; CoinGlass aggregated futures + spot) — a grey test voids the setup; void on a 4H close
 *     under the zone bottom; within 48 h of the arm.
 *   LIVE: the live ABNeon as published 12.11 (zone bounce: Lucy on the touch + entry ≤ 1% above the zone top;
 *     bounce from a fresh low with Lucy) — for reference. LOW = the live bounce from a fresh low.
 * Every entry: stop −6% from the entry (owner), cancel at a 4H close under the zone bottom (the low for LOW),
 *   4 days, fee 0.1%. Two exits: A = live (B.U. +10, trailing +20/20 p.p.); B = trading rules: take at the next
 *   resistance (bottom of the next ABNeon zone above), otherwise as A.
 * Room filters: all / room to the next resistance ≥ 1R (6%) / ≥ 2R (12%).
 * Every trade carries every reading of abneon-full (takers, delta, CVD, OI, VSA / Welkin / Lucy, trend, BTC,
 *   VPVR) for the next step: sorting by takers, delta, open interest.
 * Out: summary.txt (per entry × room × exit: trades, average, sum, % in profit, by month — November is the check;
 *   the owner's coins by name), trades.csv (every trade, both exits, every reading).
 * Run (from artifacts/api-server; caches of abneon-full):
 *   STUDY_CG_RPM=30 pnpm dlx tsx scripts/abneon-bounce-rules-study.ts --days 64 --out ../../reports/abneon-bounce-rules
 */
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { computeSupportZones, evaluateAbneonSupportBounce, resolveFrozenZone } from "../src/lib/stealth-abneon-detectors.js";
import { entryAboveZoneTopPct, touchVolumeNotGrey } from "../src/lib/abneon-volume-gate.js";
import { findLowBounce, stopUnderLevel } from "../src/lib/abneon-low-bounce.js";
import { cgHistory, cgOiAgg, cgStats, volumeReadings, withVolume, type VBar } from "./study-v2/cg.js";
import { type C, type Row, D1, H1, H4, M15, emaSeries, ensureDir, idxAtOrBefore, klines, lastClosed, parseArgs, usdtSymbols, welkin, writeCsv } from "./study-v2/lib.js";

const args = parseArgs();
const DAYS = Number(args.get("days") ?? 64);
const OUT = args.get("out") ?? "abneon-bounce-rules";
const CACHE = args.get("cache") ?? "../../reports/.cache";
const LIMIT = Number(args.get("limit") ?? 10_000);
const ONLY = args.get("symbols")?.split(",").filter(Boolean) ?? null;
const SHOW = (args.get("her") ?? "ELSA,INIT,PIEVERSE,EDGEX,KNOTS,GANG,SI,USELESS,ERA,GRVT,ZEST,OKB,ICP,ASTER,CAP,2Z,SPX,SXT").split(",").map((s) => `${s}-USDT`);
const HER = SHOW;
const HER_FROM = Date.parse(args.get("her-from") ?? "2026-10-28T00:00:00Z");
const HORIZON = 4 * D1, FEE = 0.1, BE = 10, TR_ACT = 20, TR_GAP = 20, STOP_PCT = 6, ARM_WINDOW = 48 * H1;
const WINDOWS = [4, 8, 12] as const;
const LIVE_MAX_ABOVE_TOP = 1;

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

/**
 * Welkin on a longer window (owner 2026-11-12: "not these 20 candles — a longer period", as in Lucy's VSA).
 * n bars including the bar, population σ; with longN > 0 a bar below the longN-bar average is N whatever its
 * colour (the indicator's long-average rule). null when the window is not fully covered.
 */
function welkinWin(cs: C[], i: number, n: number, longN = 0): string | null {
  if (i < 0 || i - Math.max(n, longN) + 1 < 0) return null;
  const vs: number[] = [];
  for (let k = i - n + 1; k <= i; k++) { const v = cs[k]!.volume; if (!Number.isFinite(v)) return null; vs.push(v); }
  const avg = vs.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(vs.reduce((a, v) => a + (v - avg) ** 2, 0) / n);
  const v = vs[n - 1]!, prev = vs[n - 2]!;
  if (longN > 0) {
    let s = 0;
    for (let k = i - longN + 1; k <= i; k++) { const x = cs[k]!.volume; if (!Number.isFinite(x)) return null; s += x; }
    if (v < s / longN) return "N";
  }
  if (v > avg + 4 * sd) return "W";
  if (v > avg + 3 * sd) return "M";
  if (v > avg + 2 * sd) return "O";
  if (v > avg) return "A";
  if (prev > 0 && v / prev >= 1.25) return "Y";
  return "N";
}


type V = "LIVE" | "LOW" | "R4" | "R8" | "R12";
type Entry = { v: V; kind: "zone" | "low"; at: number; entry: number; level: number; top: number; count: number; colour: string; armTime: number; trigTime: number };
type Arm = { armTime: number; frozen: number; i4: number };

/** One detector replay: the live entries (Lucy on futures + spot) and every arm (zone touch) for the rule entries. */
function replay(h4: C[], h1: C[], a4: Map<number, number>, s4: Map<number, number>, from: number, now: number): { live: Entry[]; arms: Arm[] } {
  const live: Entry[] = [];
  const arms: Arm[] = [];
  const seen = new Set<string>();
  const note = (frozen: number, armTime: number, i4: number) => { const k = `${armTime}:${frozen}`; if (!seen.has(k)) { seen.add(k); arms.push({ armTime, frozen, i4 }); } };
  let arm: { level: number; time: number } | null = null;
  for (let t = Math.ceil(from / H1) * H1; t <= now; t += H1) {
    const i4 = lastClosed(h4, t, H4), i1 = lastClosed(h1, t, H1);
    if (i4 < 0 || i1 < 0) continue;
    const c4 = h4.slice(Math.max(0, i4 - 639), i4 + 1), c1 = h1.slice(Math.max(0, i1 - 29), i1 + 1);
    const res = evaluateAbneonSupportBounce({ candles4h: c4, candles1h: c1, observedAt: t, marketCapUsd: null, ...(arm ? { frozenLevel: arm.level, armCandleTime: arm.time } : {}), sweepReclaimBars: 3 });
    if (res.status === "qualified" && res.triggerCandleTime != null && res.frozenLevel != null && res.armCandleTime != null) {
      note(res.frozenLevel, res.armCandleTime, i4);
      const tv = touchVolumeNotGrey({ candles1h: h1.slice(0, i1 + 1), candles4h: h4.slice(0, i4 + 1), agg4hUsdByTime: a4, spot4hUsdByTime: s4, armCandleTime: res.armCandleTime, triggerCandleTime: res.triggerCandleTime, zoneTop: res.frozenLevel, nowMs: t });
      if (!tv.ok && tv.reason === "touch_bar_not_closed") { if (!arm) arm = { level: res.frozenLevel, time: res.armCandleTime }; continue; }
      const ti = idxAtOrBefore(h1, res.triggerCandleTime);
      const zone = resolveFrozenZone(h4.slice(0, i4 + 1), res.armCandleTime, res.frozenLevel);
      arm = null;
      const above = ti >= 0 ? entryAboveZoneTopPct(h1[ti]!.close, res.frozenLevel) : null;
      if (tv.ok && ti >= 0 && above !== null && above <= LIVE_MAX_ABOVE_TOP) live.push({ v: "LIVE", kind: "zone", at: t, entry: h1[ti]!.close, level: zone.bottom, top: zone.top, count: zone.count, colour: tv.colours.join(""), armTime: res.armCandleTime, trigTime: res.triggerCandleTime });
      continue;
    }
    if (res.status === "armed" && res.frozenLevel != null && res.armCandleTime != null) { note(res.frozenLevel, res.armCandleTime, i4); if (!arm) arm = { level: res.frozenLevel, time: res.armCandleTime }; continue; }
    if (arm && (res.status === "terminal" || t - arm.time > 24 * H1)) arm = null;
    if (!arm && h4[i4]!.time + H4 === t) {
      const lb = findLowBounce({ candles4h: h4.slice(0, i4 + 1), agg4hUsdByTime: a4, spot4hUsdByTime: s4 });
      if (lb) live.push({ v: "LOW", kind: "low", at: t, entry: lb.triggerClose, level: lb.low, top: lb.low, count: 0, colour: `${lb.lowColour}/${lb.colour}`, armTime: lb.lowTime, trigTime: t - H1 });
    }
  }
  return { live, arms };
}

/** The bounce by the trading rules on one armed zone, the reaction at most W hours after the lowest low of the test. */
function ruleEntry(a: Arm, W: number, h4: C[], h1: C[], a4: Map<number, number>, s4: Map<number, number>, now: number): Entry | null {
  const zone = resolveFrozenZone(h4.slice(0, a.i4 + 1), a.armTime, a.frozen);
  const top = zone.top, bottom = zone.bottom;
  const i0 = h1.findIndex((c) => c.time >= a.armTime);
  if (i0 < 0) return null;
  let touched = false, low = Infinity, lowAt = 0;
  for (let k = i0; k < h1.length; k++) {
    const c = h1[k]!, closeAt = c.time + H1;
    if (closeAt > a.armTime + ARM_WINDOW || closeAt > now) return null;
    if (closeAt % H4 === 0) { const j = idxAtOrBefore(h4, closeAt - H4); if (j >= 0 && h4[j]!.time + H4 === closeAt && h4[j]!.close < bottom) return null; }
    if (!touched && c.low <= top * 1.02) touched = true;
    if (!touched) continue;
    if (c.low < low) { low = c.low; lowAt = closeAt; }
    if (!(c.close > c.open && c.close >= bottom)) continue;
    if (closeAt - lowAt > W * H1) continue;
    const tv = touchVolumeNotGrey({ candles1h: h1.slice(0, k + 1), candles4h: h4, agg4hUsdByTime: a4, spot4hUsdByTime: s4, armCandleTime: a.armTime, triggerCandleTime: c.time, zoneTop: a.frozen, nowMs: closeAt });
    if (!tv.ok && tv.reason === "touch_bar_not_closed") continue;
    if (!tv.ok) return null;
    return { v: `R${W}` as V, kind: "zone", at: closeAt, entry: c.close, level: bottom, top, count: zone.count, colour: tv.colours.join(""), armTime: a.armTime, trigTime: c.time };
  }
  return null;
}

/** Stop −6%, cancel at a 4H close under the level, 4 days; exit A = B.U. +10 / trailing +20/20; with a target = B. */
function sim(h4: C[], m15: C[], e: Entry, now: number, target: number | null): { pct: number; end: number; how: string } | null {
  let stop = e.entry * (1 - STOP_PCT / 100), peak = e.entry, how = "стоп";
  const closeAt = (price: number, t: number, h: string) => ({ pct: (price / e.entry - 1) * 100 - FEE, end: t, how: h });
  for (let i = idxAtOrBefore(m15, e.at - 1) + 1; i < m15.length; i++) {
    const c = m15[i]!;
    if (c.time >= e.at + HORIZON) break;
    if ((c.time % H4) === 0 && c.time > e.at) {
      const j = idxAtOrBefore(h4, c.time - H4);
      if (j >= 0 && h4[j]!.time + H4 === c.time && h4[j]!.close < e.level) return closeAt(h4[j]!.close, c.time, "отмена 4H под уровнем");
    }
    if (c.low <= stop) return closeAt(Math.min(stop, c.open), c.time + M15, how);
    if (target !== null && c.high >= target) return closeAt(target, c.time + M15, "тейк у сопротивления");
    peak = Math.max(peak, c.high);
    const pp = (peak / e.entry - 1) * 100;
    if (pp >= BE && stop < e.entry) { stop = e.entry; how = "безубыток"; }
    if (pp >= TR_ACT) { const ts = e.entry * (1 + (pp - TR_GAP) / 100); if (ts > stop) { stop = ts; how = "трейлинг"; } }
  }
  if (e.at + HORIZON > now) return null;
  const j = idxAtOrBefore(m15, e.at + HORIZON - M15);
  return j >= 0 ? closeAt(m15[j]!.close, e.at + HORIZON, "4 дня") : null;
}

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
    // Longer Welkin windows on the touch bars: 50 / 120 bars, and Lucy's VSA rule (20 bars, grey under the
    // 120-bar average). 4H: 120 bars = 20 days; 1H: 120 bars = 5 days.
    const t4 = idxAtOrBefore(h4v, Math.floor(h1[first]!.time / H4) * H4);
    for (const [tf, cs, i] of [["4h", h4v, t4], ["1h", h1v, first]] as const) {
      r[`${p}_touch${tf}_welkin50`] = welkinWin(cs, i, 50);
      r[`${p}_touch${tf}_welkin120`] = welkinWin(cs, i, 120);
      r[`${p}_touch${tf}_lucy`] = welkinWin(cs, i, 20, 120);
    }
    r[`${p}_sig4h_lucy`] = welkinWin(h4v, i4, 20, 120);
    r[`${p}_prev4h_welkin`] = i4 > 0 ? welkin(h4v, i4 - 1) : null;
  }
  // Long-range volume context (owner 2026-11-12, CFX: tiny volume vs its own history, yet blue on 20 bars):
  // the last 24h and the touch 4H bar against the coin's own 30-day / 60-day history.
  for (const [p, vb] of [["fut", aggF], ["spot", aggS]] as const) {
    if (!vb) continue;
    const at = h1[trig]!.time;
    const sum = (a: number, b: number) => { let s = 0, n = 0; for (let t = a; t <= b; t += H1) { const x = vb.get(t); if (x) { s += x.buy + x.sell; n++; } } return n ? s : null; };
    const last24 = sum(at - 23 * H1, at);
    const days: number[] = [];
    for (let d = 1; d <= 60; d++) { const v = sum(at - (24 * d + 23) * H1, at - 24 * d * H1); if (v !== null) days.push(v); }
    const d30 = days.slice(0, 30);
    if (last24 !== null && d30.length >= 20) {
      r[`${p}_vol24h_vs_30d_avg`] = r2(last24 / (d30.reduce((a, b) => a + b, 0) / d30.length));
      r[`${p}_vol24h_vs_60d_max_day`] = days.length >= 40 ? r2(last24 / Math.max(...days)) : null;
    }
    const touch4 = Math.floor(h1[first]!.time / H4) * H4;
    const bar4 = sum(touch4, touch4 + 3 * H1);
    const prev4: number[] = [];
    for (let k = 1; k <= 60; k++) { const v = sum(touch4 - k * H4, touch4 - k * H4 + 3 * H1); if (v !== null) prev4.push(v); }
    if (bar4 !== null && prev4.length >= 40) r[`${p}_touch4h_vs_60bar_avg`] = r2(bar4 / (prev4.reduce((a, b) => a + b, 0) / prev4.length));
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


type Res = { pct: number; end: number; how: string } | null;
type T = { symbol: string; e: Entry; a: Res; b: Res; room: number | null; up: number; rd: Row };

async function main() {
  const now = Math.floor(Date.now() / M15) * M15, from = now - DAYS * D1;
  ensureDir(OUT); ensureDir(CACHE);
  const listed = ONLY ?? (await usdtSymbols(CACHE)).slice(0, LIMIT);
  const symbols = [...new Set([...SHOW, ...listed])];
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
      if (!aggF) { errors[symbol] = "no_aggregated_futures"; continue; }
      const aggS = await cgHistory(CACHE, symbol, "aggspot", from - 30 * D1, now);
      const a4 = agg4hMap(aggF), s4 = agg4hMap(aggS);
      const { live, arms } = replay(h4, h1, a4, s4, from, now);
      const es: Entry[] = [...live];
      for (const W of WINDOWS) for (const a of arms) { const e = ruleEntry(a, W, h4, h1, a4, s4, now); if (e) es.push(e); }
      if (!es.length) continue;
      const oi = await cgOiAgg(CACHE, symbol, from - 10 * D1, now);
      es.sort((x, y) => x.at - y.at);
      const busy = new Map<V, number>();
      const seen = new Set<string>();
      for (const e of es) {
        const key = `${e.v}:${e.at}`;
        if (seen.has(key) || e.at < (busy.get(e.v) ?? -Infinity)) continue;
        seen.add(key);
        let rd: Row = {};
        try { rd = readings(e, h4, h1, aggF, aggS, oi, btc4); } catch (err) { rd = { readings_error: String(err).slice(0, 80) }; }
        rd.stop_pct = STOP_PCT;
        const room = typeof rd.room_next_zone_pct === "number" ? (rd.room_next_zone_pct as number) : null;
        const a = sim(h4, m15, e, now, null);
        const b = sim(h4, m15, e, now, room !== null && room > 0 ? e.entry * (1 + room / 100) : null);
        busy.set(e.v, a ? a.end : e.at + HORIZON);
        let hi = e.entry;
        for (let i = idxAtOrBefore(m15, e.at - 1) + 1; i < m15.length && m15[i]!.time < Math.min(e.at + HORIZON, now); i++) hi = Math.max(hi, m15[i]!.high);
        all.push({ symbol, e, a, b, room, up: (hi / e.entry - 1) * 100, rd });
      }
    } catch (err) { errors[symbol] = String(err).slice(0, 160); }
    if (++done % 25 === 0) console.error(`монеты ${done}/${symbols.length}, сделок ${all.length} · CoinGlass ${cgStats.requests} (429: ${cgStats.r429})`);
  }

  const grp = (xs: number[]) => {
    if (!xs.length) return "n 0";
    const s = xs.reduce((p, q) => p + q, 0);
    return `n ${xs.length} · ср ${r2(s / xs.length)}% · сумма ${Math.round(s)}% · в плюсе ${Math.round((100 * xs.filter((y) => y > 0).length) / xs.length)}%`;
  };
  const byMonth = (xs: T[], pick: (x: T) => Res) => {
    const m = new Map<string, number[]>();
    for (const x of xs) { const r = pick(x); if (!r) continue; const k = new Date(x.e.at + 4 * H1).toISOString().slice(0, 7); m.set(k, [...(m.get(k) ?? []), r.pct]); }
    return [...m.entries()].sort().map(([k, v]) => `${k} n${v.length} ${r2(v.reduce((a, b) => a + b, 0) / v.length)}%`).join(" · ");
  };
  const howCount = (xs: T[], pick: (x: T) => Res) => {
    const m = new Map<string, number>();
    for (const x of xs) { const r = pick(x); if (r) m.set(r.how, (m.get(r.how) ?? 0) + 1); }
    return [...m.entries()].map(([k, v]) => `${k} ${v}`).join(" · ");
  };
  const L: string[] = [];
  L.push(`ABNeon по правилам отскока · ${new Date(from).toISOString().slice(0, 10)} … ${new Date(now).toISOString().slice(0, 10)} · монет ${symbols.length}, ошибок ${Object.keys(errors).length}`);
  L.push(`Стоп −6% от входа, отмена при закрытии 4H под зоной, 4 дня, комиссия 0.1%. Выход A: Б.У. +10, трейл +20/20. Выход B: тейк у ближайшего сопротивления (низ следующей зоны), иначе как A.`);
  L.push(`R4 / R8 / R12 — вход на первой зелёной 1H свече, закрывшейся в зоне или выше, не позже 4 / 8 / 12 ч после минимума теста; касание не серое по Люси (спот + фьючи).`);
  L.push(`LIVE — как сейчас в боте (Люси + вход ≤ 1% над зоной); LOW — отскок от минимума с Люси.`);
  L.push(`Месяцы по Дубаю; ноябрь — проверка.`);
  const rooms: [string, (x: T) => boolean][] = [["все", () => true], ["до сопротивления ≥ 1R (6%)", (x) => x.room === null || x.room >= 6], ["до сопротивления ≥ 2R (12%)", (x) => x.room === null || x.room >= 12]];
  for (const v of ["LIVE", "R4", "R8", "R12", "LOW"] as V[]) {
    const xs = all.filter((x) => x.e.v === v);
    L.push(``, `${v}: сигналов ${xs.length} (${(xs.length / DAYS).toFixed(1)} в день)`);
    for (const [rn, rf] of rooms) {
      const ys = xs.filter(rf);
      for (const [en, pick] of [["A", (x: T) => x.a], ["B", (x: T) => x.b]] as const) {
        const vals = ys.map(pick).filter((r): r is NonNullable<Res> => r !== null).map((r) => r.pct);
        L.push(`  ${rn.padEnd(28)} выход ${en}: ${grp(vals)}`);
        L.push(`     по месяцам: ${byMonth(ys, pick)}`);
        L.push(`     как закрылись: ${howCount(ys, pick)}`);
      }
    }
  }
  L.push(``, `Монеты по именам с ${fmtT(HER_FROM)} (Дубай): вход, над зоной %, до сопротивления %, цвета Люси, итог A / B, пик:`);
  for (const x of all.filter((y) => SHOW.includes(y.symbol) && y.e.at >= HER_FROM).sort((p, q) => p.symbol.localeCompare(q.symbol) || p.e.at - q.e.at)) {
    const f = (r: Res) => (r ? `${r.pct >= 0 ? "+" : ""}${r2(r.pct)}% (${r.how})` : "идёт");
    L.push(`  ${x.symbol.replace("-USDT", "").padEnd(9)} ${x.e.v.padEnd(4)} ${fmtT(x.e.at)} · над зоной ${x.rd.entry_above_top_pct}% · до сопр. ${x.room ?? "—"}% · ${x.e.colour} · A ${f(x.a)} · B ${f(x.b)} · пик +${r2(x.up)}%`);
  }
  writeFileSync(join(OUT, "summary.txt"), L.join("\n") + "\n");
  writeCsv(join(OUT, "trades.csv"), all.map((x) => ({ symbol: x.symbol, variant: x.e.v, kind: x.e.kind, entry_utc: new Date(x.e.at).toISOString(), entry: x.e.entry, zone_bottom: x.e.level, zone_top: x.e.top, colours: x.e.colour, room_pct: x.room, result_a_pct: x.a ? r2(x.a.pct) : null, how_a: x.a?.how ?? "open", result_b_pct: x.b ? r2(x.b.pct) : null, how_b: x.b?.how ?? "open", peak_4d_pct: r2(x.up), ...x.rd })));
  writeFileSync(join(OUT, "errors.json"), JSON.stringify(errors, null, 1));
  console.log(L.slice(0, 40).join("\n"));
}

main().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });
