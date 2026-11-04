/**
 * Owner 2026-10-29: how fast does each pattern play out ("от и до" for the
 * Telegram signal and the dashboard pattern reference)?
 *
 * Input: CSV of closed tracked rows exported from production (columns:
 * id, symbol, sentiment_key, status, entry_price, pnl_percent, detected_at,
 * closed_at). Candles: public BingX 15m klines from detected_at to closed_at
 * (the life of the trade). Never touches a database.
 *
 * Per trade: hours from entry to +5%, +8%, +10% (first 15m candle whose high
 * reaches it), hours to the peak of the trade, peak %, hours to close.
 * Per pattern: n, how many reached each level, and p25 / median / p75 of the
 * hours for the trades that reached it. "От и до" = p25..p75 of the hours to
 * the peak among trades that reached +8% (the move a subscriber waits for).
 *
 * Run (from artifacts/api-server): tsx scripts/pattern-speed.ts <csv>
 */
import { readFileSync } from "node:fs";

const M15 = 15 * 60 * 1000;
type C = { time: number; high: number };

function parseCsv(text: string): Record<string, string>[] {
  const lines = text.trim().split(/\r?\n/);
  const split = (l: string) => {
    const out: string[] = []; let cur = "", q = false;
    for (const ch of l) {
      if (ch === '"') q = !q;
      else if (ch === "," && !q) { out.push(cur); cur = ""; }
      else cur += ch;
    }
    out.push(cur); return out;
  };
  const head = split(lines[0]!);
  return lines.slice(1).map((l) => Object.fromEntries(split(l).map((v, i) => [head[i]!, v])));
}
const utc = (s: string) => Date.parse(s.includes("T") ? s : s.replace(" ", "T") + "Z");

async function klines15m(symbol: string, start: number, end: number): Promise<C[]> {
  const out = new Map<number, C>();
  for (let cur = start; cur < end; cur += M15 * 1000) {
    const url = `https://open-api.bingx.com/openApi/swap/v3/quote/klines?symbol=${symbol}` +
      `&interval=15m&startTime=${cur}&endTime=${Math.min(end, cur + M15 * 1000)}&limit=1000`;
    const j = (await (await fetch(url)).json()) as { code: number; data?: Array<Record<string, string>> };
    if (j.code !== 0) throw new Error(`code ${j.code}`);
    for (const k of j.data ?? []) out.set(Number(k.time), { time: Number(k.time), high: +k.high });
  }
  return [...out.values()].filter((c) => c.time >= start && c.time < end).sort((a, b) => a.time - b.time);
}

function q(xs: number[], p: number): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1) + 0.5))]!;
}
const fmt = (h: number) => (h < 1 ? `${Math.round(h * 60)}м` : h < 48 ? `${h.toFixed(1)}ч` : `${(h / 24).toFixed(1)}д`);

async function main() {
  const file = process.argv[2];
  if (!file) throw new Error("usage: tsx scripts/pattern-speed.ts <csv>");
  const rows = parseCsv(readFileSync(file, "utf8"));
  type R = { key: string; to5: number | null; to8: number | null; to10: number | null; toPeak: number; peak: number; life: number };
  const res: R[] = [];
  const failed: string[] = [];
  console.log("id,symbol,sentiment_key,status,pnl,peak_pct,h_to_5,h_to_8,h_to_10,h_to_peak,h_life,candles");
  for (const r of rows) {
    const entry = Number(r.entry_price), t0 = utc(r.detected_at!), t1 = utc(r.closed_at!);
    if (!(entry > 0) || !(t1 > t0)) { failed.push(`${r.id} bad_row`); continue; }
    let cs: C[];
    try { cs = await klines15m(r.symbol!, Math.floor(t0 / M15) * M15, t1); } catch (e) { failed.push(`${r.id} ${r.symbol} ${String(e).slice(0, 30)}`); continue; }
    if (!cs.length) { failed.push(`${r.id} ${r.symbol} no_candles`); continue; }
    const h = (t: number) => Math.max(0, (t + M15 - t0) / 3.6e6);
    let to5: number | null = null, to8: number | null = null, to10: number | null = null, peak = -Infinity, toPeak = 0;
    for (const c of cs) {
      const p = (c.high / entry - 1) * 100;
      if (to5 === null && p >= 5) to5 = h(c.time);
      if (to8 === null && p >= 8) to8 = h(c.time);
      if (to10 === null && p >= 10) to10 = h(c.time);
      if (p > peak) { peak = p; toPeak = h(c.time); }
    }
    const life = (t1 - t0) / 3.6e6;
    res.push({ key: r.sentiment_key!, to5, to8, to10, toPeak, peak, life });
    console.log([r.id, r.symbol, r.sentiment_key, r.status, r.pnl_percent, peak.toFixed(2), to5?.toFixed(2) ?? "", to8?.toFixed(2) ?? "",
      to10?.toFixed(2) ?? "", toPeak.toFixed(2), life.toFixed(2), cs.length].join(","));
    await new Promise((x) => setTimeout(x, 120));
  }
  console.log(`\nrows ${rows.length}, replayed ${res.length}, failed ${failed.length}${failed.length ? ": " + failed.join("; ") : ""}`);
  console.log("SUMMARY per pattern: hours from entry, p25 / median / p75 (n reached)");
  for (const key of [...new Set(res.map((x) => x.key))].sort()) {
    const xs = res.filter((x) => x.key === key);
    const line = (name: string, v: number[]) => v.length ? `${name} ${fmt(q(v, 0.25))} / ${fmt(q(v, 0.5))} / ${fmt(q(v, 0.75))} (${v.length})` : `${name} - (0)`;
    const got = (k: "to5" | "to8" | "to10") => xs.map((x) => x[k]).filter((v): v is number => v !== null);
    const peak8 = xs.filter((x) => x.to8 !== null).map((x) => x.toPeak);
    console.log(`${key}: n=${xs.length} | ${line("to +5%", got("to5"))} | ${line("to +8%", got("to8"))} | ${line("to +10%", got("to10"))} | ` +
      `${line("to peak (trades >= +8%)", peak8)} | ${line("trade life", xs.map((x) => x.life))}`);
    if (peak8.length) console.log(`   ОТ И ДО (peak, trades >= +8%): от ${fmt(q(peak8, 0.25))} до ${fmt(q(peak8, 0.75))}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
