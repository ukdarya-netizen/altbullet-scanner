/**
 * Exits for ABNeon and Stealth (owner 2026-11-10): on the same entries — which management gives money.
 *
 * Entries
 *   abneon           the bot's entry with the live touch rule (touch 4H or the next two not grey, aggregated)
 *   stealth_m        4H close above an ABNeon zone top, breakout candle Welkin M/W (≥ avg+3σ) on aggregated
 *                    volume — the best Stealth variant of stealth-vsa-study
 *   stealth_m_x3     the same, entry ≤ zone top + 3%
 * Stop: s8 (−8%) | szone (under the zone: ABNeon — zone bottom −1%, Stealth — broken zone bottom −1%;
 *       capped at −15%, a zone stop closer than −3% is set to −3%)
 * Management (fee 0.1%, conservative inside a 15m candle: the stop first):
 *   trk            CAB tracker today: break-even at +8%, trailing from +15% (peak − 10 p.p.)
 *   be5_trk        break-even at +5%, trailing from +15%
 *   be5_h10_tr15   break-even +5%, 50% at +10%, the rest trailing from +15% (peak − 10 p.p.) — as Nihilist
 *   be5_h8_tr12    break-even +5%, 50% at +8%, the rest trailing from +12% (peak − 8 p.p.)
 *   be5_tp10       break-even +5%, the whole position at +10%
 *   tp10 / tp15    the whole position at +10% / +15%, no break-even
 *   h10_h20        50% at +10% (stop → entry), the rest at +20%
 * Cancel: none | c1 (one 4H close under the level: ABNeon — zone bottom, Stealth — broken zone top)
 * Horizon 7 days (then closed at the price). One trade per coin and entry type at a time (by the trk trade),
 * the same trades in every variant. Four periods. Every trade listed.
 *
 * Run (from artifacts/api-server; same cache):
 *   STUDY_CG_RPM=30 pnpm dlx tsx scripts/exit-study.ts --days 64 --out ../../reports/exit-study
 */
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { computeSupportZones, evaluateAbneonSupportBounce, resolveFrozenZone, type SupportZone } from "../src/lib/stealth-abneon-detectors.js";
import { type VBar, cgHistory, cgStats, withVolume } from "./study-v2/cg.js";
import {
  type C, type Row, D1, H1, H4, M15, ensureDir, idxAtOrBefore, klines, lastClosed, parseArgs, trade, usdtSymbols, welkin, writeCsv,
} from "./study-v2/lib.js";

const args = parseArgs();
const DAYS = Number(args.get("days") ?? 64);
const OUT = args.get("out") ?? "exit-study";
const CACHE = args.get("cache") ?? "../../reports/.cache";
const LIMIT = Number(args.get("limit") ?? 10_000);
const ONLY = args.get("symbols")?.split(",").filter(Boolean) ?? null;
const H4_BACK = 720, H1_BACK = 400;
const HORIZON = 7 * D1;
const FEE = 0.1;
const NON_GREY = new Set(["A", "O", "M", "W", "Y"]), M_UP = new Set(["M", "W"]);

type Coin = { h4: C[]; h1: C[]; m15: C[]; agg: Map<number, VBar> | null };
async function loadCoin(symbol: string, from: number, now: number): Promise<Coin> {
  return {
    h4: await klines(CACHE, symbol, "4h", from - H4_BACK * H4, now),
    h1: await klines(CACHE, symbol, "1h", from - H1_BACK * H1, now),
    m15: await klines(CACHE, symbol, "15m", from - 8 * M15, now),
    agg: await cgHistory(CACHE, symbol, "aggfut", from - H4_BACK * H4, now),
  };
}

type Entry = { pattern: "abneon" | "stealth_m" | "stealth_m_x3"; at: number; entry: number; top: number; bottom: number };

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

function stealthEntries(coin: Coin, a4: C[], from: number, now: number): Entry[] {
  const { h4 } = coin;
  const out: Entry[] = [];
  for (let i = 1; i < h4.length; i++) {
    const c = h4[i]!, close = c.time + H4;
    if (close > now) break;
    if (close < from) continue;
    const hist = h4.slice(Math.max(0, i - 699), i + 1);
    const zones: SupportZone[] = hist.length >= 60 ? computeSupportZones(hist) : [];
    const prev = h4[i - 1]!;
    const w4 = welkin(a4, i);
    const z4 = zones.filter((z) => prev.close <= z.top && c.close > z.top).sort((x, y) => y.top - x.top)[0];
    if (!z4 || prev.time !== c.time - H4 || !w4 || !M_UP.has(w4)) continue;
    out.push({ pattern: "stealth_m", at: close, entry: c.close, top: z4.top, bottom: z4.bottom });
    if (c.close <= z4.top * 1.03) out.push({ pattern: "stealth_m_x3", at: close, entry: c.close, top: z4.top, bottom: z4.bottom });
  }
  return out;
}

/** c1: the first 4H close under L after the entry. */
function cancelAt(coin: Coin, e: Entry, L: number): number | null {
  const { h4 } = coin;
  for (let j = idxAtOrBefore(h4, e.at) + 1; j < h4.length; j++) {
    const close = h4[j]!.time + H4;
    if (close <= e.at) continue;
    if (close > e.at + HORIZON) return null;
    if (h4[j]!.close < L) return close;
  }
  return null;
}

function priceAt(m15: C[], at: number): number | null {
  const i = idxAtOrBefore(m15, at - M15);
  return i >= 0 ? m15[i]!.close : null;
}

type Mgmt = { be: number | null; partial: { at: number; share: number } | null; take: number | null; trail: { act: number; gap: number } | null };
const MGMT: Record<string, Mgmt> = {
  trk: { be: 8, partial: null, take: null, trail: { act: 15, gap: 10 } },
  be5_trk: { be: 5, partial: null, take: null, trail: { act: 15, gap: 10 } },
  be5_h10_tr15: { be: 5, partial: { at: 10, share: 0.5 }, take: null, trail: { act: 15, gap: 10 } },
  be5_h8_tr12: { be: 5, partial: { at: 8, share: 0.5 }, take: null, trail: { act: 12, gap: 8 } },
  be5_tp10: { be: 5, partial: null, take: 10, trail: null },
  tp10: { be: null, partial: null, take: 10, trail: null },
  tp15: { be: null, partial: null, take: 15, trail: null },
  h10_h20: { be: null, partial: { at: 10, share: 0.5 }, take: 20, trail: null },
};

/** Long trade on 15m candles; returns the result % (fee included) and the close time, or null when open. */
function sim(m15: C[], from: number, entry: number, stopPrice: number, m: Mgmt, cancel: number | null, now: number): { pct: number; end: number } | null {
  let stop = stopPrice, peak = entry, part = 0, realised = 0, partialDone = false;
  const left = () => 1 - part;
  const closeAll = (price: number, t: number) => ({ pct: realised + left() * ((price / entry - 1) * 100) - FEE, end: t });
  for (let i = idxAtOrBefore(m15, from - 1) + 1; i < m15.length; i++) {
    const c = m15[i]!;
    if (c.time >= from + HORIZON) break;
    if (cancel !== null && c.time >= cancel) return closeAll(m15[i - 1]?.close ?? c.open, cancel);
    if (c.low <= stop) return closeAll(Math.min(stop, c.open), c.time + M15);
    peak = Math.max(peak, c.high);
    const pp = (peak / entry - 1) * 100;
    if (m.partial && !partialDone && pp >= m.partial.at) {
      partialDone = true; part = m.partial.share;
      realised += m.partial.share * m.partial.at;
      stop = Math.max(stop, entry);
    }
    if (m.take !== null && pp >= m.take) return { pct: realised + left() * m.take - FEE, end: c.time + M15 };
    if (m.be !== null && pp >= m.be) stop = Math.max(stop, entry);
    if (m.trail && pp >= m.trail.act) stop = Math.max(stop, entry * (1 + (pp - m.trail.gap) / 100));
  }
  if (from + HORIZON > now) return null;
  const j = idxAtOrBefore(m15, from + HORIZON - M15);
  return j >= 0 ? closeAll(m15[j]!.close, from + HORIZON) : null;
}

const PERIODS = [["07-22.09", "2026-09-07", "2026-09-23"], ["23.09-08.10", "2026-09-23", "2026-10-09"], ["09-24.10", "2026-10-09", "2026-10-25"], ["25.10-10.11", "2026-10-25", "2026-11-11"]] as const;
type Res = { symbol: string; variant: string; at: number; entry: number; stopPct: number; pct: number; end: number };

function stats(rs: Res[]): Row {
  const r = rs.map((x) => x.pct).sort((a, b) => a - b);
  const q = (p: number) => (r.length ? Math.round(100 * r[Math.min(r.length - 1, Math.floor(p * r.length))]!) / 100 : null);
  const wins = r.filter((x) => x > 0), losses = r.filter((x) => x < 0);
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
  let dep = 100;
  for (const x of [...rs].sort((a, b) => a.end - b.end)) dep *= 1 + (0.02 * x.pct) / 100; // 2% of the deposit per trade
  return {
    trades: rs.length, coins: new Set(rs.map((x) => x.symbol)).size,
    avg_pct: r.length ? Math.round((100 * sum(r)) / r.length) / 100 : null, sum_pct: Math.round(sum(r)),
    win_pct: r.length ? Math.round((1000 * wins.length) / r.length) / 10 : null,
    avg_win: wins.length ? Math.round((100 * sum(wins)) / wins.length) / 100 : null,
    avg_loss: losses.length ? Math.round((100 * sum(losses)) / losses.length) / 100 : null,
    p10: q(0.1), p25: q(0.25), p75: q(0.75), p90: q(0.9),
    deposit_2pct_per_trade: Math.round((dep - 100) * 100) / 100,
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
      const a4 = withVolume(coin.h4, coin.agg, H4);
      const entries = [...abneonEntries(coin, a4, from, now), ...stealthEntries(coin, a4, from, now)].sort((a, b) => a.at - b.at);
      entriesN += entries.length;
      const busy = new Map<string, number>();
      for (const e of entries) {
        if (e.at < (busy.get(e.pattern) ?? -Infinity)) continue;
        const base = trade(coin.m15, e.at, e.entry, e.entry * 0.92, "trk");
        if (base.pct === null) continue;
        busy.set(e.pattern, e.at + (base.hours ?? 168) * H1);
        const zoneStop = e.bottom * 0.99;
        const zonePct = Math.min(15, Math.max(3, (1 - zoneStop / e.entry) * 100));
        const stops: Array<[string, number]> = [["s8", 8], ["szone", zonePct]];
        const L = e.pattern === "abneon" ? e.bottom : e.top;
        const cAt = cancelAt(coin, e, L);
        for (const [sname, spct] of stops) for (const [mname, m] of Object.entries(MGMT)) for (const cname of ["none", "c1"] as const) {
          const r = sim(coin.m15, e.at, e.entry, e.entry * (1 - spct / 100), m, cname === "c1" ? cAt : null, now);
          if (!r) continue;
          all.push({ symbol, variant: `${e.pattern}__${sname}_${mname}_${cname}`, at: e.at, entry: e.entry, stopPct: Math.round(spct * 100) / 100, pct: Math.round(r.pct * 100) / 100, end: r.end });
        }
      }
    } catch (err) {
      errors[symbol] = String(err).slice(0, 160);
    }
    if (++done % 25 === 0) console.error(`монеты ${done}/${symbols.length}, входов ${entriesN}, строк ${all.length} · CoinGlass ${cgStats.requests} (429: ${cgStats.r429})`);
  }
  const variants = [...new Set(all.map((x) => x.variant))].sort();
  const table: Row[] = [];
  for (const v of variants) {
    const rs = all.filter((x) => x.variant === v);
    table.push({ variant: v, period: "all", ...stats(rs) });
    for (const [name, a, b] of PERIODS) table.push({ variant: v, period: name, ...stats(rs.filter((x) => x.at >= Date.parse(a) && x.at < Date.parse(b))) });
  }
  writeCsv(join(OUT, "variants.csv"), table);
  writeCsv(join(OUT, "trades.csv"), all.map((x) => ({ variant: x.variant, symbol: x.symbol, entry_utc: new Date(x.at).toISOString(), entry: x.entry, stop_pct: x.stopPct, result_pct: x.pct, closed_utc: new Date(x.end).toISOString() })));
  writeFileSync(join(OUT, "errors.json"), JSON.stringify(errors, null, 1));
  const fmt = (r: Row) => `${String(r.variant).padEnd(40)} ${String(r.period).padEnd(11)} | сделок ${r.trades} | ср ${r.avg_pct ?? "—"}% сумма ${r.sum_pct} | в плюсе ${r.win_pct ?? "—"}% (ср +${r.avg_win ?? "—"} / ${r.avg_loss ?? "—"}) | p10 ${r.p10 ?? "—"} p25 ${r.p25 ?? "—"} p75 ${r.p75 ?? "—"} p90 ${r.p90 ?? "—"} | депозит ${r.deposit_2pct_per_trade}%`;
  const s =
    `Выходы ABNeon / Stealth · ${new Date(from).toISOString()} .. ${new Date(now).toISOString()} · монет ${symbols.length}, ошибок ${Object.keys(errors).length}, входов ${entriesN}\n` +
    `Стоп s8 −8% / szone под зоной (−3…−15%); ведение trk (Б.У. +8, трейл с +15), be5_trk, be5_h10_tr15 (Б.У. +5, 50% на +10, трейл с +15), be5_h8_tr12, be5_tp10, tp10, tp15, h10_h20; отмена none / c1 (закрытие 4H под уровнем)\n` +
    `Депозит: 2% депозита на сделку, без плеча, по времени закрытия; комиссия 0.1%\n\n` +
    table.map(fmt).join("\n") +
    `\n\nCoinGlass: запросов ${cgStats.requests}, ok ${cgStats.ok}, пусто ${cgStats.empty}, ошибок ${cgStats.errors}, 429: ${cgStats.r429}\nФайлы: variants.csv, trades.csv, errors.json`;
  writeFileSync(join(OUT, "summary.txt"), s);
  console.log(s);
}

main().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });
