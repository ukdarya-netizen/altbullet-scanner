/**
 * Stealth study v2 (owner 2026-11-06): the new Stealth — breakout of a Neon resistance on a closed 4H / 1D
 * candle — with the same detector as v1 (production evaluateNeonLevelBreakout, 700 4H bars, 1D wins at the
 * 20:00 UTC close, one open trade per coin; repeats are kept with fired = 0) and for every event:
 *
 *  1. BEFORE the breakout: the base under the level (bars below it, tests of the level in 7 days, false
 *     breakouts in 30 days, higher lows, ATR / Bollinger compression, volume dry-up, run-up of 3 days) on
 *     4H, and the 1H approach (moves, streak, volume trend, VSA events, climax, effort, compression).
 *                                                                          → base_*, pre_*
 *  2. The breakout candle (its TF), the last 1H and 15m bars: anatomy, volume, VSA, Welkin; Wyckoff / ICT
 *     as in v1.                                                            → bo_*, h1last_*, bo15m_*
 *  3–4. AFTER the breakout candle: retest of the level (when, held or not, its volume), the first close
 *     back under the level, volume of the next 3 hours, takers after.     → post_*
 *  5. Entry variants: A = at the breakout close (now); B = on a retest that holds (1H touches the level
 *     and closes above it; 24h for 4H, 72h for 1D; cancelled by a close under the level); C = when price
 *     takes out the breakout candle's high (same window).                 → xA_*, xB_*, xC_*
 *  6. Stops s8 (−8%), struct (under the level), atr15 / atr20 (1.5 / 2 × ATR 4H) × exits trk (now),
 *     be5trk, tp5 / tp8 / tp10 / tp15; 7-day test window. Path at 24h / 72h / 7d, best / worst, timing.
 *  7. Market: breadth, alt index, BTC / ETH, Stealth signals across coins, session, funding, the result
 *     AGAINST the market.
 *  8. The level: earlier tests from below and how they ended (rejected −8% / passed +10%), first / last
 *     test, 1D zone, EMA200 4H, round number, previous week high.
 *  9. Takers (Binance) if reachable; live CAB Stealth signals matched (--live).
 *
 * Run (from artifacts/api-server), after the ABNeon run (shares the candle cache):
 *   pnpm dlx tsx scripts/stealth-study-v2.ts --days 60 --out ../../reports/stealth-study-v2 --live ../../reports/live-signals.csv
 */
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { computeSupportZones } from "../src/lib/stealth-abneon-detectors.js";
import { dailyFrom4h, evaluateNeonLevelBreakout } from "../src/lib/stealth-neon-level-breakout.js";
import {
  type C, type Row, type Series, D1, D7, H1, H4, M15, Market,
  addMarket, anatomy, approach, binanceNote, binanceProbe, compareLive, emaSeries, ensureDir, funding, fundingAt, grid,
  idxAtOrBefore, klines, lastClosed, majors, nearRound, parseArgs, path, pct, prevWeek, readLive, series, session,
  takerShare, takers, trade, usdtSymbols, writeCsv, wyIct,
} from "./study-v2/lib.js";

const args = parseArgs();
const DAYS = Number(args.get("days") ?? 60);
const OUT = args.get("out") ?? "stealth-study-v2";
const CACHE = args.get("cache") ?? "../../reports/.cache";
const LIMIT = Number(args.get("limit") ?? 10_000);
const ONLY = args.get("symbols")?.split(",").filter(Boolean) ?? null;
const LIVE = args.get("live");
const ZONE_BARS = 700;
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
type Ctx = { btc: { h1: C[]; h4: C[] }; eth: { h1: C[]; h4: C[] } };

function simulate(symbol: string, coin: Coin, from: number, now: number, ctx: Ctx): Row[] {
  const { h4, h1, m15 } = coin;
  const S1 = series(h1), S4 = series(h4), S15 = series(m15);
  const days = dailyFrom4h(h4);
  const SD = series(days);
  const out: Row[] = [];
  const past: { at: number; top: number }[] = [];
  let busyUntil = -Infinity;
  for (let start = Math.ceil(from / H4) * H4; start + H4 <= now; start += H4) {
    const t = start + H4; // close time = entry time
    const bi = idxAtOrBefore(h4, start);
    if (bi < 0 || h4[bi]!.time !== start) continue;
    const hist = h4.slice(Math.max(0, bi - ZONE_BARS + 1), bi + 1);
    const ev = evaluateNeonLevelBreakout(hist, start);
    if (!ev) continue;
    const entry = ev.close;
    const top = ev.level.top, bottom = ev.level.bottom;
    const fired = t >= busyUntil;
    const sameLevel = past.filter((p) => t - p.at <= 30 * D1 && Math.abs(p.top - top) / top <= 0.01).length;
    past.push({ at: t, top });

    // The breakout candle and where it starts in 4H / 1H.
    const is1d = ev.tf === "1d";
    const boStart = is1d ? Math.floor(start / D1) * D1 : start;
    const boSeries: Series = is1d ? SD : S4;
    const boIdx = idxAtOrBefore(boSeries.cs, ev.candleTime);
    const bo = boSeries.cs[boIdx]!;
    const base4 = idxAtOrBefore(h4, boStart - 1); // last 4H bar before the breakout candle
    const pre1 = idxAtOrBefore(h1, boStart); // first 1H bar of the breakout candle

    // 1. The base under the level (4H, before the breakout candle).
    let below = 0;
    for (let k = base4; k >= 0 && h4[k]!.close <= top && below < 180; k--) below++;
    let tests7d = 0;
    for (let k = Math.max(1, base4 - 41); k <= base4; k++) {
      const b = h4[k]!, p = h4[k - 1]!;
      const isTest = b.high >= bottom && b.close <= top;
      const wasTest = p.high >= bottom && p.close <= top;
      if (isTest && !wasTest) tests7d++;
    }
    let falseBreaks = 0;
    for (let k = Math.max(0, base4 - 179); k <= base4 - 1; k++) {
      if (h4[k]!.close > top && (k === 0 || h4[k - 1]!.close <= top)) {
        for (let j = k + 1; j <= Math.min(base4, k + 3); j++) if (h4[j]!.close <= top) { falseBreaks++; break; }
      }
    }
    const lows = (a: number, b: number) => Math.min(...h4.slice(Math.max(0, a), b + 1).map((c) => c.low));
    const atrRange = (a: number, b: number) => { const xs = h4.slice(Math.max(1, a), b + 1).map((c) => c.high - c.low); return xs.length ? xs.reduce((x, y) => x + y, 0) / xs.length : null; };
    const bbw = (k: number) => { const xs = h4.slice(Math.max(0, k - 19), k + 1).map((c) => c.close); const m = xs.reduce((a, b) => a + b, 0) / xs.length; const sd = Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length); return m > 0 ? sd / m : null; };
    const bbwNow = bbw(base4);
    const bbwAvg = (() => { const xs: number[] = []; for (let k = base4 - 42; k < base4; k++) { const v = bbw(k); if (v != null) xs.push(v); } return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null; })();
    const vAvg = (a: number, b: number) => { const xs = h4.slice(Math.max(0, a), b + 1).map((c) => c.volume); return xs.length ? xs.reduce((x, y) => x + y, 0) / xs.length : null; };
    const v6 = vAvg(base4 - 5, base4), v42 = vAvg(base4 - 41, base4);
    const boVol4 = is1d ? h4.slice(base4 + 1, bi + 1).reduce((a, c) => a + c.volume, 0) / Math.max(1, bi - base4) : h4[bi]!.volume;
    const lowSlope = (() => { const ys = h4.slice(Math.max(0, base4 - 11), base4 + 1).map((c) => c.low); const n = ys.length, m = ys.reduce((a, b) => a + b, 0) / n, xm = (n - 1) / 2; let num = 0, den = 0; ys.forEach((y, i) => { num += (i - xm) * (y - m); den += (i - xm) ** 2; }); return den && m ? (num / den / m) * 100 : null; })();

    // 8. The level's history: tests from below and how they ended (on 4H, outcome window closed before).
    let prevTests = 0, prevRejected = 0, prevPassed = 0, firstTestT: number | null = null, lastTestT: number | null = null;
    for (let k = Math.max(1, bi - ZONE_BARS); k < base4 - 18; k++) {
      const b = h4[k]!;
      if (b.high >= bottom && b.close <= top) {
        if (firstTestT === null) firstTestT = b.time;
        lastTestT = b.time;
      }
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
    const i1 = lastClosed(h1, t, H1);
    const vol24 = h1.slice(Math.max(0, i1 - 23), i1 + 1).reduce((a, c) => a + c.volume * c.close, 0);
    const vol7d = h1.slice(Math.max(0, i1 - 167), i1 + 1).reduce((a, c) => a + c.volume * c.close, 0) / 7;
    const atr4h = S4.atr[bi] ?? null;
    const f = fundingAt(coin.fund, t);
    const zones = ev.zones;
    const belowZone = computeSupportZones(hist).filter((z) => z.top < bottom).sort((a, b) => b.top - a.top)[0] ?? null;

    // 3–4. After the breakout.
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

    // 5–6. Variants.
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

    const tkBase = takerShare(coin.tk, boStart - 24 * H1, boStart - H1);
    const tkBo = takerShare(coin.tk, boStart, t - H1);
    const tk24 = takerShare(coin.tk, t - 24 * H1, t - H1);
    const tkPost = takerShare(coin.tk, t, t + 2 * H1);
    const row: Row = {
      symbol, tf: ev.tf, fired: fired ? 1 : 0,
      time_utc: new Date(t).toISOString(), entry_time_ms: t, entry,
      ...session(t),
      prev_close: ev.prevClose,
      level_bottom: bottom, level_top: top, level_pivots: ev.level.count, level_height_pct: pct(top, bottom),
      levels_crossed: ev.crossed.length,
      close_above_level_pct: pct(entry, top), prev_close_below_level_pct: pct(top, ev.prevClose),
      room_to_next_resistance_pct: ev.nextResistance ? pct(ev.nextResistance.bottom, entry) : null,
      next_resistance_pivots: ev.nextResistance?.count ?? null,
      next_support_below_pct: belowZone ? pct(entry, belowZone.top) : null,
      zones_total: zones.length,
      same_level_breakouts_30d_before: sameLevel,
      // 1. base
      base_bars_below_level: below,
      base_tests_7d: tests7d,
      base_false_breaks_30d: falseBreaks,
      base_higher_lows_pct: base4 >= 12 ? pct(lows(base4 - 5, base4), lows(base4 - 11, base4 - 6)) : null,
      base_low_slope12_pct_per_bar: lowSlope,
      base_atr6_vs_atr42: (() => { const a = atrRange(base4 - 5, base4), b = atrRange(base4 - 41, base4); return a != null && b ? a / b : null; })(),
      base_bbw_vs_avg42: bbwNow != null && bbwAvg ? bbwNow / bbwAvg : null,
      base_vol6_vs_vol42: v6 != null && v42 ? v6 / v42 : null,
      bo_vol_vs_base42: v42 ? boVol4 / v42 : null,
      base_runup_3d_pct: pct(ev.prevClose, lows(base4 - 17, base4)),
      ...approach("pre", S1, pre1, "up"),
      // 2. candles
      ...anatomy("bo", boSeries, boIdx),
      ...wyIct("bo", boSeries.cs, boIdx, top, bottom),
      ...anatomy("h1last", S1, i1),
      ...wyIct("h1", h1, i1, top, bottom),
      ...anatomy("bo15m", S15, lastClosed(m15, t, M15)),
      // context
      atr4h_pct: atr4h, atr1h_pct: S1.atr[i1] ?? null,
      price_24h_pct: pct(entry, h1[i1 - 24]?.close), price_7d_pct: pct(entry, h1[i1 - 168]?.close),
      from_high30d_pct: pct(entry, hi30), from_low30d_pct: pct(entry, lo30),
      vs_ema50_4h_pct: pct(entry, e50), vs_ema200_4h_pct: pct(entry, e200),
      vol24h_vs_7d: vol7d > 0 ? vol24 / vol7d : null, vol24h_usd_bingx: vol24,
      funding_last_pct: f.last, funding_avg3_pct: f.avg3,
      // 8. level
      lvl_prev_tests: prevTests, lvl_prev_rejected: prevRejected, lvl_prev_passed: prevPassed,
      lvl_first_test_days_ago: firstTestT !== null ? (t - firstTestT) / D1 : null,
      lvl_last_test_days_ago: lastTestT !== null ? (t - lastTestT) / D1 : null,
      conf_1d_zone: dZones.some((z) => z.bottom <= top * 1.01 && z.top >= bottom * 0.99) ? 1 : 0,
      conf_ema200_4h_pct: e200 ? Math.abs(pct(top, e200) ?? 99) : null,
      conf_round_pct: nearRound((top + bottom) / 2),
      conf_prev_week_high_pct: pw.high ? Math.abs(pct((top + bottom) / 2, pw.high) ?? 99) : null,
      // 9. takers
      tk_base24_buy: tkBase.buy, tk_bo_buy: tkBo.buy, tk_24h_delta: tk24.delta,
      ...majors("btc", ctx.btc.h1, ctx.btc.h4, t),
      ...majors("eth", ctx.eth.h1, ctx.eth.h4, t),
      // 3–4. after
      post_retest_hours: retestH, post_retest_held: retestHeld, post_retest_vol_vs_bo: retestVol,
      post_close_under_level_hours: closeUnderH, post_first3_vol_vs_bo: post3, post_tk3_buy: tkPost.buy,
      ...path(m15, t, entry, atr4h),
      xA_filled: 1, xA_entry: entry, xA_delay_h: 0,
      ...grid("xA", m15, t, entry, stopsFor(entry)),
      xB_filled: bEntry ? 1 : 0, xB_entry: bEntry, xB_delay_h: bFrom !== null ? (bFrom - t) / H1 : null,
      ...grid("xB", m15, bFrom, bEntry, bEntry ? stopsFor(bEntry) : none),
      xC_filled: cEntry ? 1 : 0, xC_entry: cEntry, xC_delay_h: cFrom !== null ? (cFrom - t) / H1 : null,
      ...grid("xC", m15, cFrom, cEntry, cEntry ? stopsFor(cEntry) : none),
    };
    out.push(row);
    if (fired) {
      const tr = trade(m15, t, entry, entry * 0.92, "trk");
      busyUntil = tr.hours !== null ? t + tr.hours * H1 : Infinity;
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
  for (const tf of ["4h", "1d"]) {
    const rs = rows.filter((r) => r.tf === tf && r.fired === 1);
    lines.push(`== ${tf} (вошли бы): ${c(rs)}`);
    lines.push(`   первая половина: ${c(rs.filter((r) => Number(r.entry_time_ms) < mid))}`);
    lines.push(`   вторая половина: ${c(rs.filter((r) => Number(r.entry_time_ms) >= mid))}`);
    lines.push(`== ${tf} повторы при открытой сделке: ${c(rows.filter((r) => r.tf === tf && r.fired === 0))}`);
  }
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
  addMarket(rows, market);
  const live = readLive(LIVE)?.filter((x) => x.key === "stealth_breakout" && x.method.startsWith("neon_level_")) ?? null;
  const liveText = live
    ? compareLive(rows, live, 0, 3 * H1, join(OUT, "live_compare.csv"))
    : "живые сигналы не переданы (--live)";
  rows.sort((a, b) => Number(a.entry_time_ms) - Number(b.entry_time_ms));
  writeCsv(join(OUT, "trades.csv"), rows);
  writeFileSync(join(OUT, "errors.json"), JSON.stringify(errors, null, 1));
  const tkRows = rows.filter((r) => r.tk_bo_buy != null).length;
  const fRows = rows.filter((r) => r.funding_last_pct != null).length;
  const s =
    `Stealth v2 · период ${new Date(from).toISOString()} .. ${new Date(now).toISOString()}, монет ${symbols.length}, ошибок ${Object.keys(errors).length}\n` +
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
