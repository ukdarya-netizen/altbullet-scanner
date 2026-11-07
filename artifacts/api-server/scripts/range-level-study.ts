/**
 * RANGE × LEVEL STUDY (owner 2026-11-07: Bless, ELSA, CAT, OLAXBT/AIO charts) — the Auto Range breakout whose
 * range top sits on an ABNeon zone. The breakout study took ABNeon level crossings as events; here the EVENT is
 * the Auto Range upside breakout itself (the indicator's "Breakout" label), on every timeframe the owner reads,
 * and the question is whether the coincidence of the range top with a Neon zone makes it work.
 *
 * Event sets ("set"): Auto Range [QuantAlgo] port with the indicator's default deviation window (as live; the
 * owner's charts show Deviation labels), every confirmed upside breakout (closed candle) in the window:
 *   F4  BingX futures 4H     F1  BingX futures 1H     S4  BingX SPOT 4H     D1  BingX futures 1D
 *   F4x / F1x / S4x  the same with deviation merging off (every break final; no deviations recorded)
 * Neon zones (both edges, as the indicator draws them) from BingX futures 4H (live) and from BingX spot 4H, as of
 * the breakout close. For the range TOP and the range BOTTOM: the nearest zone and the distance to it (0 = inside
 * the zone), its pivots, where the breakout candle closed vs that zone (inside it / above its top), whether the
 * same candle also crossed an ABNeon zone top (= the live Stealth would fire too).
 * Range: height, length in bars, down-deviations (springs) / up-deviations during the range, how deep.
 * Breakout candle: anatomy, VSA / Welkin on BingX and aggregated futures volume; volume before (12 / 24 1H bars on
 * aggregated futures and BingX: blue, grey, climax …), takers. Context: market, BTC/ETH, 7-day move, 30-day high.
 * Trades (entry = BingX futures price at the breakout close): stops −8% / under the range top −1% / ATR × exits
 * trk (live), be5trk, tp5/8/10/15 with hours; path 24 h / 72 h / 7 d. fired = one trade per coin per set.
 *
 * Run (from artifacts/api-server), offline from the breakout study's cache, three processes:
 *   STUDY_OFFLINE=1 pnpm dlx tsx scripts/range-level-study.ts --part 1/3 --days 60 --out ../../reports/range-level-study
 */
import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { computeSupportZones } from "../src/lib/stealth-abneon-detectors.js";
import { detectAutoRangePine, detectAutoRangePine1d, detectAutoRangePine1h, type AutoRangePineResult } from "../src/lib/auto-range-pine.js";
import { SOURCES, type Source, type VBar, cgHistory, volumeReadings, withVolume } from "./study-v2/cg.js";
import { bingxSpot4h } from "./study-v2/venues.js";
import {
  type C, type Row, D1, D7, H1, H4, M15, Market,
  addMarket, anatomy, ensureDir, grid, idxAtOrBefore, klines, lastClosed, majors, parseArgs, path, pct, series,
  trade, usdtSymbols, writeCsv,
} from "./study-v2/lib.js";

const args = parseArgs();
const DAYS = Number(args.get("days") ?? 60);
const OUT = args.get("out") ?? "../../reports/range-level-study";
const CACHE = args.get("cache") ?? "../../reports/.cache";
const LIMIT = Number(args.get("limit") ?? 10_000);
const ONLY = args.get("symbols")?.split(",").filter(Boolean) ?? null;
const PART = (args.get("part") ?? "1/1").split("/").map(Number) as [number, number];
const H4_BACK = 720, H1_BACK = 400, ZONE_BARS = 700;

type Coin = { h4: C[]; h1: C[]; m15: C[]; d1: C[]; spot4: C[]; cg: Partial<Record<Source, Map<number, VBar> | null>> };
const VOL_SOURCES: Source[] = ["aggfut", "aggspot", "binance", "bybit", "okx", "bitget", "bingxcg"];
async function loadCoin(symbol: string, from: number, now: number): Promise<Coin> {
  const h4 = await klines(CACHE, symbol, "4h", from - H4_BACK * H4, now);
  const h1 = await klines(CACHE, symbol, "1h", from - H1_BACK * H1, now);
  const m15 = await klines(CACHE, symbol, "15m", from - 8 * M15, now);
  const d1 = await klines(CACHE, symbol, "1d", from - 320 * D1, now).catch(() => [] as C[]);
  const spot4 = await bingxSpot4h(CACHE, symbol, from - H4_BACK * H4, now);
  const cg: Coin["cg"] = {};
  for (const s of SOURCES) if (VOL_SOURCES.includes(s)) cg[s] = await cgHistory(CACHE, symbol, s, from - H1_BACK * H1, now);
  return { h4, h1, m15, d1, spot4, cg };
}

type Z = { top: number; bottom: number; count: number };
const ar = (cs: C[]) => cs.map((c) => ({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close, closed: true }));
/** Nearest zone to a price: distance % (0 inside the zone), the zone. */
function nearest(zones: Z[], p: number): { d: number; z: Z } | null {
  let best: { d: number; z: Z } | null = null;
  for (const z of zones) {
    const d = p >= z.bottom && p <= z.top ? 0 : (Math.min(Math.abs(p - z.top), Math.abs(p - z.bottom)) / p) * 100;
    if (!best || d < best.d) best = { d, z };
  }
  return best;
}
const zonesAt = (h: C[], t: number): Z[] =>
  computeSupportZones(h.filter((c) => c.time + H4 <= t).slice(-ZONE_BARS)).map((z) => ({ top: z.top, bottom: z.bottom, count: z.count }));

type SetName = "F4" | "F1" | "S4" | "D1" | "F4x" | "F1x" | "S4x";
const TF: Record<SetName, number> = { F4: H4, F1: H1, S4: H4, D1: D1, F4x: H4, F1x: H1, S4x: H4 };
/** x = deviation merging off (every break final); the plain sets = the indicator's default, as live (deviations recorded). */
const MERGE_OFF = (s: SetName) => s.endsWith("x");

function rows(symbol: string, coin: Coin, from: number, now: number, ctx: { btc: { h1: C[]; h4: C[] }; eth: { h1: C[]; h4: C[] } }): Row[] {
  const out: Row[] = [];
  const S1 = series(coin.h1), S4 = series(coin.h4);
  const vol: Record<string, { h1: C[]; h4: C[]; vb: Map<number, VBar> | null }> = { bx: { h1: coin.h1, h4: coin.h4, vb: null } };
  for (const s of VOL_SOURCES) vol[s] = { h1: withVolume(coin.h1, coin.cg[s] ?? null, H1), h4: withVolume(coin.h4, coin.cg[s] ?? null, H4), vb: coin.cg[s] ?? null };
  const aggS4 = series(vol.aggfut!.h4), aggS1 = series(vol.aggfut!.h1);
  const sets: Record<SetName, C[]> = { F4: coin.h4, F1: coin.h1, S4: coin.spot4, D1: coin.d1, F4x: coin.h4, F1x: coin.h1, S4x: coin.spot4 };
  for (const set of Object.keys(sets) as SetName[]) {
    const cs = sets[set];
    if (cs.length < (set === "D1" ? 210 : 220)) continue;
    let res: AutoRangePineResult;
    try {
      const opts = MERGE_OFF(set) ? { mergeDeviations: false } : {};
      res = set.startsWith("F1") ? detectAutoRangePine1h(ar(cs), opts)
        : set === "D1" ? detectAutoRangePine1d(ar(cs))
        : detectAutoRangePine(ar(cs), opts);
    } catch { continue; }
    if (res.status !== "ready") continue;
    const tf = TF[set];
    let busy = -Infinity;
    for (const b of res.upsideBreakouts ?? []) {
      const t = b.breakoutCloseTime;
      if (t < from || t > now) continue;
      const k = idxAtOrBefore(cs, t - tf);
      if (k < 1 || cs[k]!.time !== t - tf) continue;
      const bar = cs[k]!, prev = cs[k - 1]!;
      const i15 = lastClosed(coin.m15, t, M15);
      if (i15 < 0) continue;
      const entry = coin.m15[i15]!.close; // BingX futures price at the breakout close
      const fz = zonesAt(coin.h4, t);
      const sz = coin.spot4.length >= 100 ? zonesAt(coin.spot4, t) : [];
      const up = nearest(fz, b.upper), lo = nearest(fz, b.lower), upS = nearest(sz, b.upper);
      // The same candle crossed an ABNeon zone top (on its own series)?
      const crossed = fz.filter((z) => prev.close <= z.top && bar.close > z.top).sort((a, c) => c.top - a.top)[0] ?? null;
      const devs = (res.deviations ?? []).filter((d) => d.reentryCloseTime <= t && d.breakoutCloseTime >= b.anchorAt);
      const dd = devs.filter((d) => d.direction === "down"), du = devs.filter((d) => d.direction === "up");
      const i1 = lastClosed(coin.h1, t, H1), i4 = lastClosed(coin.h4, t, H4);
      const vRows: Row = {};
      for (const key of ["bx", ...VOL_SOURCES]) {
        const v = vol[key]!;
        if (key !== "bx" && !v.vb) continue;
        Object.assign(vRows, volumeReadings(key, v.h1, v.h4, i1, i1, i1, i4, v.vb, t));
      }
      const atr4h = S4.atr[i4] ?? null;
      const fired = t >= busy;
      if (fired) {
        const tr = trade(coin.m15, t, entry, entry * 0.92, "trk");
        busy = tr.hours !== null ? t + tr.hours * H1 : Infinity;
      }
      const last180 = coin.h4.slice(Math.max(0, i4 - 179), i4 + 1);
      const hi30 = Math.max(...last180.map((c) => c.high));
      out.push({
        set, symbol, fired: fired ? 1 : 0,
        time_utc: new Date(t).toISOString(), entry_time_ms: t, entry,
        range_upper: b.upper, range_lower: b.lower, range_height_pct: pct(b.upper, b.lower),
        range_bars: (t - tf - b.anchorAt) / tf + 1, range_age_bars: (t - tf - b.openedAt) / tf + 1,
        bo_close_vs_upper_pct: pct(bar.close, b.upper), entry_vs_upper_pct: pct(entry, b.upper),
        // coincidence with Neon zones (futures 4H, as live)
        upper_zone_dist_pct: up?.d ?? null, upper_zone_top: up?.z.top ?? null, upper_zone_bottom: up?.z.bottom ?? null,
        upper_zone_pivots: up?.z.count ?? null, upper_zone_height_pct: up ? pct(up.z.top, up.z.bottom) : null,
        close_vs_upper_zone_top_pct: up ? pct(bar.close, up.z.top) : null,
        closed_above_upper_zone: up ? (bar.close > up.z.top ? 1 : 0) : null,
        lower_zone_dist_pct: lo?.d ?? null, lower_zone_pivots: lo?.z.count ?? null,
        upper_spot_zone_dist_pct: upS?.d ?? null,
        same_candle_neon_cross: crossed ? 1 : 0,
        zones_total: fz.length,
        next_zone_above_pct: (() => { const n = fz.filter((z) => z.bottom > bar.close).sort((a, c) => a.bottom - c.bottom)[0]; return n ? pct(n.bottom, entry) : null; })(),
        // range life
        dev_down_count: dd.length, dev_up_count: du.length,
        dev_down_last_hours_ago: dd.length ? (t - dd.at(-1)!.reentryCloseTime) / H1 : null,
        dev_down_max_extreme_pct: dd.length ? Math.max(...dd.map((d) => d.extremePct)) : null,
        dev_down_on_lower_zone: dd.length && lo ? (lo.d <= 1 ? 1 : 0) : null,
        // the breakout candle and the hours around it
        ...anatomy("bo", series(cs), k),
        ...(set === "F4" ? anatomy("boagg", aggS4, i4) : set === "F1" ? anatomy("boagg", aggS1, i1) : {}),
        ...anatomy("h1last", S1, i1),
        ...vRows,
        // context
        atr4h_pct: atr4h,
        price_24h_pct: pct(entry, coin.h1[i1 - 24]?.close), price_7d_pct: pct(entry, coin.h1[i1 - 168]?.close),
        from_high30d_pct: pct(entry, hi30),
        ...majors("btc", ctx.btc.h1, ctx.btc.h4, t),
        ...majors("eth", ctx.eth.h1, ctx.eth.h4, t),
        // path and trades
        ...path(coin.m15, t, entry, atr4h),
        ...grid("xA", coin.m15, t, entry, {
          s8: entry * 0.92,
          rtop: b.upper * 0.99 < entry * 0.997 ? b.upper * 0.99 : null,
          rmid: (b.upper + b.lower) / 2 < entry * 0.997 ? (b.upper + b.lower) / 2 : null,
          atr20: atr4h ? entry * (1 - (2 * atr4h) / 100) : null,
        }),
      });
    }
  }
  return out;
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
  const all_rows: Row[] = [];
  const errors: Record<string, string> = {};
  let done = 0, coins = 0;
  for (const s of mine) {
    try {
      const coin = await loadCoin(s, from, now);
      if (coin.h4.length < 100 || coin.h1.length < 200 || coin.m15.length < 100) { errors[s] = "short_history"; continue; }
      coins++;
      all_rows.push(...rows(s, coin, from, now, { btc, eth }));
    } catch (e) {
      errors[s] = String(e).slice(0, 160);
    }
    if (++done % 10 === 0) console.error(`часть ${part}/${parts}: ${done}/${mine.length}, событий ${all_rows.length}`);
  }
  addMarket(all_rows, market);
  all_rows.sort((a, b) => Number(a.entry_time_ms) - Number(b.entry_time_ms));
  writeCsv(join(OUT, `events_part${part}.csv`), all_rows);
  writeFileSync(join(OUT, `errors_part${part}.json`), JSON.stringify(errors, null, 1));
  const mid = from + (now - D7 - from) / 2;
  const c = (rs: Row[]) => {
    const trk = rs.map((r) => r.xA_s8_trk).filter((v): v is number => typeof v === "number");
    const m = (xs: Row[]) => { const v = xs.map((r) => r.xA_s8_trk).filter((x): x is number => typeof x === "number"); return v.length ? (v.reduce((a, b) => a + b, 0) / v.length).toFixed(2) : "—"; };
    return `${rs.length}: сделка ${trk.length ? (trk.reduce((a, b) => a + b, 0) / trk.length).toFixed(2) : "—"}% (1-я половина ${m(rs.filter((r) => Number(r.entry_time_ms) < mid))}%, 2-я ${m(rs.filter((r) => Number(r.entry_time_ms) >= mid))}%)`;
  };
  const lines: string[] = [];
  for (const set of ["F4", "F1", "S4", "D1", "F4x", "F1x", "S4x"]) {
    const rs = all_rows.filter((r) => r.set === set && r.fired === 1);
    if (!rs.length) continue;
    lines.push(`== ${set} все пробои Auto Range: ${c(rs)}`);
    lines.push(`   верх ренджа в зоне ABNeon: ${c(rs.filter((r) => r.upper_zone_dist_pct === 0))}`);
    lines.push(`   верх в пределах 2% от зоны: ${c(rs.filter((r) => typeof r.upper_zone_dist_pct === "number" && r.upper_zone_dist_pct <= 2))}`);
    lines.push(`   дальше 5% от зон: ${c(rs.filter((r) => typeof r.upper_zone_dist_pct === "number" && r.upper_zone_dist_pct > 5))}`);
  }
  const text = `Рендж × уровень · часть ${part}/${parts} · ${new Date(from).toISOString()} .. ${new Date(now).toISOString()} · монет ${mine.length}, с данными ${coins}, ошибок ${Object.keys(errors).length}\n${lines.join("\n")}\nсобытий ${all_rows.length}, колонок ${new Set(all_rows.flatMap((r) => Object.keys(r))).size}`;
  writeFileSync(join(OUT, `summary_part${part}.txt`), text);
  console.log(text);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
