/**
 * ABNeon «защита уровня» (owner 2026-11-10): the live pre-touch gate (10 of 12 blue 1H bars BEFORE the touch)
 * killed 2189 bounces on 325 coins since 07.11 and let 2 signals through. On the owner's charts the bright
 * Welkin bars (orange / magenta / white) stand ON the touch and on the reaction — the level is defended.
 *
 * One run, every variant on the same bounce events (the bot's own detector, sweep k3, as live):
 *   N   no volume condition (every qualified bounce)
 *   A   live gate: ≥10 of 12 Welkin-blue 1H bars before the first touch (CAB's own preTouchBlueCount)
 *   B1  defence on 1H: a 1H bar from the first touch to the reaction is Welkin O/M/W and closes ≥ zone bottom
 *   C1  B1 + the reaction 1H bar is Welkin blue or brighter
 *   B4  defence on 4H: the 4H bar of the first touch (or a later closed one up to entry) is Welkin O/M/W and
 *       closes ≥ zone bottom. Entry waits for that 4H close when the touch bar is still open (no look-ahead).
 *   C4  B4 + the reaction 1H bar is blue or brighter
 *   D   A or C1
 * each on CoinGlass aggregated futures volume (agg, as live) and on BingX's own volume (bx, what Welkin on
 * the owner's BingX charts shows).
 *
 * Outcomes (BingX 15m, stop −8% as live, CAB tracker exit; +5/+8/+10 fixed takes for comparison): peak ≥10%
 * in 72 h / 7 d, stop first, average trade, deposit (10% of the deposit per trade, no leverage, trades in
 * close order), both halves of the period, one trade per coin at a time per variant (as live).
 * NOT simulated (live only, no history): the scan's general gates (spot 24h volume, market cap, spread, …).
 *
 * Run (from artifacts/api-server; candle / CoinGlass cache of the v2/v3 studies; key from Secrets, never printed):
 *   pnpm dlx tsx scripts/abneon-defense-study.ts --days 64 --out ../../reports/abneon-defense
 * Options: --symbols A-USDT,B-USDT · --limit N · STUDY_CG_RPM (default 40).
 */
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { evaluateAbneonSupportBounce, resolveFrozenZone } from "../src/lib/stealth-abneon-detectors.js";
import { preTouchBlueCount } from "../src/lib/abneon-volume-gate.js";
import { type VBar, cgHistory, cgStats, withVolume } from "./study-v2/cg.js";
import {
  type C, type Row, D1, H1, H4, M15, ensureDir, idxAtOrBefore, klines, lastClosed, parseArgs, path, trade,
  usdtSymbols, welkin, writeCsv,
} from "./study-v2/lib.js";

const args = parseArgs();
const DAYS = Number(args.get("days") ?? 64);
const OUT = args.get("out") ?? "abneon-defense";
const CACHE = args.get("cache") ?? "../../reports/.cache";
const LIMIT = Number(args.get("limit") ?? 10_000);
const ONLY = args.get("symbols")?.split(",").filter(Boolean) ?? null;
const OWNER_COINS = ["PIEVERSE-USDT", "PRIORS-USDT", "EDGEX-USDT", "GANG-USDT", "INIT-USDT", "KNOTS-USDT", "SI-USDT"];
const SWEEP = 3;
const ARM_TTL_MS = 24 * H1;
const STOP = 0.92;
const H4_BACK = 720, H1_BACK = 400;

const BRIGHT = new Set(["O", "M", "W"]);
const BLUE_UP = new Set(["A", "O", "M", "W"]);
const SRC = ["agg", "bx"] as const;
type Src = (typeof SRC)[number];
const VARIANTS = ["N", "A", "B1", "C1", "B4", "C4", "D"] as const;
type Variant = (typeof VARIANTS)[number];

type Coin = { h4: C[]; h1: C[]; m15: C[]; agg: Map<number, VBar> | null };
async function loadCoin(symbol: string, from: number, now: number): Promise<Coin> {
  const h4 = await klines(CACHE, symbol, "4h", from - H4_BACK * H4, now);
  const h1 = await klines(CACHE, symbol, "1h", from - H1_BACK * H1, now);
  const m15 = await klines(CACHE, symbol, "15m", from - 8 * M15, now);
  const agg = await cgHistory(CACHE, symbol, "aggfut", from - H1_BACK * H1, now);
  return { h4, h1, m15, agg };
}

/** One qualified bounce with every reading the variants need. */
type Ev = {
  symbol: string; t: number; ti: number; level: number; bottom: number; firstTouch: number;
  pre: Record<Src, number | null>; def1: Record<Src, boolean | null>; react: Record<Src, boolean | null>;
  def4: Record<Src, { ok: boolean | null; at: number | null; colour: string | null }>;
  touchColours1h: Record<Src, string>;
};

function usdMap(cs: C[]): Map<number, number> {
  return new Map(cs.filter((c) => Number.isFinite(c.volume) && c.volume > 0).map((c) => [c.time, c.volume * c.close]));
}

function events(symbol: string, coin: Coin, from: number, now: number): Ev[] {
  const { h4, h1 } = coin;
  const v1: Record<Src, C[]> = { agg: withVolume(h1, coin.agg, H1), bx: h1 };
  const v4: Record<Src, C[]> = { agg: withVolume(h4, coin.agg, H4), bx: h4 };
  const usd: Record<Src, Map<number, number>> = {
    agg: new Map([...(coin.agg ?? new Map()).values()].map((b) => [b.time, b.buy + b.sell])),
    bx: usdMap(h1),
  };
  const out: Ev[] = [];
  let arm: { level: number; time: number } | null = null;
  for (let t = Math.ceil(from / H1) * H1; t <= now; t += H1) {
    const i4 = lastClosed(h4, t, H4), i1 = lastClosed(h1, t, H1);
    const res = evaluateAbneonSupportBounce({
      candles4h: h4.slice(Math.max(0, i4 - 639), i4 + 1),
      candles1h: h1.slice(Math.max(0, i1 - 29), i1 + 1),
      observedAt: t, marketCapUsd: null,
      ...(arm ? { frozenLevel: arm.level, armCandleTime: arm.time } : {}),
      sweepReclaimBars: SWEEP,
    });
    if (res.status === "qualified" && res.triggerCandleTime != null && res.frozenLevel != null && res.armCandleTime != null) {
      arm = null;
      const ti = idxAtOrBefore(h1, res.triggerCandleTime);
      if (ti < 0 || h1[ti]!.time !== res.triggerCandleTime) continue;
      const armT = res.armCandleTime, level = res.frozenLevel;
      const zone = resolveFrozenZone(h4.slice(0, i4 + 1), armT, level);
      // First touch exactly as the live gate finds it.
      let w0 = ti;
      while (w0 - 1 >= 0 && h1[w0 - 1]!.time + H1 > armT) w0--;
      let first = w0;
      for (let k = w0; k <= ti; k++) if (h1[k]!.low <= level * 1.002) { first = k; break; }
      const ev: Ev = {
        symbol, t, ti, level, bottom: zone.bottom, firstTouch: h1[first]!.time,
        pre: { agg: null, bx: null }, def1: { agg: null, bx: null }, react: { agg: null, bx: null },
        def4: { agg: { ok: null, at: null, colour: null }, bx: { ok: null, at: null, colour: null } },
        touchColours1h: { agg: "", bx: "" },
      };
      for (const s of SRC) {
        const g = preTouchBlueCount({ candles1h: h1.slice(0, ti + 1), aggUsdByTime: usd[s], armCandleTime: armT, triggerCandleTime: h1[ti]!.time, zoneTop: level });
        ev.pre[s] = g.ok ? g.blue : null;
        // 1H defence: first touch .. reaction (all closed at t).
        let known = true, def = false, cols = "";
        for (let k = first; k <= ti; k++) {
          const w = welkin(v1[s], k);
          cols += w ?? "?";
          if (w === null) { known = false; continue; }
          if (BRIGHT.has(w) && h1[k]!.close >= zone.bottom) def = true;
        }
        ev.touchColours1h[s] = cols;
        ev.def1[s] = def ? true : known ? false : null;
        const wr = welkin(v1[s], ti);
        ev.react[s] = wr === null ? null : BLUE_UP.has(wr);
        // 4H defence: the 4H bar of the first touch and later closed 4H bars, up to 24 h after the touch.
        const j0 = idxAtOrBefore(h4, h1[first]!.time);
        let found: { at: number; colour: string } | null = null, unknown = false;
        // Closed bars before the signal are read at the signal; at most one 4H close at/after it is waited for.
        for (let j = j0; j >= 0 && j < h4.length; j++) {
          const close = h4[j]!.time + H4;
          if (close > now || close > h1[first]!.time + ARM_TTL_MS) break;
          const w = welkin(v4[s], j);
          if (w === null) unknown = true;
          else if (BRIGHT.has(w) && h4[j]!.close >= zone.bottom) { found = { at: Math.max(t, close), colour: w }; break; }
          if (close >= t) break;
        }
        ev.def4[s] = found ? { ok: true, at: found.at, colour: found.colour } : { ok: unknown ? null : false, at: null, colour: null };
      }
      out.push(ev);
    } else if (res.status === "armed" && res.frozenLevel != null && res.armCandleTime != null) {
      if (!arm) arm = { level: res.frozenLevel, time: res.armCandleTime };
    } else if (arm && (res.status === "terminal" || t - arm.time > ARM_TTL_MS)) {
      arm = null;
    }
  }
  return out;
}

/** Entry time of an event under a variant, or null when the variant does not take it. */
function entryAt(ev: Ev, v: Variant, s: Src): number | null {
  const c1 = ev.def1[s] === true && ev.react[s] === true;
  switch (v) {
    case "N": return ev.t;
    case "A": return (ev.pre[s] ?? -1) >= 10 ? ev.t : null;
    case "B1": return ev.def1[s] === true ? ev.t : null;
    case "C1": return c1 ? ev.t : null;
    case "B4": return ev.def4[s].ok === true ? ev.def4[s].at : null;
    case "C4": return ev.def4[s].ok === true && ev.react[s] === true ? ev.def4[s].at : null;
    case "D": return (ev.pre[s] ?? -1) >= 10 || c1 ? ev.t : null;
  }
}

type Trade = { symbol: string; variant: Variant; src: Src; at: number; entry: number; row: Row; trk: number | null; trkH: number | null };

function priceAt(coin: Coin, at: number): number | null {
  const k = idxAtOrBefore(coin.h1, at - H1);
  return k >= 0 && coin.h1[k]!.time + H1 === at ? coin.h1[k]!.close : null;
}

function stats(ts: Trade[]): Row {
  const done = ts.filter((x) => x.row.out72 !== "OPEN");
  const share = (f: (x: Trade) => boolean) => (done.length ? Math.round((1000 * done.filter(f).length) / done.length) / 10 : null);
  const avg = (k: string) => {
    const xs = ts.map((x) => x.row[k]).filter((v): v is number => typeof v === "number");
    return xs.length ? Math.round((100 * xs.reduce((a, b) => a + b, 0)) / xs.length) / 100 : null;
  };
  const trk = ts.map((x) => x.trk).filter((v): v is number => v !== null);
  const sorted = [...ts].filter((x) => x.trk !== null).sort((a, b) => a.at + (a.trkH ?? 0) * H1 - (b.at + (b.trkH ?? 0) * H1));
  let dep = 100;
  for (const x of sorted) dep *= 1 + (0.1 * x.trk!) / 100;
  const q = (p: number) => { const s = [...trk].sort((a, b) => a - b); return s.length ? Math.round(100 * s[Math.min(s.length - 1, Math.floor(p * s.length))]!) / 100 : null; };
  return {
    trades: ts.length, coins: new Set(ts.map((x) => x.symbol)).size, with_72h_result: done.length,
    peak10_72h_pct: share((x) => x.row.out72 === "GOOD"), stop_first_72h_pct: share((x) => x.row.out72 === "STOP"),
    peak10_7d_pct: share((x) => x.row.out7d === "GOOD"),
    trk_avg_pct: trk.length ? Math.round((100 * trk.reduce((a, b) => a + b, 0)) / trk.length) / 100 : null,
    trk_p10: q(0.1), trk_p25: q(0.25), trk_p75: q(0.75), trk_p90: q(0.9),
    tp5_avg_pct: avg("tp5"), tp8_avg_pct: avg("tp8"), tp10_avg_pct: avg("tp10"),
    deposit_growth_pct: Math.round((dep - 100) * 100) / 100,
  };
}

async function main() {
  const now = Math.floor(Date.now() / M15) * M15;
  const from = now - DAYS * D1;
  const mid = from + (now - from) / 2;
  ensureDir(OUT); ensureDir(CACHE);
  if (!process.env.CoinGlassAPI?.trim()) console.error("ВНИМАНИЕ: нет ключа CoinGlass — агрегированный объём будет пустым (только кэш)");
  const symbols = ONLY ?? (await usdtSymbols(CACHE)).slice(0, LIMIT);
  const errors: Record<string, string> = {};
  const trades: Trade[] = [];
  const evRows: Row[] = [];
  let done = 0;
  for (const symbol of symbols) {
    try {
      const coin = await loadCoin(symbol, from, now);
      if (coin.h4.length < 100 || coin.h1.length < 200 || coin.m15.length < 100) { errors[symbol] = "short_history"; continue; }
      const evs = events(symbol, coin, from, now);
      const busy = new Map<string, number>();
      for (const ev of evs) {
        const base: Row = {
          symbol, signal_utc: new Date(ev.t).toISOString(), first_touch_utc: new Date(ev.firstTouch).toISOString(),
          zone_top: ev.level, zone_bottom: ev.bottom, entry_at_signal: coin.h1[ev.ti]!.close,
          agg_pre_blue12: ev.pre.agg, bx_pre_blue12: ev.pre.bx,
          agg_touch_1h_colours: ev.touchColours1h.agg, bx_touch_1h_colours: ev.touchColours1h.bx,
          agg_def1h: ev.def1.agg, bx_def1h: ev.def1.bx, agg_react_blue: ev.react.agg, bx_react_blue: ev.react.bx,
          agg_def4h: ev.def4.agg.ok, agg_def4h_colour: ev.def4.agg.colour, bx_def4h: ev.def4.bx.ok, bx_def4h_colour: ev.def4.bx.colour,
        };
        const pathAtSignal = path(coin.m15, ev.t, coin.h1[ev.ti]!.close, null);
        Object.assign(base, { peak72_pct: pathAtSignal.peak72_pct, worst72_pct: pathAtSignal.worst72_pct, out72: pathAtSignal.out72, out7d: pathAtSignal.out7d, hours_to_plus10: pathAtSignal.hours_to_plus10, hours_to_minus8: pathAtSignal.hours_to_minus8 });
        for (const s of SRC) for (const v of VARIANTS) {
          const at = entryAt(ev, v, s);
          base[`${s}_${v}`] = at === null ? 0 : 1;
          if (at === null) continue;
          const key = `${s}_${v}`;
          if (at < (busy.get(key) ?? -Infinity)) { base[`${s}_${v}`] = "busy"; continue; }
          const entry = at === ev.t ? coin.h1[ev.ti]!.close : priceAt(coin, at);
          if (entry === null) continue;
          const tr = trade(coin.m15, at, entry, entry * STOP, "trk");
          busy.set(key, tr.hours !== null ? at + tr.hours * H1 : Infinity);
          const row: Row = { ...path(coin.m15, at, entry, null) };
          for (const r of ["tp5", "tp8", "tp10"] as const) row[r] = trade(coin.m15, at, entry, entry * STOP, r).pct;
          trades.push({ symbol, variant: v, src: s, at, entry, row, trk: tr.pct, trkH: tr.hours });
        }
        evRows.push(base);
      }
    } catch (e) {
      errors[symbol] = String(e).slice(0, 160);
    }
    if (++done % 25 === 0) console.error(`монеты ${done}/${symbols.length}, отскоков ${evRows.length} · CoinGlass ${cgStats.requests} (ok ${cgStats.ok}, пусто ${cgStats.empty}, ошибок ${cgStats.errors}, 429: ${cgStats.r429})`);
  }

  const table: Row[] = [];
  for (const s of SRC) for (const v of VARIANTS) {
    const ts = trades.filter((x) => x.src === s && x.variant === v);
    table.push({ volume: s, variant: v, half: "all", ...stats(ts) });
    table.push({ volume: s, variant: v, half: "1st", ...stats(ts.filter((x) => x.at < mid)) });
    table.push({ volume: s, variant: v, half: "2nd", ...stats(ts.filter((x) => x.at >= mid)) });
  }
  const tradeRows: Row[] = trades.map((x) => ({ volume: x.src, variant: x.variant, symbol: x.symbol, entry_utc: new Date(x.at).toISOString(), entry: x.entry, trk_pct: x.trk, trk_hours: x.trkH, ...x.row }));
  evRows.sort((a, b) => String(a.signal_utc).localeCompare(String(b.signal_utc)));
  writeCsv(join(OUT, "variants.csv"), table);
  writeCsv(join(OUT, "events.csv"), evRows);
  writeCsv(join(OUT, "trades.csv"), tradeRows);
  writeCsv(join(OUT, "owner_coins.csv"), evRows.filter((r) => OWNER_COINS.includes(String(r.symbol))));
  writeFileSync(join(OUT, "errors.json"), JSON.stringify(errors, null, 1));

  const preDist = (s: Src) => {
    const d = new Map<string, number>();
    for (const r of evRows) { const k = r[`${s}_pre_blue12`] === null ? "нет данных" : String(r[`${s}_pre_blue12`]); d.set(k, (d.get(k) ?? 0) + 1); }
    return [...d.entries()].sort((a, b) => (a[0] === "нет данных" ? 99 : Number(a[0])) - (b[0] === "нет данных" ? 99 : Number(b[0]))).map(([k, n]) => `${k}:${n}`).join(" ");
  };
  const fmt = (r: Row) => `${String(r.volume).padEnd(3)} ${String(r.variant).padEnd(2)} ${String(r.half).padEnd(3)} | сделок ${r.trades}, монет ${r.coins}, итог 72ч ${r.with_72h_result} | +10% за 72ч ${r.peak10_72h_pct ?? "—"}%, за 7д ${r.peak10_7d_pct ?? "—"}% | стоп первым ${r.stop_first_72h_pct ?? "—"}% | трекер ср ${r.trk_avg_pct ?? "—"}% (p10 ${r.trk_p10 ?? "—"} p25 ${r.trk_p25 ?? "—"} p75 ${r.trk_p75 ?? "—"} p90 ${r.trk_p90 ?? "—"}) | тейк5 ${r.tp5_avg_pct ?? "—"} тейк8 ${r.tp8_avg_pct ?? "—"} тейк10 ${r.tp10_avg_pct ?? "—"} | депозит ${r.deposit_growth_pct}%`;
  const s =
    `ABNeon защита уровня · ${new Date(from).toISOString()} .. ${new Date(now).toISOString()} · монет ${symbols.length}, ошибок ${Object.keys(errors).length}, отскоков ${evRows.length}\n` +
    `Варианты: N без объёма · A живой фильтр 10/12 до касания · B1 защита 1H · C1 защита 1H + реакция синяя · B4 защита 4H · C4 B4 + реакция · D = A или C1\n` +
    `Стоп −8%, выход трекер CAB; депозит: 10% депозита на сделку без плеча; одна сделка на монету в варианте; общие фильтры скана НЕ моделируются\n\n` +
    table.map(fmt).join("\n") +
    `\n\nСиних до касания (из 12), все отскоки — agg: ${preDist("agg")}\n                                    bx:  ${preDist("bx")}` +
    `\nCoinGlass: запросов ${cgStats.requests}, ok ${cgStats.ok}, пусто ${cgStats.empty}, ошибок ${cgStats.errors}, 429: ${cgStats.r429}` +
    `\nФайлы: variants.csv, events.csv (каждый отскок, все признаки, какие варианты взяли), trades.csv (каждая сделка), owner_coins.csv (7 монет владельца)`;
  writeFileSync(join(OUT, "summary.txt"), s);
  console.log(s);
}

main().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });
