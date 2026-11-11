/**
 * Check of the new live ABNeon (owner 2026-11-11) before publishing — the live code itself, replayed hour by hour:
 *   zone bounce: evaluateAbneonSupportBounce (touch now up to 2% above the zone top) + the live touch-volume rule
 *     (touchVolumeNotGrey, aggregated 4H volume);
 *   low bounce: findLowBounce (new 10-day low, first green 4H close above the low candle's close on not-grey
 *     aggregated volume, within 24h, ≤ 25% above the low) when no zone arm is open;
 *   exit: stop under the level −1% (stopUnderLevel, 3…15%), B.U. at +10%, trailing from +20% at 20 p.p.,
 *     cancel at the close of a 4H candle under the level, 4 days; fee 0.1%; 15m candles, stop first.
 * One trade per coin at a time. Data: BingX candles, CoinGlass aggregated futures volume (same cache as the studies).
 *
 * Out: her-coins.txt (every entry on the owner's coins since --her-from, Dubai time, with the result),
 *      summary.txt (all coins: entries per day, zone vs low bounce, results with ranges), trades.csv, errors.json.
 *
 * Run (from artifacts/api-server):
 *   STUDY_CG_RPM=30 pnpm dlx tsx scripts/abneon-live-check.ts --days 64 --out ../../reports/abneon-live-check
 */
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { evaluateAbneonSupportBounce, resolveFrozenZone } from "../src/lib/stealth-abneon-detectors.js";
import { touchVolumeNotGrey } from "../src/lib/abneon-volume-gate.js";
import { findLowBounce, stopUnderLevel } from "../src/lib/abneon-low-bounce.js";
import { cgHistory, cgStats, type VBar } from "./study-v2/cg.js";
import { type C, type Row, D1, H1, H4, M15, ensureDir, idxAtOrBefore, klines, lastClosed, parseArgs, usdtSymbols, writeCsv } from "./study-v2/lib.js";

const args = parseArgs();
const DAYS = Number(args.get("days") ?? 64);
const OUT = args.get("out") ?? "abneon-live-check";
const CACHE = args.get("cache") ?? "../../reports/.cache";
const LIMIT = Number(args.get("limit") ?? 10_000);
const ONLY = args.get("symbols")?.split(",").filter(Boolean) ?? null;
const HER = (args.get("her") ?? "ELSA,INIT,PIEVERSE,EDGEX,KNOTS,GANG,SI,PRIORS").split(",").map((s) => `${s}-USDT`);
const HER_FROM = Date.parse(args.get("her-from") ?? "2026-10-28T00:00:00Z");
const HORIZON = 4 * D1;
const FEE = 0.1;
const BE = 10, TR_ACT = 20, TR_GAP = 20;

