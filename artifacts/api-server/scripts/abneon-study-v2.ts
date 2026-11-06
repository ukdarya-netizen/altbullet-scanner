/**
 * ABNeon study v2 (owner 2026-11-06). Same detector and rules as v1 (production evaluateAbneonSupportBounce,
 * Neon zones on 4H, sweep k = 3, closed 1H reaction, one open trade per coin), and for every signal:
 *
 *  1. BEFORE the touch (1H bars before the first bar that entered the zone): fall over 4/12/24/72 h, red
 *     streak, volume trend, coloured / grey bars, stopping volume, climax of 48 h, effort without result,
 *     no supply, ATR 24h vs 7d, the impulse of the last 7 days.            → columns pre_*
 *  2. The candles: first touch, deepest bar, the reaction (1H), and the 15m / 4H / 1D bars at the entry:
 *     anatomy, volume vs 20 bars, VSA colour, Welkin.                       → touch1h_*, deep1h_*, trig*_*
 *  3. AFTER the touch, up to the entry: bars in the zone, low-volume test, second low vs first, volume of
 *     up bars vs down bars, stopping volume inside the touch.               → win_*
 *  4. AFTER the entry (for stop / B.U. rules, not a filter): retest of the zone, its volume, the first
 *     close below the zone, volume of the first 3 bars.                     → post_*
 *  5. Entry variants: A = the signal; B = limit at the zone top within 24 h; D = limit at the zone middle
 *     within 24 h; C = after a low-volume test within 24 h.                 → xA_*, xB_*, xC_*, xD_*
 *  6. Stops s8 (−8%), struct (under the zone / sweep low), atr15 / atr20 (1.5 / 2 × ATR 4H) × exits
 *     trk (now), be5trk (B.U. after +5%), tp5 / tp8 / tp10 / tp15; 7-day test window.
 *     Path: GOOD / STOP / MID at 24h / 72h / 7d, best / worst move, hours to +5 / +10 / −8.
 *  7. Market: breadth (% coins above EMA50 4H), alt index 4h / 24h, BTC and ETH, alts vs BTC, ABNeon
 *     signals across all coins in the last 4h / 24h, session, weekday, funding; the result AGAINST the
 *     market (excess = coin − alt index over the same 24h / 72h / 7d).
 *  8. The level: how earlier touches of this zone went (+10% before −8%), first / last touch, a 1D zone at
 *     the same place, EMA200 4H, round number, previous week low nearby.
 *  9. Takers (Binance 1h buy share / delta) if Binance answers; live CAB signals matched (--live file).
 *
 * Run (from artifacts/api-server):
 *   pnpm dlx tsx scripts/abneon-study-v2.ts --days 60 --out ../../reports/abneon-study-v2 --live ../../reports/live-signals.csv
 * Optional: --symbols AIN-USDT,JCT-USDT  --limit 50  --cache ../../reports/.cache
 * Output: trades.csv, live_compare.csv, summary.txt, errors.json.
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
import {
  type C, type Row, type Series, D1, D7, H1, H4, M15, Market,
  addMarket, anatomy, approach, binanceNote, binanceProbe, compareLive, emaSeries, ensureDir, funding, fundingAt, grid,
  idxAtOrBefore, klines, lastClosed, majors, nearRound, parseArgs, path, pct, prevWeek, readLive, series, session,
  takerShare, takers, trade, usdtSymbols, writeCsv, wyIct,
} from "./study-v2/lib.js";

const args = parseArgs();
const DAYS = Number(args.get("days") ?? 60);
const OUT = args.get("out") ?? "abneon-study-v2";
const CACHE = args.get("cache") ?? "../../reports/.cache";
const LIMIT = Number(args.get("limit") ?? 10_000);
const ONLY = args.get("symbols")?.split(",").filter(Boolean) ?? null;
const LIVE = args.get("live");
const SWEEP = 3;
const ARM_TTL_MS = 24 * H1;
const H4_BACK = 720, H1_BACK = 400;

type Coin = { h4: C[]; h1: C[]; m15: C[]; fund: Awaited<ReturnType<typeof funding>>; tk: Awaited<ReturnType<typeof takers>> };
async function loadCoin(symbol: string, from: number, now: number): Promise<Coin> {
  const h4 = await klines(CACHE, symbol, "4h", from - H4_BACK * H4, now);
  const h1 = await klines(CACHE, symbol, "1h", from - H1_BACK * H1, now);
  const m15 = await klines(CACHE, symbol, "15m", from - 8 * M15, now);
  const fund = await funding(CACHE, symbol, from - 3 * D1, now);
  const tk = await takers(CACHE, symbol, from - H1_BACK * H1, now);
  return { h4, h1, m15, fund, tk };
}

function features(symbol: string, kind: string, coin: Coin, S1: Series, S4: Series, S15: Series, SD: Series, trigIdx: number, frozenLevel: number, armTime: number, t: number, ctx: { btc: { h1: C[]; h4: C[] }; eth: { h1: C[]; h4: C[] } }): Row {
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

  return {
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

function simulate(symbol: string, coin: Coin, from: number, now: number, ctx: Parameters<typeof features>[11]): Row[] {
  const { h4, h1 } = coin;
  const S1 = series(h1), S4 = series(h4), S15 = series(coin.m15), SD = series(dailyFrom4h(h4));
  const out: Row[] = [];
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
      const row = features(symbol, "bounce", coin, S1, S4, S15, SD, ti, res.frozenLevel, res.armCandleTime, t, ctx);
      row.fired = fired ? 1 : 0;
      out.push(row);
      if (fired) {
        // One trade per coin, as live: free again when the tracker trade closes.
        const tr = trade(coin.m15, t, h1[ti]!.close, h1[ti]!.close * 0.92, "trk");
        busyUntil = tr.hours !== null ? t + tr.hours * H1 : Infinity;
      }
    } else if (res.status === "armed" && res.frozenLevel != null && res.armCandleTime != null) {
      if (!arm) arm = { level: res.frozenLevel, time: res.armCandleTime, breakoutSeen: false };
      if (res.reason === ABNEON_LEVEL_BREAKOUT_REASON && !arm.breakoutSeen) {
        arm.breakoutSeen = true;
        if (i1 >= 0) {
          const row = features(symbol, "breakout", coin, S1, S4, S15, SD, i1, arm.level, arm.time, t, ctx);
          row.fired = 0; // production does not take these
          out.push(row);
        }
      }
    } else if (arm && (res.status === "terminal" || t - arm.time > ARM_TTL_MS)) {
      arm = null;
    }
  }
  return out;
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
  lines.push(`== bounce повторы при открытой сделке: ${c(rows.filter((r) => r.kind === "bounce" && r.fired === 0))}`);
  return lines.join("\n");
}

async function main() {
  const now = Math.floor(Date.now() / M15) * M15;
  const from = now - DAYS * D1;
  ensureDir(OUT);
  ensureDir(CACHE);
  const symbols = ONLY ?? (await usdtSymbols(CACHE)).slice(0, LIMIT);
  await binanceProbe();
  const btc = { h1: await klines(CACHE, "BTC-USDT", "1h", from - H1_BACK * H1, now), h4: await klines(CACHE, "BTC-USDT", "4h", from - H4_BACK * H4, now) };
  const eth = { h1: await klines(CACHE, "ETH-USDT", "1h", from - H1_BACK * H1, now), h4: await klines(CACHE, "ETH-USDT", "4h", from - H4_BACK * H4, now) };
  // Pass 1: load (cache) every coin and build the market.
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
    if (++done % 50 === 0) console.error(`загрузка ${done}/${symbols.length}`);
  }
  // Pass 2: signals and readings.
  const rows: Row[] = [];
  done = 0;
  for (const s of ok) {
    try {
      rows.push(...simulate(s, await loadCoin(s, from, now), from, now, { btc, eth }));
    } catch (e) {
      errors[s] = `simulate: ${String(e).slice(0, 120)}`;
    }
    if (++done % 25 === 0) console.error(`сигналы ${done}/${ok.length}, строк ${rows.length}`);
  }
  // Pass 3: market columns, live check, files.
  addMarket(rows, market);
  const live = readLive(LIVE)?.filter((x) => x.key === "neon_support_bounce") ?? null;
  const liveText = live
    ? compareLive(rows.filter((r) => r.kind === "bounce"), live, 2 * H1, 3 * H1, join(OUT, "live_compare.csv"))
    : "живые сигналы не переданы (--live)";
  rows.sort((a, b) => Number(a.entry_time_ms) - Number(b.entry_time_ms));
  writeCsv(join(OUT, "trades.csv"), rows);
  writeFileSync(join(OUT, "errors.json"), JSON.stringify(errors, null, 1));
  const tkRows = rows.filter((r) => r.tk_trig_buy != null).length;
  const fRows = rows.filter((r) => r.funding_last_pct != null).length;
  const s =
    `ABNeon v2 · период ${new Date(from).toISOString()} .. ${new Date(now).toISOString()}, монет ${symbols.length}, ошибок ${Object.keys(errors).length}\n` +
    summary(rows, from, now) +
    `\nтейкеры: ${binanceNote}; строк с тейкерами ${tkRows} из ${rows.length}\nфандинг: строк с фандингом ${fRows} из ${rows.length}\nживые: ${liveText}\nстрок всего ${rows.length}, колонок ${new Set(rows.flatMap((r) => Object.keys(r))).size}`;
  writeFileSync(join(OUT, "summary.txt"), s);
  console.log(s);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
