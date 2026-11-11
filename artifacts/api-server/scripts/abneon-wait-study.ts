/**
 * ABNeon "waiting for volume" (owner 2026-11-11, charts ELSA / INIT / PIEVERSE / EDGEX / KNOTS / GANG / SI / PRIORS):
 * the price lies on the zone for days on grey volume, then bright volume comes and the price leaves the zone.
 *
 * Rule (4H, closed candles only, nothing from the future):
 *   1. Zone: production ABNeon 4H support zones (liveSupportZones on the last 640 4H candles).
 *      Arm: a 4H candle dips to the zone (low ≤ top +1%) and closes not under it (close ≥ bottom −1%),
 *      the previous 4H close was above the zone top (the price came from above). The zone is frozen.
 *   2. Waiting: up to 5 days (30 4H candles) from the arm candle.
 *   3. Waiting cancelled: two 4H closes in a row under the zone bottom.
 *   4. Entry: the first 4H candle (the arm candle included) that closes green (close > open) above the zone
 *      top, not more than 5% above it, with a bright aggregated-futures Welkin colour (O / M / W, ≥ avg+2σ).
 *      A green close above the zone without that volume is skipped (logged) and the waiting goes on.
 *      No aggregated volume on the candle = no entry.
 *   5. One trade per coin at a time (until the trk trade closes); then the coin can arm again.
 * Compared with the live ABNeon entry (the bot's rule today, as in exit-study).
 * Exits (fee 0.1%, 15m candles, stop first): stops s8 / szone (zone bottom −1%, 3…15%), managements
 *   trk, be5_h10_tr15, be10_tr20g20, h10_tr20g20, h10_hold; horizon 7 days.
 *
 * Out: her-coins.txt (every arm / waiting candle / entry on the owner's coins, UTC and Dubai time),
 *      entries.csv, variants.csv, trades.csv, summary.txt, errors.json.
 *
 * Run (from artifacts/api-server; same cache):
 *   STUDY_CG_RPM=30 pnpm dlx tsx scripts/abneon-wait-study.ts --days 64 --out ../../reports/abneon-wait
 */
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { evaluateAbneonSupportBounce, liveSupportZones, resolveFrozenZone, type SupportZone } from "../src/lib/stealth-abneon-detectors.js";
import { cgHistory, cgStats, withVolume } from "./study-v2/cg.js";
import {
  type C, type Row, D1, H1, H4, M15, ensureDir, idxAtOrBefore, klines, lastClosed, parseArgs, trade, usdtSymbols, welkin, writeCsv,
} from "./study-v2/lib.js";

const args = parseArgs();
const DAYS = Number(args.get("days") ?? 64);
const OUT = args.get("out") ?? "abneon-wait";
const CACHE = args.get("cache") ?? "../../reports/.cache";
const LIMIT = Number(args.get("limit") ?? 10_000);
const ONLY = args.get("symbols")?.split(",").filter(Boolean) ?? null;
const HER = (args.get("her") ?? "ELSA,INIT,PIEVERSE,EDGEX,KNOTS,GANG,SI,PRIORS").split(",").map((s) => `${s}-USDT`);
const H4_BACK = 720, H1_BACK = 400;
const HORIZON = 7 * D1;
const WAIT = 30; // 4H candles = 5 days
const MAX_ABOVE = 1.05;
const TOL = 0.01;
const FEE = 0.1;
const BRIGHT = new Set(["O", "M", "W"]), NON_GREY = new Set(["A", "O", "M", "W", "Y"]);

const fmtT = (t: number) => {
  const u = new Date(t), d = new Date(t + 4 * H1);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(u.getUTCDate())}.${p(u.getUTCMonth() + 1)} ${p(u.getUTCHours())}:00 UTC (${p(d.getUTCDate())}.${p(d.getUTCMonth() + 1)} ${p(d.getUTCHours())}:00 Дубай)`;
};
const px = (x: number) => +x.toPrecision(5);

type Entry = { pattern: "wait" | "live"; at: number; entry: number; top: number; bottom: number; armAt: number | null; colour: string | null };

/** New rule: arm on a touch, wait up to 5 days for a green 4H close above the zone on bright aggregated volume. */
function waitEntries(h4: C[], a4: C[], m15: C[], from: number, now: number, log: string[] | null): Entry[] {
  const out: Entry[] = [];
  let w: { zone: SupportZone; armIdx: number; below: number } | null = null;
  let blockedUntil = -Infinity;
  for (let i = 1; i < h4.length; i++) {
    const c = h4[i]!, close = c.time + H4;
    if (close > now) break;
    if (close < from) continue;
    if (w) {
      const z = w.zone, col = welkin(a4, i) ?? "нет агрегата";
      const above = c.close > z.top, green = c.close > c.open;
      w.below = c.close < z.bottom ? w.below + 1 : 0;
      const tag = `${c.close < z.bottom ? "под зоной" : above ? `над зоной +${((c.close / z.top - 1) * 100).toFixed(1)}%` : "в зоне"}, ${green ? "зелёная" : "красная"}, объём ${col}`;
      if (w.below >= 2) {
        log?.push(`   ${fmtT(close - H4)} закрытие ${px(c.close)} · ${tag} → ОТМЕНА ожидания (2 закрытия под зоной)`);
        w = null;
        continue;
      }
      if (green && above && c.close <= z.top * MAX_ABOVE && BRIGHT.has(col)) {
        log?.push(`   ${fmtT(close - H4)} закрытие ${px(c.close)} · ${tag} → ВХОД ${px(c.close)}`);
        out.push({ pattern: "wait", at: close, entry: c.close, top: z.top, bottom: z.bottom, armAt: h4[w.armIdx]!.time, colour: col });
        const base = trade(m15, close, c.close, c.close * 0.92, "trk");
        blockedUntil = close + (base.hours ?? 168) * H1;
        w = null;
        continue;
      }
      const why = green && above && c.close > z.top * MAX_ABOVE ? " → пропуск: выше зоны больше 5%" : green && above ? " → пропуск: объём не яркий" : "";
      log?.push(`   ${fmtT(close - H4)} закрытие ${px(c.close)} · ${tag}${why}`);
      if (i - w.armIdx + 1 >= WAIT) { log?.push(`   ожидание истекло (5 дней)`); w = null; }
      continue;
    }
    if (close <= blockedUntil) continue;
    const prev = h4[i - 1]!;
    if (prev.time !== c.time - H4) continue;
    const zones = liveSupportZones(h4.slice(Math.max(0, i - 639), i + 1));
    const z = zones
      .filter((z) => prev.close > z.top && c.low <= z.top * (1 + TOL) && c.close >= z.bottom * (1 - TOL))
      .sort((a, b) => b.top - a.top)[0];
    if (!z) continue;
    w = { zone: z, armIdx: i, below: 0 };
    log?.push(`\n ${fmtT(c.time)} КАСАНИЕ зоны ${px(z.bottom)}–${px(z.top)} (лоу ${px(c.low)}) → ожидание объёма`);
    i--; // the arm candle itself is checked as a possible entry
  }
  return out;
}

/** The bot's ABNeon entry today (as exit-study). */
function liveEntries(h4: C[], h1: C[], a4: C[], from: number, now: number): Entry[] {
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
      let w0 = ti;
      while (w0 - 1 >= 0 && h1[w0 - 1]!.time + H1 > res.armCandleTime) w0--;
      let touch = h1[w0]!.time;
      for (let k = w0; k <= ti; k++) if (h1[k]!.low <= res.frozenLevel * 1.002) { touch = h1[k]!.time; break; }
      const j0 = idxAtOrBefore(h4, touch);
      let col: string | null = null;
      for (let j = j0; j >= 0 && j <= j0 + 2 && j < h4.length; j++) {
        if (h4[j]!.time + H4 > t) break;
        const x = welkin(a4, j);
        if (x && NON_GREY.has(x)) { col = x; break; }
      }
      if (!col) continue;
      const z = resolveFrozenZone(h4.slice(0, i4 + 1), res.armCandleTime, res.frozenLevel);
      out.push({ pattern: "live", at: t, entry: h1[ti]!.close, top: z.top, bottom: z.bottom, armAt: res.armCandleTime, colour: col });
    } else if (res.status === "armed" && res.frozenLevel != null && res.armCandleTime != null) {
      if (!arm) arm = { level: res.frozenLevel, time: res.armCandleTime };
    } else if (arm && (res.status === "terminal" || t - arm.time > 24 * H1)) {
      arm = null;
    }
  }
  return out;
}

type Mgmt = { be: number | null; partial: { at: number; share: number } | null; trail: { act: number; gap: number } | null };
const MGMT: Record<string, Mgmt> = {
  trk: { be: 8, partial: null, trail: { act: 15, gap: 10 } },
  be5_h10_tr15: { be: 5, partial: { at: 10, share: 0.5 }, trail: { act: 15, gap: 10 } },
  be10_tr20g20: { be: 10, partial: null, trail: { act: 20, gap: 20 } },
  h10_tr20g20: { be: null, partial: { at: 10, share: 0.5 }, trail: { act: 20, gap: 20 } },
  h10_hold: { be: null, partial: { at: 10, share: 0.5 }, trail: null },
};

function sim(m15: C[], from: number, entry: number, stopPrice: number, m: Mgmt, now: number): { pct: number; end: number } | null {
  let stop = stopPrice, peak = entry, part = 0, realised = 0, partialDone = false;
  const closeAll = (price: number, t: number) => ({ pct: realised + (1 - part) * ((price / entry - 1) * 100) - FEE, end: t });
  for (let i = idxAtOrBefore(m15, from - 1) + 1; i < m15.length; i++) {
    const c = m15[i]!;
    if (c.time >= from + HORIZON) break;
    if (c.low <= stop) return closeAll(Math.min(stop, c.open), c.time + M15);
    peak = Math.max(peak, c.high);
    const pp = (peak / entry - 1) * 100;
    if (m.partial && !partialDone && pp >= m.partial.at) { partialDone = true; part = m.partial.share; realised += m.partial.share * m.partial.at; stop = Math.max(stop, entry); }
    if (m.be !== null && pp >= m.be) stop = Math.max(stop, entry);
    if (m.trail && pp >= m.trail.act) stop = Math.max(stop, entry * (1 + (pp - m.trail.gap) / 100));
  }
  if (from + HORIZON > now) return null;
  const j = idxAtOrBefore(m15, from + HORIZON - M15);
  return j >= 0 ? closeAll(m15[j]!.close, from + HORIZON) : null;
}

/** Max up / max down from the entry within 7 days (or until now), and the last price. */
function path(m15: C[], from: number, entry: number, now: number) {
  let hi = entry, lo = entry, last = entry;
  for (let i = idxAtOrBefore(m15, from - 1) + 1; i < m15.length; i++) {
    const c = m15[i]!;
    if (c.time >= Math.min(from + HORIZON, now)) break;
    hi = Math.max(hi, c.high); lo = Math.min(lo, c.low); last = c.close;
  }
  return { up: (hi / entry - 1) * 100, down: (lo / entry - 1) * 100, last: (last / entry - 1) * 100 };
}

const PERIODS = [["07-22.09", "2026-09-07", "2026-09-23"], ["23.09-08.10", "2026-09-23", "2026-10-09"], ["09-24.10", "2026-10-09", "2026-10-25"], ["25.10-11.11", "2026-10-25", "2026-11-12"]] as const;
type Res = { symbol: string; variant: string; at: number; pct: number; end: number };

function stats(rs: Res[]): Row {
  const r = rs.map((x) => x.pct).sort((a, b) => a - b);
  const q = (p: number) => (r.length ? Math.round(100 * r[Math.min(r.length - 1, Math.floor(p * r.length))]!) / 100 : null);
  const wins = r.filter((x) => x > 0), losses = r.filter((x) => x < 0);
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
  let dep = 100;
  for (const x of [...rs].sort((a, b) => a.end - b.end)) dep *= 1 + (0.02 * x.pct) / 100;
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
  const listed = ONLY ?? (await usdtSymbols(CACHE)).slice(0, LIMIT);
  const symbols = [...new Set([...HER, ...listed])];
  const errors: Record<string, string> = {};
  const all: Res[] = [];
  const entryRows: Row[] = [];
  const her: string[] = [];
  let done = 0;
  for (const symbol of symbols) {
    const isHer = HER.includes(symbol);
    try {
      const h4 = await klines(CACHE, symbol, "4h", from - H4_BACK * H4, now);
      const h1 = await klines(CACHE, symbol, "1h", from - H1_BACK * H1, now);
      const m15 = await klines(CACHE, symbol, "15m", from - 8 * M15, now);
      const agg = await cgHistory(CACHE, symbol, "aggfut", from - H4_BACK * H4, now);
      if (h4.length < 250 || h1.length < 200 || m15.length < 100) { errors[symbol] = "short_history"; if (isHer) her.push(`\n=== ${symbol}: мало истории на BingX`); continue; }
      const a4 = withVolume(h4, agg, H4);
      const log: string[] | null = isHer ? [] : null;
      const entries = [...waitEntries(h4, a4, m15, from, now, log), ...liveEntries(h4, h1, a4, from, now)].sort((a, b) => a.at - b.at);
      const busy = new Map<string, number>();
      const herTrades: string[] = [];
      for (const e of entries) {
        if (e.at < (busy.get(e.pattern) ?? -Infinity)) continue;
        const base = trade(m15, e.at, e.entry, e.entry * 0.92, "trk");
        busy.set(e.pattern, e.at + (base.hours ?? 168) * H1);
        const zonePct = Math.min(15, Math.max(3, (1 - (e.bottom * 0.99) / e.entry) * 100));
        const p = path(m15, e.at, e.entry, now);
        const row: Row = {
          pattern: e.pattern, symbol, arm_utc: e.armAt ? new Date(e.armAt).toISOString() : null, entry_utc: new Date(e.at).toISOString(),
          entry: e.entry, zone_bottom: e.bottom, zone_top: e.top, above_top_pct: Math.round((e.entry / e.top - 1) * 1000) / 10, colour: e.colour,
          zone_stop_pct: Math.round(zonePct * 100) / 100, max_up_7d_pct: Math.round(p.up * 10) / 10, max_down_7d_pct: Math.round(p.down * 10) / 10,
        };
        for (const [sname, spct] of [["s8", 8], ["szone", zonePct]] as const) for (const [mname, m] of Object.entries(MGMT)) {
          const r = sim(m15, e.at, e.entry, e.entry * (1 - spct / 100), m, now);
          row[`${sname}_${mname}`] = r ? Math.round(r.pct * 100) / 100 : null;
          if (r) all.push({ symbol, variant: `${e.pattern}__${sname}_${mname}`, at: e.at, pct: Math.round(r.pct * 100) / 100, end: r.end });
        }
        entryRows.push(row);
        if (isHer) herTrades.push(`   ${e.pattern === "wait" ? "НОВОЕ" : "СЕЙЧАС"} ${fmtT(e.at)} вход ${px(e.entry)} · зона ${px(e.bottom)}–${px(e.top)} · объём ${e.colour} · за 7 дн макс +${p.up.toFixed(1)}% / мин ${p.down.toFixed(1)}%${e.at + HORIZON > now ? ` (идёт, сейчас ${p.last >= 0 ? "+" : ""}${p.last.toFixed(1)}%)` : ""} · trk s8: ${row.s8_trk ?? "открыта"}%`);
      }
      if (isHer) {
        her.push(`\n=== ${symbol} ${agg ? "" : "(НЕТ агрегированного объёма — сигналов нет)"}`);
        her.push(log!.length ? log!.join("\n") : " касаний зон за период нет");
        her.push(`\n Сделки (НОВОЕ = ожидание объёма, СЕЙЧАС = как бот входит сегодня):`);
        her.push(herTrades.length ? herTrades.join("\n") : "   нет");
      }
    } catch (err) {
      errors[symbol] = String(err).slice(0, 160);
      if (isHer) her.push(`\n=== ${symbol}: ошибка ${errors[symbol]}`);
    }
    if (++done % 25 === 0) console.error(`монеты ${done}/${symbols.length}, сделок ${entryRows.length} · CoinGlass ${cgStats.requests} (429: ${cgStats.r429})`);
  }
  const variants = [...new Set(all.map((x) => x.variant))].sort();
  const table: Row[] = [];
  for (const v of variants) {
    const rs = all.filter((x) => x.variant === v);
    table.push({ variant: v, period: "all", ...stats(rs) });
    for (const [name, a, b] of PERIODS) table.push({ variant: v, period: name, ...stats(rs.filter((x) => x.at >= Date.parse(a) && x.at < Date.parse(b))) });
  }
  writeCsv(join(OUT, "variants.csv"), table);
  writeCsv(join(OUT, "entries.csv"), entryRows);
  writeCsv(join(OUT, "trades.csv"), all.map((x) => ({ variant: x.variant, symbol: x.symbol, entry_utc: new Date(x.at).toISOString(), result_pct: x.pct, closed_utc: new Date(x.end).toISOString() })));
  writeFileSync(join(OUT, "errors.json"), JSON.stringify(errors, null, 1));
  writeFileSync(join(OUT, "her-coins.txt"),
    `ABNeon с ожиданием объёма — твои монеты · ${new Date(from).toISOString()} .. ${new Date(now).toISOString()}\n` +
    `Время — открытие 4H свечи. Объём — цвет Welkin по агрегату фьючерсов: N серый, A синий, Y жёлтый, O оранжевый, M фиолетовый, W белый.\n` +
    `Вход: зелёная 4H закрылась выше зоны (≤ +5%) на O/M/W. Отмена: 2 закрытия под зоной. Ожидание до 5 дней.\n` + her.join("\n") + "\n");
  const fmt = (r: Row) => `${String(r.variant).padEnd(26)} ${String(r.period).padEnd(11)} | сделок ${r.trades} монет ${r.coins} | ср ${r.avg_pct ?? "—"}% сумма ${r.sum_pct} | в плюсе ${r.win_pct ?? "—"}% (ср +${r.avg_win ?? "—"} / ${r.avg_loss ?? "—"}) | p10 ${r.p10 ?? "—"} p25 ${r.p25 ?? "—"} p75 ${r.p75 ?? "—"} p90 ${r.p90 ?? "—"} | депозит ${r.deposit_2pct_per_trade}%`;
  const s =
    `ABNeon: ожидание объёма (wait) против входа сегодня (live) · ${new Date(from).toISOString()} .. ${new Date(now).toISOString()} · монет ${symbols.length}, ошибок ${Object.keys(errors).length}\n` +
    `Стоп s8 −8% / szone под зоной (−3…−15%); ведение trk (Б.У. +8, трейл с +15 −10), be5_h10_tr15, be10_tr20g20, h10_tr20g20, h10_hold; 7 дней; комиссия 0.1%; депозит 2% на сделку\n\n` +
    table.map(fmt).join("\n") +
    `\n\nCoinGlass: запросов ${cgStats.requests}, ok ${cgStats.ok}, пусто ${cgStats.empty}, ошибок ${cgStats.errors}, 429: ${cgStats.r429}\nФайлы: her-coins.txt, entries.csv, variants.csv, trades.csv, errors.json`;
  writeFileSync(join(OUT, "summary.txt"), s);
  console.log(s);
}

main().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });
