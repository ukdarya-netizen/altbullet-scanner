/**
 * CAB Bitcoin exit (owner 2026-11-11): tune the BTC trade management on the bot's own BTC signals, by the
 * examples of its good trades. Today (watcher-config / watcher): stop −1% from entry, B.U. once the peak
 * reached +1%, trailing from +2% at 1 p.p. under the peak, 4 days.
 *
 * Entries: every CAB BTC-USDT signal in tracked_signals (production DB, read only; reclassified rows left out),
 * entry = entry_price at detected_at. Candles: BingX BTC-USDT 5m (public API, own cache file), stop checked
 * before the high inside a candle (conservative); fee 0.1% (price %, before the 50× leverage).
 * Variants: stop 1 / 1.5 / 2 / 3 %, B.U. at +1 / +1.5 / +2 / +3 % or none, trailing from +2 / +3 / +4 / +6 %
 * at 1 / 1.5 / 2 / 3 p.p. under the peak; plus 50% closed at +2 / +3 % with the rest on the trailing.
 *
 * Out: summary.txt — the current rule, the variants ranked by the sum (with average, share in profit and
 *      ranges), and every trade: pattern, time, peak and low within 4 days, result now and in the best
 *      variants; trades.csv; variants.csv.
 *
 * Run (from artifacts/api-server; production DB read only):
 *   pnpm dlx tsx scripts/btc-exit-study.ts --out ../../reports/btc-exit
 */
import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { pool } from "@workspace/db";
import { type Row, ensureDir, parseArgs, writeCsv } from "./study-v2/lib.js";

const args = parseArgs();
const OUT = args.get("out") ?? "btc-exit";
const CACHE = args.get("cache") ?? "../../reports/.cache";
const M5 = 5 * 60_000, H1 = 3_600_000, D1 = 24 * H1, HORIZON = 4 * D1, FEE = 0.1;
type C = { time: number; open: number; high: number; low: number; close: number };

async function klines5m(start: number, end: number): Promise<C[]> {
  const file = join(CACHE, "BTC-USDT_5m_btcstudy.json");
  let have: C[] = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : [];
  const byTime = new Map(have.map((c) => [c.time, c]));
  const first = have[0]?.time ?? Infinity, last = have.at(-1)?.time ?? -Infinity;
  const ranges: [number, number][] = [];
  if (start < first) ranges.push([start, Math.min(end, first)]);
  if (end > last + M5) ranges.push([Math.max(start, last + M5), end]);
  for (const [a, b] of ranges) {
    for (let t = a; t < b; t += 1000 * M5) {
      const url = `https://open-api.bingx.com/openApi/swap/v3/quote/klines?symbol=BTC-USDT&interval=5m&startTime=${t}&endTime=${Math.min(b, t + 1000 * M5) - 1}&limit=1000`;
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          const j = (await (await fetch(url)).json()) as { code: number; data?: Record<string, string>[] };
          if (j.code === 0) {
            for (const k of j.data ?? []) byTime.set(Number(k.time), { time: Number(k.time), open: +k.open!, high: +k.high!, low: +k.low!, close: +k.close! });
            break;
          }
        } catch { /* retry */ }
        await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
      }
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  have = [...byTime.values()].sort((x, y) => x.time - y.time);
  writeFileSync(file, JSON.stringify(have));
  return have;
}

type V = { name: string; stop: number; be: number | null; act: number; gap: number; part: { at: number; share: number } | null };
const variants: V[] = [];
for (const stop of [1, 1.5, 2, 3]) for (const be of [1, 1.5, 2, 3, null]) for (const act of [2, 3, 4, 6]) for (const gap of [1, 1.5, 2, 3]) {
  if (be !== null && be > act) continue;
  variants.push({ name: `s${stop}_be${be ?? "-"}_tr${act}g${gap}`, stop, be, act, gap, part: null });
}
for (const stop of [1, 1.5, 2]) for (const at of [2, 3]) for (const act of [3, 4, 6]) for (const gap of [1.5, 2, 3])
  variants.push({ name: `s${stop}_h50@${at}_tr${act}g${gap}`, stop, be: 1, act, gap, part: { at, share: 0.5 } });
const CURRENT = "s1_be1_tr2g1";

function sim(cs: C[], i0: number, at: number, entry: number, v: V, now: number): { pct: number; how: string } | null {
  let stop = entry * (1 - v.stop / 100), peak = entry, part = 0, realised = 0, how = "стоп", partDone = false;
  const close = (price: number, h: string) => ({ pct: realised + (1 - part) * ((price / entry - 1) * 100) - FEE, how: h });
  for (let i = i0; i < cs.length; i++) {
    const c = cs[i]!;
    if (c.time >= at + HORIZON) break;
    if (c.low <= stop) return close(Math.min(stop, c.open), how);
    peak = Math.max(peak, c.high);
    const pp = (peak / entry - 1) * 100;
    if (v.part && !partDone && pp >= v.part.at) { partDone = true; part = v.part.share; realised += v.part.share * v.part.at; }
    if (v.be !== null && pp >= v.be && stop < entry) { stop = entry; how = "безубыток"; }
    if (pp >= v.act) { const ts = entry * (1 + (pp - v.gap) / 100); if (ts > stop) { stop = ts; how = "трейлинг"; } }
  }
  if (at + HORIZON > now) return null;
  let j = i0;
  while (j + 1 < cs.length && cs[j + 1]!.time < at + HORIZON) j++;
  return close(cs[j]!.close, "4 дня");
}

async function main() {
  ensureDir(OUT); ensureDir(CACHE);
  const now = Date.now();
  const sig = await pool.query<{ id: number; sentiment_key: string; detected_at: Date; entry_price: number; status: string; pnl_percent: number | null; stop_loss_pct: number | null; is_short: boolean | null }>(
    `SELECT id, sentiment_key, detected_at, entry_price, status::text AS status, pnl_percent, stop_loss_pct, is_short
       FROM tracked_signals
      WHERE symbol IN ('BTC-USDT', 'BTCUSDT') AND status::text <> 'reclassified' AND entry_price > 0
      ORDER BY detected_at`);
  const rows = sig.rows.filter((r) => r.is_short !== true);
  if (!rows.length) { writeFileSync(join(OUT, "summary.txt"), "BTC-сигналов CAB в базе нет\n"); await pool.end(); return; }
  const cs = await klines5m(new Date(rows[0]!.detected_at).getTime() - D1, now);
  const per: Row[] = [];
  const res = new Map<string, number[]>();
  for (const r of rows) {
    const at = new Date(r.detected_at).getTime(), entry = Number(r.entry_price);
    const i0 = cs.findIndex((c) => c.time + M5 > at);
    if (i0 < 0) continue;
    let hi = entry, lo = entry;
    for (let i = i0; i < cs.length && cs[i]!.time < Math.min(at + HORIZON, now); i++) { hi = Math.max(hi, cs[i]!.high); lo = Math.min(lo, cs[i]!.low); }
    const row: Row = { id: r.id, pattern: r.sentiment_key, detected_utc: new Date(at).toISOString(), entry, status_now: r.status, pnl_tracked: r.pnl_percent, stop_pct_tracked: r.stop_loss_pct,
      peak_4d_pct: Math.round(((hi / entry) - 1) * 1000) / 10, low_4d_pct: Math.round(((lo / entry) - 1) * 1000) / 10 };
    for (const v of variants) {
      const s = sim(cs, i0, at, entry, v, now);
      if (s) { row[v.name] = Math.round(s.pct * 100) / 100; res.set(v.name, [...(res.get(v.name) ?? []), s.pct]); if (v.name === CURRENT) row.how_current = s.how; }
    }
    per.push(row);
  }
  const table: Row[] = variants.map((v) => {
    const xs = [...(res.get(v.name) ?? [])].sort((a, b) => a - b);
    const q = (p: number) => (xs.length ? Math.round(100 * xs[Math.min(xs.length - 1, Math.floor(p * xs.length))]!) / 100 : null);
    const sum = xs.reduce((a, b) => a + b, 0);
    return { variant: v.name, trades: xs.length, sum_pct: Math.round(sum * 100) / 100, avg_pct: xs.length ? Math.round((100 * sum) / xs.length) / 100 : null,
      win_pct: xs.length ? Math.round((1000 * xs.filter((x) => x > 0).length) / xs.length) / 10 : null, min: q(0), p25: q(0.25), p75: q(0.75), max: xs.length ? Math.round(xs[xs.length - 1]! * 100) / 100 : null };
  }).sort((a, b) => Number(b.sum_pct) - Number(a.sum_pct));
  writeCsv(join(OUT, "variants.csv"), table);
  writeCsv(join(OUT, "trades.csv"), per);
  const cur = table.find((t) => t.variant === CURRENT)!;
  const top = table.slice(0, 10);
  const line = (t: Row) => `${String(t.variant).padEnd(24)} | сделок ${t.trades} | сумма ${t.sum_pct}% | ср ${t.avg_pct}% | в плюсе ${t.win_pct}% | мин ${t.min} p25 ${t.p25} p75 ${t.p75} макс ${t.max}`;
  const out = [
    `CAB BTC: выход по сделкам бота · сигналов ${rows.length} (${rows[0]!.detected_at.toISOString()} … ${rows.at(-1)!.detected_at.toISOString()}) · 5m BingX, стоп раньше хая, комиссия 0.1%, % цены (без плеча 50×)`,
    `s = стоп, be = безубыток, tr X gY = трейлинг с +X% на Y п.п. ниже пика, h50@X = 50% на +X%`,
    ``,
    `Сейчас:   ${line(cur)}`,
    ``,
    `Лучшие 10 по сумме:`,
    ...top.map((t) => ` ${line(t)}`),
    ``,
    `Каждая сделка (пик/просадка за 4 дня; итог сейчас и в трёх лучших вариантах):`,
    ...per.map((r) => ` #${r.id} ${String(r.pattern).padEnd(20)} ${r.detected_utc} вход ${r.entry} · пик +${r.peak_4d_pct}% / ${r.low_4d_pct}% · сейчас ${r[CURRENT] ?? "идёт"} (${r.how_current ?? "—"}) · ${top.slice(0, 3).map((t) => `${t.variant} ${r[String(t.variant)] ?? "идёт"}`).join(" · ")}`),
  ];
  writeFileSync(join(OUT, "summary.txt"), out.join("\n") + "\n");
  console.log(out.slice(0, 8).join("\n"));
  await pool.end();
}

main().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });
