/**
 * Stealth Breakout by ERA and MAGMA (owner 2026-11-12: "ERA — натуральный пробой; взять метрики MAGMA и ERA,
 * подобрать оптимальные и изменить паттерн"). One run, everything at once.
 *
 * Events: every breakout of an ABNeon zone top (the live Stealth levels — computeSupportZones on closed 4H) on
 *   - 4H: a closed 4H candle closes above the zone top, the previous 4H close at/below it (the live crossing);
 *   - 1H: a closed 1H candle closes above the top of a zone of the closed 4H candles, the previous 1H close at/below.
 *   Several zones crossed at once → the highest is the level. No volume filter at the event: volume is a reading.
 * Every event carries every reading known at its close (no look-ahead):
 *   breakout candle: body, close position, close above the top %, zone width / pivots, zones crossed, room to the
 *     next resistance, tests of the top before (30 4H bars), base under the level (12 / 30 4H bars range width);
 *   volume (CoinGlass aggregated futures and spot, separately and summed): Welkin 20, Lucy (20 bars, grey under the
 *     120-bar average), ratio to the 20 / 120-bar average on the breakout candle (4H and 1H), the 6 bars before vs
 *     the 30 before them, blue+ bars of the last 12, 24h volume vs the 30-day day average, spot / futures 24h;
 *   takers: delta (buy − sell) / (buy + sell) on the breakout candle, the 12 h before, the 24 h; futures and spot;
 *   open interest (aggregated): change 4 / 24 / 72 h;
 *   trend: vs EMA50 / EMA200 4H, change 24h / 7d / 30d, from the 30-day high, ATR 4H %; BTC 24h / 7d / vs EMA50.
 * Outcome (entry at the breakout close, fee 0.1%): the live Stealth exit — stop −8%, B.U. after +8%, trailing from
 *   +15% at 10 p.p., 4 days; and take at the next resistance (bottom of the next zone above) for comparison;
 *   peak / worst 72 h, hours to +10%. One trade per coin at a time per timeframe.
 * Reference: ERA and MAGMA breakouts from --ref-from (default 28.10) — every one listed with all readings; the
 *   "natural" ones = peak 72 h ≥ +15%.
 * Calibration (data-grounded, no guessing): for every reading, the one-sided bound that keeps every natural
 *   reference (≥ their minimum / ≤ their maximum; colours: in their set) — each scored on all events
 *   (Sep–Oct = selection, November = check, never used to pick); then a greedy combination of up to 6 bounds,
 *   chosen on Sep–Oct only, each step reported with its November result. The current live Stealth
 *   (4H + futures Welkin M/W) and the plain crossing are reported the same way.
 * Out: summary.txt, events.csv (every event, every reading, both exits), errors.json.
 * Run (from artifacts/api-server; same caches as the ABNeon / Stealth studies):
 *   STUDY_CG_RPM=30 pnpm dlx tsx scripts/stealth-era-magma-study.ts --days 64 --out ../../reports/stealth-era-magma
 */
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { computeSupportZones, type SupportZone } from "../src/lib/stealth-abneon-detectors.js";
import { cgHistory, cgOiAgg, cgStats, withVolume, type VBar } from "./study-v2/cg.js";
import { type C, type Row, D1, H1, H4, M15, emaSeries, ensureDir, idxAtOrBefore, klines, lastClosed, parseArgs, trade, usdtSymbols, welkin, writeCsv } from "./study-v2/lib.js";

const args = parseArgs();
const DAYS = Number(args.get("days") ?? 64);
const OUT = args.get("out") ?? "stealth-era-magma";
const CACHE = args.get("cache") ?? "../../reports/.cache";
const LIMIT = Number(args.get("limit") ?? 10_000);
const ONLY = args.get("symbols")?.split(",").filter(Boolean) ?? null;
const REFS = (args.get("refs") ?? "ERA,MAGMA").split(",").map((s) => `${s}-USDT`);
const REF_FROM = Date.parse(args.get("ref-from") ?? "2026-10-28T00:00:00Z");
const NOV = Date.parse("2026-10-31T20:00:00Z"); // 1 Nov 00:00 Dubai
const HORIZON = 4 * D1, STOP = 0.92, NATURAL_PEAK = 15;
const r2 = (x: number | null | undefined) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 100) / 100);
const chg = (a?: number | null, b?: number | null) => (a && b ? ((a - b) / b) * 100 : null);

/** Welkin on n bars incl. the bar; with longN a bar under the longN-bar average is N (Lucy's VSA rule). */
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
const avgVol = (cs: C[], from: number, to: number) => {
  let s = 0, n = 0;
  for (let k = Math.max(0, from); k <= to; k++) { const v = cs[k]?.volume; if (v === undefined || !Number.isFinite(v)) return null; s += v; n++; }
  return n ? s / n : null;
};
const sumVol = (vb: Map<number, VBar> | null, a: number, b: number) => {
  if (!vb) return null;
  let s = 0, n = 0;
  for (let t = a; t <= b; t += H1) { const x = vb.get(t); if (x) { s += x.buy + x.sell; n++; } }
  return n ? s : null;
};
const delta = (vb: Map<number, VBar> | null, a: number, b: number) => {
  if (!vb) return null;
  let bu = 0, se = 0, n = 0;
  for (let t = a; t <= b; t += H1) { const x = vb.get(t); if (x) { bu += x.buy; se += x.sell; n++; } }
  return n && bu + se > 0 ? r2(((bu - se) / (bu + se)) * 100) : null;
};
const sumMaps = (a: Map<number, VBar> | null, b: Map<number, VBar> | null): Map<number, VBar> | null => {
  if (!a) return null;
  const out = new Map<number, VBar>();
  for (const [t, x] of a) { const y = b?.get(t); out.set(t, { time: t, buy: x.buy + (y?.buy ?? 0), sell: x.sell + (y?.sell ?? 0) }); }
  return out;
};

type Ev = { symbol: string; tf: "4h" | "1h"; at: number; candle: C; prevClose: number; level: SupportZone; crossed: number; next: SupportZone | null; zones: SupportZone[]; i4: number; i1: number };

/** Highest zone whose top the close crossed (prev close ≤ top < close). */
function crossing(zones: SupportZone[], prevClose: number, close: number) {
  const xs = zones.filter((z) => prevClose <= z.top && close > z.top).sort((a, b) => b.top - a.top);
  if (!xs.length) return null;
  const next = zones.filter((z) => z.bottom > close).sort((a, b) => a.bottom - b.bottom)[0] ?? null;
  return { level: xs[0]!, crossed: xs.length, next };
}

function readings(e: Ev, h4: C[], h1: C[], aggF: Map<number, VBar> | null, aggS: Map<number, VBar> | null, oi: Map<number, number> | null, btc4: C[]): Row {
  const r: Row = {};
  const c = e.candle, top = e.level.top, bottom = e.level.bottom;
  const rng = c.high - c.low;
  r.body_pct = r2(((c.close - c.open) / c.open) * 100);
  r.close_pos = rng > 0 ? r2((c.close - c.low) / rng) : null;
  r.upper_wick_pct = rng > 0 ? r2(((c.high - c.close) / rng) * 100) : null;
  r.above_top_pct = r2(((c.close - top) / top) * 100);
  r.zone_width_pct = r2(((top - bottom) / bottom) * 100);
  r.zone_pivots = e.level.count;
  r.zones_crossed = e.crossed;
  r.room_next_pct = e.next ? r2(((e.next.bottom - c.close) / c.close) * 100) : null;
  r.zones_within_20pct = e.zones.filter((z) => z.bottom > c.close && z.bottom <= c.close * 1.2).length;
  // tests of the top and the base under it (4H bars before the breakout bar)
  const i4 = e.i4;
  let tests = 0;
  for (let k = Math.max(0, i4 - 30); k < i4; k++) if (h4[k]!.high >= top * 0.99 && h4[k]!.close <= top) tests++;
  r.top_tests_30 = tests;
  for (const n of [12, 30]) {
    const seg = h4.slice(Math.max(0, i4 - n), i4);
    if (seg.length === n) {
      const hi = Math.max(...seg.map((x) => x.high)), lo = Math.min(...seg.map((x) => x.low));
      r[`base${n}_width_pct`] = r2(((hi - lo) / lo) * 100);
      r[`base${n}_low_vs_top_pct`] = r2(((lo - top) / top) * 100);
    }
  }
  // volume
  const tot = sumMaps(aggF, aggS);
  for (const [p, vb] of [["fut", aggF], ["spot", aggS], ["tot", tot]] as const) {
    if (!vb) { r[`${p}_have`] = 0; continue; }
    r[`${p}_have`] = 1;
    const v4 = withVolume(h4, vb, H4), v1 = withVolume(h1, vb, H1);
    const [cs, i] = e.tf === "4h" ? [v4, i4] : [v1, e.i1];
    r[`${p}_welkin`] = welkin(cs, i);
    r[`${p}_lucy`] = welkinWin(cs, i, 20, 120);
    const a20 = avgVol(cs, i - 20, i - 1), a120 = avgVol(cs, i - 120, i - 1), v = cs[i]?.volume;
    r[`${p}_vs20`] = a20 && v != null && Number.isFinite(v) ? r2(v / a20) : null;
    r[`${p}_vs120`] = a120 && v != null && Number.isFinite(v) ? r2(v / a120) : null;
    // 4H context, also for 1H events
    const j4 = e.tf === "4h" ? i4 : i4; // the last closed 4H bar at the event
    const pre6 = avgVol(v4, j4 - 6, j4 - 1), pre30 = avgVol(v4, j4 - 36, j4 - 7);
    r[`${p}_pre6_vs_prev30`] = pre6 && pre30 ? r2(pre6 / pre30) : null;
    let blue = 0, grey = 0;
    for (let k = j4 - 12; k < j4; k++) { const w = welkin(v4, k); if (w && "AOMW".includes(w)) blue++; if (w === "N") grey++; }
    r[`${p}_blue12_4h`] = blue;
    r[`${p}_grey12_4h`] = grey;
    const at = e.at - H1; // the last hour of the breakout candle
    const last24 = sumVol(vb, at - 23 * H1, at);
    const days: number[] = [];
    for (let d = 1; d <= 30; d++) { const x = sumVol(vb, at - (24 * d + 23) * H1, at - 24 * d * H1); if (x !== null) days.push(x); }
    r[`${p}_vol24_vs_30d`] = last24 !== null && days.length >= 20 ? r2(last24 / (days.reduce((a, b) => a + b, 0) / days.length)) : null;
    if (p !== "tot") {
      const t0 = e.at - (e.tf === "4h" ? H4 : H1);
      r[`${p}_tk_candle`] = delta(vb, t0, e.at - H1);
      r[`${p}_tk_pre12`] = delta(vb, t0 - 12 * H1, t0 - H1);
      r[`${p}_tk_24h`] = delta(vb, e.at - 24 * H1, e.at - H1);
    }
  }
  if (aggF && aggS) {
    const f = sumVol(aggF, e.at - 24 * H1, e.at - H1), s = sumVol(aggS, e.at - 24 * H1, e.at - H1);
    r.spot_vs_fut_24h = f && s !== null ? r2(s / f) : null;
  }
  if (oi) {
    const at = e.at - H1;
    r.oi_chg4h = r2(chg(oi.get(at), oi.get(at - 4 * H1)));
    r.oi_chg24h = r2(chg(oi.get(at), oi.get(at - 24 * H1)));
    r.oi_chg72h = r2(chg(oi.get(at), oi.get(at - 72 * H1)));
  }
  // trend
  const closes = h4.slice(0, i4 + 1).map((x) => x.close);
  const e50 = emaSeries(closes, 50).at(-1), e200 = emaSeries(closes, 200).at(-1);
  r.vs_ema50_4h_pct = e50 ? r2(((c.close - e50) / e50) * 100) : null;
  r.vs_ema200_4h_pct = e200 ? r2(((c.close - e200) / e200) * 100) : null;
  r.chg24h_pct = r2(chg(c.close, h4[i4 - 6]?.close));
  r.chg7d_pct = r2(chg(c.close, h4[i4 - 42]?.close));
  r.chg30d_pct = r2(chg(c.close, h4[i4 - 180]?.close));
  let hi30 = 0;
  for (let k = Math.max(0, i4 - 179); k <= i4; k++) hi30 = Math.max(hi30, h4[k]!.high);
  r.from_30d_high_pct = hi30 ? r2(((c.close - hi30) / hi30) * 100) : null;
  let atr = 0;
  for (let k = i4 - 13; k <= i4; k++) if (k > 0) atr += Math.max(h4[k]!.high - h4[k]!.low, Math.abs(h4[k]!.high - h4[k - 1]!.close), Math.abs(h4[k]!.low - h4[k - 1]!.close));
  r.atr4h_pct = r2((atr / 14 / c.close) * 100);
  const b4 = lastClosed(btc4, e.at, H4);
  if (b4 > 200) {
    const bc = btc4.slice(0, b4 + 1).map((x) => x.close), be50 = emaSeries(bc, 50).at(-1);
    r.btc_chg24h_pct = r2(chg(bc.at(-1), bc.at(-7)));
    r.btc_chg7d_pct = r2(chg(bc.at(-1), bc.at(-43)));
    r.btc_vs_ema50_4h_pct = be50 ? r2(((bc.at(-1)! - be50) / be50) * 100) : null;
  }
  return r;
}

type Res = { pct: number | null; hours: number | null };
type T = { e: Ev; rd: Row; live: Res; take: Res; peak72: number; worst72: number; h10: number | null };

function takeExit(m15: C[], from: number, entry: number, target: number | null): Res {
  if (target === null) return trade(m15, from, entry, entry * STOP, "trk", HORIZON);
  let s = entry * STOP, peak = entry;
  for (let i = idxAtOrBefore(m15, from - 1) + 1; i < m15.length; i++) {
    const c = m15[i]!;
    if (c.time >= from + HORIZON) break;
    if (c.low <= s) return { pct: (Math.min(s, c.open) / entry - 1) * 100 - 0.1, hours: (c.time + M15 - from) / H1 };
    if (c.high >= target) return { pct: (target / entry - 1) * 100 - 0.1, hours: (c.time + M15 - from) / H1 };
    peak = Math.max(peak, c.high);
    if ((peak / entry - 1) * 100 >= 8) s = Math.max(s, entry);
  }
  if (from + HORIZON > Date.now()) return { pct: null, hours: null };
  const j = idxAtOrBefore(m15, from + HORIZON - M15);
  return j >= 0 ? { pct: (m15[j]!.close / entry - 1) * 100 - 0.1, hours: HORIZON / H1 } : { pct: null, hours: null };
}

async function main() {
  const now = Math.floor(Date.now() / M15) * M15, from = now - DAYS * D1;
  ensureDir(OUT); ensureDir(CACHE);
  const listed = ONLY ?? (await usdtSymbols(CACHE)).slice(0, LIMIT);
  const symbols = [...new Set([...REFS, ...listed])];
  const btc4 = await klines(CACHE, "BTC-USDT", "4h", from - 400 * H4, now);
  const errors: Record<string, string> = {};
  const all: T[] = [];
  let done = 0;
  for (const symbol of symbols) {
    try {
      const h4 = await klines(CACHE, symbol, "4h", from - 720 * H4, now);
      const h1 = await klines(CACHE, symbol, "1h", from - 800 * H1, now);
      const m15 = await klines(CACHE, symbol, "15m", from - 8 * M15, now);
      if (h4.length < 260 || h1.length < 200 || m15.length < 100) { errors[symbol] = "short_history"; continue; }
      const aggF = await cgHistory(CACHE, symbol, "aggfut", from - 720 * H4, now);
      if (!aggF) { errors[symbol] = "no_aggregated_futures"; continue; }
      const aggS = await cgHistory(CACHE, symbol, "aggspot", from - 40 * D1, now);
      const evs: Ev[] = [];
      const zonesAt = new Map<number, SupportZone[]>();
      const zonesFor = (i4: number) => {
        let z = zonesAt.get(i4);
        if (!z) { z = computeSupportZones(h4.slice(Math.max(0, i4 - 639), i4 + 1)); zonesAt.set(i4, z); }
        return z;
      };
      for (let i4 = 1; i4 < h4.length; i4++) {
        const bar = h4[i4]!, closeAt = bar.time + H4;
        if (closeAt < from || closeAt > now || i4 < 250) continue;
        const zones = zonesFor(i4);
        const x = crossing(zones, h4[i4 - 1]!.close, bar.close);
        if (x) evs.push({ symbol, tf: "4h", at: closeAt, candle: bar, prevClose: h4[i4 - 1]!.close, level: x.level, crossed: x.crossed, next: x.next, zones, i4, i1: idxAtOrBefore(h1, closeAt - H1) });
      }
      for (let i1 = 1; i1 < h1.length; i1++) {
        const bar = h1[i1]!, closeAt = bar.time + H1;
        if (closeAt < from || closeAt > now || closeAt % H4 === 0) continue; // a 4H close is the 4H event
        const i4 = lastClosed(h4, closeAt, H4);
        if (i4 < 250) continue;
        const zones = zonesFor(i4);
        const x = crossing(zones, h1[i1 - 1]!.close, bar.close);
        if (x) evs.push({ symbol, tf: "1h", at: closeAt, candle: bar, prevClose: h1[i1 - 1]!.close, level: x.level, crossed: x.crossed, next: x.next, zones, i4, i1 });
      }
      if (!evs.length) continue;
      const oi = await cgOiAgg(CACHE, symbol, from - 10 * D1, now);
      evs.sort((a, b) => a.at - b.at);
      const busy: Record<string, number> = { "4h": -Infinity, "1h": -Infinity };
      for (const e of evs) {
        if (e.at < busy[e.tf]!) continue;
        const entry = e.candle.close;
        const live = trade(m15, e.at, entry, entry * STOP, "trk", HORIZON);
        const take = takeExit(m15, e.at, entry, e.next ? e.next.bottom : null);
        busy[e.tf] = live.hours !== null ? e.at + live.hours * H1 : e.at + HORIZON;
        let pk = 0, wr = 0, h10: number | null = null;
        for (let i = idxAtOrBefore(m15, e.at - 1) + 1; i < m15.length && m15[i]!.time < e.at + 72 * H1; i++) {
          const c = m15[i]!;
          pk = Math.max(pk, (c.high / entry - 1) * 100);
          wr = Math.min(wr, (c.low / entry - 1) * 100);
          if (h10 === null && c.high >= entry * 1.1) h10 = (c.time + M15 - e.at) / H1;
        }
        let rd: Row = {};
        try { rd = readings(e, h4, h1, aggF, aggS, oi, btc4); } catch (err) { rd = { readings_error: String(err).slice(0, 80) }; }
        all.push({ e, rd, live, take, peak72: pk, worst72: wr, h10 });
      }
    } catch (err) { errors[symbol] = String(err).slice(0, 160); }
    if (++done % 25 === 0) console.error(`монеты ${done}/${symbols.length}, событий ${all.length} · CoinGlass ${cgStats.requests} (429: ${cgStats.r429})`);
  }

  // ── report ──
  const fmtT = (t: number) => { const d = new Date(t + 4 * H1), p = (n: number) => String(n).padStart(2, "0"); return `${p(d.getUTCDate())}.${p(d.getUTCMonth() + 1)} ${p(d.getUTCHours())}:00`; };
  const score = (xs: T[]) => {
    const v = xs.map((x) => x.live.pct).filter((p): p is number => p !== null);
    const tk = xs.map((x) => x.take.pct).filter((p): p is number => p !== null);
    const s = v.reduce((a, b) => a + b, 0);
    return { n: v.length, avg: v.length ? s / v.length : null, sum: s, win: v.length ? (100 * v.filter((p) => p > 0).length) / v.length : null, take: tk.length ? tk.reduce((a, b) => a + b, 0) / tk.length : null, p10: xs.length ? (100 * xs.filter((x) => x.peak72 >= 10).length) / xs.length : null };
  };
  const line = (xs: T[]) => {
    const a = score(xs.filter((x) => x.e.at < NOV)), b = score(xs.filter((x) => x.e.at >= NOV));
    const f = (s: ReturnType<typeof score>) => `n ${s.n} · ср ${r2(s.avg)}% · сумма ${Math.round(s.sum)}% · в плюсе ${r2(s.win)}% · +10% за 72ч ${r2(s.p10)}% · тейк у сопр. ${r2(s.take)}%`;
    return `сен–окт: ${f(a)}\n      ноябрь:  ${f(b)}`;
  };
  const L: string[] = [];
  L.push(`Stealth по ERA и MAGMA · ${new Date(from).toISOString().slice(0, 10)} … ${new Date(now).toISOString().slice(0, 10)} · монет ${symbols.length}, ошибок ${Object.keys(errors).length}, событий ${all.length}`);
  L.push(`Событие = закрытие 4H / 1H выше верха зоны ABNeon (предыдущее закрытие на/под ним). Вход на закрытии, стоп −8%, Б.У. +8%, трейл с +15% на 10 п.п., 4 дня, комиссия 0.1%. Сен–окт — подбор, ноябрь — проверка (в подборе не участвует).`);
  const isLive = (x: T) => x.e.tf === "4h" && (x.rd.fut_welkin === "M" || x.rd.fut_welkin === "W");
  for (const [name, f] of [["все пробои 4H", (x: T) => x.e.tf === "4h"], ["все пробои 1H", (x: T) => x.e.tf === "1h"], ["нынешний Stealth (4H, фьючи Welkin M/W)", isLive]] as [string, (x: T) => boolean][]) {
    L.push(``, `${name}:`, `      ${line(all.filter(f))}`);
  }
  // reference
  const ref = all.filter((x) => REFS.includes(x.e.symbol) && x.e.at >= REF_FROM);
  const natural = ref.filter((x) => x.peak72 >= NATURAL_PEAK);
  L.push(``, `Эталон: ${REFS.map((s) => s.replace("-USDT", "")).join(", ")} с ${fmtT(REF_FROM)} (Дубай) — все пробои; «натуральный» = пик за 72ч ≥ +${NATURAL_PEAK}%:`);
  const keys = [...new Set(all.flatMap((x) => Object.keys(x.rd)))];
  for (const x of ref) {
    L.push(`  ${x.e.symbol.replace("-USDT", "")} ${x.e.tf} ${fmtT(x.e.at)} · ${x.peak72 >= NATURAL_PEAK ? "НАТУРАЛЬНЫЙ" : "—"} · пик72 +${r2(x.peak72)}% · худшее72 ${r2(x.worst72)}% · итог ${r2(x.live.pct) ?? "идёт"}% · тейк ${r2(x.take.pct) ?? "идёт"}%`);
    L.push(`     ${keys.map((k) => `${k}=${x.rd[k] ?? "—"}`).join(" ")}`);
  }
  if (!natural.length) L.push(`  натуральных пробоев нет — подбор не делается`);
  // single bounds
  type Bound = { key: string; desc: string; f: (x: T) => boolean };
  const bounds: Bound[] = [];
  for (const k of keys) {
    const vals = natural.map((x) => x.rd[k]);
    if (!vals.length || vals.some((v) => v === null || v === undefined)) continue;
    if (vals.every((v) => typeof v === "number")) {
      const nums = vals as number[];
      const lo = Math.min(...nums), hi = Math.max(...nums);
      bounds.push({ key: k, desc: `${k} ≥ ${lo}`, f: (x) => typeof x.rd[k] === "number" && (x.rd[k] as number) >= lo });
      bounds.push({ key: k, desc: `${k} ≤ ${hi}`, f: (x) => typeof x.rd[k] === "number" && (x.rd[k] as number) <= hi });
    } else {
      const set = new Set(vals.map(String));
      bounds.push({ key: k, desc: `${k} ∈ {${[...set].join(",")}}`, f: (x) => set.has(String(x.rd[k])) });
    }
  }
  for (const [tfName, tff] of [["4H", (x: T) => x.e.tf === "4h"], ["1H", (x: T) => x.e.tf === "1h"], ["4H+1H", () => true]] as [string, (x: T) => boolean][]) {
    if (!natural.some(tff)) continue;
    const base = all.filter(tff);
    const train = base.filter((x) => x.e.at < NOV);
    const scored = bounds.map((b) => ({ b, s: score(train.filter(b.f)) })).filter((x) => x.s.n >= 100 && x.s.avg !== null).sort((p, q) => q.s.avg! - p.s.avg!);
    L.push(``, `Одиночные границы (${tfName}), держат все натуральные эталоны, лучшие 40 по сен–окт (n ≥ 100):`);
    for (const { b } of scored.slice(0, 40)) L.push(`  ${b.desc}`, `      ${line(base.filter(b.f))}`);
    // greedy
    L.push(``, `Жадная комбинация (${tfName}): шаг за шагом граница, лучшая по сен–окт (n ≥ 60), с проверкой на ноябре:`);
    let cur = base, used: Bound[] = [];
    for (let step = 1; step <= 6; step++) {
      const trainCur = cur.filter((x) => x.e.at < NOV);
      const cand = bounds.filter((b) => !used.some((u) => u.key === b.key)).map((b) => ({ b, s: score(trainCur.filter(b.f)) }))
        .filter((x) => x.s.n >= 60 && x.s.avg !== null).sort((p, q) => q.s.avg! - p.s.avg!)[0];
      if (!cand) break;
      used = [...used, cand.b];
      cur = cur.filter(cand.b.f);
      L.push(`  ${step}. + ${cand.b.desc}`, `      ${line(cur)}`, `      эталоны внутри: ${cur.filter((x) => natural.includes(x)).map((x) => `${x.e.symbol.replace("-USDT", "")} ${fmtT(x.e.at)}`).join(", ")}`);
    }
  }
  writeFileSync(join(OUT, "summary.txt"), L.join("\n") + "\n");
  writeCsv(join(OUT, "events.csv"), all.map((x) => ({
    symbol: x.e.symbol, tf: x.e.tf, close_utc: new Date(x.e.at).toISOString(), entry: x.e.candle.close, level_top: x.e.level.top, level_bottom: x.e.level.bottom,
    live_pct: r2(x.live.pct), live_hours: r2(x.live.hours), take_pct: r2(x.take.pct), peak72_pct: r2(x.peak72), worst72_pct: r2(x.worst72), hours_to_plus10: r2(x.h10),
    reference: REFS.includes(x.e.symbol) && x.e.at >= REF_FROM ? (x.peak72 >= NATURAL_PEAK ? "natural" : "ref") : "", ...x.rd,
  })));
  writeFileSync(join(OUT, "errors.json"), JSON.stringify(errors, null, 1));
  console.log(L.slice(0, 30).join("\n"));
}

main().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });
