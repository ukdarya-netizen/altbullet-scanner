/**
 * LC: which entry catches the champions the capitulation candle misses (owner 2026-11-12: "we lost many
 * champions to the capitulation candle — the filter has to change"). Universe: every LC watch in
 * liq_cascade_watch (14.07 → now, ~11k). For each watch every entry below is tried inside the watch window
 * (72 h after the detection) on BingX 15m candles; nothing from the future is used for the entry.
 *
 *   A           entry at the detection (no filter; the reference)
 *   CAP_LIVE    live rule: first 15m candle with range ≥ 5.6% and body −3.5 … −5.5%
 *   CAP_DEEP    the same without the −5.5% floor: range ≥ 5.6%, body ≤ −3.5%
 *   CAP_2       softer red candle: range ≥ 3%, body ≤ −2%
 *   HAMMER      15m candle with lower wick ≥ 2 × body, range ≥ 2.5%, close in the upper half
 *   RECLAIM_15  first 15m close above the high of the detection candle
 *   RECLAIM_1H  first 1h close above the high of the detection candle
 *   BOUNCE_3    first 15m close ≥ 3% above the lowest low since the detection
 *   BOUNCE_5    first 15m close ≥ 5% above the lowest low since the detection
 *   BOS_1H      after the lowest low since the detection: first 1h close above the previous 1h candle's high
 *
 * champion = +10% before −8% from the entry; result = LC exit (stop −8%, B.U. at +8%, trailing from +15% at
 * 10 p.p., 4 days, fee 0.1%). One trade per coin per entry candle (overlapping watches of a coin are merged).
 *
 * Out: summary.txt — per entry: trades, champions (count and %), average / sum of the result, % in profit,
 *      the result by month, how many of A's champions it catches (and how many A-losers it takes);
 *      the A-champions by name with what every entry did. trades.csv — every trade.
 *
 * No database connection. Input: the same watches.json as lc-watch-study (SELECT * FROM liq_cascade_watch).
 * Run (from artifacts/api-server; BingX candles via the study cache, already filled by lc-watch-study):
 *   pnpm dlx tsx scripts/lc-entry-variants-study.ts --watches watches.json --out ../../reports/lc-entry-variants
 */
import { join } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { type C, type Row, D1, H1, M15, ensureDir, idxAtOrBefore, klines, parseArgs, writeCsv } from "./study-v2/lib.js";

const args = parseArgs();
const OUT = args.get("out") ?? "lc-entry-variants";
const CACHE = args.get("cache") ?? "../../reports/.cache";
const FILE = args.get("watches");
const HORIZON = 4 * D1, WINDOW = 3 * D1;
const parseT = (v: unknown) => { const s = String(v); return Date.parse(/[zZ]|[+-]\d\d(:?\d\d)?$/.test(s) ? s : `${s.replace(" ", "T")}Z`); };

type T = { entry: number; at: number; peak: number; champion: boolean | null; result: number | null; how: string };
function trade(m15: C[], i0: number, now: number): T {
  const entry = m15[i0]!.close, at = m15[i0]!.time + M15;
  let peak = entry, stop = entry * 0.92, how = "стоп", champion: boolean | null = null, res: number | null = null;
  for (let i = i0 + 1; i < m15.length; i++) {
    const c = m15[i]!;
    if (c.time >= at + HORIZON || c.time > now) break;
    if (champion === null && c.low <= entry * 0.92) champion = false;
    if (c.low <= stop) { res = (Math.min(stop, c.open) / entry - 1) * 100 - 0.1; break; }
    peak = Math.max(peak, c.high);
    if (champion === null && peak >= entry * 1.1) champion = true;
    const pp = (peak / entry - 1) * 100;
    if (pp >= 8 && stop < entry) { stop = entry; how = "безубыток"; }
    if (pp >= 15) { const ts = entry * (1 + (pp - 10) / 100); if (ts > stop) { stop = ts; how = "трейлинг"; } }
  }
  if (res === null) {
    if (at + HORIZON > now) return { entry, at, peak: (peak / entry - 1) * 100, champion, result: null, how: "идёт" };
    const j = idxAtOrBefore(m15, at + HORIZON - M15);
    res = (m15[j]!.close / entry - 1) * 100 - 0.1; how = "4 дня";
  }
  return { entry, at, peak: (peak / entry - 1) * 100, champion: champion ?? false, result: res, how };
}

const ENTRIES = ["A", "CAP_LIVE", "CAP_DEEP", "CAP_2", "HAMMER", "RECLAIM_15", "RECLAIM_1H", "BOUNCE_3", "BOUNCE_5", "BOS_1H"] as const;
type E = (typeof ENTRIES)[number];

/** Index of the 15m candle at whose close the entry is taken, or -1. iA = first 15m candle closing at / after the detection. */
function findEntry(e: E, m15: C[], iA: number, iDet: number, det: number, now: number): number {
  const end = (k: number) => k >= m15.length || m15[k]!.time >= det + WINDOW || m15[k]!.time + M15 > now;
  const pct = (a: number, b: number) => ((a - b) / b) * 100;
  if (e === "A") return iA;
  const detHigh = iDet >= 0 ? m15[iDet]!.high : m15[iA]!.high;
  let low = Infinity;
  for (let k = iA; !end(k); k++) {
    const c = m15[k]!;
    if (c.low < low) low = c.low;
    const body = pct(c.close, c.open);
    const rangePct = ((c.high - c.low) / c.open) * 100;
    switch (e) {
      case "CAP_LIVE": if (rangePct >= 5.6 && body <= -3.5 && body >= -5.5) return k; break;
      case "CAP_DEEP": if (rangePct >= 5.6 && body <= -3.5) return k; break;
      case "CAP_2": if (rangePct >= 3 && body <= -2) return k; break;
      case "HAMMER": {
        const bodyAbs = Math.abs(c.close - c.open), lower = Math.min(c.open, c.close) - c.low;
        if (rangePct >= 2.5 && lower >= 2 * bodyAbs && c.close >= (c.high + c.low) / 2) return k;
        break;
      }
      case "RECLAIM_15": if (c.close > detHigh) return k; break;
      case "RECLAIM_1H": if ((c.time + M15) % H1 === 0 && c.close > detHigh) return k; break;
      case "BOUNCE_3": if (pct(c.close, low) >= 3) return k; break;
      case "BOUNCE_5": if (pct(c.close, low) >= 5) return k; break;
      case "BOS_1H": {
        // on an hour close: this hour (m15[k-3..k]) closes above the previous hour's high (m15[k-7..k-4])
        if ((c.time + M15) % H1 !== 0 || k - 7 < 0) break;
        let prevHigh = -Infinity;
        for (let q = k - 7; q <= k - 4; q++) prevHigh = Math.max(prevHigh, m15[q]!.high);
        if (c.close > prevHigh) return k;
        break;
      }
    }
  }
  return -1;
}

async function main() {
  if (!FILE) throw new Error("--watches <json file> is required");
  ensureDir(OUT); ensureDir(CACHE);
  const now = Date.now();
  const watches = (JSON.parse(readFileSync(FILE, "utf8")) as Record<string, unknown>[]).filter((w) => Number.isFinite(parseT(w.detected_at)));
  const bySym = new Map<string, Record<string, unknown>[]>();
  for (const w of watches) bySym.set(String(w.symbol), [...(bySym.get(String(w.symbol)) ?? []), w]);
  const trades: Row[] = [];
  const perWatch = new Map<number, Partial<Record<E, T | null>>>();
  const watchInfo = new Map<number, { symbol: string; det: number; fired: boolean }>();
  let done = 0;
  for (const [symbol, ws] of bySym) {
    const first = Math.min(...ws.map((w) => parseT(w.detected_at)));
    const m15 = await klines(CACHE, symbol, "15m", first - 2 * D1, now).catch(() => [] as C[]);
    const seen = new Map<E, Set<number>>(ENTRIES.map((e) => [e, new Set<number>()]));
    for (const w of ws) {
      const det = parseT(w.detected_at), id = Number(w.id);
      watchInfo.set(id, { symbol, det, fired: w.signal_id != null });
      const iA = m15.findIndex((c) => c.time + M15 >= det);
      if (iA < 0 || m15[iA]!.time >= det + H1) continue;
      const iDet = idxAtOrBefore(m15, det - M15);
      const res: Partial<Record<E, T | null>> = {};
      for (const e of ENTRIES) {
        const k = findEntry(e, m15, iA, iDet, det, now);
        if (k < 0) { res[e] = null; continue; }
        const t = trade(m15, k, now);
        res[e] = t;
        if (seen.get(e)!.has(k)) continue; // the same entry candle from an overlapping watch of this coin
        seen.get(e)!.add(k);
        trades.push({ entry_kind: e, symbol, watch_id: id, detected_utc: new Date(det).toISOString(), entry_utc: new Date(t.at).toISOString(),
          wait_h: Math.round(((t.at - det) / H1) * 10) / 10, peak: Math.round(t.peak * 10) / 10,
          champion: t.champion === null ? null : t.champion ? 1 : 0, result: t.result === null ? null : Math.round(t.result * 100) / 100, how: t.how });
      }
      perWatch.set(id, res);
    }
    if (++done % 50 === 0) console.error(`монеты ${done}/${bySym.size}, сделок ${trades.length}`);
  }
  writeCsv(join(OUT, "trades.csv"), trades);

  const r2 = (x: number) => Math.round(x * 100) / 100;
  const out: string[] = [
    `LC: какой вход ловит чемпионов · наблюдений ${watches.length}, монет ${bySym.size}`,
    `чемп = +10% раньше −8% от входа; итог = выход LC (стоп −8%, Б.У. +8, трейл +15/10, 4 дня, комиссия 0.1%). Одна сделка на монету на свечу входа.`,
    `«ловит чемп. A» — из чемпионов входа на обнаружении (A) сколько этот вход тоже взял и сколько из них у него самого стали чемпионами.`,
    ``,
  ];
  const aChamps = [...perWatch.entries()].filter(([, r]) => r.A?.champion === true);
  const aLosers = [...perWatch.entries()].filter(([, r]) => r.A?.champion === false);
  for (const e of ENTRIES) {
    const ts = trades.filter((t) => t.entry_kind === e);
    const closed = ts.filter((t) => typeof t.result === "number");
    const res = closed.map((t) => t.result as number);
    const ch = ts.filter((t) => t.champion === 1).length, chKnown = ts.filter((t) => t.champion === 0 || t.champion === 1).length;
    const months = new Map<string, number[]>();
    for (const t of closed) { const m = String(t.entry_utc).slice(0, 7); months.set(m, [...(months.get(m) ?? []), t.result as number]); }
    const caught = aChamps.filter(([, r]) => r[e]).length, caughtCh = aChamps.filter(([, r]) => r[e]?.champion === true).length;
    const tookLos = aLosers.filter(([, r]) => r[e]).length;
    const waits = ts.map((t) => Number(t.wait_h)).sort((a, b) => a - b);
    out.push(`${e}: сделок ${ts.length} · чемп ${ch} (${chKnown ? Math.round((100 * ch) / chKnown) : "—"}%) · ср ${res.length ? r2(res.reduce((a, b) => a + b, 0) / res.length) : "—"}% · сумма ${r2(res.reduce((a, b) => a + b, 0))}% · в плюсе ${res.length ? Math.round((100 * res.filter((x) => x > 0).length) / res.length) : "—"}%`);
    out.push(`   ловит чемп. A: ${caught} из ${aChamps.length} (у него чемп ${caughtCh}) · берёт A-неудачных: ${tookLos} из ${aLosers.length} · ожидание входа ${waits.length ? `${waits[0]}…${waits.at(-1)} ч` : "—"}`);
    out.push(`   по месяцам: ${[...months.entries()].sort().map(([m, xs]) => `${m} n${xs.length} ${r2(xs.reduce((a, b) => a + b, 0) / xs.length)}%`).join(" · ")}`);
  }
  out.push(``, `Чемпионы A по имени (лучшие 80 по пику A): что сделал каждый вход (итог %, * = чемпион у этого входа, — = входа не было):`);
  const named = aChamps.map(([id, r]) => ({ id, r, info: watchInfo.get(id)! })).sort((a, b) => (b.r.A?.peak ?? 0) - (a.r.A?.peak ?? 0));
  for (const { id, r, info } of named.slice(0, 80)) {
    const cells = ENTRIES.map((e) => { const t = r[e]; return `${e} ${t ? `${t.result === null ? "идёт" : r2(t.result)}${t.champion ? "*" : ""}` : "—"}`; });
    out.push(`  ${info.symbol.padEnd(16)} ${new Date(info.det).toISOString().slice(0, 16)} #${id}${info.fired ? " (LC сработал)" : ""} пик A +${r2(r.A!.peak)}% · ${cells.join(" · ")}`);
  }
  writeFileSync(join(OUT, "summary.txt"), out.join("\n") + "\n");
  console.log(out.slice(0, 4 + ENTRIES.length * 3).join("\n"));
}

main().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });
