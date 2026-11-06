/**
 * BREAKOUT STUDY — the new Stealth (owner 2026-11-06), the mirror of the ABNeon bounce, everything in one run.
 *
 * Event = a closed BingX-futures candle (4H, or the UTC day) closing above the top of a Neon level while the
 * previous close was at/below it. Level sets ("variant"):
 *   V0  as live: production evaluateNeonLevelBreakout (BingX futures 4H, 600-bar Neon algorithm, 6 zones)
 *   V1  12 zones instead of 6        V2  levels from BingX SPOT 4H
 *   V3  levels from Binance SPOT 4H  V4  levels from Binance FUTURES 4H  (both via CoinGlass price history)
 * V1–V4 rows are kept only when V0 has no event on the same coin and candle (in_v0 = 0): the levels the
 * live bot does not see. fired = the bot would enter (one open trade per coin per variant); fired = 0 rows
 * (coin busy) are kept — they are real breakouts too.
 *
 * For EVERY event (same columns for all variants):
 *  1. BEFORE: base under the level (bars below, tests in 7 days, false breakouts in 30 days, higher lows,
 *     ATR / Bollinger compression, volume dry-up, 3-day run-up), 1H approach (moves, streak, volume trend,
 *     VSA events, climax, effort, no supply, compression, impulse), level history (earlier tests and how
 *     they ended), confluence (1D zone, EMA200, round number, previous week high), ICT, Wyckoff.
 *  2. THE BREAKOUT CANDLE: anatomy / VSA / Welkin on BingX volume, on aggregated futures volume, Wyckoff on
 *     aggregated volume; last 1H and 15m bars; how far above the level it closed; levels crossed; room to the
 *     next resistance; spot–futures basis.
 *  3. VOLUME ON 8 SOURCES (bx = BingX, aggfut = CoinGlass aggregated futures = live CAB, aggspot = aggregated
 *     spot + spot CVD, binance, bybit, okx, bitget, bingxcg): 12 / 24 1H bars before the breakout candle
 *     (blue = Welkin above average, grey, coloured, longest blue run, stopping volume, climax, effort,
 *     no supply), bars inside the breakout candle (up vs down volume, blue bars), the 4H bars, takers
 *     (buy − sell share) before / inside / after, spot CVD change.             → <source>_* columns
 *  4. DERIVATIVES: aggregated OI change before / during / after, OI vs price, aggregated liquidations of
 *     shorts / longs (breakout candle, 24 h before, vs 7-day rate), Binance long/short accounts, funding.
 *  5. AUTO RANGE [QuantAlgo] 15m / 1H / 4H / 1D: range state, range top on the level, upside break of the
 *     range (recent, on the level), failed upside breaks, spring (down deviation) before.
 *  6. MARKET: breadth, alt index, BTC / ETH, alts vs BTC, breakouts across all coins in 4 h / 24 h,
 *     session, weekday; the result AGAINST the market (excess 24 h / 72 h / 7 d).
 *  7. AFTER (management only, never a filter): retest of the level (when, held, its volume), first close
 *     back under the level, volume of the next 3 hours, OI after, takers after.
 *  8. ENTRY VARIANTS A (at the close, as live), B (retest that holds), C (above the breakout candle high);
 *     each × stops s8 (−8%), struct (under the level), atr15 / atr20 × exits trk (live), be5trk, tp5, tp8,
 *     tp10, tp15, with trade hours (deposit simulation); path 24h / 72h / 7d, best / worst, timing.
 *  9. champions_*.csv — every start of a +20% move (before −8%, within 72 h) on every coin: was there a
 *     breakout (any variant) at / before it, the nearest level, volume / OI / takers / range readings —
 *     the breakouts the bot missed.
 * 10. live_compare: CAB's live new-Stealth signals matched to the events.
 *
 * Run (from artifacts/api-server), two steps:
 *   A. download (one process; CoinGlass slow-paced, shares the key with the live bot):
 *      pnpm dlx tsx scripts/breakout-study.ts --step download --days 60
 *   B. compute, three processes in parallel, offline from the cache:
 *      STUDY_OFFLINE=1 pnpm dlx tsx scripts/breakout-study.ts --step compute --part 1/3 --days 60 --out ../../reports/breakout-study --live ../../reports/live-signals.csv
 *      (… --part 2/3 …, … --part 3/3 …)
 */
import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { computeSupportZones } from "../src/lib/stealth-abneon-detectors.js";
import { dailyFrom4h, evaluateNeonLevelBreakout } from "../src/lib/stealth-neon-level-breakout.js";
import { SOURCES, type Source, type VBar, cgHistory, cgStats, volumeReadings, withVolume, resetRangeMemo } from "./study-v2/cg.js";
import { cg2Stats, cgSeries, derivReadings, rangeUpReadings, type NSeries } from "./study-v2/cg2.js";
import { bingxSpot4h, cgPrice } from "./study-v2/venues.js";
import {
  type C, type Row, type Series, D1, D7, H1, H4, M15, Market,
  addMarket, anatomy, approach, compareLive, emaSeries, ensureDir, funding, fundingAt, grid,
  idxAtOrBefore, klines, lastClosed, majors, nearRound, parseArgs, path, pct, prevWeek, readLive, series, session,
  trade, usdtSymbols, writeCsv, wyIct,
} from "./study-v2/lib.js";

const args = parseArgs();
const STEP = args.get("step") ?? "compute";
const DAYS = Number(args.get("days") ?? 60);
const OUT = args.get("out") ?? "../../reports/breakout-study";
const CACHE = args.get("cache") ?? "../../reports/.cache";
const LIMIT = Number(args.get("limit") ?? 10_000);
const ONLY = args.get("symbols")?.split(",").filter(Boolean) ?? null;
const LIVE = args.get("live");
const PART = (args.get("part") ?? "1/1").split("/").map(Number) as [number, number];
const ZONE_BARS = 700;
const H4_BACK = 720, H1_BACK = 400;

type Lv = "V1" | "V2" | "V3" | "V4";
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
type Ev = { tf: "4h" | "1d"; candleTime: number; close: number; prevClose: number; level: Z; crossed: Z[]; nextResistance: Z | null; zones: Z[] };

/** The same crossing rule as production, on another level set (zones from `src`, closes from BingX futures). */
function crossOn(src: C[], h4: C[], bi: number, maxZones?: number): Ev | null {
  const last = h4[bi], prev = h4[bi - 1];
  if (!last || !prev || prev.time !== last.time - H4) return null;
  const t = last.time + H4;
  const hist = src.filter((c) => c.time + H4 <= t).slice(-ZONE_BARS);
  if (hist.length < 60) return null;
  const zones = computeSupportZones(hist, maxZones).map((z) => ({ top: z.top, bottom: z.bottom, count: z.count })).sort((a, b) => a.bottom - b.bottom);
  if (!zones.length) return null;
  const mk = (tf: "4h" | "1d", candleTime: number, close: number, prevClose: number): Ev | null => {
    const crossed = zones.filter((z) => prevClose <= z.top && close > z.top).sort((a, b) => b.top - a.top);
    if (!crossed.length) return null;
    const next = zones.filter((z) => z.top > close).sort((a, b) => a.bottom - b.bottom)[0] ?? null;
    return { tf, candleTime, close, prevClose, level: crossed[0]!, crossed, nextResistance: next, zones };
  };
  if (t % D1 === 0) {
    const days = dailyFrom4h(h4.slice(0, bi + 1));
    const day = days.at(-1), pd = days.at(-2);
    if (day && pd && day.time === t - D1 && pd.time === day.time - D1) {
      const e = mk("1d", day.time, day.close, pd.close);
      if (e) return e;
    }
  }
  return mk("4h", last.time, last.close, prev.close);
}

type Pre = {
  S1: Series; S4: Series; S15: Series; SD: Series; days: C[];
  vol: Record<"bx" | Source, { h1: C[]; h4: C[]; vb: Map<number, VBar> | null }>;
  aggS4: Series; aggSD: Series;
};
function prepare(coin: Coin): Pre {
  const days = dailyFrom4h(coin.h4);
  const vol = { bx: { h1: coin.h1, h4: coin.h4, vb: null } } as Pre["vol"];
  for (const s of SOURCES) vol[s] = { h1: withVolume(coin.h1, coin.cg[s], H1), h4: withVolume(coin.h4, coin.cg[s], H4), vb: coin.cg[s] };
  return {
    S1: series(coin.h1), S4: series(coin.h4), S15: series(coin.m15), SD: series(days), days, vol,
    aggS4: series(vol.aggfut.h4), aggSD: series(dailyFrom4h(vol.aggfut.h4)),
  };
}

function features(symbol: string, variant: string, coin: Coin, P: Pre, ev: Ev, bi: number, ctx: Ctx): Row {
  const { h4, h1, m15 } = coin;
  const t = h4[bi]!.time + H4;
  const entry = ev.close;
  const top = ev.level.top, bottom = ev.level.bottom;
  const is1d = ev.tf === "1d";
  const boStart = is1d ? ev.candleTime : h4[bi]!.time;
  const boSeries = is1d ? P.SD : P.S4;
  const boIdx = idxAtOrBefore(boSeries.cs, ev.candleTime);
  const bo = boSeries.cs[boIdx]!;
  const base4 = idxAtOrBefore(h4, boStart - 1);
  const pre1 = idxAtOrBefore(h1, boStart);
  const i1 = lastClosed(h1, t, H1);

  // 1. Base under the level (4H, before the breakout candle).
  let below = 0;
  for (let k = base4; k >= 0 && h4[k]!.close <= top && below < 180; k--) below++;
  let tests7d = 0;
  for (let k = Math.max(1, base4 - 41); k <= base4; k++) {
    const b = h4[k]!, p = h4[k - 1]!;
    if (b.high >= bottom && b.close <= top && !(p.high >= bottom && p.close <= top)) tests7d++;
  }
  let falseBreaks = 0;
  for (let k = Math.max(0, base4 - 179); k <= base4 - 1; k++) {
    if (h4[k]!.close > top && (k === 0 || h4[k - 1]!.close <= top)) {
      for (let j = k + 1; j <= Math.min(base4, k + 3); j++) if (h4[j]!.close <= top) { falseBreaks++; break; }
    }
  }
  const lows = (a: number, b: number) => Math.min(...h4.slice(Math.max(0, a), b + 1).map((c) => c.low));
  const avgRange = (a: number, b: number) => { const xs = h4.slice(Math.max(1, a), b + 1).map((c) => c.high - c.low); return xs.length ? xs.reduce((x, y) => x + y, 0) / xs.length : null; };
  const bbw = (k: number) => { const xs = h4.slice(Math.max(0, k - 19), k + 1).map((c) => c.close); const m = xs.reduce((a, b) => a + b, 0) / xs.length; const sd = Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length); return m > 0 ? sd / m : null; };
  const bbwNow = bbw(base4);
  const bbwAvg = (() => { const xs: number[] = []; for (let k = base4 - 42; k < base4; k++) { const v = bbw(k); if (v != null) xs.push(v); } return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null; })();
  const vAvg = (cs: C[], a: number, b: number) => { const xs = cs.slice(Math.max(0, a), b + 1).map((c) => c.volume).filter(Number.isFinite); return xs.length ? xs.reduce((x, y) => x + y, 0) / xs.length : null; };
  const boVolOf = (cs: C[]) => (is1d ? cs.slice(base4 + 1, bi + 1).reduce((a, c) => a + c.volume, 0) / Math.max(1, bi - base4) : cs[bi]!.volume);
  const v6 = vAvg(h4, base4 - 5, base4), v42 = vAvg(h4, base4 - 41, base4);
  const ag4 = P.vol.aggfut.h4;
  const av6 = vAvg(ag4, base4 - 5, base4), av42 = vAvg(ag4, base4 - 41, base4), avBo = boVolOf(ag4);
  const lowSlope = (() => { const ys = h4.slice(Math.max(0, base4 - 11), base4 + 1).map((c) => c.low); const n = ys.length, m = ys.reduce((a, b) => a + b, 0) / n, xm = (n - 1) / 2; let num = 0, den = 0; ys.forEach((y, i) => { num += (i - xm) * (y - m); den += (i - xm) ** 2; }); return den && m ? (num / den / m) * 100 : null; })();

  // Level history: tests from below and how they ended (4H, outcome window closed before the base).
  let prevTests = 0, prevRejected = 0, prevPassed = 0, firstTestT: number | null = null, lastTestT: number | null = null;
  for (let k = Math.max(1, bi - ZONE_BARS); k < base4 - 18; k++) {
    const b = h4[k]!;
    if (b.high >= bottom && b.close <= top) { if (firstTestT === null) firstTestT = b.time; lastTestT = b.time; }
    if (b.high >= bottom && h4[k - 1]!.high < bottom) {
      prevTests++;
      const base = b.close;
      for (let j = k + 1; j <= k + 18; j++) {
        if (h4[j]!.low <= base * 0.92) { prevRejected++; break; }
        if (h4[j]!.high >= base * 1.1) { prevPassed++; break; }
      }
    }
  }
  const c4 = h4.slice(0, bi + 1);
  const dZones = computeSupportZones(dailyFrom4h(c4).slice(-200));
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

  // 7. After the breakout (management readings).
  const win = is1d ? 72 * H1 : D1;
  let retestH: number | null = null, retestHeld: number | null = null, retestVol: number | null = null, closeUnderH: number | null = null;
  const boHourVol = h1.slice(pre1, i1 + 1).reduce((a, c) => a + c.volume, 0) / Math.max(1, i1 - pre1 + 1);
  for (let k = i1 + 1; k < h1.length && h1[k]!.time < t + 72 * H1; k++) {
    const b = h1[k]!;
    if (retestH === null && b.time < t + win && b.low <= top * 1.003) {
      retestH = (b.time + H1 - t) / H1;
      retestHeld = b.close >= top ? 1 : 0;
      retestVol = boHourVol > 0 ? b.volume / boHourVol : null;
    }
    if (closeUnderH === null && b.close < bottom) closeUnderH = (b.time + H1 - t) / H1;
  }
  const next3 = h1.slice(i1 + 1, i1 + 4);
  const post3 = next3.length === 3 && boHourVol > 0 ? next3.reduce((a, c) => a + c.volume, 0) / 3 / boHourVol : null;

  // 8. Entry variants × stops × exits.
  const stopsFor = (e: number) => ({
    s8: e * 0.92,
    struct: bottom * 0.997 < e ? bottom * 0.997 : null,
    atr15: atr4h ? e * (1 - (1.5 * atr4h) / 100) : null,
    atr20: atr4h ? e * (1 - (2 * atr4h) / 100) : null,
  });
  const none = { s8: null, struct: null, atr15: null, atr20: null };
  let bFrom: number | null = null, bEntry: number | null = null;
  for (let k = i1 + 1; k < h1.length && h1[k]!.time < t + win; k++) {
    const b = h1[k]!;
    if (b.close < bottom) break;
    if (b.low <= top * 1.003 && b.close >= top) { bFrom = b.time + H1; bEntry = b.close; break; }
  }
  let cFrom: number | null = null, cEntry: number | null = null;
  for (let i = idxAtOrBefore(m15, t - 1) + 1; i < m15.length && m15[i]!.time < t + win; i++) {
    const b = m15[i]!;
    if (b.high > bo.high) { cFrom = b.time; cEntry = Math.max(bo.high, b.open); break; }
  }

  // 3. Volume of every source (pre = 12 / 24 1H bars before the breakout candle; win = bars inside it).
  const vRows: Row = {};
  const i4 = lastClosed(h4, t, H4);
  for (const k of ["bx", ...SOURCES] as const) {
    const v = P.vol[k];
    Object.assign(vRows, volumeReadings(k, v.h1, v.h4, pre1, pre1, i1, i4, v.vb, t));
  }
  // Wyckoff on aggregated volume (skipped when the aggregated series has gaps).
  const aggBo = is1d ? dailyFrom4h(ag4) : ag4;
  const aggBoIdx = idxAtOrBefore(aggBo, ev.candleTime);
  const aggOk = aggBoIdx >= 60 && aggBo.slice(Math.max(0, aggBoIdx - 300), aggBoIdx + 1).every((c) => Number.isFinite(c.volume));
  const wyAgg = aggOk ? wyIct("boagg", aggBo, aggBoIdx, top, bottom) : {};
  const wyAggSlim = Object.fromEntries(Object.entries(wyAgg).filter(([k]) => k.includes("_wy_")));

  const priceAt = (time: number) => { const i = lastClosed(h1, time, H1); return i >= 0 ? h1[i]!.close : null; };

  return {
    variant, symbol, tf: ev.tf, fired: 0,
    time_utc: new Date(t).toISOString(), entry_time_ms: t, entry,
    ...session(t),
    prev_close: ev.prevClose,
    level_bottom: bottom, level_top: top, level_pivots: ev.level.count, level_height_pct: pct(top, bottom),
    levels_crossed: ev.crossed.length,
    level_rank_from_bottom: ev.zones.filter((z) => z.top < bottom).length,
    close_above_level_pct: pct(entry, top), prev_close_below_level_pct: pct(top, ev.prevClose),
    room_to_next_resistance_pct: ev.nextResistance ? pct(ev.nextResistance.bottom, entry) : null,
    next_resistance_pivots: ev.nextResistance?.count ?? null,
    next_support_below_pct: belowZone ? pct(entry, belowZone.top) : null,
    zones_total: ev.zones.length,
    spot_basis_pct: spotBar ? pct(spotBar.close, h4[bi]!.close) : null,
    // 1. base
    base_bars_below_level: below,
    base_tests_7d: tests7d,
    base_false_breaks_30d: falseBreaks,
    base_higher_lows_pct: base4 >= 12 ? pct(lows(base4 - 5, base4), lows(base4 - 11, base4 - 6)) : null,
    base_low_slope12_pct_per_bar: lowSlope,
    base_atr6_vs_atr42: (() => { const a = avgRange(base4 - 5, base4), b = avgRange(base4 - 41, base4); return a != null && b ? a / b : null; })(),
    base_bbw_vs_avg42: bbwNow != null && bbwAvg ? bbwNow / bbwAvg : null,
    base_vol6_vs_vol42: v6 != null && v42 ? v6 / v42 : null,
    bo_vol_vs_base42: v42 ? boVolOf(h4) / v42 : null,
    agg_base_vol6_vs_vol42: av6 != null && av42 ? av6 / av42 : null,
    agg_bo_vol_vs_base42: av42 && Number.isFinite(avBo) ? avBo / av42 : null,
    base_runup_3d_pct: pct(ev.prevClose, lows(base4 - 17, base4)),
    ...approach("pre", P.S1, pre1, "up"),
    // 2. candles
    ...anatomy("bo", boSeries, boIdx),
    ...wyIct("bo", boSeries.cs, boIdx, top, bottom),
    ...anatomy("boagg", is1d ? P.aggSD : P.aggS4, is1d ? idxAtOrBefore(P.aggSD.cs, ev.candleTime) : bi),
    ...wyAggSlim,
    ...anatomy("h1last", P.S1, i1),
    ...wyIct("h1", h1, i1, top, bottom),
    ...anatomy("bo15m", P.S15, lastClosed(m15, t, M15)),
    // 3. volume sources
    ...vRows,
    // 4. derivatives
    ...derivReadings(coin.oi, coin.liq, coin.ls, boStart, t, priceAt),
    funding_last_pct: f.last, funding_avg3_pct: f.avg3,
    // 5. Auto Range
    ...rangeUpReadings("15m", m15, t, bottom, top, D1, 700),
    ...rangeUpReadings("1h", h1, t, bottom, top, D1, 500),
    ...rangeUpReadings("4h", h4, t, bottom, top, 72 * H1, 700),
    ...rangeUpReadings("1d", coin.d1, t, bottom, top, D7, 300),
    // context
    atr4h_pct: atr4h, atr1h_pct: P.S1.atr[i1] ?? null,
    price_24h_pct: pct(entry, h1[i1 - 24]?.close), price_7d_pct: pct(entry, h1[i1 - 168]?.close),
    from_high30d_pct: pct(entry, hi30), from_low30d_pct: pct(entry, lo30),
    vs_ema50_4h_pct: pct(entry, e50), vs_ema200_4h_pct: pct(entry, e200),
    vol24h_vs_7d: vol7d > 0 ? vol24 / vol7d : null, vol24h_usd_bingx: vol24,
    lvl_prev_tests: prevTests, lvl_prev_rejected: prevRejected, lvl_prev_passed: prevPassed,
    lvl_first_test_days_ago: firstTestT !== null ? (t - firstTestT) / D1 : null,
    lvl_last_test_days_ago: lastTestT !== null ? (t - lastTestT) / D1 : null,
    conf_1d_zone: dZones.some((z) => z.bottom <= top * 1.01 && z.top >= bottom * 0.99) ? 1 : 0,
    conf_ema200_4h_pct: e200 ? Math.abs(pct(top, e200) ?? 99) : null,
    conf_round_pct: nearRound((top + bottom) / 2),
    conf_prev_week_high_pct: pw.high ? Math.abs(pct((top + bottom) / 2, pw.high) ?? 99) : null,
    ...majors("btc", ctx.btc.h1, ctx.btc.h4, t),
    ...majors("eth", ctx.eth.h1, ctx.eth.h4, t),
    // 7. after
    post_retest_hours: retestH, post_retest_held: retestHeld, post_retest_vol_vs_bo: retestVol,
    post_close_under_level_hours: closeUnderH, post_first3_vol_vs_bo: post3,
    // 8. path and trades
    ...path(m15, t, entry, atr4h),
    xA_filled: 1, xA_entry: entry, xA_delay_h: 0,
    ...grid("xA", m15, t, entry, stopsFor(entry)),
    xB_filled: bEntry ? 1 : 0, xB_entry: bEntry, xB_delay_h: bFrom !== null ? (bFrom - t) / H1 : null,
    ...grid("xB", m15, bFrom, bEntry, bEntry ? stopsFor(bEntry) : none),
    xC_filled: cEntry ? 1 : 0, xC_entry: cEntry, xC_delay_h: cFrom !== null ? (cFrom - t) / H1 : null,
    ...grid("xC", m15, cFrom, cEntry, cEntry ? stopsFor(cEntry) : none),
  };
}

/** All events of one coin: V0 (production) and V1–V4 where V0 has nothing on that candle. */
function simulate(symbol: string, coin: Coin, from: number, now: number, ctx: Ctx): { rows: Row[]; champions: Row[]; dup: Record<string, number> } {
  const { h4, m15 } = coin;
  resetRangeMemo();
  const P = prepare(coin);
  const rows: Row[] = [];
  const dup: Record<string, number> = { V1: 0, V2: 0, V3: 0, V4: 0 };
  const busy: Record<string, number> = { V0: -Infinity, V1: -Infinity, V2: -Infinity, V3: -Infinity, V4: -Infinity };
  const past: { at: number; top: number }[] = [];
  const evTimes: { t: number; v: string; top: number }[] = [];
  const srcOf: Record<Lv, { cs: C[]; max?: number }> = { V1: { cs: h4, max: 12 }, V2: { cs: coin.spot4 }, V3: { cs: coin.bnSpot4 }, V4: { cs: coin.bnFut4 } };
  for (let start = Math.ceil(from / H4) * H4; start + H4 <= now; start += H4) {
    const t = start + H4;
    const bi = idxAtOrBefore(h4, start);
    if (bi < 1 || h4[bi]!.time !== start) continue;
    const v0 = evaluateNeonLevelBreakout(h4.slice(Math.max(0, bi - ZONE_BARS + 1), bi + 1), start) as Ev | null;
    const add = (variant: string, ev: Ev) => {
      const fired = t >= busy[variant]!;
      const row = features(symbol, variant, coin, P, ev, bi, ctx);
      row.fired = fired ? 1 : 0;
      row.same_level_breakouts_30d_before = past.filter((p) => t - p.at <= 30 * D1 && Math.abs(p.top - ev.level.top) / ev.level.top <= 0.01).length;
      rows.push(row);
      evTimes.push({ t, v: variant, top: ev.level.top });
      if (fired) {
        const tr = trade(m15, t, ev.close, ev.close * 0.92, "trk");
        busy[variant] = tr.hours !== null ? t + tr.hours * H1 : Infinity;
      }
    };
    if (v0) { add("V0", v0); past.push({ at: t, top: v0.level.top }); }
    for (const v of ["V1", "V2", "V3", "V4"] as Lv[]) {
      const s = srcOf[v];
      if (s.cs.length < 100) continue;
      const ev = crossOn(s.cs, h4, bi, s.max);
      if (!ev) continue;
      if (v0) { dup[v]!++; continue; } // V0 already has a breakout on this candle
      add(v, ev);
    }
  }

  // 9. Champions: every start of a +20% move (before −8%) within 72 h, 72 h cooldown.
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
    const zones = computeSupportZones(h4.slice(Math.max(0, bi - ZONE_BARS + 1), bi + 1));
    const above = zones.filter((z) => z.top > base).sort((a, b) => a.bottom - b.bottom)[0] ?? null;
    const pre1 = idxAtOrBefore(coin.h1, h4[bi]!.time);
    const i1 = lastClosed(coin.h1, t, H1);
    const i4 = lastClosed(h4, t, H4);
    const vA = volumeReadings("aggfut", P.vol.aggfut.h1, P.vol.aggfut.h4, pre1, pre1, i1, i4, P.vol.aggfut.vb, t);
    const vB = volumeReadings("bx", coin.h1, h4, pre1, pre1, i1, i4, null, t);
    const keep = (r: Row) => Object.fromEntries(Object.entries(r).filter(([k]) => /_(pre_blue12|pre_grey12|pre_colored12|pre_blue_run24|pre_vol12_vs_prev36|4h_blue6|tk_pre12_delta|tk_24h_delta|tk_win_delta)$/.test(k)));
    const ev = (v: string, a: number, b: number) => evTimes.filter((x) => x.v === v && x.t >= a && x.t <= b).length;
    const priceAt = (time: number) => { const i = lastClosed(coin.h1, time, H1); return i >= 0 ? coin.h1[i]!.close : null; };
    champions.push({
      symbol, time_utc: new Date(t).toISOString(), entry_time_ms: t, close: base,
      hours_to_plus20: hit, peak72_pct: peak,
      v0_event_same_candle: ev("V0", t, t), v0_events_prev24h: ev("V0", t - D1, t), v0_events_prev72h: ev("V0", t - 72 * H1, t),
      other_variant_events_prev24h: ["V1", "V2", "V3", "V4"].reduce((a, v) => a + ev(v, t - D1, t), 0),
      next_level_above_pct: above ? pct(above.bottom, base) : null,
      crossed_level_on_candle: zones.some((z) => h4[bi - 1]!.close <= z.top && base > z.top) ? 1 : 0,
      price_24h_pct: pct(base, priceAt(t - D1)),
      atr4h_pct: P.S4.atr[bi] ?? null,
      ...keep(vA), ...keep(vB),
      ...Object.fromEntries(Object.entries(derivReadings(coin.oi, coin.liq, coin.ls, h4[bi]!.time, t, priceAt)).filter(([k]) => !k.startsWith("post_"))),
      ...rangeUpReadings("4h", h4, t, base, base, 72 * H1, 700),
    });
  }
  return { rows, champions, dup };
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
  for (const v of ["V0", "V1", "V2", "V3", "V4"]) for (const tf of ["4h", "1d"]) {
    const rs = rows.filter((r) => r.variant === v && r.tf === tf && r.fired === 1);
    if (!rs.length) continue;
    lines.push(`== ${v} ${tf} (вошли бы): ${c(rs)}`);
    lines.push(`   первая половина: ${c(rs.filter((r) => Number(r.entry_time_ms) < mid))}`);
    lines.push(`   вторая половина: ${c(rs.filter((r) => Number(r.entry_time_ms) >= mid))}`);
    lines.push(`   монета занята (fired=0): ${c(rows.filter((r) => r.variant === v && r.tf === tf && r.fired === 0))}`);
  }
  return lines.join("\n");
}

async function main() {
  ensureDir(CACHE);
  const nowFile = join(CACHE, "_breakout_now.txt");
  const now = STEP === "download" || !existsSync(nowFile) ? Math.floor(Date.now() / M15) * M15 : Number(readFileSync(nowFile, "utf8"));
  if (STEP === "download") writeFileSync(nowFile, String(now));
  const from = now - DAYS * D1;
  const all = ONLY ?? (await usdtSymbols(CACHE)).slice(0, LIMIT);

  if (STEP === "download") {
    let done = 0;
    const errors: Record<string, string> = {};
    for (const s of [...all, "BTC-USDT", "ETH-USDT"]) {
      try { await loadCoin(s, from, now); } catch (e) { errors[s] = String(e).slice(0, 160); }
      if (++done % 25 === 0) console.error(`загрузка ${done}/${all.length + 2} · CoinGlass объём ${cgStats.requests} (ok ${cgStats.ok}, пусто ${cgStats.empty}, ошибок ${cgStats.errors}, 429 ${cgStats.r429}) · OI/ликв/LS ${cg2Stats.requests} (ok ${cg2Stats.ok}, пусто ${cg2Stats.empty}, ошибок ${cg2Stats.errors}, 429 ${cg2Stats.r429})`);
    }
    ensureDir(OUT);
    writeFileSync(join(OUT, "download_errors.json"), JSON.stringify(errors, null, 1));
    const msg = `загрузка готова: монет ${all.length}, ошибок ${Object.keys(errors).length}; CoinGlass объём: запросов ${cgStats.requests}, ok ${cgStats.ok}, пусто ${cgStats.empty}, ошибок ${cgStats.errors}, 429 ${cgStats.r429}; OI/ликвидации/LS: запросов ${cg2Stats.requests}, ok ${cg2Stats.ok}, пусто ${cg2Stats.empty}, ошибок ${cg2Stats.errors}, 429 ${cg2Stats.r429}; now=${new Date(now).toISOString()}`;
    writeFileSync(join(OUT, "download_summary.txt"), msg);
    console.log(msg);
    return;
  }

  // compute
  ensureDir(OUT);
  const [part, parts] = PART;
  const mine = all.filter((_, i) => i % parts === part - 1);
  const btc = { h1: await klines(CACHE, "BTC-USDT", "1h", from - H1_BACK * H1, now), h4: await klines(CACHE, "BTC-USDT", "4h", from - H4_BACK * H4, now) };
  const eth = { h1: await klines(CACHE, "ETH-USDT", "1h", from - H1_BACK * H1, now), h4: await klines(CACHE, "ETH-USDT", "4h", from - H4_BACK * H4, now) };
  // Market from ALL coins (cache only).
  const market = new Market();
  for (const s of all) {
    try {
      const h4 = await klines(CACHE, s, "4h", from - H4_BACK * H4, now);
      const h1 = await klines(CACHE, s, "1h", from - H1_BACK * H1, now);
      if (h4.length >= 100 && h1.length >= 200) market.addCoin(h1, h4);
    } catch { /* not cached */ }
  }
  const rows: Row[] = [], champs: Row[] = [];
  const dupAll: Record<string, number> = { V1: 0, V2: 0, V3: 0, V4: 0 };
  const errors: Record<string, string> = {};
  const cover = { coins: 0, spot: 0, bnSpot: 0, bnFut: 0, oi: 0, liq: 0, ls: 0, agg: 0 };
  let done = 0;
  for (const s of mine) {
    try {
      const coin = await loadCoin(s, from, now);
      if (coin.h4.length < 100 || coin.h1.length < 200 || coin.m15.length < 100) { errors[s] = "short_history"; continue; }
      cover.coins++;
      if (coin.spot4.length >= 100) cover.spot++;
      if (coin.bnSpot4.length >= 100) cover.bnSpot++;
      if (coin.bnFut4.length >= 100) cover.bnFut++;
      if (coin.oi?.size) cover.oi++;
      if (coin.liq?.size) cover.liq++;
      if (coin.ls?.size) cover.ls++;
      if (coin.cg.aggfut?.size) cover.agg++;
      const r = simulate(s, coin, from, now, { btc, eth });
      rows.push(...r.rows); champs.push(...r.champions);
      for (const k of Object.keys(dupAll)) dupAll[k]! += r.dup[k] ?? 0;
    } catch (e) {
      errors[s] = `simulate: ${String(e).slice(0, 160)}`;
    }
    if (++done % 10 === 0) console.error(`часть ${part}/${parts}: ${done}/${mine.length}, событий ${rows.length}, чемпионов ${champs.length}`);
  }
  // Market columns: breakouts across coins are counted within this part only — the analysis recounts them over all parts.
  addMarket(rows, market);
  const live = readLive(LIVE)?.filter((x) => x.key === "stealth_breakout" && x.method.startsWith("neon_level_") && mine.includes(x.symbol)) ?? null;
  const liveText = live ? compareLive(rows.filter((r) => r.variant === "V0"), live, 0, 3 * H1, join(OUT, `live_compare_part${part}.csv`)) : "живые сигналы не переданы";
  rows.sort((a, b) => Number(a.entry_time_ms) - Number(b.entry_time_ms));
  writeCsv(join(OUT, `events_part${part}.csv`), rows);
  writeCsv(join(OUT, `champions_part${part}.csv`), champs);
  writeFileSync(join(OUT, `errors_part${part}.json`), JSON.stringify(errors, null, 1));
  const text =
    `Пробои · часть ${part}/${parts} · ${new Date(from).toISOString()} .. ${new Date(now).toISOString()} · монет ${mine.length}, с данными ${cover.coins}, ошибок ${Object.keys(errors).length}\n` +
    summary(rows, from, now) +
    `\nдубли с V0 (тот же пробой, не записаны): ${Object.entries(dupAll).map(([k, v]) => `${k} ${v}`).join(", ")}` +
    `\nпокрытие монет: спот BingX ${cover.spot}, спот Binance ${cover.bnSpot}, фьючерсы Binance ${cover.bnFut}, агрегированный объём ${cover.agg}, OI ${cover.oi}, ликвидации ${cover.liq}, long/short ${cover.ls} (из ${cover.coins})` +
    `\nчемпионов (+20% до −8% за 72ч): ${champs.length}, из них с пробоем V0 за 24ч до старта: ${champs.filter((c) => Number(c.v0_events_prev24h) > 0).length}` +
    `\nживые: ${liveText}\nсобытий ${rows.length}, колонок ${new Set(rows.flatMap((r) => Object.keys(r))).size}`;
  writeFileSync(join(OUT, `summary_part${part}.txt`), text);
  console.log(text);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
