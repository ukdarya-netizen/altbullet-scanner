/**
 * Cancellations for ABNeon and Stealth (owner 2026-11-10): a trade is cancelled only when the price HOLDS
 * under the level (закреп) AND the breakdown has volume. One run, both patterns, on the same entries.
 *
 * Entries
 *   ABNeon   the bot's entry (detector «qualified», sweep k3) with the live touch rule: the touch 4H candle or
 *            one of the next two closed 4H candles not grey on aggregated volume
 *   Stealth  range   — current Stealth (Auto Range 4H breakout on an ABNeon zone)
 *            level4h — 4H close above an ABNeon zone top, breakout candle Welkin O/M/W on aggregated volume
 *            level1h — the same on a 1H close
 * Level (L): ABNeon — the zone bottom; Stealth — the broken zone top (lvtop) or its bottom (lvbot).
 * Hold under L (only closed bars after the entry):
 *   c1   one 4H close under L                        → cancel at that close
 *   c2   two 4H closes in a row under L              → cancel at the second close
 *   c1h2 a 4H close under L and the next two 1H closes still under L → cancel at the second 1H close
 * Volume of the 4H bar that first closed under L: any | agg_A (blue+) | agg_O (orange+) | bx_A | bx_O
 * The trade is the live one (stop −8%, CAB tracker); a cancel closes it at the cancel bar's close if it is
 * still open then. Reported per variant: trades, cancelled, average / sum / p10…p90 of the result, and for
 * the cancelled ones what they would have done without the cancel (saved %, killed winners: peak ≥ +10%
 * reached AFTER the cancel). Baseline «none» = no cancel (today). Four periods. Every trade listed.
 *
 * Run (from artifacts/api-server; same cache as the ABNeon / Stealth studies):
 *   STUDY_CG_RPM=30 pnpm dlx tsx scripts/cancel-study.ts --days 64 --out ../../reports/cancel-study
 */
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { computeSupportZones, evaluateAbneonSupportBounce, resolveFrozenZone, type SupportZone } from "../src/lib/stealth-abneon-detectors.js";
import { evaluateNeonRangeBreakout, type NlCandle } from "../src/lib/stealth-neon-level-breakout.js";
import { type VBar, cgHistory, cgStats, withVolume } from "./study-v2/cg.js";
import {
  type C, type Row, D1, H1, H4, M15, ensureDir, idxAtOrBefore, klines, lastClosed, parseArgs, path, trade, usdtSymbols, welkin, writeCsv,
} from "./study-v2/lib.js";

const args = parseArgs();
const DAYS = Number(args.get("days") ?? 64);
const OUT = args.get("out") ?? "cancel-study";
const CACHE = args.get("cache") ?? "../../reports/.cache";
const LIMIT = Number(args.get("limit") ?? 10_000);
const ONLY = args.get("symbols")?.split(",").filter(Boolean) ?? null;
const STOP = 0.92;
const H4_BACK = 720, H1_BACK = 400;
const HORIZON = 7 * D1;
const BLUE_UP = new Set(["A", "O", "M", "W"]), O_UP = new Set(["O", "M", "W"]), NON_GREY = new Set(["A", "O", "M", "W", "Y"]);
const HOLDS = ["c1", "c2", "c1h2"] as const;
const VOLS = ["any", "agg_A", "agg_O", "bx_A", "bx_O"] as const;

type Coin = { h4: C[]; h1: C[]; m15: C[]; agg: Map<number, VBar> | null };
async function loadCoin(symbol: string, from: number, now: number): Promise<Coin> {
  return {
    h4: await klines(CACHE, symbol, "4h", from - H4_BACK * H4, now),
    h1: await klines(CACHE, symbol, "1h", from - H1_BACK * H1, now),
    m15: await klines(CACHE, symbol, "15m", from - 8 * M15, now),
    agg: await cgHistory(CACHE, symbol, "aggfut", from - H4_BACK * H4, now),
  };
}

type Entry = { pattern: "abneon" | "stealth_range" | "stealth_level4h" | "stealth_level1h"; at: number; entry: number; top: number; bottom: number };

function abneonEntries(coin: Coin, a4: C[], from: number, now: number): Entry[] {
  const { h4, h1 } = coin;
  const out: Entry[] = [];
  let arm: { level: number; time: number } | null = null;
  for (let t = Math.ceil(from / H1) * H1; t <= now; t += H1) {
    const i4 = lastClosed(h4, t, H4), i1 = lastClosed(h1, t, H1);
    const res = evaluateAbneonSupportBounce({
      candles4h: h4.slice(Math.max(0, i4 - 639), i4 + 1), candles1h: h1.slice(Math.max(0, i1 - 29), i1 + 1),
      observedAt: t, marketCapUsd: null, ...(arm ? { frozenLevel: arm.level, armCandleTime: arm.time } : {}), sweepReclaimBars: 3,
    });
    if (res.status === "qualified" && res.triggerCandleTime != null && res.frozenLevel != null && res.armCandleTime != null) {
      arm = null;
      const ti = idxAtOrBefore(h1, res.triggerCandleTime);
      if (ti < 0 || h1[ti]!.time !== res.triggerCandleTime) continue;
      // Live touch rule: first touch after the arm; touch 4H + next two (closed by t) not grey on aggregated volume.
      let w0 = ti;
      while (w0 - 1 >= 0 && h1[w0 - 1]!.time + H1 > res.armCandleTime) w0--;
      let touch = h1[w0]!.time;
      for (let k = w0; k <= ti; k++) if (h1[k]!.low <= res.frozenLevel * 1.002) { touch = h1[k]!.time; break; }
      const j0 = idxAtOrBefore(h4, touch);
      let ok = false;
      for (let j = j0; j >= 0 && j <= j0 + 2 && j < h4.length; j++) {
        if (h4[j]!.time + H4 > t) break;
        const w = welkin(a4, j);
        if (w && NON_GREY.has(w)) ok = true;
      }
      if (!ok) continue;
      const z = resolveFrozenZone(h4.slice(0, i4 + 1), res.armCandleTime, res.frozenLevel);
      out.push({ pattern: "abneon", at: t, entry: h1[ti]!.close, top: z.top, bottom: z.bottom });
    } else if (res.status === "armed" && res.frozenLevel != null && res.armCandleTime != null) {
      if (!arm) arm = { level: res.frozenLevel, time: res.armCandleTime };
    } else if (arm && (res.status === "terminal" || t - arm.time > 24 * H1)) {
      arm = null;
    }
  }
  return out;
}

function stealthEntries(coin: Coin, a4: C[], a1: C[], from: number, now: number): Entry[] {
  const { h4, h1 } = coin;
  const nl: NlCandle[] = h4.map((c) => ({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume }));
  const out: Entry[] = [];
  for (let i = 1; i < h4.length; i++) {
    const c = h4[i]!, close = c.time + H4;
    if (close > now) break;
    if (close < from) continue;
    const hist = nl.slice(Math.max(0, i - 699), i + 1);
    const zones: SupportZone[] = hist.length >= 60 ? computeSupportZones(hist) : [];
    const rb = hist.length >= 220 ? evaluateNeonRangeBreakout(hist, c.time) : null;
    if (rb && rb.tf === "4h") out.push({ pattern: "stealth_range", at: close, entry: c.close, top: rb.level.top, bottom: rb.level.bottom });
    const prev = h4[i - 1]!;
    const w4 = welkin(a4, i);
    const z4 = zones.filter((z) => prev.close <= z.top && c.close > z.top).sort((x, y) => y.top - x.top)[0];
    if (z4 && prev.time === c.time - H4 && w4 && O_UP.has(w4)) out.push({ pattern: "stealth_level4h", at: close, entry: c.close, top: z4.top, bottom: z4.bottom });
    if (!zones.length) continue;
    const k0 = idxAtOrBefore(h1, close);
    for (let k = Math.max(1, k0); k < h1.length && h1[k]!.time < close + H4; k++) {
      const b = h1[k]!, p = h1[k - 1]!;
      if (b.time < close || b.time + H1 > now || p.time !== b.time - H1) continue;
      const z = zones.filter((x) => p.close <= x.top && b.close > x.top).sort((x, y) => y.top - x.top)[0];
      const w1 = welkin(a1, k);
      if (z && w1 && O_UP.has(w1)) out.push({ pattern: "stealth_level1h", at: b.time + H1, entry: b.close, top: z.top, bottom: z.bottom });
    }
  }
  return out;
}

/** Cancel time for an entry: hold rule × volume rule under level L, or null. */
function cancelAt(coin: Coin, a4: C[], e: Entry, L: number, hold: (typeof HOLDS)[number], vol: (typeof VOLS)[number], until: number): number | null {
  const { h4, h1 } = coin;
  const volOk = (j: number) => {
    if (vol === "any") return true;
    const w = vol.startsWith("agg") ? welkin(a4, j) : welkin(h4, j);
    return w !== null && (vol.endsWith("_A") ? BLUE_UP : O_UP).has(w);
  };
  for (let j = idxAtOrBefore(h4, e.at) + 1; j < h4.length; j++) {
    const close = h4[j]!.time + H4;
    if (close <= e.at) continue;
    if (close > until) return null;
    if (h4[j]!.close >= L) continue;
    if (!volOk(j)) continue;
    if (hold === "c1") return close;
    if (hold === "c2") {
      const n = h4[j + 1];
      if (n && n.time + H4 <= until && n.close < L) return n.time + H4;
      continue;
    }
    // c1h2: the next two 1H closes after this 4H close stay under L.
    const k = idxAtOrBefore(h1, close);
    const x1 = h1[k], x2 = h1[k + 1];
    if (x1 && x2 && x1.time === close && x2.time === close + H1 && x2.time + H1 <= until && x1.close < L && x2.close < L) return x2.time + H1;
  }
  return null;
}

function priceAt(m15: C[], at: number): number | null {
  const i = idxAtOrBefore(m15, at - M15);
  return i >= 0 ? m15[i]!.close : null;
}

const PERIODS = [["07-22.09", "2026-09-07", "2026-09-23"], ["23.09-08.10", "2026-09-23", "2026-10-09"], ["09-24.10", "2026-10-09", "2026-10-25"], ["25.10-10.11", "2026-10-25", "2026-11-11"]] as const;
type Res = { symbol: string; variant: string; at: number; entry: number; result: number; base: number; cancelled: boolean; cancelUtc: string | null; peakAfterCancel: number | null; baseRow: Row };

function stats(rs: Res[]): Row {
  const r = rs.map((x) => x.result).sort((a, b) => a - b);
  const q = (p: number) => (r.length ? Math.round(100 * r[Math.min(r.length - 1, Math.floor(p * r.length))]!) / 100 : null);
  const c = rs.filter((x) => x.cancelled);
  const sum = (xs: number[]) => Math.round(xs.reduce((a, b) => a + b, 0) * 10) / 10;
  return {
    trades: rs.length, coins: new Set(rs.map((x) => x.symbol)).size,
    avg_pct: r.length ? Math.round((100 * r.reduce((a, b) => a + b, 0)) / r.length) / 100 : null, sum_pct: sum(r),
    p10: q(0.1), p25: q(0.25), p75: q(0.75), p90: q(0.9),
    cancelled: c.length,
    cancelled_saved_pct: sum(c.map((x) => x.result - x.base)),
    cancelled_would_lose: c.filter((x) => x.base < 0).length,
    cancelled_would_win: c.filter((x) => x.base > 0).length,
    killed_winners_peak10_after: c.filter((x) => (x.peakAfterCancel ?? 0) >= 10).length,
  };
}

async function main() {
  const now = Math.floor(Date.now() / M15) * M15;
  const from = now - DAYS * D1;
  ensureDir(OUT); ensureDir(CACHE);
  const symbols = ONLY ?? (await usdtSymbols(CACHE)).slice(0, LIMIT);
  const errors: Record<string, string> = {};
  const all: Res[] = [];
  let done = 0, entriesN = 0;
  for (const symbol of symbols) {
    try {
      const coin = await loadCoin(symbol, from, now);
      if (coin.h4.length < 250 || coin.h1.length < 200 || coin.m15.length < 100) { errors[symbol] = "short_history"; continue; }
      const a4 = withVolume(coin.h4, coin.agg, H4), a1 = withVolume(coin.h1, coin.agg, H1);
      const entries = [...abneonEntries(coin, a4, from, now), ...stealthEntries(coin, a4, a1, from, now)].sort((a, b) => a.at - b.at);
      entriesN += entries.length;
      const busy = new Map<string, number>();
      for (const e of entries) {
        // Same trades in every variant: one trade per coin and pattern at a time, by the trade without cancels.
        if (e.at < (busy.get(e.pattern) ?? -Infinity)) continue;
        const tr = trade(coin.m15, e.at, e.entry, e.entry * STOP, "trk");
        if (tr.pct === null) continue;
        const endAt = tr.hours !== null ? e.at + tr.hours * H1 : Math.min(now, e.at + HORIZON);
        busy.set(e.pattern, endAt);
        const baseRow = path(coin.m15, e.at, e.entry, null);
        const levels: Array<[string, number]> = e.pattern === "abneon" ? [["zbot", e.bottom]] : [["lvtop", e.top], ["lvbot", e.bottom]];
        const run = (variant: string, cAt: number | null) => {
          const cancelled = cAt !== null && cAt < endAt;
          let result = tr.pct!, peakAfter: number | null = null;
          if (cancelled) {
            const p = priceAt(coin.m15, cAt!);
            if (p === null) return;
            result = Math.round(((p / e.entry - 1) * 100 - 0.1) * 100) / 100;
            let hi = 0;
            for (let i = idxAtOrBefore(coin.m15, cAt!) + 1; i < coin.m15.length && coin.m15[i]!.time < e.at + HORIZON; i++) hi = Math.max(hi, (coin.m15[i]!.high / e.entry - 1) * 100);
            peakAfter = Math.round(hi * 100) / 100;
          }
          all.push({ symbol, variant, at: e.at, entry: e.entry, result, base: tr.pct!, cancelled, cancelUtc: cancelled ? new Date(cAt!).toISOString() : null, peakAfterCancel: peakAfter, baseRow });
        };
        run(`${e.pattern}__none`, null);
        for (const [lname, L] of levels) for (const h of HOLDS) for (const v of VOLS) {
          run(`${e.pattern}__${lname}_${h}_${v}`, cancelAt(coin, a4, e, L, h, v, endAt));
        }
      }
    } catch (err) {
      errors[symbol] = String(err).slice(0, 160);
    }
    if (++done % 25 === 0) console.error(`монеты ${done}/${symbols.length}, входов ${entriesN}, строк ${all.length} · CoinGlass ${cgStats.requests} (429: ${cgStats.r429})`);
  }
  const variants = [...new Set(all.map((x) => x.variant))].sort((a, b) => (a.endsWith("__none") ? -1 : 0) - (b.endsWith("__none") ? -1 : 0) || a.localeCompare(b));
  const table: Row[] = [];
  for (const v of variants) {
    const rs = all.filter((x) => x.variant === v);
    table.push({ variant: v, period: "all", ...stats(rs) });
    for (const [name, a, b] of PERIODS) table.push({ variant: v, period: name, ...stats(rs.filter((x) => x.at >= Date.parse(a) && x.at < Date.parse(b))) });
  }
  writeCsv(join(OUT, "variants.csv"), table);
  writeCsv(join(OUT, "trades.csv"), all.map((x) => ({ variant: x.variant, symbol: x.symbol, entry_utc: new Date(x.at).toISOString(), entry: x.entry, result_pct: x.result, without_cancel_pct: x.base, cancelled: x.cancelled, cancel_utc: x.cancelUtc, peak_after_cancel_pct: x.peakAfterCancel, peak72_pct: x.baseRow.peak72_pct, out72: x.baseRow.out72 })));
  writeFileSync(join(OUT, "errors.json"), JSON.stringify(errors, null, 1));
  const fmt = (r: Row) => `${String(r.variant).padEnd(40)} ${String(r.period).padEnd(11)} | сделок ${r.trades} | ср ${r.avg_pct ?? "—"}% сумма ${r.sum_pct} (p10 ${r.p10 ?? "—"} p25 ${r.p25 ?? "—"} p75 ${r.p75 ?? "—"} p90 ${r.p90 ?? "—"}) | отменено ${r.cancelled}: сэкономлено ${r.cancelled_saved_pct}%, без отмены были бы в минусе ${r.cancelled_would_lose} / в плюсе ${r.cancelled_would_win}, убитых +10% после отмены ${r.killed_winners_peak10_after}`;
  const s =
    `Отмены ABNeon / Stealth · ${new Date(from).toISOString()} .. ${new Date(now).toISOString()} · монет ${symbols.length}, ошибок ${Object.keys(errors).length}, входов ${entriesN}\n` +
    `Уровень: zbot = низ зоны ABNeon; lvtop / lvbot = верх / низ пробитой зоны Stealth. Закреп: c1 одно закрытие 4H под уровнем, c2 два подряд, c1h2 4H под уровнем и ещё 2 часовые свечи под ним. Объём бара пробоя вниз: any / agg_A (синий+) / agg_O (оранжевый+) / bx_A / bx_O. none = без отмен (сейчас)\n` +
    `Стоп −8%, выход трекер CAB; отмена = закрытие по цене бара отмены, комиссия 0.1%\n\n` +
    table.map(fmt).join("\n") +
    `\n\nCoinGlass: запросов ${cgStats.requests}, ok ${cgStats.ok}, пусто ${cgStats.empty}, ошибок ${cgStats.errors}, 429: ${cgStats.r429}\nФайлы: variants.csv, trades.csv, errors.json`;
  writeFileSync(join(OUT, "summary.txt"), s);
  console.log(s);
}

main().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });
