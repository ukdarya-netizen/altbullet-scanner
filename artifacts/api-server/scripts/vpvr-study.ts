/**
 * VPVR (volume profile) at the entry of ABNeon and Stealth (owner 2026-11-11): does the volume profile separate
 * good entries from bad ones? History-checkable: the profile is built from candles and aggregated volume.
 *
 * Entries: the trades of the latest checks (no detector re-run) —
 *   ABNeon:  reports/abneon-live-check-3/trades.csv   (zone / low bounce, exit as the new ABNeon)
 *   Stealth: reports/stealth-her-check/trades.csv      (rule zone_MW = the new Stealth; exits trk and neon)
 * Profile at each entry, nothing from the future: the 30 days of closed 1H BingX candles before the entry,
 * CoinGlass aggregated futures volume (USD) of each hour spread evenly over that candle's low…high, 120 price
 * bins across the 30-day low…high. Value area = 70% of the volume around the POC.
 * Readings (all relative to the entry price):
 *   poc_dist_pct     (POC / entry − 1)·100: >0 POC above the entry
 *   in_value_area    entry inside VAL…VAH
 *   vah_dist_pct / val_dist_pct
 *   above5 / above10 share of the 30-day volume within +5% / +10% above the entry (overhead supply)
 *   below5 / below10 share within −5% / −10% under the entry (support underneath)
 *   above_below10    above10 / below10
 *   entry_bin_pctile how heavy the entry's own price bin is among all bins (0…100)
 * No aggregated volume for >10% of the hours = no reading.
 *
 * Out: readings.csv (every entry with its readings and result), summary.txt — per pattern and exit, for each
 * reading: five equal groups (quintiles) by value with the range, entries, average result, share in profit,
 * share that peaked ≥ +10%; plus the owner's coins listed.
 *
 * Run (from artifacts/api-server; reuses the study cache — keep it fresh enough):
 *   STUDY_CG_RPM=30 STUDY_CG_MAXAGE_H=48 pnpm dlx tsx scripts/vpvr-study.ts --out ../../reports/vpvr-study
 */
import { join } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { cgHistory, cgStats } from "./study-v2/cg.js";
import { type C, type Row, D1, H1, ensureDir, idxAtOrBefore, klines, parseArgs, writeCsv } from "./study-v2/lib.js";

const args = parseArgs();
const OUT = args.get("out") ?? "vpvr-study";
const CACHE = args.get("cache") ?? "../../reports/.cache";
const ABNEON_CSV = args.get("abneon") ?? "../../reports/abneon-live-check-3/trades.csv";
const STEALTH_CSV = args.get("stealth") ?? "../../reports/stealth-her-check/trades.csv";
const HER = new Set((args.get("her") ?? "ELSA,INIT,PIEVERSE,EDGEX,KNOTS,GANG,SI,IRYS,LYN,BLESS").split(",").map((s) => `${s}-USDT`));
const LOOKBACK = 30 * D1;
const BINS = 120;

function parseCsv(file: string): Record<string, string>[] {
  const lines = readFileSync(file, "utf8").trim().split("\n");
  const head = lines[0]!.split(",");
  return lines.slice(1).map((l) => {
    const v = l.split(",");
    return Object.fromEntries(head.map((h, i) => [h, v[i] ?? ""]));
  });
}

type Entry = { pattern: string; exit: string; symbol: string; at: number; entry: number; result: number | null; peak: number };

function profile(h1: C[], agg: Map<number, { buy: number; sell: number }>, at: number, entry: number): Row | null {
  const j1 = idxAtOrBefore(h1, at - H1);
  if (j1 < 0) return null;
  const bars: { lo: number; hi: number; usd: number }[] = [];
  let missing = 0, total = 0;
  for (let i = j1; i >= 0 && h1[i]!.time >= at - LOOKBACK; i--) {
    const c = h1[i]!;
    if (c.time + H1 > at) continue;
    total++;
    const v = agg.get(c.time);
    if (!v) { missing++; continue; }
    const usd = v.buy + v.sell;
    if (usd > 0 && c.high >= c.low && c.low > 0) bars.push({ lo: c.low, hi: c.high, usd });
  }
  if (total < 24 * 20 || missing > 0.1 * total || bars.length === 0) return null;
  const lo = Math.min(...bars.map((b) => b.lo)), hi = Math.max(...bars.map((b) => b.hi));
  if (!(hi > lo)) return null;
  const w = (hi - lo) / BINS;
  const vol = new Array<number>(BINS).fill(0);
  const binOf = (p: number) => Math.min(BINS - 1, Math.max(0, Math.floor((p - lo) / w)));
  for (const b of bars) {
    const a = binOf(b.lo), z = binOf(b.hi);
    for (let k = a; k <= z; k++) vol[k]! += b.usd / (z - a + 1);
  }
  const sum = vol.reduce((x, y) => x + y, 0);
  let poc = 0;
  for (let k = 1; k < BINS; k++) if (vol[k]! > vol[poc]!) poc = k;
  let a = poc, z = poc, acc = vol[poc]!;
  while (acc < 0.7 * sum && (a > 0 || z < BINS - 1)) {
    const left = a > 0 ? vol[a - 1]! : -1, right = z < BINS - 1 ? vol[z + 1]! : -1;
    if (right >= left) { z++; acc += vol[z]!; } else { a--; acc += vol[a]!; }
  }
  const mid = (k: number) => lo + (k + 0.5) * w;
  const val = lo + a * w, vah = lo + (z + 1) * w;
  const share = (p1: number, p2: number) => {
    let s = 0;
    for (let k = 0; k < BINS; k++) { const m = mid(k); if (m >= p1 && m <= p2) s += vol[k]!; }
    return (100 * s) / sum;
  };
  const eb = binOf(entry);
  const pctile = (100 * vol.filter((x) => x < vol[eb]!).length) / BINS;
  const r = (x: number) => Math.round(x * 100) / 100;
  const above10 = share(entry, entry * 1.1), below10 = share(entry * 0.9, entry);
  return {
    poc_dist_pct: r((mid(poc) / entry - 1) * 100),
    in_value_area: entry >= val && entry <= vah ? 1 : 0,
    vah_dist_pct: r((vah / entry - 1) * 100),
    val_dist_pct: r((val / entry - 1) * 100),
    above5: r(share(entry, entry * 1.05)),
    above10: r(above10),
    below5: r(share(entry * 0.95, entry)),
    below10: r(below10),
    above_below10: below10 > 0 ? r(above10 / below10) : null,
    entry_bin_pctile: r(pctile),
  };
}

const READINGS = ["poc_dist_pct", "in_value_area", "vah_dist_pct", "val_dist_pct", "above5", "above10", "below5", "below10", "above_below10", "entry_bin_pctile"];

async function main() {
  ensureDir(OUT); ensureDir(CACHE);
  const entries: Entry[] = [];
  for (const r of parseCsv(ABNEON_CSV))
    entries.push({ pattern: r.kind === "low" ? "abneon_low" : "abneon_zone", exit: "neon", symbol: r.symbol!, at: Date.parse(r.entry_utc!), entry: Number(r.entry), result: r.result_pct ? Number(r.result_pct) : null, peak: Number(r.max_up_4d_pct) });
  for (const r of parseCsv(STEALTH_CSV)) {
    if (r.rule !== "zone_MW" && r.rule !== "live") continue;
    entries.push({ pattern: r.rule === "live" ? "stealth_old" : "stealth_new", exit: r.exit!, symbol: r.symbol!, at: Date.parse(r.entry_utc!), entry: Number(r.entry), result: r.result_pct ? Number(r.result_pct) : null, peak: Number(r.max_up_4d_pct) });
  }
  const bySymbol = new Map<string, Entry[]>();
  for (const e of entries) bySymbol.set(e.symbol, [...(bySymbol.get(e.symbol) ?? []), e]);
  const rows: Row[] = [];
  const errors: Record<string, string> = {};
  let done = 0;
  for (const [symbol, es] of bySymbol) {
    try {
      const first = Math.min(...es.map((e) => e.at)), last = Math.max(...es.map((e) => e.at));
      const h1 = await klines(CACHE, symbol, "1h", first - LOOKBACK - D1, last);
      const agg = await cgHistory(CACHE, symbol, "aggfut", first - LOOKBACK - D1, Date.now());
      for (const e of es) {
        const p = agg ? profile(h1, agg, e.at, e.entry) : null;
        rows.push({ pattern: e.pattern, exit: e.exit, symbol, entry_utc: new Date(e.at).toISOString(), entry: e.entry, result_pct: e.result, max_up_4d_pct: e.peak, ...(p ?? { no_reading: agg ? "short_or_missing_volume" : "no_aggregated_volume" }) });
      }
    } catch (err) {
      errors[symbol] = String(err).slice(0, 160);
    }
    if (++done % 50 === 0) console.error(`монеты ${done}/${bySymbol.size} · CoinGlass ${cgStats.requests} (429: ${cgStats.r429})`);
  }
  writeCsv(join(OUT, "readings.csv"), rows);
  const out: string[] = [
    `VPVR на входе ABNeon и Stealth · профиль за 30 дней до входа (1H, агрегированный объём фьючерсов) · входов ${rows.length}, монет ${bySymbol.size}, ошибок ${Object.keys(errors).length}`,
    `Для каждого показателя: 5 равных групп по значению (диапазон), входов, средний итог, % в плюсе, % дошедших до +10%.`,
    `abneon_* — выход как новый ABNeon; stealth_new = пробой зоны на M/W (новый Stealth), stealth_old = прежний; exit trk / neon.`,
  ];
  const groups = [...new Set(rows.map((r) => `${r.pattern}|${r.exit}`))].sort();
  for (const g of groups) {
    const [pattern, exit] = g.split("|");
    const rs = rows.filter((r) => r.pattern === pattern && r.exit === exit && r.result_pct != null && r.poc_dist_pct != null);
    const all = rows.filter((r) => r.pattern === pattern && r.exit === exit);
    const avg = (xs: Row[]) => (xs.length ? Math.round((100 * xs.reduce((s, r) => s + Number(r.result_pct), 0)) / xs.length) / 100 : null);
    out.push(`\n=== ${pattern} · выход ${exit} · входов ${all.length}, с профилем и итогом ${rs.length} · ср ${avg(rs)}%`);
    for (const key of READINGS) {
      const vals = rs.filter((r) => r[key] != null).sort((a, b) => Number(a[key]) - Number(b[key]));
      if (vals.length < 25) continue;
      const parts: string[] = [];
      for (let q = 0; q < 5; q++) {
        const sl = vals.slice(Math.floor((q * vals.length) / 5), Math.floor(((q + 1) * vals.length) / 5));
        if (!sl.length) continue;
        const win = Math.round((100 * sl.filter((r) => Number(r.result_pct) > 0).length) / sl.length);
        const pk = Math.round((100 * sl.filter((r) => Number(r.max_up_4d_pct) >= 10).length) / sl.length);
        parts.push(`[${sl[0]![key]}…${sl[sl.length - 1]![key]}] n${sl.length} ср ${avg(sl)}% плюс ${win}% пик≥10 ${pk}%`);
      }
      out.push(` ${key.padEnd(16)} ${parts.join(" | ")}`);
    }
  }
  out.push(`\n=== Твои монеты (с 28.10)`);
  for (const r of rows.filter((x) => HER.has(String(x.symbol)) && Date.parse(String(x.entry_utc)) >= Date.parse("2026-10-28T00:00:00Z") && (x.exit === "neon" || x.pattern !== "stealth_old")))
    out.push(` ${String(r.symbol).padEnd(14)} ${r.pattern}/${r.exit} ${r.entry_utc} итог ${r.result_pct ?? "идёт"} пик +${r.max_up_4d_pct} · POC ${r.poc_dist_pct ?? "—"}% · в зоне стоимости ${r.in_value_area ?? "—"} · над +10% ${r.above10 ?? "—"}% · под −10% ${r.below10 ?? "—"}% · вес цены входа ${r.entry_bin_pctile ?? "—"}`);
  out.push(`\nCoinGlass: запросов ${cgStats.requests}, 429: ${cgStats.r429} · ошибки: ${JSON.stringify(errors)}`);
  writeFileSync(join(OUT, "summary.txt"), out.join("\n") + "\n");
  console.log(out.slice(0, 3).join("\n"));
}

main().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });
