/**
 * Owner question 2026-10-29: LC enters at the close of the capitulation 15m
 * candle. Would waiting for one more CLOSED 5m candle be better?
 *
 * Entries: scripts/data/lc-capitulation-entries.json — every LC watch from
 * 14.07 to 24.10 whose detection 15m candle passed the live capitulation rule
 * (range >= 5.6%, body -3.5..-5.5%), 174 rows (reports/full/analysis/lc_entry_timing.py).
 * Candles: public BingX 5m klines from the capitulation close for 72h.
 * Exit as live LC: stop -10%; B.U. once the peak reached +8%; trailing from a
 * +15% peak at 10 pp below the peak; close at 72h. Stop is checked before the
 * high inside a candle (conservative). Fee 0.1% per trade.
 *
 * Variants:
 *  LIVE      enter at the capitulation close (T0)
 *  WAIT5     enter at the close of the first 5m candle after T0, always
 *  WAIT5_NL  same, only if that 5m candle did not go below the capitulation low
 *  WAIT5_G   same, only if that 5m candle is green
 *
 * Run (from artifacts/api-server): npx tsx scripts/lc-wait-5m-replay.ts
 * Needs internet only (BingX public API). Never touches a database.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

type Entry = { id: number; symbol: string; candleOpenMs: number; low: number; close: number; month: string };
type C = { time: number; open: number; high: number; low: number; close: number };

const M5 = 5 * 60 * 1000, M15 = 15 * 60 * 1000, H72 = 72 * 60 * 60 * 1000;
const here = dirname(fileURLToPath(import.meta.url));
const ENTRIES: Entry[] = JSON.parse(readFileSync(join(here, "data/lc-capitulation-entries.json"), "utf8"));

async function klines5m(symbol: string, start: number, end: number): Promise<C[]> {
  const url = `https://open-api.bingx.com/openApi/swap/v3/quote/klines?symbol=${symbol}` +
    `&interval=5m&startTime=${start}&endTime=${end}&limit=1000`;
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(url);
    const j = (await res.json()) as { code: number; data?: Array<Record<string, string>> };
    if (j.code === 0) {
      return (j.data ?? []).map((k) => ({ time: Number(k.time), open: +k.open, high: +k.high, low: +k.low, close: +k.close }))
        .filter((c) => c.time >= start && c.time + M5 <= end).sort((a, b) => a.time - b.time);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`klines ${symbol}: failed`);
}

function lcExit(cs: C[], e: number): { r: number; peak: number } {
  let stop = e * 0.9, peak = e;
  for (const c of cs) {
    if (c.low <= stop) return { r: (stop / e - 1) * 100 - 0.1, peak: (peak / e - 1) * 100 };
    peak = Math.max(peak, c.high);
    const pp = (peak / e - 1) * 100;
    if (pp >= 8) stop = Math.max(stop, e);
    if (pp >= 15) stop = Math.max(stop, e * (1 + (pp - 10) / 100));
  }
  return { r: (cs[cs.length - 1]!.close / e - 1) * 100 - 0.1, peak: (peak / e - 1) * 100 };
}

type Res = { id: number; month: string; r: number; peak: number };
const V: Record<string, Res[]> = { LIVE: [], WAIT5: [], WAIT5_NL: [], WAIT5_G: [] };
const failed: string[] = [];

async function main() {
  for (const e of ENTRIES) {
    const t0 = e.candleOpenMs + M15;
    let cs: C[];
    try { cs = await klines5m(e.symbol, t0, t0 + H72 + M5); } catch { failed.push(`${e.id} ${e.symbol}`); continue; }
    if (cs.length < 800 || cs[0]!.time !== t0) { failed.push(`${e.id} ${e.symbol} candles=${cs.length}`); continue; }
    const live = lcExit(cs, e.close);
    V.LIVE!.push({ id: e.id, month: e.month, ...live });
    const first = cs[0]!;
    const rest = cs.slice(1);
    const w = lcExit(rest, first.close);
    V.WAIT5!.push({ id: e.id, month: e.month, ...w });
    if (first.low >= e.low) V.WAIT5_NL!.push({ id: e.id, month: e.month, ...w });
    if (first.close > first.open) V.WAIT5_G!.push({ id: e.id, month: e.month, ...w });
    await new Promise((r) => setTimeout(r, 150));
  }
  const live = new Map(V.LIVE!.map((x) => [x.id, x.r]));
  console.log(`entries ${ENTRIES.length}, replayed ${V.LIVE!.length}, failed ${failed.length}${failed.length ? ": " + failed.join("; ") : ""}`);
  for (const [name, xs] of Object.entries(V)) {
    const n = xs.length; if (!n) { console.log(name, "n=0"); continue; }
    const sum = xs.reduce((s, x) => s + x.r, 0);
    const liveSame = xs.reduce((s, x) => s + (live.get(x.id) ?? 0), 0);
    const by = new Map<string, number[]>();
    for (const x of xs) by.set(x.month, [...(by.get(x.month) ?? []), x.r]);
    console.log(`${name.padEnd(9)} n=${n} sum=${sum.toFixed(0)}% avg=${(sum / n).toFixed(2)}% ` +
      `peak>=10%=${(100 * xs.filter((x) => x.peak >= 10).length / n).toFixed(0)}% stops=${xs.filter((x) => x.r <= -9).length} ` +
      `| LIVE on the same trades=${liveSame.toFixed(0)}% | ` +
      [...by.entries()].sort().map(([m, v]) => `${m}:${v.reduce((a, b) => a + b, 0).toFixed(0)}(${v.length})`).join(" "));
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
