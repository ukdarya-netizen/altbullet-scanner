/**
 * CAB Bitcoin signals (owner 2026-11-11): what the bot itself recorded at every BTC signal — open interest,
 * liquidations, CVD, takers, funding, money flow, everything in decision_metrics, the LC watch snapshot and
 * signal_entry_extras — set against how each trade went. All CAB BTC signals so far are liquidation_cascade.
 *
 * Outcome per trade comes from reports/btc-exit/trades.csv (btc-exit-study v2, BingX 5m / 15m candles):
 * peak and low within 4 days, result under the current rule (stop 1, B.U. +1, trailing +2/1) and under
 * s3_be1.5_tr2g1. Groups: "пошёл" = peak ≥ +2% within 4 days, "не пошёл" = peak < +2%.
 *
 * Out: summary.txt — every trade with all its readings; for every reading the values of both groups (full
 *      ranges, every value listed, no medians) and the best single cut "≥ x" / "≤ x" with trades kept / dropped
 *      and their sums; readings ranked by how many "не пошёл" trades a cut drops while keeping every "пошёл".
 *      trades.csv — one row per trade, one column per reading. metrics.csv — one row per reading.
 *
 * The script does not connect to any database. The agent exports with its read-only production SQL tool
 * (JSON arrays of row objects):
 *   signals.json:  SELECT id, sentiment_key, detected_at, entry_price, status::text AS status, pnl_percent,
 *                         decision_metrics
 *                    FROM tracked_signals WHERE symbol IN ('BTC-USDT','BTCUSDT') AND entry_price > 0 ORDER BY detected_at
 *   watches.json:  SELECT * FROM liq_cascade_watch WHERE signal_id IN (<the ids above>)
 *   extras.json:   SELECT tracked_signal_id, sentiment_key, recorded_at, metrics
 *                    FROM signal_entry_extras WHERE tracked_signal_id IN (<the ids above>)
 * Run (from artifacts/api-server):
 *   pnpm dlx tsx scripts/btc-signal-metrics-study.ts --signals signals.json --watches watches.json \
 *     --extras extras.json --trades ../../reports/btc-exit/trades.csv --out ../../reports/btc-signal-metrics
 */
import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

// self-contained on purpose: nothing here imports the app (no database module is loaded)
type Row = Record<string, string | number | boolean | null>;
function parseArgs(): Map<string, string> {
  const m = new Map<string, string>();
  const a = process.argv.slice(2);
  for (let i = 0; i < a.length; i++) if (a[i].startsWith("--")) m.set(a[i].slice(2), a[i + 1] && !a[i + 1].startsWith("--") ? a[++i] : "1");
  return m;
}
const ensureDir = (d: string) => mkdirSync(d, { recursive: true });
function writeCsv(file: string, rows: Row[]) {
  const keys = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const f = (v: unknown) => (v == null ? "" : typeof v === "number" ? (Number.isFinite(v) ? String(+v.toFixed(5)) : "") : typeof v === "boolean" ? (v ? "1" : "0") : String(v).replace(/,/g, ";"));
  writeFileSync(file, [keys.join(","), ...rows.map((r) => keys.map((k) => f(r[k])).join(","))].join("\n"));
}

const args = parseArgs();
const OUT = args.get("out") ?? "btc-signal-metrics";
const need = (k: string) => { const v = args.get(k); if (!v) throw new Error(`--${k} <file> is required`); return v; };
const readJson = (f: string): Record<string, unknown>[] => {
  const v = JSON.parse(readFileSync(f, "utf8"));
  return Array.isArray(v) ? v : [];
};

const signals = readJson(need("signals"));
const watches = args.get("watches") && existsSync(args.get("watches")!) ? readJson(args.get("watches")!) : [];
const extras = args.get("extras") && existsSync(args.get("extras")!) ? readJson(args.get("extras")!) : [];

// outcomes from the exit study
const tradeLines = readFileSync(need("trades"), "utf8").trim().split("\n");
const head = tradeLines[0].split(",");
const col = (n: string) => head.indexOf(n);
type Out = { peak: number | null; low: number | null; now: number | null; best: number | null; how: string };
const outcome = new Map<number, Out>();
const nOrNull = (s: string | undefined) => (s === undefined || s === "" ? null : Number.isFinite(Number(s)) ? Number(s) : null);
for (const l of tradeLines.slice(1)) {
  const c = l.split(",");
  outcome.set(Number(c[col("id")]), {
    peak: nOrNull(c[col("peak_4d_pct")]),
    low: nOrNull(c[col("low_4d_pct")]),
    now: nOrNull(c[col("s1_be1_tr2g1")]),
    best: nOrNull(c[col("s3_be1.5_tr2g1")]),
    how: c[col("how_current")] ?? "",
  });
}

// flatten every number / boolean leaf
function flatten(v: unknown, prefix: string, out: Map<string, number>) {
  if (v === null || v === undefined) return;
  if (typeof v === "string") {
    const t = v.trim();
    if ((t.startsWith("{") && t.endsWith("}")) || (t.startsWith("[") && t.endsWith("]"))) {
      try { flatten(JSON.parse(t), prefix, out); } catch { /* plain text */ }
      return;
    }
    if (t === "t" || t === "true") { out.set(prefix, 1); return; }
    if (t === "f" || t === "false") { out.set(prefix, 0); return; }
    if (t !== "" && Number.isFinite(Number(t)) && !/^\d{4}-\d\d-\d\d/.test(t)) out.set(prefix, Number(t));
    return;
  }
  if (typeof v === "number") { if (Number.isFinite(v)) out.set(prefix, v); return; }
  if (typeof v === "boolean") { out.set(prefix, v ? 1 : 0); return; }
  if (Array.isArray(v)) { out.set(`${prefix}.length`, v.length); return; }
  if (typeof v === "object") for (const [k, x] of Object.entries(v as Record<string, unknown>)) flatten(x, prefix ? `${prefix}.${k}` : k, out);
}
const SKIP = /(^|\.)(id|signal_id|tracked_signal_id|time|at|capturedAt|fetchedAt|candleAt|oiBucket|first_seen_at|flush_seen_at|last_fired_at|cycle_count|entry_price|entryPrice|price|current_price|price_at_detect|priceAtDecision|last_price|first_price|stop_loss_price|stopPrice|targetPrice)$/i;

type T = { id: number; at: string; status: string; pnl: number | null; o: Out | null; m: Map<string, number> };
const trades: T[] = [];
for (const s of signals) {
  const id = Number(s.id);
  const m = new Map<string, number>();
  flatten(s.decision_metrics, "dm", m);
  for (const w of watches.filter((w) => Number(w.signal_id) === id)) {
    const { id: _a, signal_id: _b, symbol: _c, status: _d, detected_at: _e, expires_at: _f, last_check_at: _g, ...rest } = w;
    flatten(rest, "watch", m);
  }
  for (const x of extras.filter((x) => Number(x.tracked_signal_id) === id)) flatten(x.metrics, "extra", m);
  for (const k of [...m.keys()]) if (SKIP.test(k)) m.delete(k);
  trades.push({ id, at: String(s.detected_at), status: String(s.status), pnl: nOrNull(String(s.pnl_percent ?? "")), o: outcome.get(id) ?? null, m });
}

const WIN = 2;
const done = trades.filter((t) => t.o && t.o.peak !== null && t.o.now !== null);
const isWin = (t: T) => (t.o!.peak ?? 0) >= WIN;
const r = (v: number) => Math.round(v * 100) / 100;
const fmt = (v: number) => (Math.abs(v) >= 1000 ? String(Math.round(v)) : String(r(v)));
const sum = (ts: T[], k: "now" | "best") => r(ts.reduce((a, t) => a + (t.o![k] ?? 0), 0));

const keys = [...new Set(trades.flatMap((t) => [...t.m.keys()]))].sort();
type Cut = { dir: "≥" | "≤"; x: number; keep: T[]; drop: T[]; winsKept: number; lossDropped: number };
type MRes = { key: string; have: number; wins: number[]; losses: number[]; cut: Cut | null; sep: boolean };
const res: MRes[] = [];
for (const k of keys) {
  const ts = done.filter((t) => t.m.has(k));
  const w = ts.filter(isWin), l = ts.filter((t) => !isWin(t));
  if (ts.length < 4 || new Set(ts.map((t) => t.m.get(k))).size < 2) continue;
  let best: Cut | null = null;
  for (const x of [...new Set(ts.map((t) => t.m.get(k)!))]) {
    for (const dir of ["≥", "≤"] as const) {
      const pass = (t: T) => (dir === "≥" ? t.m.get(k)! >= x : t.m.get(k)! <= x);
      const keep = ts.filter(pass), drop = ts.filter((t) => !pass(t));
      if (keep.length === 0 || drop.length === 0) continue;
      const c: Cut = { dir, x, keep, drop, winsKept: keep.filter(isWin).length, lossDropped: drop.filter((t) => !isWin(t)).length };
      const score = (q: Cut) => (q.winsKept === w.length ? 1000 : 0) + q.lossDropped * 10 + q.winsKept;
      if (!best || score(c) > score(best)) best = c;
    }
  }
  const wv = w.map((t) => t.m.get(k)!), lv = l.map((t) => t.m.get(k)!);
  const sep = wv.length > 0 && lv.length > 0 && (Math.min(...wv) > Math.max(...lv) || Math.max(...wv) < Math.min(...lv));
  res.push({ key: k, have: ts.length, wins: wv, losses: lv, cut: best, sep });
}
res.sort((a, b) => {
  const fa = a.cut && a.cut.winsKept === a.wins.length ? a.cut.lossDropped : -1;
  const fb = b.cut && b.cut.winsKept === b.wins.length ? b.cut.lossDropped : -1;
  return fb - fa || b.have - a.have;
});

ensureDir(OUT);
const L: string[] = [];
const wins = done.filter(isWin), losses = done.filter((t) => !isWin(t));
L.push(`CAB BTC: показатели, которые бот записал на каждом сигнале, против исхода сделки`);
L.push(`Сигналов BTC в выгрузке: ${trades.length}; с исходом (закрытые, свечи есть): ${done.length}; снимков watch: ${watches.length}; записей extras: ${extras.length}`);
L.push(`Пошёл (пик ≥ +${WIN}% за 4 дня): ${wins.length} — ${wins.map((t) => `#${t.id}`).join(" ")}`);
L.push(`Не пошёл (пик < +${WIN}%): ${losses.length} — ${losses.map((t) => `#${t.id}`).join(" ")}`);
L.push(`Показателей найдено: ${keys.length}; сравнимых (есть хотя бы у 4 сделок, значения различаются): ${res.length}`);
L.push(`ВНИМАНИЕ: ${done.length} сделок — любой порог ниже подобран на этих же сделках; на новых может не повториться.`);
L.push("");
L.push(`Показатели, где порог оставляет ВСЕ «пошёл» и отсекает больше всего «не пошёл» (суммы: сейчас / s3_be1.5_tr2g1):`);
for (const m of res) {
  const c = m.cut;
  if (!c) continue;
  const allWins = c.winsKept === m.wins.length;
  L.push(` ${m.key}  [есть у ${m.have}]${m.sep ? "  ГРУППЫ НЕ ПЕРЕСЕКАЮТСЯ" : ""}`);
  L.push(`   пошёл:    ${m.wins.length ? `${fmt(Math.min(...m.wins))}…${fmt(Math.max(...m.wins))}` : "—"}  [${m.wins.map(fmt).join(", ")}]`);
  L.push(`   не пошёл: ${m.losses.length ? `${fmt(Math.min(...m.losses))}…${fmt(Math.max(...m.losses))}` : "—"}  [${m.losses.map(fmt).join(", ")}]`);
  L.push(`   порог ${c.dir} ${fmt(c.x)}: оставляет ${c.keep.length} (пошёл ${c.winsKept}/${m.wins.length}${allWins ? "" : " — теряет хорошие"}) ${sum(c.keep, "now")}% / ${sum(c.keep, "best")}% · отсекает ${c.drop.length} (не пошёл ${c.lossDropped}/${m.losses.length}) ${sum(c.drop, "now")}% / ${sum(c.drop, "best")}% · отсечены: ${c.drop.map((t) => `#${t.id}`).join(" ")}`);
}
L.push("");
L.push(`Каждая сделка со всеми показателями:`);
for (const t of trades) {
  const o = t.o;
  L.push(` #${t.id} ${t.at} · статус ${t.status} · ${o ? `пик +${o.peak}% / ${o.low}% · сейчас ${o.now ?? "идёт"}${o.how ? ` (${o.how})` : ""} · s3_be1.5_tr2g1 ${o.best ?? "идёт"}` : "нет исхода"}${o && o.peak !== null && o.now !== null ? (o.peak >= WIN ? " · ПОШЁЛ" : " · НЕ ПОШЁЛ") : ""}`);
  L.push(`   ${[...t.m.entries()].map(([k, v]) => `${k}=${fmt(v)}`).join(" · ") || "показателей нет"}`);
}
writeFileSync(join(OUT, "summary.txt"), L.join("\n") + "\n");

const tradeRows: Row[] = trades.map((t) => {
  const row: Row = { id: t.id, detected_at: t.at, status: t.status, peak_4d: t.o?.peak ?? null, low_4d: t.o?.low ?? null, now: t.o?.now ?? null, best: t.o?.best ?? null, group: t.o?.peak == null || t.o.now == null ? "" : t.o.peak >= WIN ? "пошёл" : "не пошёл" };
  for (const k of keys) row[k] = t.m.get(k) ?? null;
  return row;
});
writeCsv(join(OUT, "trades.csv"), tradeRows);
writeCsv(join(OUT, "metrics.csv"), res.map((m) => ({
  metric: m.key, trades: m.have,
  win_min: m.wins.length ? Math.min(...m.wins) : null, win_max: m.wins.length ? Math.max(...m.wins) : null,
  loss_min: m.losses.length ? Math.min(...m.losses) : null, loss_max: m.losses.length ? Math.max(...m.losses) : null,
  separated: m.sep, cut: m.cut ? `${m.cut.dir} ${m.cut.x}` : "", wins_kept: m.cut?.winsKept ?? null, losses_dropped: m.cut?.lossDropped ?? null,
  kept_sum_now: m.cut ? sum(m.cut.keep, "now") : null, kept_sum_best: m.cut ? sum(m.cut.keep, "best") : null,
})));
console.log(`done: ${trades.length} signals, ${res.length} comparable readings → ${OUT}`);
