/**
 * ABNeon study v3 (owner 2026-11-06): everything of v2 (same detector, same columns, candle cache) plus
 *
 *  A. VSA / Welkin re-checked on the volumes CAB really uses: CoinGlass aggregated futures (all 28
 *     exchanges, as live), aggregated spot (+ spot CVD), and futures of Binance, Bybit, OKX, Bitget,
 *     BingX one by one, next to BingX's own volume — before the touch (12 / 24 bars: colours, blue =
 *     Welkin above average, grey, longest blue run, stopping volume, climax, effort, no supply), the
 *     touch / deepest / reaction candles, the last 6 4H bars (blue / grey / coloured, stopping volume),
 *     after the touch up to the entry (up vs down volume, stopping bars, low-volume test, blue bars),
 *     takers (buy − sell share) before / in / after, spot CVD change.        → <source>_* columns
 *  B. Auto Range [QuantAlgo] (CAB's port) on 15m / 1H / 4H / 1D: the range, where price is, and the
 *     latest down-deviation (broke below the range, closed back inside): how recent, how deep, whether
 *     the range bottom / the deviation sits on the ABNeon zone.               → rng<tf>_* columns
 *  C. touches.csv — EVERY fresh 4H touch of a Neon support zone as the indicator draws it, on all coins:
 *     whether the zone is dropped by the 22.10 rule (traded through after its last pivot), whether the
 *     bot gave a signal on it within 24 h, whether the coin was busy, how the touch ended (+10 / −8 at
 *     72 h / 7 d), blue / grey 4H bars at the touch on BingX and aggregated volume, the 4H deviation.
 *
 * Heavy columns are computed for the signals the bot would take (fired = 1), the breakouts, and repeats
 * within ±3 h of a live CAB signal (for the live comparison); other repeats are only counted.
 *
 * Run (from artifacts/api-server; uses the candle cache of v2; CoinGlass key from Secrets, never printed):
 *   pnpm dlx tsx scripts/abneon-study-v3.ts --days 60 --out ../../reports/abneon-study-v3 --live ../../reports/live-signals.csv
 * Optional: STUDY_CG_RPM (CoinGlass requests per minute for this run, default 40).
 */
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import {
  ABNEON_LEVEL_BREAKOUT_REASON,
  computeSupportZones,
  evaluateAbneonSupportBounce,
  resolveFrozenZone,
} from "../src/lib/stealth-abneon-detectors.js";
import { dailyFrom4h } from "../src/lib/stealth-neon-level-breakout.js";
import { computeSupportZones as zonesOf, type SupportZone } from "../src/lib/stealth-abneon-detectors.js";
import { SOURCES, type Source, type VBar, cgHistory, cgStats, coverage, rangeReadings, resetRangeMemo, volumeReadings, withVolume } from "./study-v2/cg.js";
import {
  type C, type Row, type Series, D1, D7, H1, H4, M15, Market,
  addMarket, anatomy, approach, binanceNote, binanceProbe, compareLive, emaSeries, ensureDir, funding, fundingAt, grid,
  idxAtOrBefore, klines, lastClosed, majors, nearRound, parseArgs, path, pct, prevWeek, readLive, series, session,
  takerShare, takers, trade, usdtSymbols, welkin, writeCsv, wyIct,
} from "./study-v2/lib.js";

const args = parseArgs();
const DAYS = Number(args.get("days") ?? 60);
const OUT = args.get("out") ?? "abneon-study-v3";
const CACHE = args.get("cache") ?? "../../reports/.cache";
const LIMIT = Number(args.get("limit") ?? 10_000);
const ONLY = args.get("symbols")?.split(",").filter(Boolean) ?? null;
const LIVE = args.get("live");
const SWEEP = 3;
const ARM_TTL_MS = 24 * H1;
const H4_BACK = 720, H1_BACK = 400;

type Coin = {
  h4: C[]; h1: C[]; m15: C[]; d1: C[]; fund: Awaited<ReturnType<typeof funding>>; tk: Awaited<ReturnType<typeof takers>>;
  cg: Record<Source, Map<number, VBar> | null>;
};
async function loadCoin(symbol: string, from: number, now: number): Promise<Coin> {
  const h4 = await klines(CACHE, symbol, "4h", from - H4_BACK * H4, now);
  const h1 = await klines(CACHE, symbol, "1h", from - H1_BACK * H1, now);
  const m15 = await klines(CACHE, symbol, "15m", from - 8 * M15, now);
  const d1 = await klines(CACHE, symbol, "1d", from - 320 * D1, now).catch(() => [] as C[]);
  const fund = await funding(CACHE, symbol, from - 3 * D1, now);
  const tk = await takers(CACHE, symbol, from - H1_BACK * H1, now);
  const cg = {} as Coin["cg"];
  for (const src of SOURCES) cg[src] = await cgHistory(CACHE, symbol, src, from - H1_BACK * H1, now);
  return { h4, h1, m15, d1, fund, tk, cg };
}
/** BingX OHLC with each source's volume (1H and 4H), built once per coin. */
type Vol = Record<"bx" | Source, { h1: C[]; h4: C[]; vb: Map<number, VBar> | null }>;
function volumes(coin: Coin): Vol {
  const out = { bx: { h1: coin.h1, h4: coin.h4, vb: null } } as Vol;
  for (const src of SOURCES) out[src] = { h1: withVolume(coin.h1, coin.cg[src], H1), h4: withVolume(coin.h4, coin.cg[src], H4), vb: coin.cg[src] };
  return out;
}

type Ctx = { btc: { h1: C[]; h4: C[] }; eth: { h1: C[]; h4: C[] } };
function features(symbol: string, kind: string, coin: Coin, S1: Series, S4: Series, S15: Series, SD: Series, trigIdx: number, frozenLevel: number, armTime: number, t: number, ctx: Ctx, vol: Vol): Row {
  const { h4, h1, m15 } = coin;
  const trig = h1[trigIdx]!;
  const entry = trig.close;
  const i4 = lastClosed(h4, t, H4);
  const c4 = h4.slice(0, i4 + 1);
  const zone = resolveFrozenZone(c4, armTime, frozenLevel, H4);
  const zones = computeSupportZones(c4.slice(-700));
  const above = zones.filter((z) => z.bottom > zone.top).sort((a, b) => a.bottom - b.bottom)[0] ?? null;
  const below = zones.filter((z) => z.top < zone.bottom).sort((a, b) => b.top - a.top)[0] ?? null;

  // The touch window on 1H: bars after the arm up to the reaction.
  let w0 = trigIdx;
  while (w0 - 1 >= 0 && h1[w0 - 1]!.time + H1 > armTime) w0--;
  let first = w0;
  for (let k = w0; k <= trigIdx; k++) if (h1[k]!.low <= zone.top * 1.002) { first = k; break; }
  let deep = w0;
  for (let k = w0; k <= trigIdx; k++) if (h1[k]!.low < h1[deep]!.low) deep = k;
  const minLow = h1[deep]!.low;

  // 3. After the touch up to the entry.
  let inZone = 0, upVol = 0, dnVol = 0, stopIn = 0, lowVolTest = 0;
  for (let k = first; k <= trigIdx; k++) {
    const b = h1[k]!;
    if (b.low <= zone.top && b.high >= zone.bottom) inZone++;
    if (b.close >= b.open) upVol += b.volume; else dnVol += b.volume;
    const vr = S1.vsa.ratio[k] ?? 0, range = b.high - b.low, cp = range > 0 ? (b.close - b.low) / range : 0.5;
    if (b.close < b.open && vr >= 1.8 && cp >= 0.5) stopIn++;
    const avg = S1.volAvg20[k];
    if (k > deep && k < trigIdx && b.low <= zone.top * 1.005 && avg && b.volume / avg <= 0.8) lowVolTest = 1;
  }
  let secondLow: number | null = null;
  for (let k = deep + 2; k < trigIdx; k++) secondLow = secondLow === null ? h1[k]!.low : Math.min(secondLow, h1[k]!.low);
  // Lows before the deepest bar inside the window (a first low that the deepest one undercut).
  let firstLowBefore: number | null = null;
  for (let k = first; k < deep - 1; k++) firstLowBefore = firstLowBefore === null ? h1[k]!.low : Math.min(firstLowBefore, h1[k]!.low);

  // 8. The level's history on 4H before the arm.
  const armI4 = idxAtOrBefore(h4, armTime - 1);
  let prevTouches = 0, prevGood = 0, prevStop = 0, firstTouchT: number | null = null, lastTouchT: number | null = null;
  for (let k = Math.max(1, armI4 - 700); k < armI4; k++) {
    const b = h4[k]!;
    const overlaps = b.low <= zone.top && b.high >= zone.bottom;
    if (overlaps && firstTouchT === null) firstTouchT = b.time;
    if (overlaps && b.time < armTime - D1) lastTouchT = b.time;
    if (b.low <= zone.top && h4[k - 1]!.low > zone.top && k + 18 < armI4) {
      prevTouches++;
      const base = b.close;
      for (let j = k + 1; j <= k + 18; j++) {
        if (h4[j]!.low <= base * 0.92) { prevStop++; break; }
        if (h4[j]!.high >= base * 1.1) { prevGood++; break; }
      }
    }
  }
  const daily = dailyFrom4h(c4);
  const dZones = computeSupportZones(daily.slice(-200));
  const e200 = emaSeries(c4.slice(-400).map((c) => c.close), 200).at(-1) ?? null;
  const e50 = emaSeries(c4.slice(-400).map((c) => c.close), 50).at(-1) ?? null;
  const pw = prevWeek(h4, t);
  const last180 = c4.slice(-180);
  const hi30 = last180.length ? Math.max(...last180.map((c) => c.high)) : null;
  const lo30 = last180.length ? Math.min(...last180.map((c) => c.low)) : null;
  const vol24 = h1.slice(Math.max(0, trigIdx - 23), trigIdx + 1).reduce((a, c) => a + c.volume * c.close, 0);
  const vol7d = h1.slice(Math.max(0, trigIdx - 167), trigIdx + 1).reduce((a, c) => a + c.volume * c.close, 0) / 7;
  const atr4h = S4.atr[i4] ?? null;
  const f = fundingAt(coin.fund, t);

  // 4. After the entry (management readings, never filters).
  let retestH: number | null = null, retestHeld: number | null = null, retestVol: number | null = null, closeBelowH: number | null = null;
  for (let k = trigIdx + 1; k < h1.length && h1[k]!.time < t + 72 * H1; k++) {
    const b = h1[k]!;
    if (retestH === null && k <= trigIdx + 24 && b.low <= zone.top) {
      retestH = (b.time + H1 - t) / H1;
      retestHeld = b.close >= zone.bottom ? 1 : 0;
      retestVol = trig.volume > 0 ? b.volume / trig.volume : null;
    }
    if (closeBelowH === null && b.close < zone.bottom) closeBelowH = (b.time + H1 - t) / H1;
  }
  const next3 = h1.slice(trigIdx + 1, trigIdx + 4);
  const post3Vol = next3.length === 3 && trig.volume > 0 ? next3.reduce((a, c) => a + c.volume, 0) / 3 / trig.volume : null;

  // 5–6. Entry variants × stops × exits.
  const structBase = Math.min(zone.bottom, minLow) * 0.997;
  const stopsFor = (e: number, lowSoFar: number) => ({
    s8: e * 0.92,
    struct: Math.min(structBase, lowSoFar * 0.997) < e ? Math.min(structBase, lowSoFar * 0.997) : null,
    atr15: atr4h ? e * (1 - (1.5 * atr4h) / 100) : null,
    atr20: atr4h ? e * (1 - (2 * atr4h) / 100) : null,
  });
  // B / D: limit at the zone top / zone middle within 24h, cancelled by a 1H close under the zone first.
  // (When the signal price is already below that line the limit fills at once at the next open.)
  const cancelAt = (() => { for (let k = trigIdx + 1; k < h1.length && h1[k]!.time < t + D1; k++) if (h1[k]!.close < zone.bottom) return h1[k]!.time + H1; return Infinity; })();
  const limitFill = (px: number) => {
    for (let i = idxAtOrBefore(m15, t - 1) + 1; i < m15.length && m15[i]!.time < t + D1 && m15[i]!.time < cancelAt; i++) {
      const b = m15[i]!;
      if (b.low <= px) return { from: b.time, entry: Math.min(px, b.open), low: Math.min(minLow, b.low) };
    }
    return null;
  };
  const fillB = limitFill(zone.top);
  const fillD = limitFill((zone.top + zone.bottom) / 2);
  const bFrom = fillB?.from ?? null, bEntry = fillB?.entry ?? null, bLow = fillB?.low ?? minLow;
  // C: after a low-volume test of the zone (1H, within 24h), at that bar's close.
  let cFrom: number | null = null, cEntry: number | null = null, cLow = minLow;
  for (let k = trigIdx + 1; k < h1.length && h1[k]!.time < t + D1; k++) {
    const b = h1[k]!;
    cLow = Math.min(cLow, b.low);
    if (b.close < zone.bottom) break;
    const avg = S1.volAvg20[k];
    if (b.low <= zone.top * 1.005 && avg && b.volume / avg <= 0.8 && b.close >= zone.bottom) { cFrom = b.time + H1; cEntry = b.close; break; }
  }

  const i15 = lastClosed(m15, t, M15);
  const iD = lastClosed(SD.cs, t, D1);
  const tkPre = takerShare(coin.tk, h1[Math.max(0, first - 12)]!.time, h1[Math.max(0, first - 1)]!.time);
  const tkWin = takerShare(coin.tk, h1[first]!.time, trig.time);
  const tkTrig = takerShare(coin.tk, trig.time, trig.time);
  const tk24 = takerShare(coin.tk, trig.time - 23 * H1, trig.time);
  const tkPost = takerShare(coin.tk, trig.time + H1, trig.time + 3 * H1);

  // A. Volumes of every source (BingX "bx" with the same functions, for a like-for-like comparison).
  const vRows: Row = {};
  for (const k of ["bx", ...SOURCES] as const) {
    const v = vol[k];
    Object.assign(vRows, volumeReadings(k, v.h1, v.h4, first, deep, trigIdx, i4, v.vb, t));
    if (k !== "bx") vRows[`${k}_coverage_7d`] = coverage(v.vb, t - D7, t);
  }
  // B. Auto Range deviations.
  const rRows: Row = {
    ...rangeReadings("15m", m15, t, zone.bottom, zone.top, D1, 700),
    ...rangeReadings("1h", h1, t, zone.bottom, zone.top, D1, 500),
    ...rangeReadings("4h", h4, t, zone.bottom, zone.top, 72 * H1, 700),
    ...rangeReadings("1d", coin.d1, t, zone.bottom, zone.top, D7, 300),
  };
  return {
    ...vRows, ...rRows,
    frozen_level: frozenLevel,
    symbol, kind,
    time_utc: new Date(t).toISOString(), entry_time_ms: t, entry,
    ...session(t),
    zone_bottom: zone.bottom, zone_top: zone.top, zone_pivots: zone.count, zone_height_pct: pct(zone.top, zone.bottom),
    zone_touches_30d: last180.filter((c) => c.low <= zone.top && c.high >= zone.bottom).length,
    arm_age_h: (t - armTime) / H1,
    sweep_below_zone_pct: pct(zone.bottom, minLow),
    entry_above_zone_top_pct: pct(entry, zone.top),
    room_to_next_resistance_pct: above ? pct(above.bottom, entry) : null,
    next_resistance_pivots: above ? above.count : null,
    next_support_below_pct: below ? pct(entry, below.top) : null,
    zones_total: zones.length,
    // 1. before
    ...approach("pre", S1, first, "down"),
    // 2. candles
    ...anatomy("touch1h", S1, first),
    ...anatomy("deep1h", S1, deep),
    ...anatomy("trig1h", S1, trigIdx),
    ...anatomy("trig15m", S15, i15),
    ...anatomy("trig4h", S4, i4),
    ...anatomy("trig1d", SD, iD),
    // 3. after the touch, before the entry
    win_bars: trigIdx - first + 1,
    win_bars_in_zone: inZone,
    win_hours_deep_to_entry: trigIdx - deep,
    win_low_vol_test: lowVolTest,
    win_second_low_vs_deep_pct: secondLow !== null ? pct(secondLow, minLow) : null,
    win_first_low_vs_deep_pct: firstLowBefore !== null ? pct(firstLowBefore, minLow) : null,
    win_up_vs_down_volume: dnVol > 0 ? upVol / dnVol : null,
    win_stopping_bars: stopIn,
    // Wyckoff / ICT on 1H (as v1)
    ...wyIct("h1", h1, trigIdx, zone.top, zone.bottom),
    // context of the coin
    atr4h_pct: atr4h, atr1h_pct: S1.atr[trigIdx] ?? null,
    price_24h_pct: pct(entry, h1[trigIdx - 24]?.close), price_7d_pct: pct(entry, h1[trigIdx - 168]?.close),
    from_high30d_pct: pct(entry, hi30), from_low30d_pct: pct(entry, lo30),
    vs_ema50_4h_pct: pct(entry, e50), vs_ema200_4h_pct: pct(entry, e200),
    vol24h_vs_7d: vol7d > 0 ? vol24 / vol7d : null, vol24h_usd_bingx: vol24,
    funding_last_pct: f.last, funding_avg3_pct: f.avg3,
    // 8. the level
    lvl_prev_touches: prevTouches, lvl_prev_good: prevGood, lvl_prev_stop: prevStop,
    lvl_first_touch_days_ago: firstTouchT !== null ? (t - firstTouchT) / D1 : null,
    lvl_last_touch_days_ago: lastTouchT !== null ? (t - lastTouchT) / D1 : null,
    conf_1d_zone: dZones.some((z) => z.bottom <= zone.top * 1.01 && z.top >= zone.bottom * 0.99) ? 1 : 0,
    conf_ema200_4h_pct: e200 ? Math.abs(pct(zone.top, e200) ?? 99) : null,
    conf_round_pct: nearRound((zone.top + zone.bottom) / 2),
    conf_prev_week_low_pct: pw.low ? Math.abs(pct((zone.top + zone.bottom) / 2, pw.low) ?? 99) : null,
    // 9. takers (Binance)
    tk_pre12_buy: tkPre.buy, tk_win_buy: tkWin.buy, tk_trig_buy: tkTrig.buy, tk_24h_delta: tk24.delta,
    // 7. majors (market columns are added after all coins)
    ...majors("btc", ctx.btc.h1, ctx.btc.h4, t),
    ...majors("eth", ctx.eth.h1, ctx.eth.h4, t),
    // 4. after the entry
    post_retest_hours: retestH, post_retest_held: retestHeld, post_retest_vol_vs_trig: retestVol,
    post_close_below_zone_hours: closeBelowH, post_first3_vol_vs_trig: post3Vol, post_tk3_buy: tkPost.buy,
    // 6. path of the signal entry
    ...path(m15, t, entry, atr4h),
    // 5–6. variants
    xA_filled: 1, xA_entry: entry, xA_delay_h: 0,
    ...grid("xA", m15, t, entry, stopsFor(entry, minLow)),
    xB_filled: bEntry ? 1 : 0, xB_entry: bEntry, xB_delay_h: bFrom !== null ? (bFrom - t) / H1 : null,
    ...grid("xB", m15, bFrom, bEntry, bEntry ? stopsFor(bEntry, bLow) : { s8: null, struct: null, atr15: null, atr20: null }),
    xD_filled: fillD ? 1 : 0, xD_entry: fillD?.entry ?? null, xD_delay_h: fillD ? (fillD.from - t) / H1 : null,
    ...grid("xD", m15, fillD?.from ?? null, fillD?.entry ?? null, fillD ? stopsFor(fillD.entry, fillD.low) : { s8: null, struct: null, atr15: null, atr20: null }),
    xC_filled: cEntry ? 1 : 0, xC_entry: cEntry, xC_delay_h: cFrom !== null ? (cFrom - t) / H1 : null,
    ...grid("xC", m15, cFrom, cEntry, cEntry ? stopsFor(cEntry, cLow) : { s8: null, struct: null, atr15: null, atr20: null }),
  };
}

/** 22.10 rule as live (sweep mode, k = 3): the zone dies on 3 closed 4H in a row > 1% under its bottom after its last pivot. */
function zoneDropped(h: C[], z: SupportZone, k: number): boolean {
  let pivotAt = -1;
  for (let i = 6; i + 6 < h.length; i++) {
    const c = h[i]!;
    if (c.low < z.bottom || c.low > z.top) continue;
    let isLow = true;
    for (let j = i - 6; j <= i + 6; j++) if (j !== i && h[j]!.low < c.low) isLow = false;
    if (isLow) pivotAt = i;
  }
  if (pivotAt < 0) return false;
  const below = z.bottom * 0.99;
  let run = 0;
  for (const c of h.slice(pivotAt + 1)) { run = c.close < below ? run + 1 : 0; if (run >= k) return true; }
  return false;
}

type Live = Map<string, number[]>;
function simulate(symbol: string, coin: Coin, from: number, now: number, ctx: Ctx, live: Live): { rows: Row[]; touches: Row[]; repeats: number } {
  const { h4, h1, m15 } = coin;
  resetRangeMemo();
  const S1 = series(h1), S4 = series(h4), S15 = series(m15), SD = series(dailyFrom4h(h4));
  const vol = volumes(coin);
  const liveT = live.get(symbol) ?? [];
  const nearLive = (t: number) => liveT.some((x) => x >= t - 3 * H1 && x <= t + 3 * H1);
  const out: Row[] = [];
  const light: { t: number; level: number; fired: boolean }[] = [];
  const busy: { from: number; to: number }[] = [];
  let repeats = 0;
  let arm: { level: number; time: number; breakoutSeen: boolean } | null = null;
  let busyUntil = -Infinity;
  for (let t = Math.ceil(from / H1) * H1; t <= now; t += H1) {
    const i4 = lastClosed(h4, t, H4), i1 = lastClosed(h1, t, H1);
    const res = evaluateAbneonSupportBounce({
      candles4h: h4.slice(Math.max(0, i4 - 639), i4 + 1),
      candles1h: h1.slice(Math.max(0, i1 - 29), i1 + 1),
      observedAt: t,
      marketCapUsd: null,
      ...(arm ? { frozenLevel: arm.level, armCandleTime: arm.time } : {}),
      sweepReclaimBars: SWEEP,
    });
    if (res.status === "qualified" && res.triggerCandleTime != null && res.frozenLevel != null && res.armCandleTime != null) {
      arm = null;
      const ti = idxAtOrBefore(h1, res.triggerCandleTime);
      if (ti < 0 || h1[ti]!.time !== res.triggerCandleTime) continue;
      const fired = t >= busyUntil;
      light.push({ t, level: res.frozenLevel, fired });
      if (fired || nearLive(t)) {
        const row = features(symbol, "bounce", coin, S1, S4, S15, SD, ti, res.frozenLevel, res.armCandleTime, t, ctx, vol);
        row.fired = fired ? 1 : 0;
        out.push(row);
      } else repeats++;
      if (fired) {
        // One trade per coin, as live: free again when the tracker trade closes.
        const tr = trade(m15, t, h1[ti]!.close, h1[ti]!.close * 0.92, "trk");
        busyUntil = tr.hours !== null ? t + tr.hours * H1 : Infinity;
        busy.push({ from: t, to: busyUntil });
      }
    } else if (res.status === "armed" && res.frozenLevel != null && res.armCandleTime != null) {
      if (!arm) arm = { level: res.frozenLevel, time: res.armCandleTime, breakoutSeen: false };
      if (res.reason === ABNEON_LEVEL_BREAKOUT_REASON && !arm.breakoutSeen) {
        arm.breakoutSeen = true;
        if (i1 >= 0) {
          const row = features(symbol, "breakout", coin, S1, S4, S15, SD, i1, arm.level, arm.time, t, ctx, vol);
          row.fired = 0; // production does not take these
          out.push(row);
        }
      }
    } else if (arm && (res.status === "terminal" || t - arm.time > ARM_TTL_MS)) {
      arm = null;
    }
  }

  // C. Every fresh 4H touch of a Neon support zone (as the indicator draws them).
  const touches: Row[] = [];
  const bx4 = vol.bx.h4, ag4 = vol.aggfut.h4, bx1 = vol.bx.h1, ag1 = vol.aggfut.h1;
  const Sb4 = series(bx4), Sa4 = series(ag4);
  const blue = (w: string | null) => w === "A" || w === "O" || w === "M" || w === "W";
  for (let k = Math.max(1, idxAtOrBefore(h4, from)); k < h4.length; k++) {
    const t = h4[k]!.time + H4;
    if (t > now) break;
    const hist = h4.slice(Math.max(0, k - 639), k + 1);
    const zones = zonesOf(hist);
    for (const z of zones) {
      const bar = h4[k]!, prev = h4[k - 1]!;
      if (!(bar.low <= z.top && prev.low > z.top)) continue;
      const near = (lvl: number) => lvl >= z.bottom * 0.99 && lvl <= z.top * 1.01;
      const sig = light.filter((x) => x.t >= t - H4 && x.t <= t + D1 && near(x.level));
      let brokeAfter: number | null = null;
      for (let j = k + 1; j < Math.min(h4.length, k + 19); j++) if (h4[j]!.close < z.bottom * 0.99) { brokeAfter = (h4[j]!.time + H4 - t) / H1; break; }
      const last6 = [k - 5, k - 4, k - 3, k - 2, k - 1, k];
      const i1t = idxAtOrBefore(h1, bar.time) ; // first 1H bar of the touch candle
      const pre12 = [...Array(12).keys()].map((q) => i1t - 12 + q).filter((q) => q >= 20);
      const pth = path(m15, t, bar.close, S4.atr[k] ?? null);
      touches.push({
        symbol, time_utc: new Date(t).toISOString(), touch_close: bar.close, touch_low: bar.low,
        zone_bottom: z.bottom, zone_top: z.top, zone_pivots: z.count,
        depth_below_bottom_pct: pct(z.bottom, bar.low), close_vs_zone_top_pct: pct(bar.close, z.top),
        zone_dropped_22_10: zoneDropped(hist, z, SWEEP) ? 1 : 0,
        zones_below: zones.filter((x) => x.top < z.bottom).length,
        bot_signal_24h: sig.length ? 1 : 0, bot_signal_fired: sig.some((x) => x.fired) ? 1 : 0,
        coin_busy: busy.some((b) => t >= b.from && t < b.to) ? 1 : 0,
        broke_below_hours: brokeAfter,
        atr4h_pct: S4.atr[k] ?? null,
        bx_touch4h_vsa: Sb4.vsa.color[k] ?? null, bx_touch4h_welkin: welkin(bx4, k),
        bx_4h_blue6: last6.filter((q) => q >= 0 && blue(welkin(bx4, q))).length, bx_4h_grey6: last6.filter((q) => q >= 0 && welkin(bx4, q) === "N").length,
        ag_touch4h_vsa: Sa4.vsa.color[k] ?? null, ag_touch4h_welkin: welkin(ag4, k),
        ag_4h_blue6: last6.filter((q) => q >= 0 && blue(welkin(ag4, q))).length, ag_4h_grey6: last6.filter((q) => q >= 0 && welkin(ag4, q) === "N").length,
        bx_1h_blue12_before: pre12.filter((q) => blue(welkin(bx1, q))).length,
        ag_1h_blue12_before: pre12.filter((q) => blue(welkin(ag1, q))).length,
        ...rangeReadings("4h", h4, t, z.bottom, z.top, 72 * H1, 700),
        out72: pth.out72, out7d: pth.out7d, peak72_pct: pth.peak72_pct, worst72_pct: pth.worst72_pct, peak7d_pct: pth.peak7d_pct,
        close72_pct: pth.close72_pct, hours_to_plus10: pth.hours_to_plus10, hours_to_minus8: pth.hours_to_minus8,
        trk_from_touch: trade(m15, t, bar.close, bar.close * 0.92, "trk").pct,
      });
    }
  }
  return { rows: out, touches, repeats };
}

function summary(rows: Row[], from: number, now: number): string {
  const lines: string[] = [];
  const mid = from + (now - D7 - from) / 2;
  const c = (rs: Row[]) => {
    const done = rs.filter((r) => r.out72 !== "OPEN");
    const n = (k: string) => done.filter((r) => r.out72 === k).length;
    const p = (k: string) => (done.length ? Math.round((100 * n(k)) / done.length) : 0);
    const trk = rs.map((r) => r.xA_s8_trk).filter((v): v is number => typeof v === "number");
    const ex = rs.map((r) => r.excess72_pct).filter((v): v is number => typeof v === "number");
    return `${rs.length} (${done.length} с итогом 72ч): GOOD ${p("GOOD")}%, STOP ${p("STOP")}%; сделка в среднем (−8%, трекер) ${trk.length ? (trk.reduce((a, b) => a + b, 0) / trk.length).toFixed(2) : "—"}%; против рынка за 72ч ${ex.length ? (ex.reduce((a, b) => a + b, 0) / ex.length).toFixed(2) : "—"}%`;
  };
  for (const kind of ["bounce", "breakout"]) {
    const rs = rows.filter((r) => r.kind === kind && (kind === "breakout" || r.fired === 1));
    lines.push(`== ${kind}${kind === "bounce" ? " (вошли бы)" : " (бот не берёт)"}: ${c(rs)}`);
    lines.push(`   первая половина: ${c(rs.filter((r) => Number(r.entry_time_ms) < mid))}`);
    lines.push(`   вторая половина: ${c(rs.filter((r) => Number(r.entry_time_ms) >= mid))}`);
  }
  return lines.join("\n");
}

async function main() {
  const now = Math.floor(Date.now() / M15) * M15;
  const from = now - DAYS * D1;
  ensureDir(OUT);
  ensureDir(CACHE);
  if (!process.env.CoinGlassAPI?.trim()) console.error("ВНИМАНИЕ: нет ключа CoinGlass (CoinGlassAPI) — колонки CoinGlass будут пустыми");
  const symbols = ONLY ?? (await usdtSymbols(CACHE)).slice(0, LIMIT);
  await binanceProbe();
  const liveAll = readLive(LIVE)?.filter((x) => x.key === "neon_support_bounce") ?? null;
  const live: Live = new Map();
  for (const x of liveAll ?? []) (live.get(x.symbol) ?? live.set(x.symbol, []).get(x.symbol)!).push(x.time);
  const btc = { h1: await klines(CACHE, "BTC-USDT", "1h", from - H1_BACK * H1, now), h4: await klines(CACHE, "BTC-USDT", "4h", from - H4_BACK * H4, now) };
  const eth = { h1: await klines(CACHE, "ETH-USDT", "1h", from - H1_BACK * H1, now), h4: await klines(CACHE, "ETH-USDT", "4h", from - H4_BACK * H4, now) };
  // Pass 1: load (cache) every coin incl. CoinGlass, build the market.
  const market = new Market();
  const errors: Record<string, string> = {};
  const ok: string[] = [];
  let done = 0;
  for (const s of symbols) {
    try {
      const coin = await loadCoin(s, from, now);
      if (coin.h4.length < 100 || coin.h1.length < 200 || coin.m15.length < 100) errors[s] = "short_history";
      else { market.addCoin(coin.h1, coin.h4); ok.push(s); }
    } catch (e) {
      errors[s] = String(e).slice(0, 120);
    }
    if (++done % 25 === 0) console.error(`загрузка ${done}/${symbols.length} · CoinGlass запросов ${cgStats.requests} (ok ${cgStats.ok}, пусто ${cgStats.empty}, ошибок ${cgStats.errors}, 429: ${cgStats.r429})`);
  }
  // Pass 2: signals, readings, touches.
  const rows: Row[] = [];
  const touches: Row[] = [];
  let repeats = 0;
  done = 0;
  for (const s of ok) {
    try {
      const r = simulate(s, await loadCoin(s, from, now), from, now, { btc, eth }, live);
      rows.push(...r.rows); touches.push(...r.touches); repeats += r.repeats;
    } catch (e) {
      errors[s] = `simulate: ${String(e).slice(0, 120)}`;
    }
    if (++done % 25 === 0) console.error(`сигналы ${done}/${ok.length}, строк ${rows.length}, касаний ${touches.length}`);
  }
  // Pass 3: market columns, live check, files.
  addMarket(rows, market);
  const liveText = liveAll
    ? compareLive(rows.filter((r) => r.kind === "bounce"), liveAll, 2 * H1, 3 * H1, join(OUT, "live_compare.csv"))
    : "живые сигналы не переданы (--live)";
  rows.sort((a, b) => Number(a.entry_time_ms) - Number(b.entry_time_ms));
  touches.sort((a, b) => String(a.time_utc).localeCompare(String(b.time_utc)));
  writeCsv(join(OUT, "trades.csv"), rows);
  writeCsv(join(OUT, "touches.csv"), touches);
  writeFileSync(join(OUT, "errors.json"), JSON.stringify(errors, null, 1));
  const fired = rows.filter((r) => r.fired === 1);
  const cov = (k: string) => fired.filter((r) => r[`${k}_cov24`] === 1).length;
  const tN = touches.length, tDrop = touches.filter((x) => x.zone_dropped_22_10 === 1).length, tSig = touches.filter((x) => x.bot_signal_24h === 1).length;
  const s =
    `ABNeon v3 · период ${new Date(from).toISOString()} .. ${new Date(now).toISOString()}, монет ${symbols.length}, ошибок ${Object.keys(errors).length}\n` +
    summary(rows, from, now) +
    `\n== bounce повторы при открытой сделке (только счёт): ${repeats}` +
    `\nCoinGlass: запросов ${cgStats.requests}, ok ${cgStats.ok}, пусто ${cgStats.empty}, ошибок ${cgStats.errors}, 429: ${cgStats.r429}` +
    `\nпокрытие объёмом (сигналы бота, 24ч до входа): ` + ["aggfut", "aggspot", "binance", "bybit", "okx", "bitget", "bingxcg"].map((k) => `${k} ${cov(k)}/${fired.length}`).join(", ") +
    `\nкасания зон 4H: ${tN}; зона выброшена правилом 22.10: ${tDrop}; бот дал сигнал за 24ч: ${tSig}` +
    `\nтейкеры Binance: ${binanceNote}\nживые: ${liveText}\nстрок ${rows.length}, колонок ${new Set(rows.flatMap((r) => Object.keys(r))).size}`;
  writeFileSync(join(OUT, "summary.txt"), s);
  console.log(s);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
