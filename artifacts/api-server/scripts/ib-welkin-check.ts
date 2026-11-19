/**
 * IB: the 30m signal candle on Welkin (20 bars only) vs Lucy's VSA (20 bars + grey under the 120-bar average)
 * (owner 2026-11-19: «а если смотреть VSA не за 120 свечей как у Люси, а за 20, как у старого Welkin?»). Read-only.
 * Every IB signal in reports/ib-review-1118 and reports/ib-review-1119 (signals.jsonl): the signal candle (the one the
 * bot judged), aggregated futures + spot USD from CoinGlass 15m (two halves → 30m), Welkin and Lucy colours, and the
 * same for the 3 candles before it; plus Welkin on BingX's own volume (one exchange, as the Welkin indicator on a
 * BingX chart). CoinGlass data from the studies' cache (already final), fetched only if missing.
 * Run: STUDY_CG_MAXAGE_H=10000 pnpm dlx tsx scripts/ib-welkin-check.ts
 * Output: reports/ib-welkin-1119/welkin.csv
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { lucyColour, welkinColour, LUCY_LONG_BARS } from "../src/lib/abneon-volume-gate.js";
import { cgHistoryTf } from "./study-v2/cg.js";
import { ensureDir, klines, writeCsv, type Row } from "./study-v2/lib.js";

const CACHE = "../../reports/.cache";
const OUT = "../../reports/ib-welkin-1119";
const M15 = 900_000, M30 = 1_800_000, D1 = 86_400_000;

const jsonl = (f: string) => (existsSync(f) ? readFileSync(f, "utf8").split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l) as Record<string, unknown>) : []);
const parse = (v: unknown) => (typeof v === "string" ? (() => { try { return JSON.parse(v); } catch { return v; } })() : v);
const time = (v: unknown): number | null => {
  if (typeof v !== "string" && typeof v !== "number") return null;
  const s = typeof v === "string" && !/[zZ]|[+-]\d\d:?\d\d$/.test(v) ? `${v.replace(" ", "T")}Z` : v;
  const t = typeof s === "number" ? s : Date.parse(s);
  return Number.isFinite(t) ? t : null;
};

async function main() {
  ensureDir(OUT);
  const now = Date.now();
  const seen = new Set<string>();
  const sig = [...jsonl("../../reports/ib-review-1119/signals.jsonl"), ...jsonl("../../reports/ib-review-1118/signals.jsonl")]
    .filter((r) => { const k = String(r.id); if (seen.has(k)) return false; seen.add(k); return true; });
  const rows: Row[] = [];
  for (const r of sig) {
    const m = parse(r.impulse_decision_metrics) as Record<string, unknown> | null;
    const at = time(r.detected_at)!;
    const closedAt = time(m?.candleClosedAt) ?? Math.floor(at / M30) * M30;
    const start = closedAt - M30;
    const sym = String(r.symbol).includes("-") ? String(r.symbol) : String(r.symbol).replace(/USDT$/, "-USDT");
    const row: Row = { id: String(r.id), symbol: sym, detected_at: new Date(at).toISOString(), status: String(r.status), candle_open: new Date(start).toISOString() };
    const fut = await cgHistoryTf(CACHE, sym, "aggfut", start - 5 * D1, now, "15m").catch(() => null);
    const spot = await cgHistoryTf(CACHE, sym, "aggspot", start - 5 * D1, now, "15m").catch(() => null);
    const vol30 = (t: number): number | null => {
      const a = fut?.get(t), b = fut?.get(t + M15);
      if (!a || !b) return null;
      const sa = spot?.get(t), sb = spot?.get(t + M15);
      return a.buy + a.sell + b.buy + b.sell + (sa && sb ? sa.buy + sa.sell + sb.buy + sb.sell : 0);
    };
    const series: number[] = [];
    let ok = true;
    for (let k = LUCY_LONG_BARS - 1 + 3; k >= 0; k--) { const v = vol30(start - k * M30); if (v === null) { ok = false; break; } series.push(v); }
    if (ok) {
      const j = series.length - 1;
      row.welkin = welkinColour(series, j); row.lucy = lucyColour(series, j);
      row.vol_vs_avg20 = series[j]! / (series.slice(j - 19, j + 1).reduce((s, x) => s + x, 0) / 20);
      row.vol_vs_avg120 = series[j]! / (series.slice(j - 119, j + 1).reduce((s, x) => s + x, 0) / 120);
      for (let p = 1; p <= 3; p++) { row[`welkin_prev${p}`] = welkinColour(series, j - p); row[`lucy_prev${p}`] = lucyColour(series, j - p); }
    } else row.error = fut ? "short_history" : "no_futures_volume";
    // Welkin on BingX volume only (one exchange), 30m from the 15m candles.
    const m15 = await klines(CACHE, sym, "15m", start - 3 * D1, Math.min(now, start + D1)).catch(() => []);
    const bv = new Map(m15.map((c) => [c.time, c.volume * c.close]));
    const bx: number[] = [];
    let bok = true;
    for (let k = 20 - 1 + 3; k >= 0; k--) { const t = start - k * M30, a = bv.get(t), b = bv.get(t + M15); if (a == null || b == null) { bok = false; break; } bx.push(a + b); }
    if (bok) { const j = bx.length - 1; row.welkin_bingx = welkinColour(bx, j); for (let p = 1; p <= 3; p++) row[`welkin_bingx_prev${p}`] = welkinColour(bx, j - p); }
    rows.push(row);
  }
  writeCsv(join(OUT, "welkin.csv"), rows);
  console.error(`готово: ${rows.length}`);
}
void main();
