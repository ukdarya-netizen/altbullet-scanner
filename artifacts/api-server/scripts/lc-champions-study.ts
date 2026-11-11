/**
 * Liquidation Cascade: the rejected «champions» (owner 2026-11-11 — LC gives too few trades). Which LC
 * candidates did the bot reject, what happened to the price after, and which rule rejected the good ones.
 *
 * Source: scan_reject_log (production DB, read only) — every LC rejection since --from, with its reason and the
 * readings logged with it (oi30m, vol_mult, price24h). Rejections of one coin within 4 hours form one episode
 * (all its reasons kept, the first one is the main reason). Fired LC since --from: tracked_signals.
 * Outcome from the first rejection of the episode (BingX 15m candles, nothing before it is used):
 *   peak / low within 4 days; champion = reached +10% before −8%;
 *   LC exit as live (stop −8%, B.U. at +8%, trailing from +15% at 10 p.p., 4 days, fee 0.1%).
 *
 * Out: summary.txt (per reason: episodes, champions, average LC-exit result, ranges; fired LC the same way;
 *      the champions by name), episodes.csv, fired.csv.
 *
 * Run (from artifacts/api-server; production DB read only; BingX candles via the study cache):
 *   pnpm dlx tsx scripts/lc-champions-study.ts --from 2026-11-01 --out ../../reports/lc-champions
 */
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { pool } from "@workspace/db";
import { type C, type Row, D1, H1, M15, ensureDir, idxAtOrBefore, klines, parseArgs, writeCsv } from "./study-v2/lib.js";

const args = parseArgs();
const OUT = args.get("out") ?? "lc-champions";
const CACHE = args.get("cache") ?? "../../reports/.cache";
const FROM = Date.parse(args.get("from") ?? "2026-11-01T00:00:00Z");
const HORIZON = 4 * D1;
const EPISODE_GAP = 4 * H1;

const fmtT = (t: number) => {
  const d = new Date(t + 4 * H1), p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getUTCDate())}.${p(d.getUTCMonth() + 1)} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())} Дубай`;
};

function outcome(m15: C[], at: number, now: number) {
  const i0 = idxAtOrBefore(m15, at - M15);
  if (i0 < 0) return null;
  const entry = m15[i0]!.close;
  let peak = entry, low = entry, champion: boolean | null = null;
  let stop = entry * 0.92, how = "стоп", res: number | null = null;
  for (let i = i0 + 1; i < m15.length; i++) {
    const c = m15[i]!;
    if (c.time >= at + HORIZON || c.time > now) break;
    if (champion === null && c.low <= entry * 0.92) champion = false;
    if (res === null && c.low <= stop) res = (Math.min(stop, c.open) / entry - 1) * 100 - 0.1;
    peak = Math.max(peak, c.high); low = Math.min(low, c.low);
    if (champion === null && peak >= entry * 1.1) champion = true;
    const pp = (peak / entry - 1) * 100;
    if (res === null) {
      if (pp >= 8 && stop < entry) { stop = entry; how = "безубыток"; }
      if (pp >= 15) { const ts = entry * (1 + (pp - 10) / 100); if (ts > stop) { stop = ts; how = "трейлинг"; } }
    }
  }
  if (res === null) {
    if (at + HORIZON > now) return { entry, peak: (peak / entry - 1) * 100, low: (low / entry - 1) * 100, champion, result: null, how: "идёт" };
    const j = idxAtOrBefore(m15, at + HORIZON - M15);
    res = (m15[j]!.close / entry - 1) * 100 - 0.1; how = "4 дня";
  }
  return { entry, peak: (peak / entry - 1) * 100, low: (low / entry - 1) * 100, champion: champion ?? false, result: res, how };
}

function stats(rows: Row[]): string {
  const res = rows.map((r) => r.lc_exit_pct).filter((x): x is number => typeof x === "number").sort((a, b) => a - b);
  const champ = rows.filter((r) => r.champion === true).length;
  const q = (p: number) => (res.length ? Math.round(100 * res[Math.min(res.length - 1, Math.floor(p * res.length))]!) / 100 : "—");
  const avg = res.length ? Math.round((100 * res.reduce((a, b) => a + b, 0)) / res.length) / 100 : "—";
  return `n ${rows.length} | чемпионов (+10% раньше −8%) ${champ} (${rows.length ? Math.round((100 * champ) / rows.length) : 0}%) | выход LC: ср ${avg}% · p10 ${q(0.1)} p25 ${q(0.25)} p75 ${q(0.75)} p90 ${q(0.9)}`;
}

async function main() {
  ensureDir(OUT); ensureDir(CACHE);
  const now = Date.now();
  const patterns = await pool.query<{ pattern: string; n: string }>(
    `SELECT pattern, count(*)::text AS n FROM scan_reject_log WHERE cycle_at >= to_timestamp($1 / 1000.0) GROUP BY pattern ORDER BY 2 DESC`, [FROM]);
  const lcPatterns = patterns.rows.map((r) => r.pattern).filter((p) => /liq|cascade|^lc/i.test(p));
  const range = await pool.query<{ first: Date | null; last: Date | null }>(`SELECT min(cycle_at) AS first, max(cycle_at) AS last FROM scan_reject_log`);
  const rej = await pool.query<{ symbol: string; reason: string; hour: Date; first_at: Date; oi30m: number | null; vol_mult: number | null; price24h: number | null; n: string }>(
    `SELECT symbol, reason, date_trunc('hour', cycle_at) AS hour, min(cycle_at) AS first_at,
            (array_agg(oi30m ORDER BY cycle_at))[1] AS oi30m, (array_agg(vol_mult ORDER BY cycle_at))[1] AS vol_mult,
            (array_agg(price24h ORDER BY cycle_at))[1] AS price24h, count(*)::text AS n
       FROM scan_reject_log
      WHERE cycle_at >= to_timestamp($1 / 1000.0) AND pattern = ANY($2::text[])
      GROUP BY symbol, reason, date_trunc('hour', cycle_at)
      ORDER BY symbol, first_at`, [FROM, lcPatterns]);
  const fired = await pool.query<{ id: number; symbol: string; detected_at: Date; status: string; pnl_percent: number | null }>(
    `SELECT id, symbol, detected_at, status::text AS status, pnl_percent FROM tracked_signals
      WHERE sentiment_key = 'liquidation_cascade' AND detected_at >= to_timestamp($1 / 1000.0) ORDER BY detected_at`, [FROM]);

  type Ep = { symbol: string; start: number; last: number; reasons: Map<string, number>; first: string; oi30m: number | null; vol: number | null; p24: number | null };
  const eps: Ep[] = [];
  const open = new Map<string, Ep>();
  for (const r of rej.rows) {
    const t = new Date(r.first_at).getTime();
    const cur = open.get(r.symbol);
    if (cur && t - cur.last <= EPISODE_GAP) {
      cur.last = Math.max(cur.last, t);
      cur.reasons.set(r.reason, (cur.reasons.get(r.reason) ?? 0) + Number(r.n));
    } else {
      const ep: Ep = { symbol: r.symbol, start: t, last: t, reasons: new Map([[r.reason, Number(r.n)]]), first: r.reason, oi30m: r.oi30m, vol: r.vol_mult, p24: r.price24h };
      eps.push(ep); open.set(r.symbol, ep);
    }
  }
  // A coin that fired LC within the episode is not a rejected champion.
  const firedBy = new Map<string, number[]>();
  for (const f of fired.rows) firedBy.set(f.symbol, [...(firedBy.get(f.symbol) ?? []), new Date(f.detected_at).getTime()]);

  const cache = new Map<string, C[]>();
  const m15For = async (symbol: string) => {
    if (!cache.has(symbol)) cache.set(symbol, await klines(CACHE, symbol, "15m", FROM - D1, now).catch(() => []));
    return cache.get(symbol)!;
  };
  const epRows: Row[] = [];
  let done = 0;
  for (const ep of eps) {
    const m15 = await m15For(ep.symbol);
    const o = m15.length ? outcome(m15, ep.start, now) : null;
    const firedNear = (firedBy.get(ep.symbol) ?? []).some((t) => t >= ep.start - EPISODE_GAP && t <= ep.last + EPISODE_GAP);
    epRows.push({
      symbol: ep.symbol, start_utc: new Date(ep.start).toISOString(), main_reason: ep.first,
      reasons: [...ep.reasons.entries()].map(([k, v]) => `${k}:${v}`).join(" "), fired_lc_nearby: firedNear ? 1 : 0,
      oi30m: ep.oi30m, vol_mult: ep.vol, price24h: ep.p24, entry: o?.entry ?? null,
      peak_4d_pct: o ? Math.round(o.peak * 10) / 10 : null, low_4d_pct: o ? Math.round(o.low * 10) / 10 : null,
      champion: o?.champion ?? null, lc_exit_pct: o?.result == null ? null : Math.round(o.result * 100) / 100, how: o?.how ?? "нет свечей",
    });
    if (++done % 100 === 0) console.error(`эпизоды ${done}/${eps.length}`);
  }
  const firedRows: Row[] = [];
  for (const f of fired.rows) {
    const t = new Date(f.detected_at).getTime();
    const m15 = await m15For(f.symbol);
    const o = m15.length ? outcome(m15, t, now) : null;
    firedRows.push({ id: f.id, symbol: f.symbol, detected_utc: new Date(f.detected_at).toISOString(), status: f.status, pnl_tracked: f.pnl_percent,
      peak_4d_pct: o ? Math.round(o.peak * 10) / 10 : null, champion: o?.champion ?? null, lc_exit_pct: o?.result == null ? null : Math.round(o.result * 100) / 100 });
  }
  writeCsv(join(OUT, "episodes.csv"), epRows);
  writeCsv(join(OUT, "fired.csv"), firedRows);
  const rejected = epRows.filter((r) => r.fired_lc_nearby === 0 && r.entry != null);
  const byReason = new Map<string, Row[]>();
  for (const r of rejected) byReason.set(String(r.main_reason), [...(byReason.get(String(r.main_reason)) ?? []), r]);
  const anyReason = new Map<string, Row[]>();
  for (const r of rejected) for (const k of String(r.reasons).split(" ").map((x) => x.split(":")[0]!)) anyReason.set(k, [...(anyReason.get(k) ?? []), r]);
  const champs = rejected.filter((r) => r.champion === true).sort((a, b) => Number(b.peak_4d_pct) - Number(a.peak_4d_pct));
  const out = [
    `LC: отклонённые «чемпионы» с ${new Date(FROM).toISOString()} · scan_reject_log хранит ${range.rows[0]?.first?.toISOString() ?? "—"} … ${range.rows[0]?.last?.toISOString() ?? "—"}`,
    `Паттерны в журнале отказов: ${patterns.rows.map((r) => `${r.pattern} ${r.n}`).join(", ")} · LC: ${lcPatterns.join(", ") || "НЕ НАЙДЕН"}`,
    `Эпизод = отказы одной монеты в пределах 4 ч. Итог от первого отказа: пик/просадка 4 дня; чемпион = +10% раньше −8%; выход LC = стоп −8%, Б.У. +8, трейл +15/10, 4 дня.`,
    ``,
    `Сработавшие LC: ${stats(firedRows)}`,
    `Отклонённые (без LC рядом): ${stats(rejected)}`,
    ``,
    `По главной причине отказа:`,
    ...[...byReason.entries()].sort((a, b) => b[1].length - a[1].length).map(([k, rs]) => ` ${k.padEnd(44)} ${stats(rs)}`),
    ``,
    `По любой причине в эпизоде:`,
    ...[...anyReason.entries()].sort((a, b) => b[1].length - a[1].length).map(([k, rs]) => ` ${k.padEnd(44)} ${stats(rs)}`),
    ``,
    `Чемпионы (${champs.length}), по пику:`,
    ...champs.slice(0, 80).map((r) => ` ${String(r.symbol).padEnd(16)} ${fmtT(Date.parse(String(r.start_utc)))} вход ${r.entry} · пик +${r.peak_4d_pct}% · выход LC ${r.lc_exit_pct ?? "идёт"}% · причины ${r.reasons} · oi30m ${r.oi30m} vol ${r.vol_mult} 24ч ${r.price24h}`),
  ];
  writeFileSync(join(OUT, "summary.txt"), out.join("\n") + "\n");
  console.log(out.slice(0, 7).join("\n"));
  await pool.end();
}

main().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });
