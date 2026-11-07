/**
 * ABNEON 1D STUDY — the ABNeon support bounce on the closed UTC DAY (owner 2026-11-07: AIO, ELSA charts),
 * everything in one run, before it goes live. Offline from the breakout study's cache (no new downloads).
 *
 * Event = a closed UTC day (built from its six BingX-futures 4H bars) that OPENED above the bottom of a Neon
 * support zone, DIPPED into it (low ≤ zone top +1%) and CLOSED back at/above the zone bottom −1%, and did not
 * close above the next Neon resistance (that is a breakout = Stealth). Several zones → the highest. Zones as
 * they stood when the day opened. Bullish or not is a column (bull = 1 is the live rule in
 * src/lib/abneon-daily-bounce.ts; prod_match checks the backtest against that very function).
 * Level sets ("variant"):
 *   V0  as live: BingX futures 4H, 6 zones, minus zones broken after their last pivot (22.10 rule)
 *   V1  12 zones        V1K  6 zones, broken zones kept (no 22.10 rule)
 *   V2  levels from BingX SPOT 4H     V3  Binance SPOT 4H     V4  Binance FUTURES 4H
 * V1–V4 rows are kept only when V0 has no event on the same coin and day. fired = the bot would enter
 * (one open trade per coin per variant, live rule bull = 1); fired = 0 rows are kept.
 *
 * For EVERY event (same columns for all variants):
 *  - THE DAY: anatomy / VSA / Welkin (BingX and aggregated volume), how deep into the zone, close vs zone,
 *    days in the zone before (first touch or a multi-day test), the reclaim above the zone top.
 *  - BEFORE: the drop into the zone (1H approach, 3-day / 7-day move, from the 30-day high), level history.
 *  - VOLUME ON 8 SOURCES around the 1H bars of the day: before the first touch (12 / 24 bars: blue, grey,
 *    climax, stopping volume, effort, no supply), the touch / deepest / last bar, the 4H bars, takers, CVD.
 *  - THE LIVE ABNEON GATE: blue 1H bars of 12 before the first touch on aggregated futures volume
 *    (abneon-volume-gate.ts, the live function) → gate_blue12, gate_pass (≥ 11).
 *  - DERIVATIVES: OI, liquidations, long/short, funding.   AUTO RANGE 15m/1H/4H/1D: down-deviations, the
 *    range bottom on the zone.   WYCKOFF / ICT on the day and the 1H.   MARKET: breadth, alts, BTC/ETH,
 *    excess vs market.
 *  - ENTRY A (day close, as live), B (retest of the zone that holds, 72 h), C (above the day's high);
 *    stops −8% / under the zone / ATR 1.5 / 2.0 × exits trk (live), be5trk, tp5/8/10/15, with hours (deposit).
 *  - champions_*.csv: every +20% start (before −8%, 72 h) — was there a 1D bounce before it, was price on a
 *    support zone at the start (the bounces the 1D rule misses).
 *
 * Run (from artifacts/api-server), offline, three processes in parallel (cache of the breakout study):
 *   STUDY_OFFLINE=1 pnpm dlx tsx scripts/abneon-1d-study.ts --part 1/3 --days 60 --out ../../reports/abneon-1d-study
 *   (… --part 2/3 …, … --part 3/3 …)
 */
import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { liveSupportZones } from "../src/lib/stealth-abneon-detectors.js";
import { evaluateAbneonDailyBounce } from "../src/lib/abneon-daily-bounce.js";
import { ABNEON_PRE_TOUCH_BLUE_MIN, preTouchBlueCount } from "../src/lib/abneon-volume-gate.js";
import { dailyFrom4h } from "../src/lib/stealth-neon-level-breakout.js";
import { SOURCES, type Source, type VBar, cgHistory, rangeReadings, resetRangeMemo, volumeReadings, withVolume } from "./study-v2/cg.js";
import { cgSeries, derivReadings, type NSeries } from "./study-v2/cg2.js";
import { bingxSpot4h, cgPrice } from "./study-v2/venues.js";
import {
  type C, type Row, type Series, D1, D7, H1, H4, M15, Market,
  addMarket, anatomy, approach, emaSeries, ensureDir, funding, fundingAt, grid,
  idxAtOrBefore, klines, lastClosed, majors, nearRound, parseArgs, path, pct, prevWeek, series, session,
  trade, usdtSymbols, writeCsv, wyIct,
} from "./study-v2/lib.js";

const args = parseArgs();
const DAYS = Number(args.get("days") ?? 60);
const OUT = args.get("out") ?? "../../reports/abneon-1d-study";
const CACHE = args.get("cache") ?? "../../reports/.cache";
const LIMIT = Number(args.get("limit") ?? 10_000);
const ONLY = args.get("symbols")?.split(",").filter(Boolean) ?? null;
const PART = (args.get("part") ?? "1/1").split("/").map(Number) as [number, number];
const ZONE_BARS = 700;
const H4_BACK = 720, H1_BACK = 400;
const TOL = 0.01;

type Lv = "V1" | "V1K" | "V2" | "V3" | "V4";
type Coin = {
  h4: C[]; h1: C[]; m15: C[]; d1: C[]; fund: Awaited<ReturnType<typeof funding>>;
  cg: Record<Source, Map<number, VBar> | null>;
  oi: NSeries | null; liq: NSeries | null; ls: NSeries | null;
  spot4: C[]; bnSpot4: C[]; bnFut4: C[];
};
async function loadCoin(symbol: string, from: number, now: number): Promise<Coin> {
  const h4 = await klines(CACHE, symbol, "4h", from - H4_BACK * H4, now);
  const h1 = await klines(CACHE, symbol, "1h", from - H1_BACK * H1, now);
  const m15 = await klines(CACHE, symbol, "15m", from - 8 * M15, now);
  const d1 = await klines(CACHE, symbol, "1d", from - 320 * D1, now).catch(() => [] as C[]);
  const fund = await funding(CACHE, symbol, from - 3 * D1, now);
  const cg = {} as Coin["cg"];
  for (const src of SOURCES) cg[src] = await cgHistory(CACHE, symbol, src, from - H1_BACK * H1, now);
  const oi = await cgSeries(CACHE, symbol, "oi", from - H1_BACK * H1, now);
  const liq = await cgSeries(CACHE, symbol, "liq", from - H1_BACK * H1, now);
  const ls = await cgSeries(CACHE, symbol, "ls", from - H1_BACK * H1, now);
  const spot4 = await bingxSpot4h(CACHE, symbol, from - H4_BACK * H4, now);
  const bnSpot4 = await cgPrice(CACHE, "spot", symbol, from - H4_BACK * H4, now);
  const bnFut4 = await cgPrice(CACHE, "futures", symbol, from - H4_BACK * H4, now);
  return { h4, h1, m15, d1, fund, cg, oi, liq, ls, spot4, bnSpot4, bnFut4 };
}
type Ctx = { btc: { h1: C[]; h4: C[] }; eth: { h1: C[]; h4: C[] } };
type Z = { top: number; bottom: number; count: number };
type Ev = { day: C; prevDays: C[]; level: Z; touched: Z[]; nextResistance: Z | null; zones: Z[] };

/** The bounce rule on one level set: zones from `src` (as of the day's open), the day from BingX futures. */
function bounceOn(src: C[], h4: C[], bi: number, opts: { maxZones?: number; keepBroken?: boolean }): Ev | null {
  const start = h4[bi]!.time, t = start + H4;
  if (t % D1 !== 0) return null;
  const days = dailyFrom4h(h4.slice(Math.max(0, bi - 70), bi + 1));
  const day = days.at(-1);
  if (!day || day.time !== t - D1) return null;
  const hist = src.filter((c) => c.time + H4 <= day.time).slice(-ZONE_BARS);
  if (hist.length < 60) return null;
  const zones = liveSupportZones(hist, opts).map((z) => ({ top: z.top, bottom: z.bottom, count: z.count })).sort((a, b) => a.bottom - b.bottom);
  const touched = zones
    .filter((x) => day.open >= x.bottom && day.low <= x.top * (1 + TOL) && day.close >= x.bottom * (1 - TOL))
    .sort((a, b) => b.top - a.top);
  const level = touched[0];
  if (!level) return null;
  const next = zones.filter((x) => x.bottom > level.top).sort((a, b) => a.bottom - b.bottom)[0] ?? null;
  if (next && day.close > next.top) return null;
  return { day, prevDays: days.slice(0, -1), level, touched, nextResistance: next, zones };
}

type Pre = {
  S1: Series; S4: Series; S15: Series; SD: Series; days: C[];
  vol: Record<"bx" | Source, { h1: C[]; h4: C[]; vb: Map<number, VBar> | null }>;
  aggSD: Series;
};
function prepare(coin: Coin): Pre {
  const days = dailyFrom4h(coin.h4);
  const vol = { bx: { h1: coin.h1, h4: coin.h4, vb: null } } as Pre["vol"];
  for (const s of SOURCES) vol[s] = { h1: withVolume(coin.h1, coin.cg[s], H1), h4: withVolume(coin.h4, coin.cg[s], H4), vb: coin.cg[s] };
  return { S1: series(coin.h1), S4: series(coin.h4), S15: series(coin.m15), SD: series(days), days, vol, aggSD: series(dailyFrom4h(vol.aggfut.h4)) };
}

function features(symbol: string, variant: string, coin: Coin, P: Pre, ev: Ev, bi: number, ctx: Ctx): Row {
  const { h4, h1, m15 } = coin;
  const t = h4[bi]!.time + H4;
  const day = ev.day;
  const entry = day.close;
  const top = ev.level.top, bottom = ev.level.bottom;
  const dayIdx = idxAtOrBefore(P.SD.cs, day.time);
  const base4 = idxAtOrBefore(h4, day.time - 1);
  const h1Start = idxAtOrBefore(h1, day.time);
  const i1 = lastClosed(h1, t, H1);
  // The 1H bars of the day: first touch of the zone, the deepest bar, the last bar.
  let first = -1, deep = h1Start;
  for (let k = Math.max(0, h1Start); k <= i1; k++) {
    const b = h1[k]!;
    if (b.time < day.time) continue;
    if (first < 0 && b.low <= top * 1.002) first = k;
    if (b.low < h1[deep]!.low) deep = k;
  }
  if (first < 0) first = deep;

  // The live gate (same function as production), aggregated futures volume.
  const aggUsd = new Map<number, number>();
  for (const [time, b] of coin.cg.aggfut ?? new Map()) aggUsd.set(time, b.buy + b.sell);
  const gate = coin.cg.aggfut
    ? preTouchBlueCount({ candles1h: h1.slice(0, i1 + 1), aggUsdByTime: aggUsd, armCandleTime: day.time, triggerCandleTime: h1[i1]!.time, zoneTop: top })
    : ({ ok: false, reason: "no_aggregated_volume", blue: null } as const);

  // Days in the zone before this one (a multi-day test) and the reclaim above the zone top.
  let daysInZone = 0;
  for (let k = ev.prevDays.length - 1; k >= 0 && daysInZone < 15; k--) {
    const d = ev.prevDays[k]!;
    if (d.low <= top * (1 + TOL) && d.close >= bottom * (1 - 3 * TOL)) daysInZone++;
    else break;
  }
  const pd = ev.prevDays.at(-1);
  let above = 0; // 4H bars closing above the zone before the day (how long price stood above before coming down)
  for (let k = base4; k >= 0 && h4[k]!.close > top && above < 180; k--) above++;

  // Level history (4H): earlier touches from above and how they ended.
  let prevTests = 0, prevHeld = 0, prevBroke = 0, firstTestT: number | null = null, lastTestT: number | null = null;
  for (let k = Math.max(1, base4 - ZONE_BARS); k < base4 - 18; k++) {
    const b = h4[k]!;
    if (b.low <= top && b.close >= bottom) { if (firstTestT === null) firstTestT = b.time; lastTestT = b.time; }
    if (b.low <= top && h4[k - 1]!.low > top) {
      prevTests++;
      const base = b.close;
      for (let j = k + 1; j <= k + 18; j++) {
        if (h4[j]!.low <= base * 0.92) { prevBroke++; break; }
        if (h4[j]!.high >= base * 1.1) { prevHeld++; break; }
      }
    }
  }
  const c4 = h4.slice(0, bi + 1);
  const dZones = liveSupportZones(dailyFrom4h(c4).slice(-200));
  const e200 = emaSeries(c4.slice(-400).map((c) => c.close), 200).at(-1) ?? null;
  const e50 = emaSeries(c4.slice(-400).map((c) => c.close), 50).at(-1) ?? null;
  const pw = prevWeek(h4, t);
  const last180 = c4.slice(-180);
  const hi30 = Math.max(...last180.map((c) => c.high)), lo30 = Math.min(...last180.map((c) => c.low));
  const vol24 = h1.slice(Math.max(0, i1 - 23), i1 + 1).reduce((a, c) => a + c.volume * c.close, 0);
  const vol7d = h1.slice(Math.max(0, i1 - 167), i1 + 1).reduce((a, c) => a + c.volume * c.close, 0) / 7;
  const atr4h = P.S4.atr[bi] ?? null;
  const f = fundingAt(coin.fund, t);
  const belowZone = ev.zones.filter((z) => z.top < bottom).sort((a, b) => b.top - a.top)[0] ?? null;
  const spotBar = coin.spot4.find((c) => c.time === h4[bi]!.time);

  // After the day (management readings, never filters).
  let retestH: number | null = null, retestHeld: number | null = null, closeUnderH: number | null = null;
  for (let k = i1 + 1; k < h1.length && h1[k]!.time < t + 72 * H1; k++) {
    const b = h1[k]!;
    if (retestH === null && b.low <= top * 1.003) { retestH = (b.time + H1 - t) / H1; retestHeld = b.close >= bottom ? 1 : 0; }
    if (closeUnderH === null && b.close < bottom * (1 - TOL)) closeUnderH = (b.time + H1 - t) / H1;
  }

  // Entry variants × stops × exits.
  const stopsFor = (e: number) => ({
    s8: e * 0.92,
    struct: bottom * 0.99 < e * 0.997 ? bottom * 0.99 : null,
    atr15: atr4h ? e * (1 - (1.5 * atr4h) / 100) : null,
    atr20: atr4h ? e * (1 - (2 * atr4h) / 100) : null,
  });
  const none = { s8: null, struct: null, atr15: null, atr20: null };
  let bFrom: number | null = null, bEntry: number | null = null;
  for (let k = i1 + 1; k < h1.length && h1[k]!.time < t + 72 * H1; k++) {
    const b = h1[k]!;
    if (b.close < bottom * (1 - TOL)) break;
    if (b.low <= top * 1.003 && b.close >= bottom && b.close > b.open) { bFrom = b.time + H1; bEntry = b.close; break; }
  }
  let cFrom: number | null = null, cEntry: number | null = null;
  for (let i = idxAtOrBefore(m15, t - 1) + 1; i < m15.length && m15[i]!.time < t + 72 * H1; i++) {
    const b = m15[i]!;
    if (b.high > day.high) { cFrom = b.time; cEntry = Math.max(day.high, b.open); break; }
  }

  const vRows: Row = {};
  const i4 = lastClosed(h4, t, H4);
  for (const k of ["bx", ...SOURCES] as const) {
    const v = P.vol[k];
    Object.assign(vRows, volumeReadings(k, v.h1, v.h4, first, deep, i1, i4, v.vb, t));
  }
  const aggDays = dailyFrom4h(P.vol.aggfut.h4);
  const aggIdx = idxAtOrBefore(aggDays, day.time);
  const aggOk = aggIdx >= 60 && aggDays.slice(Math.max(0, aggIdx - 300), aggIdx + 1).every((c) => Number.isFinite(c.volume));
  const wyAgg = aggOk ? wyIct("dayagg", aggDays, aggIdx, top, bottom) : {};
  const priceAt = (time: number) => { const i = lastClosed(h1, time, H1); return i >= 0 ? h1[i]!.close : null; };
  const range = day.high - day.low;

  return {
    variant, symbol, tf: "1d", fired: 0,
    time_utc: new Date(t).toISOString(), entry_time_ms: t, entry,
    ...session(t),
    // the day vs the zone
    bull: day.close > day.open ? 1 : 0,
    zone_bottom: bottom, zone_top: top, zone_pivots: ev.level.count, zone_height_pct: pct(top, bottom),
    zones_touched: ev.touched.length,
    zone_rank_from_bottom: ev.zones.filter((z) => z.top < bottom).length,
    open_above_top_pct: pct(day.open, top),
    low_vs_top_pct: pct(day.low, top), low_vs_bottom_pct: pct(day.low, bottom),
    close_vs_top_pct: pct(entry, top), close_vs_bottom_pct: pct(entry, bottom),
    close_above_top: entry > top ? 1 : 0,
    swept_below: day.low < bottom ? 1 : 0,
    day_lower_wick_share: range > 0 ? (Math.min(day.open, day.close) - day.low) / range : null,
    days_in_zone_before: daysInZone,
    prev_day_bull: pd ? (pd.close > pd.open ? 1 : 0) : null,
    prev_day_close_vs_top_pct: pd ? pct(pd.close, top) : null,
    room_to_next_resistance_pct: ev.nextResistance ? pct(ev.nextResistance.bottom, entry) : null,
    next_resistance_pivots: ev.nextResistance?.count ?? null,
    next_support_below_pct: belowZone ? pct(entry, belowZone.top) : null,
    zones_total: ev.zones.length,
    spot_basis_pct: spotBar ? pct(spotBar.close, h4[bi]!.close) : null,
    // the live gate
    gate_blue12: gate.ok ? gate.blue : null,
    gate_reason: gate.ok ? "ok" : gate.reason,
    gate_pass: gate.ok && gate.blue >= ABNEON_PRE_TOUCH_BLUE_MIN ? 1 : 0,
    first_touch_hour: first >= 0 ? (h1[first]!.time - day.time) / H1 : null,
    deepest_hour: (h1[deep]!.time - day.time) / H1,
    // before
    bars_above_zone_before: above,
    drop_3d_pct: pct(day.open, Math.max(...h4.slice(Math.max(0, base4 - 17), base4 + 1).map((c) => c.high))),
    ...approach("pre", P.S1, first, "down"),
    // the day and the hours
    ...anatomy("day", P.SD, dayIdx),
    ...wyIct("day", P.SD.cs, dayIdx, top, bottom),
    ...anatomy("dayagg", P.aggSD, idxAtOrBefore(P.aggSD.cs, day.time)),
    ...Object.fromEntries(Object.entries(wyAgg).filter(([k]) => k.includes("_wy_"))),
    ...anatomy("h1last", P.S1, i1),
    ...wyIct("h1", h1, i1, top, bottom),
    ...anatomy("h4last", P.S4, bi),
    // volume sources
    ...vRows,
    // derivatives
    ...derivReadings(coin.oi, coin.liq, coin.ls, day.time, t, priceAt),
    funding_last_pct: f.last, funding_avg3_pct: f.avg3,
    // Auto Range (down-deviations, the range bottom on the zone)
    ...rangeReadings("15m", m15, t, bottom, top, D1, 700),
    ...rangeReadings("1h", h1, t, bottom, top, D1, 500),
    ...rangeReadings("4h", h4, t, bottom, top, 72 * H1, 700),
    ...rangeReadings("1d", coin.d1, t, bottom, top, D7, 300),
    // context
    atr4h_pct: atr4h, atr1h_pct: P.S1.atr[i1] ?? null,
    price_24h_pct: pct(entry, h1[i1 - 24]?.close), price_7d_pct: pct(entry, h1[i1 - 168]?.close),
    from_high30d_pct: pct(entry, hi30), from_low30d_pct: pct(entry, lo30),
    vs_ema50_4h_pct: pct(entry, e50), vs_ema200_4h_pct: pct(entry, e200),
    vol24h_vs_7d: vol7d > 0 ? vol24 / vol7d : null, vol24h_usd_bingx: vol24,
    lvl_prev_tests: prevTests, lvl_prev_held: prevHeld, lvl_prev_broke: prevBroke,
    lvl_first_test_days_ago: firstTestT !== null ? (t - firstTestT) / D1 : null,
    lvl_last_test_days_ago: lastTestT !== null ? (t - lastTestT) / D1 : null,
    conf_1d_zone: dZones.some((z) => z.bottom <= top * 1.01 && z.top >= bottom * 0.99) ? 1 : 0,
    conf_ema200_4h_pct: e200 ? Math.abs(pct(top, e200) ?? 99) : null,
    conf_round_pct: nearRound((top + bottom) / 2),
    conf_prev_week_low_pct: pw.low ? Math.abs(pct((top + bottom) / 2, pw.low) ?? 99) : null,
    ...majors("btc", ctx.btc.h1, ctx.btc.h4, t),
    ...majors("eth", ctx.eth.h1, ctx.eth.h4, t),
    // after
    post_retest_hours: retestH, post_retest_held: retestHeld, post_close_under_zone_hours: closeUnderH,
    // path and trades
    ...path(m15, t, entry, atr4h),
    xA_filled: 1, xA_entry: entry, xA_delay_h: 0,
    ...grid("xA", m15, t, entry, stopsFor(entry)),
    xB_filled: bEntry ? 1 : 0, xB_entry: bEntry, xB_delay_h: bFrom !== null ? (bFrom - t) / H1 : null,
    ...grid("xB", m15, bFrom, bEntry, bEntry ? stopsFor(bEntry) : none),
    xC_filled: cEntry ? 1 : 0, xC_entry: cEntry, xC_delay_h: cFrom !== null ? (cFrom - t) / H1 : null,
    ...grid("xC", m15, cFrom, cEntry, cEntry ? stopsFor(cEntry) : none),
  };
}

function simulate(symbol: string, coin: Coin, from: number, now: number, ctx: Ctx): { rows: Row[]; champions: Row[]; dup: Record<string, number>; prodMismatch: number } {
  const { h4, m15 } = coin;
  resetRangeMemo();
  const P = prepare(coin);
  const rows: Row[] = [];
  const dup: Record<string, number> = { V1: 0, V1K: 0, V2: 0, V3: 0, V4: 0 };
  let prodMismatch = 0;
  const busy: Record<string, number> = { V0: -Infinity, V1: -Infinity, V1K: -Infinity, V2: -Infinity, V3: -Infinity, V4: -Infinity };
  const evTimes: { t: number; v: string; bull: number }[] = [];
  const srcOf: Record<Lv, { cs: C[]; opts: { maxZones?: number; keepBroken?: boolean } }> = {
    V1: { cs: h4, opts: { maxZones: 12 } }, V1K: { cs: h4, opts: { keepBroken: true } },
    V2: { cs: coin.spot4, opts: {} }, V3: { cs: coin.bnSpot4, opts: {} }, V4: { cs: coin.bnFut4, opts: {} },
  };
  for (let start = Math.ceil(from / H4) * H4; start + H4 <= now; start += H4) {
    const t = start + H4;
    if (t % D1 !== 0) continue;
    const bi = idxAtOrBefore(h4, start);
    if (bi < 1 || h4[bi]!.time !== start) continue;
    const v0 = bounceOn(h4, h4, bi, {});
    // The backtest must see exactly what the live function sees (bull = 1).
    const live = evaluateAbneonDailyBounce(h4.slice(Math.max(0, bi - ZONE_BARS - 6), bi + 1), start);
    if ((live !== null) !== (v0 !== null && v0.day.close > v0.day.open) || (live && v0 && Math.abs(live.zone.top - v0.level.top) > 1e-12)) prodMismatch++;
    const add = (variant: string, ev: Ev) => {
      const bull = ev.day.close > ev.day.open;
      const fired = bull && t >= busy[variant]!;
      const row = features(symbol, variant, coin, P, ev, bi, ctx);
      row.fired = fired ? 1 : 0;
      rows.push(row);
      evTimes.push({ t, v: variant, bull: bull ? 1 : 0 });
      if (fired) {
        const tr = trade(m15, t, ev.day.close, ev.day.close * 0.92, "trk");
        busy[variant] = tr.hours !== null ? t + tr.hours * H1 : Infinity;
      }
    };
    if (v0) add("V0", v0);
    for (const v of ["V1", "V1K", "V2", "V3", "V4"] as Lv[]) {
      const s = srcOf[v];
      if (s.cs.length < 100) continue;
      const ev = bounceOn(s.cs, h4, bi, s.opts);
      if (!ev) continue;
      if (v0) { dup[v]!++; continue; }
      add(v, ev);
    }
  }

  // Champions: every start of a +20% move (before −8%) within 72 h, 72 h cooldown.
  const champions: Row[] = [];
  let cool = -Infinity;
  for (let bi = Math.max(1, idxAtOrBefore(h4, from)); bi < h4.length; bi++) {
    const t = h4[bi]!.time + H4;
    if (t > now - 72 * H1 || t < cool) continue;
    const base = h4[bi]!.close;
    let hit: number | null = null, peak = 0;
    for (let i = idxAtOrBefore(m15, t - 1) + 1; i < m15.length && m15[i]!.time < t + 72 * H1; i++) {
      const c = m15[i]!;
      if (c.low <= base * 0.92) break;
      peak = Math.max(peak, (c.high / base - 1) * 100);
      if (hit === null && c.high >= base * 1.2) hit = (c.time + M15 - t) / H1;
    }
    if (hit === null) continue;
    cool = t + 72 * H1;
    const zones = liveSupportZones(h4.slice(Math.max(0, bi - ZONE_BARS + 1), bi + 1));
    const lo24 = Math.min(...h4.slice(Math.max(0, bi - 5), bi + 1).map((c) => c.low));
    const onZone = zones.filter((z) => lo24 <= z.top * (1 + TOL) && base >= z.bottom * (1 - TOL)).sort((a, b) => b.top - a.top)[0] ?? null;
    const ev = (v: string, a: number, b: number, bullOnly = false) => evTimes.filter((x) => x.v === v && x.t >= a && x.t <= b && (!bullOnly || x.bull)).length;
    champions.push({
      symbol, time_utc: new Date(t).toISOString(), entry_time_ms: t, close: base,
      hours_to_plus20: hit, peak72_pct: peak,
      v0_bounce_prev24h: ev("V0", t - D1, t), v0_bull_bounce_prev24h: ev("V0", t - D1, t, true), v0_bounce_prev72h: ev("V0", t - 72 * H1, t),
      other_variant_bounce_prev24h: ["V1", "V1K", "V2", "V3", "V4"].reduce((a, v) => a + ev(v, t - D1, t), 0),
      on_support_zone_24h: onZone ? 1 : 0,
      zone_top_vs_close_pct: onZone ? pct(base, onZone.top) : null,
      price_24h_pct: pct(base, coin.h1[lastClosed(coin.h1, t - D1, H1)]?.close),
      atr4h_pct: P.S4.atr[bi] ?? null,
    });
  }
  return { rows, champions, dup, prodMismatch };
}

function summary(rows: Row[], from: number, now: number): string {
  const lines: string[] = [];
  const mid = from + (now - D7 - from) / 2;
  const c = (rs: Row[]) => {
    const done = rs.filter((r) => r.out72 !== "OPEN");
    const p = (k: string) => (done.length ? Math.round((100 * done.filter((r) => r.out72 === k).length) / done.length) : 0);
    const trk = rs.map((r) => r.xA_s8_trk).filter((v): v is number => typeof v === "number");
    return `${rs.length} (${done.length} с итогом 72ч): GOOD ${p("GOOD")}%, STOP ${p("STOP")}%; сделка (−8%, трекер) ${trk.length ? (trk.reduce((a, b) => a + b, 0) / trk.length).toFixed(2) : "—"}%`;
  };
  for (const v of ["V0", "V1", "V1K", "V2", "V3", "V4"]) {
    const all = rows.filter((r) => r.variant === v);
    if (!all.length) continue;
    const f = all.filter((r) => r.fired === 1);
    lines.push(`== ${v} 1D: все касания ${c(all)}`);
    lines.push(`   бычий день, вошли бы: ${c(f)}`);
    lines.push(`     первая половина: ${c(f.filter((r) => Number(r.entry_time_ms) < mid))}`);
    lines.push(`     вторая половина: ${c(f.filter((r) => Number(r.entry_time_ms) >= mid))}`);
    lines.push(`     + фильтр объёма ABNeon (≥11 из 12): ${c(f.filter((r) => r.gate_pass === 1))}`);
    lines.push(`   медвежий день: ${c(all.filter((r) => r.bull === 0))}`);
  }
  return lines.join("\n");
}

async function main() {
  const nowFile = join(CACHE, "_breakout_now.txt");
  if (!existsSync(nowFile)) throw new Error("no cache of the breakout study (reports/.cache/_breakout_now.txt)");
  const now = Number(readFileSync(nowFile, "utf8"));
  const from = now - DAYS * D1;
  const all = ONLY ?? (await usdtSymbols(CACHE)).slice(0, LIMIT);
  ensureDir(OUT);
  const [part, parts] = PART;
  const mine = all.filter((_, i) => i % parts === part - 1);
  const btc = { h1: await klines(CACHE, "BTC-USDT", "1h", from - H1_BACK * H1, now), h4: await klines(CACHE, "BTC-USDT", "4h", from - H4_BACK * H4, now) };
  const eth = { h1: await klines(CACHE, "ETH-USDT", "1h", from - H1_BACK * H1, now), h4: await klines(CACHE, "ETH-USDT", "4h", from - H4_BACK * H4, now) };
  const market = new Market();
  for (const s of all) {
    try {
      const h4 = await klines(CACHE, s, "4h", from - H4_BACK * H4, now);
      const h1 = await klines(CACHE, s, "1h", from - H1_BACK * H1, now);
      if (h4.length >= 100 && h1.length >= 200) market.addCoin(h1, h4);
    } catch { /* not cached */ }
  }
  const rows: Row[] = [], champs: Row[] = [];
  const dupAll: Record<string, number> = { V1: 0, V1K: 0, V2: 0, V3: 0, V4: 0 };
  const errors: Record<string, string> = {};
  let mismatch = 0, coins = 0, agg = 0, done = 0;
  for (const s of mine) {
    try {
      const coin = await loadCoin(s, from, now);
      if (coin.h4.length < 100 || coin.h1.length < 200 || coin.m15.length < 100) { errors[s] = "short_history"; continue; }
      coins++;
      if (coin.cg.aggfut?.size) agg++;
      const r = simulate(s, coin, from, now, { btc, eth });
      rows.push(...r.rows); champs.push(...r.champions);
      mismatch += r.prodMismatch;
      for (const k of Object.keys(dupAll)) dupAll[k]! += r.dup[k] ?? 0;
    } catch (e) {
      errors[s] = `simulate: ${String(e).slice(0, 160)}`;
    }
    if (++done % 10 === 0) console.error(`часть ${part}/${parts}: ${done}/${mine.length}, событий ${rows.length}, чемпионов ${champs.length}`);
  }
  addMarket(rows, market);
  rows.sort((a, b) => Number(a.entry_time_ms) - Number(b.entry_time_ms));
  writeCsv(join(OUT, `events_part${part}.csv`), rows);
  writeCsv(join(OUT, `champions_part${part}.csv`), champs);
  writeFileSync(join(OUT, `errors_part${part}.json`), JSON.stringify(errors, null, 1));
  const text =
    `ABNeon 1D · часть ${part}/${parts} · ${new Date(from).toISOString()} .. ${new Date(now).toISOString()} · монет ${mine.length}, с данными ${coins}, агрегированный объём ${agg}, ошибок ${Object.keys(errors).length}\n` +
    `сверка с живой функцией (бычий день V0): расхождений ${mismatch}\n` +
    summary(rows, from, now) +
    `\nдубли с V0 (тот же день, не записаны): ${Object.entries(dupAll).map(([k, v]) => `${k} ${v}`).join(", ")}` +
    `\nчемпионов (+20% до −8% за 72ч): ${champs.length}, у зоны поддержки за 24ч: ${champs.filter((c) => c.on_support_zone_24h === 1).length}, с отскоком 1D V0 за 24ч: ${champs.filter((c) => Number(c.v0_bounce_prev24h) > 0).length}` +
    `\nсобытий ${rows.length}, колонок ${new Set(rows.flatMap((r) => Object.keys(r))).size}`;
  writeFileSync(join(OUT, `summary_part${part}.txt`), text);
  console.log(text);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