const fmtT = (t: number) => {
  const d = new Date(t + 4 * H1), p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getUTCDate())}.${p(d.getUTCMonth() + 1)} ${p(d.getUTCHours())}:00 Дубай`;
};
const px = (x: number) => String(+x.toPrecision(5));

function agg4hMap(agg: Map<number, VBar> | null): Map<number, number> {
  const out = new Map<number, number>();
  if (!agg) return out;
  const sums = new Map<number, { usd: number; n: number }>();
  for (const [t, b] of agg) {
    const k = Math.floor(t / H4) * H4;
    const s = sums.get(k) ?? { usd: 0, n: 0 };
    s.usd += b.buy + b.sell; s.n++;
    sums.set(k, s);
  }
  for (const [k, s] of sums) if (s.n === 4) out.set(k, s.usd);
  return out;
}

type Entry = { kind: "zone" | "low"; at: number; entry: number; level: number; colour: string };

function entries(h4: C[], h1: C[], a4: Map<number, number>, from: number, now: number): Entry[] {
  const out: Entry[] = [];
  let arm: { level: number; time: number } | null = null;
  for (let t = Math.ceil(from / H1) * H1; t <= now; t += H1) {
    const i4 = lastClosed(h4, t, H4), i1 = lastClosed(h1, t, H1);
    if (i4 < 0 || i1 < 0) continue;
    const c4 = h4.slice(Math.max(0, i4 - 639), i4 + 1), c1 = h1.slice(Math.max(0, i1 - 29), i1 + 1);
    let res = evaluateAbneonSupportBounce({
      candles4h: c4, candles1h: c1, observedAt: t, marketCapUsd: null,
      ...(arm ? { frozenLevel: arm.level, armCandleTime: arm.time } : {}), sweepReclaimBars: 3,
    });
    if (res.status === "qualified" && res.triggerCandleTime != null && res.frozenLevel != null && res.armCandleTime != null) {
      const tv = touchVolumeNotGrey({
        candles1h: h1.slice(0, i1 + 1), candles4h: h4.slice(0, i4 + 1), agg4hUsdByTime: a4,
        armCandleTime: res.armCandleTime, triggerCandleTime: res.triggerCandleTime, zoneTop: res.frozenLevel, nowMs: t,
      });
      if (!tv.ok && tv.reason === "touch_bar_not_closed") {
        if (!arm) arm = { level: res.frozenLevel, time: res.armCandleTime };
        continue;
      }
      const ti = idxAtOrBefore(h1, res.triggerCandleTime);
      const zone = resolveFrozenZone(h4.slice(0, i4 + 1), res.armCandleTime, res.frozenLevel);
      arm = null;
      if (tv.ok && ti >= 0) out.push({ kind: "zone", at: t, entry: h1[ti]!.close, level: zone.bottom, colour: tv.colours.join("") });
      continue;
    }
    if (res.status === "armed" && res.frozenLevel != null && res.armCandleTime != null) {
      if (!arm) arm = { level: res.frozenLevel, time: res.armCandleTime };
      continue;
    }
    if (arm && (res.status === "terminal" || t - arm.time > 24 * H1)) arm = null;
    // Low bounce: with no zone arm, at each new 4H close.
    if (!arm && h4[i4]!.time + H4 === t) {
      const lb = findLowBounce({ candles4h: h4.slice(0, i4 + 1), agg4hUsdByTime: a4 });
      if (lb) out.push({ kind: "low", at: t, entry: lb.triggerClose, level: lb.low, colour: lb.colour });
    }
  }
  return out;
}

function sim(h4: C[], m15: C[], e: Entry, now: number): { pct: number; end: number; how: string } | null {
  const stopP = stopUnderLevel(e.entry, e.level);
  if (stopP === null) return null;
  let stop = stopP, peak = e.entry, how = "стоп";
  const closeAt = (price: number, t: number, h: string) => ({ pct: (price / e.entry - 1) * 100 - FEE, end: t, how: h });
  for (let i = idxAtOrBefore(m15, e.at - 1) + 1; i < m15.length; i++) {
    const c = m15[i]!;
    if (c.time >= e.at + HORIZON) break;
    // Cancel: a 4H candle that closed (after the entry) under the level, at its close.
    if ((c.time % H4) === 0 && c.time > e.at) {
      const j = idxAtOrBefore(h4, c.time - H4);
      if (j >= 0 && h4[j]!.time + H4 === c.time && h4[j]!.close < e.level) return closeAt(h4[j]!.close, c.time, "отмена 4H под уровнем");
    }
    if (c.low <= stop) return closeAt(Math.min(stop, c.open), c.time + M15, how);
    peak = Math.max(peak, c.high);
    const pp = (peak / e.entry - 1) * 100;
    if (pp >= BE && stop < e.entry) { stop = e.entry; how = "безубыток"; }
    if (pp >= TR_ACT) { const ts = e.entry * (1 + (pp - TR_GAP) / 100); if (ts > stop) { stop = ts; how = "трейлинг"; } }
  }
  if (e.at + HORIZON > now) return null;
  const j = idxAtOrBefore(m15, e.at + HORIZON - M15);
  return j >= 0 ? closeAt(m15[j]!.close, e.at + HORIZON, "4 дня") : null;
}

function stats(xs: number[]): Row {
  const r = [...xs].sort((a, b) => a - b);
  const q = (p: number) => (r.length ? Math.round(100 * r[Math.min(r.length - 1, Math.floor(p * r.length))]!) / 100 : null);
  const sum = r.reduce((a, b) => a + b, 0);
  const wins = r.filter((x) => x > 0);
  return {
    trades: r.length, avg_pct: r.length ? Math.round((100 * sum) / r.length) / 100 : null, sum_pct: Math.round(sum),
    win_pct: r.length ? Math.round((1000 * wins.length) / r.length) / 10 : null,
    min: q(0), p10: q(0.1), p25: q(0.25), p75: q(0.75), p90: q(0.9), max: r.length ? r[r.length - 1]! : null,
  };
}

async function main() {
  const now = Math.floor(Date.now() / M15) * M15;
  const from = now - DAYS * D1;
  ensureDir(OUT); ensureDir(CACHE);
  const listed = ONLY ?? (await usdtSymbols(CACHE)).slice(0, LIMIT);
  const symbols = [...new Set([...HER, ...listed])];
  const errors: Record<string, string> = {};
  const rows: Array<{ symbol: string; e: Entry; r: { pct: number; end: number; how: string } | null; up: number }> = [];
  const her: string[] = [];
  let done = 0;
  for (const symbol of symbols) {
    const isHer = HER.includes(symbol);
    try {
      const h4 = await klines(CACHE, symbol, "4h", from - 720 * H4, now);
      const h1 = await klines(CACHE, symbol, "1h", from - 400 * H1, now);
      const m15 = await klines(CACHE, symbol, "15m", from - 8 * M15, now);
      const agg = await cgHistory(CACHE, symbol, "aggfut", from - 720 * H4, now);
      if (h4.length < 40 || h1.length < 40 || m15.length < 100) { errors[symbol] = "short_history"; if (isHer) her.push(`\n=== ${symbol}: мало истории на BingX`); continue; }
      const a4 = agg4hMap(agg);
      let busyUntil = -Infinity;
      const mine: string[] = [];
      for (const e of entries(h4, h1, a4, from, now)) {
        if (e.at < busyUntil) continue;
        const r = sim(h4, m15, e, now);
        busyUntil = r ? r.end : e.at + HORIZON;
        let hi = e.entry;
        for (let i = idxAtOrBefore(m15, e.at - 1) + 1; i < m15.length && m15[i]!.time < Math.min(e.at + HORIZON, now); i++) hi = Math.max(hi, m15[i]!.high);
        const up = (hi / e.entry - 1) * 100;
        rows.push({ symbol, e, r, up });
        if (isHer && e.at >= HER_FROM) {
          const stopP = stopUnderLevel(e.entry, e.level)!;
          mine.push(`   ${fmtT(e.at)} ${e.kind === "zone" ? "отскок от зоны" : "отскок от минимума"} · вход ${px(e.entry)} · уровень ${px(e.level)} · стоп ${px(stopP)} (−${((1 - stopP / e.entry) * 100).toFixed(1)}%) · объём ${e.colour} · макс за 4 дня +${up.toFixed(1)}% · ${r ? `итог ${r.pct >= 0 ? "+" : ""}${r.pct.toFixed(1)}% (${r.how})` : "идёт"}`);
        }
      }
      if (isHer) her.push(`\n=== ${symbol}${agg ? "" : " (НЕТ агрегата CoinGlass — сигналов нет)"}\n${mine.length ? mine.join("\n") : "   входов нет"}`);
    } catch (err) {
      errors[symbol] = String(err).slice(0, 160);
      if (isHer) her.push(`\n=== ${symbol}: ошибка ${errors[symbol]}`);
    }
    if (++done % 25 === 0) console.error(`монеты ${done}/${symbols.length}, входов ${rows.length} · CoinGlass ${cgStats.requests} (429: ${cgStats.r429})`);
  }
  const days = DAYS;
  const closed = rows.filter((x) => x.r);
  const line = (name: string, xs: typeof rows) => {
    const s = stats(xs.filter((x) => x.r).map((x) => x.r!.pct));
    const peaks10 = xs.filter((x) => x.up >= 10).length;
    return `${name.padEnd(22)} | входов ${xs.length} (${(xs.length / days).toFixed(1)} в день) | закрыто ${s.trades} | ср ${s.avg_pct ?? "—"}% сумма ${s.sum_pct}% | в плюсе ${s.win_pct ?? "—"}% | мин ${s.min ?? "—"} p10 ${s.p10 ?? "—"} p25 ${s.p25 ?? "—"} p75 ${s.p75 ?? "—"} p90 ${s.p90 ?? "—"} макс ${s.max ?? "—"} | пик ≥ +10%: ${xs.length ? Math.round((100 * peaks10) / xs.length) : 0}%`;
  };
  const summary = [
    `Новый ABNeon (живой код): касание до +2%, объём на касании, отскок от минимума; выход стоп под уровнем, Б.У. +10, трейл +20/20 п.п., отмена 4H под уровнем, 4 дня`,
    `${new Date(from).toISOString()} .. ${new Date(now).toISOString()} · монет ${symbols.length}, ошибок ${Object.keys(errors).length}`,
    "",
    line("все", rows),
    line("отскок от зоны", rows.filter((x) => x.e.kind === "zone")),
    line("отскок от минимума", rows.filter((x) => x.e.kind === "low")),
    "",
    "Как закрылись: " + Object.entries(closed.reduce<Record<string, number>>((a, x) => ((a[x.r!.how] = (a[x.r!.how] ?? 0) + 1), a), {})).map(([k, v]) => `${k} ${v}`).join(", "),
    `CoinGlass: запросов ${cgStats.requests}, ok ${cgStats.ok}, пусто ${cgStats.empty}, ошибок ${cgStats.errors}, 429: ${cgStats.r429}`,
    `Файлы: her-coins.txt, summary.txt, trades.csv, errors.json`,
  ].join("\n");
  writeFileSync(join(OUT, "summary.txt"), summary + "\n");
  writeFileSync(join(OUT, "her-coins.txt"), `Новый ABNeon на твоих монетах с ${fmtT(HER_FROM)} · время — закрытие свечи сигнала\n` + her.join("\n") + "\n");
  writeCsv(join(OUT, "trades.csv"), rows.map((x) => ({
    symbol: x.symbol, kind: x.e.kind, entry_utc: new Date(x.e.at).toISOString(), entry: x.e.entry, level: x.e.level, colour: x.e.colour,
    max_up_4d_pct: Math.round(x.up * 10) / 10, result_pct: x.r ? Math.round(x.r.pct * 100) / 100 : null, how: x.r?.how ?? "open",
  })));
  writeFileSync(join(OUT, "errors.json"), JSON.stringify(errors, null, 1));
  console.log(summary);
}

main().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });
