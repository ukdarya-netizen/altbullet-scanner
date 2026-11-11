/**
 * Stealth on the owner's charts (owner 2026-11-11; charts of 07.11: OLAXBT, Everlyn AI, BLESS — breakouts on
 * bright VSA candles). Same idea as the ABNeon check: does the bot catch HER breakouts, and with which rule.
 *
 * Entries compared (4H, closed candles, nothing from the future):
 *   live      the bot today: evaluateNeonRangeBreakout (Auto Range breakout with the range top on an ABNeon
 *             zone, 4H / 1D), no volume rule
 *   zone_MW   4H close above an ABNeon zone top (previous close at/below it), breakout candle Welkin M/W
 *   zone_OMW  the same, O / M / W
 *   zone_A    the same, not grey (A / Y / O / M / W)
 *   Volume: CoinGlass aggregated futures; where the coin has NO aggregated volume, BingX's own volume is the
 *   fallback (the Stealth exception the owner asked to consider) — such entries are marked "bingx".
 * Exits (fee 0.1%, 15m candles, stop first, 4 days):
 *   trk   stop −8%, B.U. +8%, trailing from +15% at 10 p.p. (Stealth today)
 *   neon  as the new ABNeon: stop under the broken zone bottom −1% (3…15%), B.U. +10%, trailing from +20% at
 *         20 p.p., cancel at a 4H close under the broken zone top
 *
 * Out: her-coins.txt (every 4H close above a zone on her coins since --her-from with both volume colours and
 *      which rule fires, then the trades), summary.txt (all coins, per entry and exit, ranges), trades.csv.
 *
 * Run (from artifacts/api-server; same cache):
 *   STUDY_CG_RPM=30 pnpm dlx tsx scripts/stealth-her-check.ts --days 64 --out ../../reports/stealth-her-check
 */
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { computeSupportZones } from "../src/lib/stealth-abneon-detectors.js";
import { dailyFrom4h, evaluateNeonRangeBreakout } from "../src/lib/stealth-neon-level-breakout.js";
import { stopUnderLevel } from "../src/lib/abneon-low-bounce.js";
import { cgHistory, cgStats, withVolume } from "./study-v2/cg.js";
import { type C, type Row, D1, H1, H4, M15, ensureDir, idxAtOrBefore, klines, parseArgs, usdtSymbols, welkin, writeCsv } from "./study-v2/lib.js";

const args = parseArgs();
const DAYS = Number(args.get("days") ?? 64);
const OUT = args.get("out") ?? "stealth-her-check";
const CACHE = args.get("cache") ?? "../../reports/.cache";
const LIMIT = Number(args.get("limit") ?? 10_000);
const ONLY = args.get("symbols")?.split(",").filter(Boolean) ?? null;
const HER = (args.get("her") ?? "OLAXBT,LYN,EVERLYN,BLESS").split(",").map((s) => `${s}-USDT`);
const HER_FROM = Date.parse(args.get("her-from") ?? "2026-10-20T00:00:00Z");
const HORIZON = 4 * D1;
const FEE = 0.1;
const SETS: Record<string, Set<string>> = {
  zone_MW: new Set(["M", "W"]),
  zone_OMW: new Set(["O", "M", "W"]),
  zone_A: new Set(["A", "Y", "O", "M", "W"]),
};

const fmtT = (t: number) => {
  const d = new Date(t + 4 * H1), p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getUTCDate())}.${p(d.getUTCMonth() + 1)} ${p(d.getUTCHours())}:00 Дубай`;
};
const px = (x: number) => String(+x.toPrecision(5));

type Entry = { rule: string; at: number; entry: number; top: number; bottom: number; colour: string; src: "agg" | "bingx" | "-" };

function sim(h4: C[], m15: C[], e: Entry, exit: "trk" | "neon", now: number): { pct: number; end: number; how: string } | null {
  const stopP = exit === "trk" ? e.entry * 0.92 : stopUnderLevel(e.entry, e.bottom);
  if (stopP === null) return null;
  const [be, act, gap] = exit === "trk" ? [8, 15, 10] : [10, 20, 20];
  let stop = stopP, peak = e.entry, how = "стоп";
  const done = (price: number, t: number, h: string) => ({ pct: (price / e.entry - 1) * 100 - FEE, end: t, how: h });
  for (let i = idxAtOrBefore(m15, e.at - 1) + 1; i < m15.length; i++) {
    const c = m15[i]!;
    if (c.time >= e.at + HORIZON) break;
    if (exit === "neon" && c.time % H4 === 0 && c.time > e.at) {
      const j = idxAtOrBefore(h4, c.time - H4);
      if (j >= 0 && h4[j]!.time + H4 === c.time && h4[j]!.close < e.top) return done(h4[j]!.close, c.time, "отмена 4H под уровнем");
    }
    if (c.low <= stop) return done(Math.min(stop, c.open), c.time + M15, how);
    peak = Math.max(peak, c.high);
    const pp = (peak / e.entry - 1) * 100;
    if (pp >= be && stop < e.entry) { stop = e.entry; how = "безубыток"; }
    if (pp >= act) { const ts = e.entry * (1 + (pp - gap) / 100); if (ts > stop) { stop = ts; how = "трейлинг"; } }
  }
  if (e.at + HORIZON > now) return null;
  const j = idxAtOrBefore(m15, e.at + HORIZON - M15);
  return j >= 0 ? done(m15[j]!.close, e.at + HORIZON, "4 дня") : null;
}

function stats(xs: number[]): Row {
  const r = [...xs].sort((a, b) => a - b);
  const q = (p: number) => (r.length ? Math.round(100 * r[Math.min(r.length - 1, Math.floor(p * r.length))]!) / 100 : null);
  const sum = r.reduce((a, b) => a + b, 0);
  let dep = 100;
  for (const x of xs) dep *= 1 + (0.02 * x) / 100;
  return {
    trades: r.length, avg: r.length ? Math.round((100 * sum) / r.length) / 100 : null, sum: Math.round(sum),
    win: r.length ? Math.round((1000 * r.filter((x) => x > 0).length) / r.length) / 10 : null,
    min: q(0), p10: q(0.1), p25: q(0.25), p75: q(0.75), p90: q(0.9), max: r.length ? Math.round(r[r.length - 1]! * 10) / 10 : null,
    dep2pct: Math.round((dep - 100) * 100) / 100,
  };
}

async function main() {
  const now = Math.floor(Date.now() / M15) * M15;
  const from = now - DAYS * D1;
  ensureDir(OUT); ensureDir(CACHE);
  const listed = ONLY ?? (await usdtSymbols(CACHE)).slice(0, LIMIT);
  const symbols = [...new Set([...HER, ...listed])];
  const errors: Record<string, string> = {};
  const rows: Array<{ symbol: string; e: Entry; exit: string; r: { pct: number; end: number; how: string } | null; up: number }> = [];
  const her: string[] = [];
  let done = 0;
  for (const symbol of symbols) {
    const isHer = HER.includes(symbol);
    try {
      const h4 = await klines(CACHE, symbol, "4h", from - 720 * H4, now);
      const m15 = await klines(CACHE, symbol, "15m", from - 8 * M15, now);
      if (h4.length < 60 || m15.length < 100) { errors[symbol] = "short_history"; if (isHer) her.push(`\n=== ${symbol}: мало истории на BingX (${h4.length} 4H)`); continue; }
      const agg = await cgHistory(CACHE, symbol, "aggfut", from - 720 * H4, now);
      const a4 = withVolume(h4, agg, H4);
      const log: string[] = [];
      const entries: Entry[] = [];
      for (let i = 1; i < h4.length; i++) {
        const c = h4[i]!, prev = h4[i - 1]!, close = c.time + H4;
        if (close > now) break;
        if (close < from || prev.time !== c.time - H4) continue;
        const hist = h4.slice(Math.max(0, i - 699), i + 1);
        // live
        const ev = evaluateNeonRangeBreakout(hist, c.time, close % D1 === 0 ? dailyFrom4h(hist) : undefined);
        if (ev) entries.push({ rule: "live", at: close, entry: c.close, top: ev.level.top, bottom: ev.level.bottom, colour: "-", src: "-" });
        // zone breakout
        const zones = hist.length >= 60 ? computeSupportZones(hist) : [];
        const z = zones.filter((x) => prev.close <= x.top && c.close > x.top).sort((x, y) => y.top - x.top)[0];
        const wa = welkin(a4, i), wb = welkin(h4, i);
        const src: "agg" | "bingx" = agg && wa ? "agg" : "bingx";
        const col = src === "agg" ? wa! : (wb ?? "нет");
        if (z) for (const [name, set] of Object.entries(SETS)) if (set.has(col)) entries.push({ rule: name, at: close, entry: c.close, top: z.top, bottom: z.bottom, colour: col, src });
        if (isHer && close >= HER_FROM && (z || ev))
          log.push(`   ${fmtT(close)} закрытие ${px(c.close)} · ${z ? `выше зоны ${px(z.bottom)}–${px(z.top)}` : "зону не пробила"} · объём агрегат ${wa ?? "нет"}, BingX ${wb ?? "нет"} · сейчас бот: ${ev ? `ДА (${ev.tf})` : "нет"} · M/W: ${z && SETS.zone_MW!.has(col) ? "ДА" : "нет"} · O/M/W: ${z && SETS.zone_OMW!.has(col) ? "ДА" : "нет"} · не серый: ${z && SETS.zone_A!.has(col) ? "ДА" : "нет"}`);
      }
      const trades: string[] = [];
      for (const rule of ["live", ...Object.keys(SETS)]) for (const exit of ["trk", "neon"] as const) {
        let busy = -Infinity;
        for (const e of entries.filter((x) => x.rule === rule).sort((a, b) => a.at - b.at)) {
          if (e.at < busy) continue;
          const r = sim(h4, m15, e, exit, now);
          busy = r ? r.end : e.at + HORIZON;
          let hi = e.entry;
          for (let k = idxAtOrBefore(m15, e.at - 1) + 1; k < m15.length && m15[k]!.time < Math.min(e.at + HORIZON, now); k++) hi = Math.max(hi, m15[k]!.high);
          const up = (hi / e.entry - 1) * 100;
          rows.push({ symbol, e, exit, r, up });
          if (isHer && e.at >= HER_FROM && exit === "neon")
            trades.push(`   ${rule.padEnd(8)} ${fmtT(e.at)} вход ${px(e.entry)} · зона ${px(e.bottom)}–${px(e.top)} · объём ${e.colour} (${e.src}) · макс за 4 дня +${up.toFixed(1)}% · выход как ABNeon: ${r ? `${r.pct >= 0 ? "+" : ""}${r.pct.toFixed(1)}% (${r.how})` : "идёт"}`);
        }
      }
      if (isHer) her.push(`\n=== ${symbol}${agg ? "" : " (нет агрегата CoinGlass — объём BingX)"}\n Закрытия 4H выше зоны:\n${log.join("\n") || "   нет"}\n Сделки:\n${trades.join("\n") || "   нет"}`);
    } catch (err) {
      errors[symbol] = String(err).slice(0, 160);
      if (isHer) her.push(`\n=== ${symbol}: ошибка ${errors[symbol]}`);
    }
    if (++done % 25 === 0) console.error(`монеты ${done}/${symbols.length}, сделок ${rows.length} · CoinGlass ${cgStats.requests} (429: ${cgStats.r429})`);
  }
  const lines: string[] = [];
  for (const rule of ["live", ...Object.keys(SETS)]) for (const exit of ["trk", "neon"]) for (const src of ["все", "agg", "bingx"]) {
    const xs = rows.filter((x) => x.e.rule === rule && x.exit === exit && (src === "все" || x.e.src === src || rule === "live"));
    if (rule === "live" && src !== "все") continue;
    const s = stats(xs.filter((x) => x.r).map((x) => x.r!.pct));
    const pk = xs.length ? Math.round((100 * xs.filter((x) => x.up >= 10).length) / xs.length) : 0;
    lines.push(`${`${rule} · ${exit} · ${src}`.padEnd(26)} | входов ${xs.length} (${(xs.length / DAYS).toFixed(1)}/день) | ср ${s.avg ?? "—"}% сумма ${s.sum}% | в плюсе ${s.win ?? "—"}% | мин ${s.min ?? "—"} p10 ${s.p10 ?? "—"} p25 ${s.p25 ?? "—"} p75 ${s.p75 ?? "—"} p90 ${s.p90 ?? "—"} макс ${s.max ?? "—"} | пик ≥ +10%: ${pk}% | депозит 2%/сделку ${s.dep2pct}%`);
  }
  const summary = `Stealth: сейчас (live) против пробоя зоны на ярком объёме · ${new Date(from).toISOString()} .. ${new Date(now).toISOString()} · монет ${symbols.length}, ошибок ${Object.keys(errors).length}\nВыход trk = стоп −8%, Б.У. +8, трейл +15/10; neon = как новый ABNeon (стоп под зоной, Б.У. +10, трейл +20/20, отмена 4H под зоной). 4 дня, комиссия 0.1%.\nbingx = у монеты нет агрегата CoinGlass, объём BingX.\n\n${lines.join("\n")}\n\nCoinGlass: запросов ${cgStats.requests}, 429: ${cgStats.r429}\nФайлы: her-coins.txt, summary.txt, trades.csv, errors.json`;
  writeFileSync(join(OUT, "summary.txt"), summary + "\n");
  writeFileSync(join(OUT, "her-coins.txt"), `Stealth на твоих монетах с ${fmtT(HER_FROM)} · время — закрытие 4H свечи\nОбъём Welkin: N серый, A синий, Y жёлтый, O оранжевый, M фиолетовый, W белый\n` + her.join("\n") + "\n");
  writeCsv(join(OUT, "trades.csv"), rows.map((x) => ({
    symbol: x.symbol, rule: x.e.rule, exit: x.exit, entry_utc: new Date(x.e.at).toISOString(), entry: x.e.entry, zone_bottom: x.e.bottom, zone_top: x.e.top,
    colour: x.e.colour, volume_source: x.e.src, max_up_4d_pct: Math.round(x.up * 10) / 10, result_pct: x.r ? Math.round(x.r.pct * 100) / 100 : null, how: x.r?.how ?? "open",
  })));
  writeFileSync(join(OUT, "errors.json"), JSON.stringify(errors, null, 1));
  console.log(summary);
}

main().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });
