/**
 * Stealth «пробой на ярком объёме» (owner 2026-11-10): on the owner's charts (PIEVERSE, EDGEX, INIT) the
 * breakout candle itself carries bright Welkin volume (orange / magenta / white, ≥ avg + 2σ); the volume
 * before it may be grey. One run, every variant against the current Stealth.
 *
 *   range        current Stealth: Auto Range 4H upside breakout whose top sits on an ABNeon zone (live v2)
 *   level4h      a closed 4H candle crosses an ABNeon resistance zone top (prev close ≤ top < close)
 *   level1h      a closed 1H candle crosses the top of an ABNeon zone built on closed 4H candles
 *   × volume of the breakout candle itself (known at its close — the entry, no look-ahead):
 *       any | O+ (Welkin O/M/W, > avg+2σ) | M+ (M/W, > avg+3σ), on CoinGlass aggregated (agg) and BingX (bx)
 *   × not chasing: entry ≤ zone top + X%, X ∈ {3, 5, 8, any}
 * Entry at the breakout close; stop −8% (live Stealth); CAB tracker exit; +5/+8/+10 takes for comparison;
 * peak ≥10% in 72 h / 7 d; four periods; one trade per coin at a time per variant; every trade listed; the
 * owner's coins separately. NOT simulated: the scan's general gates.
 *
 * Run (from artifacts/api-server; same candle / CoinGlass cache as the ABNeon studies):
 *   STUDY_CG_RPM=30 pnpm dlx tsx scripts/stealth-vsa-study.ts --days 64 --out ../../reports/stealth-vsa
 */
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { computeSupportZones, type SupportZone } from "../src/lib/stealth-abneon-detectors.js";
import { evaluateNeonRangeBreakout, type NlCandle } from "../src/lib/stealth-neon-level-breakout.js";
import { type VBar, cgHistory, cgStats, withVolume } from "./study-v2/cg.js";
import {
  type C, type Row, D1, H1, H4, M15, ensureDir, idxAtOrBefore, klines, parseArgs, path, trade, usdtSymbols, welkin, writeCsv,
} from "./study-v2/lib.js";

const args = parseArgs();
const DAYS = Number(args.get("days") ?? 64);
const OUT = args.get("out") ?? "stealth-vsa";
const CACHE = args.get("cache") ?? "../../reports/.cache";
const LIMIT = Number(args.get("limit") ?? 10_000);
const ONLY = args.get("symbols")?.split(",").filter(Boolean) ?? null;
const OWNER_COINS = ["PIEVERSE-USDT", "EDGEX-USDT", "INIT-USDT", "GANG-USDT", "KNOTS-USDT", "SI-USDT", "PRIORS-USDT"];
const STOP = 0.92;
const H4_BACK = 720, H1_BACK = 400;
const VOLS = ["any", "agg_O", "agg_M", "bx_O", "bx_M"] as const;
type Vol = (typeof VOLS)[number];
const NEAR = [3, 5, 8, null] as const;
const O_UP = new Set(["O", "M", "W"]), M_UP = new Set(["M", "W"]);

type Coin = { h4: C[]; h1: C[]; m15: C[]; agg: Map<number, VBar> | null };
async function loadCoin(symbol: string, from: number, now: number): Promise<Coin> {
  return {
    h4: await klines(CACHE, symbol, "4h", from - H4_BACK * H4, now),
    h1: await klines(CACHE, symbol, "1h", from - H1_BACK * H1, now),
    m15: await klines(CACHE, symbol, "15m", from - 8 * M15, now),
    agg: await cgHistory(CACHE, symbol, "aggfut", from - H4_BACK * H4, now),
  };
}

type Ev = { kind: "range" | "level4h" | "level1h"; at: number; entry: number; top: number; colAgg: string | null; colBx: string | null };

const volOk = (v: Vol, e: Ev) =>
  v === "any" ? true
  : v === "agg_O" ? e.colAgg !== null && O_UP.has(e.colAgg)
  : v === "agg_M" ? e.colAgg !== null && M_UP.has(e.colAgg)
  : v === "bx_O" ? e.colBx !== null && O_UP.has(e.colBx)
  : e.colBx !== null && M_UP.has(e.colBx);

function events(coin: Coin, from: number, now: number): Ev[] {
  const { h4, h1 } = coin;
  const a4 = withVolume(h4, coin.agg, H4), a1 = withVolume(h1, coin.agg, H1);
  const nl: NlCandle[] = h4.map((c) => ({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume }));
  const out: Ev[] = [];
  let zones: SupportZone[] = [];
  for (let i = 1; i < h4.length; i++) {
    const c = h4[i]!, close = c.time + H4;
    if (close > now) break;
    if (close < from) continue;
    const hist = nl.slice(Math.max(0, i - 699), i + 1);
    // Zones as of this closed 4H candle (used by level4h now and by level1h for the next four hours).
    zones = hist.length >= 60 ? computeSupportZones(hist) : [];
    // Current Stealth (Auto Range on an ABNeon zone).
    const rb = hist.length >= 220 ? evaluateNeonRangeBreakout(hist, c.time) : null;
    if (rb && rb.tf === "4h") out.push({ kind: "range", at: close, entry: c.close, top: rb.level.top, colAgg: welkin(a4, i), colBx: welkin(h4, i) });
    // Plain crossing of an ABNeon zone top on this 4H close.
    const prev = h4[i - 1]!;
    const crossed = zones.filter((z) => prev.close <= z.top && c.close > z.top).sort((x, y) => y.top - x.top)[0];
    if (crossed && prev.time === c.time - H4) out.push({ kind: "level4h", at: close, entry: c.close, top: crossed.top, colAgg: welkin(a4, i), colBx: welkin(h4, i) });
    // 1H crossings during the next 4H window, against these zones.
    if (!zones.length) continue;
    const k0 = idxAtOrBefore(h1, close);
    for (let k = Math.max(1, k0); k < h1.length && h1[k]!.time < close + H4; k++) {
      const b = h1[k]!, p = h1[k - 1]!;
      if (b.time < close || b.time + H1 > now || p.time !== b.time - H1) continue;
      const z = zones.filter((x) => p.close <= x.top && b.close > x.top).sort((x, y) => y.top - x.top)[0];
      if (z) out.push({ kind: "level1h", at: b.time + H1, entry: b.close, top: z.top, colAgg: welkin(a1, k), colBx: welkin(h1, k) });
    }
  }
  return out;
}

const PERIODS = [["07-22.09", "2026-09-07", "2026-09-23"], ["23.09-08.10", "2026-09-23", "2026-10-09"], ["09-24.10", "2026-10-09", "2026-10-25"], ["25.10-10.11", "2026-10-25", "2026-11-11"]] as const;
type Trade = { symbol: string; variant: string; at: number; entry: number; trk: number | null; trkH: number | null; row: Row };
function stats(ts: Trade[]): Row {
  const done = ts.filter((x) => x.row.out72 !== "OPEN");
  const share = (f: (x: Trade) => boolean) => (done.length ? Math.round((1000 * done.filter(f).length) / done.length) / 10 : null);
  const trk = ts.map((x) => x.trk).filter((v): v is number => v !== null).sort((a, b) => a - b);
  const q = (p: number) => (trk.length ? Math.round(100 * trk[Math.min(trk.length - 1, Math.floor(p * trk.length))]!) / 100 : null);
  const avg = (k: string) => { const xs = ts.map((x) => x.row[k]).filter((v): v is number => typeof v === "number"); return xs.length ? Math.round((100 * xs.reduce((a, b) => a + b, 0)) / xs.length) / 100 : null; };
  return {
    trades: ts.length, coins: new Set(ts.map((x) => x.symbol)).size,
    peak10_72h_pct: share((x) => x.row.out72 === "GOOD"), stop_first_72h_pct: share((x) => x.row.out72 === "STOP"), peak10_7d_pct: share((x) => x.row.out7d === "GOOD"),
    trk_avg_pct: trk.length ? Math.round((100 * trk.reduce((a, b) => a + b, 0)) / trk.length) / 100 : null,
    trk_sum_pct: Math.round(trk.reduce((a, b) => a + b, 0)),
    trk_p10: q(0.1), trk_p25: q(0.25), trk_p75: q(0.75), trk_p90: q(0.9),
    tp5_avg_pct: avg("tp5"), tp8_avg_pct: avg("tp8"), tp10_avg_pct: avg("tp10"),
  };
}

async function main() {
  const now = Math.floor(Date.now() / M15) * M15;
  const from = now - DAYS * D1;
  ensureDir(OUT); ensureDir(CACHE);
  const symbols = ONLY ?? (await usdtSymbols(CACHE)).slice(0, LIMIT);
  const errors: Record<string, string> = {};
  const trades: Trade[] = [];
  let evN = 0, done = 0;
  for (const symbol of symbols) {
    try {
      const coin = await loadCoin(symbol, from, now);
      if (coin.h4.length < 250 || coin.h1.length < 200 || coin.m15.length < 100) { errors[symbol] = "short_history"; continue; }
      const evs = events(coin, from, now).sort((a, b) => a.at - b.at);
      evN += evs.length;
      const busy = new Map<string, number>();
      for (const e of evs) {
        const fromTop = (e.entry / e.top - 1) * 100;
        for (const vol of VOLS) {
          if (!volOk(vol, e)) continue;
          for (const x of NEAR) {
            if (x !== null && fromTop > x) continue;
            const variant = `${e.kind}_${vol}_${x === null ? "xany" : `x${x}`}`;
            if (e.at < (busy.get(variant) ?? -Infinity)) continue;
            const tr = trade(coin.m15, e.at, e.entry, e.entry * STOP, "trk");
            busy.set(variant, tr.hours !== null ? e.at + tr.hours * H1 : Infinity);
            const row: Row = { level_top: e.top, from_level_pct: Math.round(fromTop * 100) / 100, agg_colour: e.colAgg, bx_colour: e.colBx, ...path(coin.m15, e.at, e.entry, null) };
            for (const r of ["tp5", "tp8", "tp10"] as const) row[r] = trade(coin.m15, e.at, e.entry, e.entry * STOP, r).pct;
            trades.push({ symbol, variant, at: e.at, entry: e.entry, trk: tr.pct, trkH: tr.hours, row });
          }
        }
      }
    } catch (err) {
      errors[symbol] = String(err).slice(0, 160);
    }
    if (++done % 25 === 0) console.error(`монеты ${done}/${symbols.length}, событий ${evN}, сделок ${trades.length} · CoinGlass ${cgStats.requests} (429: ${cgStats.r429})`);
  }
  const variants = [...new Set(trades.map((t) => t.variant))].sort();
  const table: Row[] = [];
  for (const v of variants) {
    const ts = trades.filter((x) => x.variant === v);
    table.push({ variant: v, period: "all", ...stats(ts) });
    for (const [name, a, b] of PERIODS) table.push({ variant: v, period: name, ...stats(ts.filter((x) => x.at >= Date.parse(a) && x.at < Date.parse(b))) });
  }
  const rows: Row[] = trades.map((x) => ({ variant: x.variant, symbol: x.symbol, entry_utc: new Date(x.at).toISOString(), entry: x.entry, trk_pct: x.trk, trk_hours: x.trkH, ...x.row }));
  writeCsv(join(OUT, "variants.csv"), table);
  writeCsv(join(OUT, "trades.csv"), rows);
  writeCsv(join(OUT, "owner_coins.csv"), rows.filter((r) => OWNER_COINS.includes(String(r.symbol))));
  writeFileSync(join(OUT, "errors.json"), JSON.stringify(errors, null, 1));
  const fmt = (r: Row) => `${String(r.variant).padEnd(24)} ${String(r.period).padEnd(11)} | сделок ${r.trades}, монет ${r.coins} | +10% 72ч ${r.peak10_72h_pct ?? "—"}% 7д ${r.peak10_7d_pct ?? "—"}% | стоп первым ${r.stop_first_72h_pct ?? "—"}% | трекер ср ${r.trk_avg_pct ?? "—"}% сумма ${r.trk_sum_pct} (p10 ${r.trk_p10 ?? "—"} p25 ${r.trk_p25 ?? "—"} p75 ${r.trk_p75 ?? "—"} p90 ${r.trk_p90 ?? "—"}) | тейк5 ${r.tp5_avg_pct ?? "—"} тейк8 ${r.tp8_avg_pct ?? "—"} тейк10 ${r.tp10_avg_pct ?? "—"}`;
  const s =
    `Stealth VSA · ${new Date(from).toISOString()} .. ${new Date(now).toISOString()} · монет ${symbols.length}, ошибок ${Object.keys(errors).length}, событий ${evN}, сделок ${trades.length}\n` +
    `range = нынешний Stealth; level4h / level1h = пробой зоны ABNeon на закрытии 4H / 1H; объём свечи пробоя any / agg_O (≥+2σ) / agg_M (≥+3σ) / bx_O / bx_M; xN = не дальше N% от верха зоны\n` +
    `Вход на закрытии свечи пробоя, стоп −8%, выход трекер CAB; одна сделка на монету в варианте; общие фильтры скана НЕ моделируются\n\n` +
    table.map(fmt).join("\n") +
    `\n\nCoinGlass: запросов ${cgStats.requests}, ok ${cgStats.ok}, пусто ${cgStats.empty}, ошибок ${cgStats.errors}, 429: ${cgStats.r429}` +
    `\nФайлы: variants.csv, trades.csv, owner_coins.csv, errors.json`;
  writeFileSync(join(OUT, "summary.txt"), s);
  console.log(s);
}

main().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });
