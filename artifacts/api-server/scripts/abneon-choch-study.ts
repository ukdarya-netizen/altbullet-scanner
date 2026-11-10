/**
 * ABNeon «как на графиках владельца» (2026-11-10): price comes into a 4H ABNeon support zone (or pokes under
 * it and comes back), the volume on the touch is not grey, and the entry is NOT the first green 1H candle but
 * the turn of the structure: a 1H close above the last lower high (CHoCH up) while the price is still near the
 * zone. One run, every variant on the same zones; the current bot entry is the baseline.
 *
 * Zones: the bot's own 4H zones (evaluateAbneonSupportBounce «armed» → frozen level + resolveFrozenZone).
 * Touch: first 1H low ≤ zone top·1.002 after the arm. Watch 72 h after the touch:
 *   cancel  a closed 4H candle closes under the zone bottom before the entry (setup broken);
 *   volume  the 4H bar of the touch or one of the next two closed 4H bars (closed before the entry — no
 *           look-ahead) is Welkin blue or brighter (A/O/M/W), or any non-grey (also Y);
 *   CHoCH   last 1H pivot high (P bars each side, confirmed before the entry) formed before the lowest low
 *           since the touch, within 72 h before that low; entry = close of the first 1H candle above it;
 *   near    entry price ≤ zone top · (1 + X%).
 * Variants: CHoCH × pivot P ∈ {3,5} × X ∈ {3,5,8}% × volume ∈ {none, blue+ agg, blue+ BingX, non-grey agg};
 * baselines: the bot's current entry (detector «qualified», sweep k3) with and without blue+ volume.
 * Outcomes as the live pattern: stop −8%, CAB tracker exit; +5/+8/+10 takes for comparison; peak ≥10% in
 * 72 h / 7 d; four periods and halves; one trade per coin at a time per variant. No deposit line (trades
 * overlap). NOT simulated: the scan's general gates.
 *
 * Run (from artifacts/api-server; same cache as abneon-defense-study):
 *   STUDY_CG_RPM=30 pnpm dlx tsx scripts/abneon-choch-study.ts --days 64 --out ../../reports/abneon-choch
 */
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { evaluateAbneonSupportBounce, resolveFrozenZone } from "../src/lib/stealth-abneon-detectors.js";
import { type VBar, cgHistory, cgStats, withVolume } from "./study-v2/cg.js";
import {
  type C, type Row, D1, H1, H4, M15, ensureDir, idxAtOrBefore, klines, lastClosed, parseArgs, path, trade,
  usdtSymbols, welkin, writeCsv,
} from "./study-v2/lib.js";

const args = parseArgs();
const DAYS = Number(args.get("days") ?? 64);
const OUT = args.get("out") ?? "abneon-choch";
const CACHE = args.get("cache") ?? "../../reports/.cache";
const LIMIT = Number(args.get("limit") ?? 10_000);
const ONLY = args.get("symbols")?.split(",").filter(Boolean) ?? null;
const OWNER_COINS = ["PIEVERSE-USDT", "PRIORS-USDT", "EDGEX-USDT", "GANG-USDT", "INIT-USDT", "KNOTS-USDT", "SI-USDT"];
const SWEEP = 3;
const ARM_TTL = 24 * H1;
const WATCH = 72 * H1;
const STOP = 0.92;
const H4_BACK = 720, H1_BACK = 400;
const PIVOTS = [3, 5] as const;
const NEAR = [3, 5, 8] as const;
const VOLS = ["none", "agg_blue", "bx_blue", "agg_any"] as const;
type Vol = (typeof VOLS)[number];
const BLUE_UP = new Set(["A", "O", "M", "W"]);
const NON_GREY = new Set(["A", "O", "M", "W", "Y"]);

type Coin = { h4: C[]; h1: C[]; m15: C[]; agg: Map<number, VBar> | null };
async function loadCoin(symbol: string, from: number, now: number): Promise<Coin> {
  return {
    h4: await klines(CACHE, symbol, "4h", from - H4_BACK * H4, now),
    h1: await klines(CACHE, symbol, "1h", from - H1_BACK * H1, now),
    m15: await klines(CACHE, symbol, "15m", from - 8 * M15, now),
    agg: await cgHistory(CACHE, symbol, "aggfut", from - H1_BACK * H1, now),
  };
}

type Zone = { armT: number; top: number; bottom: number };
type Entry = { variant: string; at: number; entry: number; info: Row };

/** Zones the bot armed (one per level per touch) and the bot's own qualified entries. */
function scan(coin: Coin, from: number, now: number) {
  const { h4, h1 } = coin;
  const zones: Zone[] = [];
  const qualified: { t: number; ti: number; level: number; bottom: number; armT: number }[] = [];
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
    if (res.status === "armed" && res.frozenLevel != null && res.armCandleTime != null) {
      if (!arm) {
        arm = { level: res.frozenLevel, time: res.armCandleTime };
        const z = resolveFrozenZone(h4.slice(0, i4 + 1), res.armCandleTime, res.frozenLevel);
        const last = zones.at(-1);
        // The same level re-armed while its previous watch is still running is the same setup.
        if (!last || Math.abs(last.top / z.top - 1) > 0.005 || res.armCandleTime - last.armT > WATCH + ARM_TTL)
          zones.push({ armT: res.armCandleTime, top: z.top, bottom: z.bottom });
      }
    } else if (res.status === "qualified" && res.triggerCandleTime != null && res.frozenLevel != null && res.armCandleTime != null) {
      const ti = idxAtOrBefore(h1, res.triggerCandleTime);
      if (ti >= 0 && h1[ti]!.time === res.triggerCandleTime) {
        const z = resolveFrozenZone(h4.slice(0, i4 + 1), res.armCandleTime, res.frozenLevel);
        qualified.push({ t, ti, level: res.frozenLevel, bottom: z.bottom, armT: res.armCandleTime });
      }
      arm = null;
    } else if (arm && (res.status === "terminal" || t - arm.time > ARM_TTL)) {
      arm = null;
    }
  }
  return { zones, qualified };
}

/** Is a pivot high at index k with P bars each side (needs k+P closed by `at`)? */
function pivotHigh(h1: C[], k: number, p: number): boolean {
  if (k - p < 0 || k + p >= h1.length) return false;
  for (let j = k - p; j <= k + p; j++) if (j !== k && h1[j]!.high >= h1[k]!.high) return false;
  return true;
}

/** Touch-volume colours of the touch 4H bar and the next two, only those closed by `at`. */
function touchColours(v4: C[], h4: C[], touch: number, at: number): string[] {
  const j0 = idxAtOrBefore(h4, touch);
  const out: string[] = [];
  for (let j = j0; j >= 0 && j < h4.length && j <= j0 + 2; j++) {
    if (h4[j]!.time + H4 > at) break;
    out.push(welkin(v4, j) ?? "?");
  }
  return out;
}

function chochEntries(coin: Coin, z: Zone, now: number, v4: Record<"agg" | "bx", C[]>): Entry[] {
  const { h1, h4 } = coin;
  const out: Entry[] = [];
  // Touch: first closed 1H after the arm whose low reaches the zone top.
  let ti = idxAtOrBefore(h1, z.armT);
  ti = ti < 0 ? 0 : ti;
  let touch = -1;
  for (let k = ti; k < h1.length && h1[k]!.time < z.armT + ARM_TTL; k++) {
    if (h1[k]!.time + H1 <= z.armT) continue;
    if (h1[k]!.low <= z.top * 1.002) { touch = k; break; }
  }
  if (touch < 0) return out;
  const touchT = h1[touch]!.time;
  for (const p of PIVOTS) {
    let lowK = touch;
    let broken = false;
    const pending = new Set<number>(NEAR);
    for (let k = touch; k < h1.length && h1[k]!.time < touchT + WATCH && pending.size; k++) {
      const closeT = h1[k]!.time + H1;
      if (closeT > now) break;
      // Setup broken: a 4H candle closed under the zone bottom (closed by this hour).
      const j = idxAtOrBefore(h4, h1[k]!.time);
      if (j >= 0 && h4[j]!.time + H4 === closeT && h4[j]!.close < z.bottom && h4[j]!.time + H4 > touchT) { broken = true; break; }
      if (h1[k]!.low < h1[lowK]!.low) lowK = k;
      // Last lower high: newest pivot high confirmed by now, formed before the lowest low, ≤72 h before it.
      let lh = -1;
      for (let q = lowK - 1; q >= 0 && h1[q]!.time >= h1[lowK]!.time - WATCH; q--) {
        if (q + p > k) continue;
        if (pivotHigh(h1, q, p)) { lh = q; break; }
      }
      if (lh < 0 || h1[k]!.close <= h1[lh]!.high || k <= lowK) continue;
      const entry = h1[k]!.close;
      for (const x of [...pending]) {
        if (entry > z.top * (1 + x / 100)) continue;
        pending.delete(x);
        const colours = { agg: touchColours(v4.agg, h4, touchT, closeT), bx: touchColours(v4.bx, h4, touchT, closeT) };
        const info: Row = {
          zone_top: z.top, zone_bottom: z.bottom, touch_utc: new Date(touchT).toISOString(),
          low_utc: new Date(h1[lowK]!.time).toISOString(), low: h1[lowK]!.low, choch_level: h1[lh]!.high,
          from_zone_top_pct: Math.round((entry / z.top - 1) * 10000) / 100,
          agg_touch_colours: colours.agg.join(""), bx_touch_colours: colours.bx.join(""),
        };
        for (const vol of VOLS) {
          const ok = vol === "none" ? true
            : vol === "agg_blue" ? colours.agg.some((c) => BLUE_UP.has(c))
            : vol === "bx_blue" ? colours.bx.some((c) => BLUE_UP.has(c))
            : colours.agg.some((c) => NON_GREY.has(c));
          if (ok) out.push({ variant: `choch_p${p}_x${x}_${vol}`, at: closeT, entry, info });
        }
      }
    }
    void broken;
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
  let zonesN = 0, done = 0;
  for (const symbol of symbols) {
    try {
      const coin = await loadCoin(symbol, from, now);
      if (coin.h4.length < 100 || coin.h1.length < 200 || coin.m15.length < 100) { errors[symbol] = "short_history"; continue; }
      const v4 = { agg: withVolume(coin.h4, coin.agg, H4), bx: coin.h4 };
      const { zones, qualified } = scan(coin, from, now);
      zonesN += zones.length;
      const entries: Entry[] = [];
      for (const z of zones) entries.push(...chochEntries(coin, z, now, v4));
      for (const q of qualified) {
        const colours = touchColours(v4.agg, coin.h4, q.armT, q.t);
        const info: Row = { zone_top: q.level, zone_bottom: q.bottom, agg_touch_colours: colours.join(""), from_zone_top_pct: Math.round((coin.h1[q.ti]!.close / q.level - 1) * 10000) / 100 };
        entries.push({ variant: "bot_now", at: q.t, entry: coin.h1[q.ti]!.close, info });
        if (colours.some((c) => BLUE_UP.has(c))) entries.push({ variant: "bot_now_agg_blue", at: q.t, entry: coin.h1[q.ti]!.close, info });
      }
      entries.sort((a, b) => a.at - b.at);
      const busy = new Map<string, number>();
      for (const e of entries) {
        if (e.at < (busy.get(e.variant) ?? -Infinity)) continue;
        const tr = trade(coin.m15, e.at, e.entry, e.entry * STOP, "trk");
        busy.set(e.variant, tr.hours !== null ? e.at + tr.hours * H1 : Infinity);
        const row: Row = { ...e.info, ...path(coin.m15, e.at, e.entry, null) };
        for (const r of ["tp5", "tp8", "tp10"] as const) row[r] = trade(coin.m15, e.at, e.entry, e.entry * STOP, r).pct;
        trades.push({ symbol, variant: e.variant, at: e.at, entry: e.entry, trk: tr.pct, trkH: tr.hours, row });
      }
    } catch (err) {
      errors[symbol] = String(err).slice(0, 160);
    }
    if (++done % 25 === 0) console.error(`монеты ${done}/${symbols.length}, зон ${zonesN}, сделок ${trades.length} · CoinGlass ${cgStats.requests} (429: ${cgStats.r429})`);
  }

  const variants = [...new Set(trades.map((t) => t.variant))].sort((a, b) => (a.startsWith("bot") ? -1 : 0) - (b.startsWith("bot") ? -1 : 0) || a.localeCompare(b));
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
  const fmt = (r: Row) => `${String(r.variant).padEnd(26)} ${String(r.period).padEnd(11)} | сделок ${r.trades}, монет ${r.coins} | +10% 72ч ${r.peak10_72h_pct ?? "—"}% 7д ${r.peak10_7d_pct ?? "—"}% | стоп первым ${r.stop_first_72h_pct ?? "—"}% | трекер ср ${r.trk_avg_pct ?? "—"}% сумма ${r.trk_sum_pct} (p10 ${r.trk_p10 ?? "—"} p25 ${r.trk_p25 ?? "—"} p75 ${r.trk_p75 ?? "—"} p90 ${r.trk_p90 ?? "—"}) | тейк5 ${r.tp5_avg_pct ?? "—"} тейк8 ${r.tp8_avg_pct ?? "—"} тейк10 ${r.tp10_avg_pct ?? "—"}`;
  const s =
    `ABNeon CHoCH · ${new Date(from).toISOString()} .. ${new Date(now).toISOString()} · монет ${symbols.length}, ошибок ${Object.keys(errors).length}, зон ${zonesN}, сделок ${trades.length}\n` +
    `bot_now = вход бота сейчас (без фильтра объёма до касания); choch_pP_xX_vol = вход на CHoCH 1H (пивот P), не дальше X% от верха зоны, объём на касании 4H: none / agg_blue / bx_blue / agg_any (не серый)\n` +
    `Стоп −8%, выход трекер CAB; одна сделка на монету в варианте; общие фильтры скана НЕ моделируются\n\n` +
    table.map(fmt).join("\n") +
    `\n\nCoinGlass: запросов ${cgStats.requests}, ok ${cgStats.ok}, пусто ${cgStats.empty}, ошибок ${cgStats.errors}, 429: ${cgStats.r429}` +
    `\nФайлы: variants.csv, trades.csv (каждая сделка), owner_coins.csv (7 монет владельца), errors.json`;
  writeFileSync(join(OUT, "summary.txt"), s);
  console.log(s);
}

main().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });
