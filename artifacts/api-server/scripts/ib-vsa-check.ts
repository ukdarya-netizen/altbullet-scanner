/**
 * IB VSA filter check (owner 2026-11-19: «правильно ли были внедрены фильтры VSA?»). Read-only.
 * For every Impulse Buy fired or stopped by the 30m-candle VSA filter since its release: the colour the bot recorded
 * vs the colour on FINAL CoinGlass data (15m aggregated futures + spot, two halves → 30m, 120 bars — the same
 * function the bot uses, lucyColour30m).
 *
 * Input (from production, JSON lines): fired.jsonl (tracked_signals: id, symbol, detected_at, impulse_decision_metrics),
 * blocked.jsonl (pattern_decision_snapshots: id, symbol, decision_at, decision_reason, entry_metrics).
 * Run: pnpm dlx tsx scripts/ib-vsa-check.ts --in ../../reports/ib-vsa-check --out ../../reports/ib-vsa-check
 * Output: check.csv, run.txt.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { lucyColour30m } from "../src/lib/ib-signal-candle-vsa.js";
import { cgHistoryTf } from "./study-v2/cg.js";
import { ensureDir, parseArgs, writeCsv, type Row } from "./study-v2/lib.js";

const args = parseArgs();
const IN = args.get("in") ?? "../../reports/ib-vsa-check";
const OUT = args.get("out") ?? IN;
const CACHE = join(OUT, ".cache-fresh"); // fresh CoinGlass data, not the studies' cache
const M30 = 30 * 60_000, D1 = 86_400_000;

const jsonl = (f: string) => (existsSync(f) ? readFileSync(f, "utf8").split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l) as Record<string, unknown>) : []);
const parse = (v: unknown) => (typeof v === "string" ? (() => { try { return JSON.parse(v); } catch { return v; } })() : v);
const time = (v: unknown): number | null => {
  if (typeof v !== "string" && typeof v !== "number") return null;
  const s = typeof v === "string" && !/[zZ]|[+-]\d\d:?\d\d$/.test(v) ? `${v.replace(" ", "T")}Z` : v;
  const t = typeof s === "number" ? s : Date.parse(s);
  return Number.isFinite(t) ? t : null;
};
function find(v: unknown, key: string): unknown {
  if (!v || typeof v !== "object") return undefined;
  if (key in (v as Record<string, unknown>)) return (v as Record<string, unknown>)[key];
  for (const x of Object.values(v as Record<string, unknown>)) { const r = find(x, key); if (r !== undefined) return r; }
  return undefined;
}

async function main() {
  ensureDir(OUT); ensureDir(CACHE);
  const now = Date.now();
  const items = [
    ...jsonl(join(IN, "fired.jsonl")).map((r) => ({ kind: "fired", id: r.id, symbol: String(r.symbol), at: time(r.detected_at), m: parse(r.impulse_decision_metrics), reason: "" })),
    ...jsonl(join(IN, "blocked.jsonl")).map((r) => ({ kind: "blocked", id: r.id, symbol: String(r.symbol), at: time(r.decision_at), m: parse(r.entry_metrics), reason: String(r.decision_reason ?? "") })),
  ];
  const rows: Row[] = [];
  for (const it of items) {
    const closedAt = time(find(it.m, "candleClosedAt"));
    const recorded = (find(it.m, "lucy30mColour") as string | null | undefined) ?? null;
    const r: Row = { kind: it.kind, id: String(it.id), symbol: it.symbol, at: it.at ? new Date(it.at).toISOString() : null, candle_open: closedAt ? new Date(closedAt - M30).toISOString() : null, recorded, final: null, same: null, reason: it.reason };
    if (closedAt) {
      const sym = it.symbol.includes("-") ? it.symbol : it.symbol.replace(/USDT$/, "-USDT");
      const fut = await cgHistoryTf(CACHE, sym, "aggfut", closedAt - 4 * D1, now, "15m").catch(() => null);
      const spot = await cgHistoryTf(CACHE, sym, "aggspot", closedAt - 4 * D1, now, "15m").catch(() => null);
      const tot = (m: typeof fut) => (m ? new Map([...m.values()].map((b) => [b.time, b.buy + b.sell])) : null);
      const f = tot(fut);
      r.final = f ? lucyColour30m(f, tot(spot), closedAt - M30) : null;
      r.same = r.final !== null && recorded !== null ? (r.final === recorded ? 1 : 0) : null;
    }
    rows.push(r);
  }
  writeCsv(join(OUT, "check.csv"), rows);
  writeFileSync(join(OUT, "run.txt"), `строк: ${rows.length}; совпало: ${rows.filter((r) => r.same === 1).length}; не совпало: ${rows.filter((r) => r.same === 0).length}; без сравнения: ${rows.filter((r) => r.same === null).length}\n`);
}
void main();
