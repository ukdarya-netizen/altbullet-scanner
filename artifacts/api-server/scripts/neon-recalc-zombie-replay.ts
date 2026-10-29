/**
 * Owner 2026-10-29: seven ABNeon rows restated by the 2026-10-25 "no-wait"
 * recalc were left open (four of them had already been closed). The watcher
 * then closed them only on 29.10 at that day's prices. This replays each row
 * from its restated entry on public BingX 15m candles with the live ABNeon
 * exit rules and the 4-day lifetime, and (with --apply) writes the result.
 *
 * Rules (watcher-config.ts / watcher.ts, neon_support_bounce):
 *  - stop: entry × (1 - stop_loss_pct %) until B.U.;
 *  - B.U. once the peak reached +8% (stop = entry, closes at 0%);
 *  - first target +10% → in_run (no +10% → +5% promotion for ABNeon);
 *  - trailing from a +15% peak at 10 pp below the peak (closes as profit);
 *  - lifetime 4 days from detected_at: classifyTimeoutExit (trailing → profit,
 *    B.U. earned → bu_stop at 0%, pnl < 0 → stop_loss, ≥ 5% → profit,
 *    else expired), at the close of the last candle.
 * Within a candle the stop is checked before the high (conservative).
 *
 * Run (from artifacts/api-server): npx tsx scripts/neon-recalc-zombie-replay.ts
 * Prints the report and the SQL; it never connects to a database.
 */
import { NEON_NO_WAIT_ROWS } from "../src/lib/neon-no-wait-recalc-data.js";

const IDS = [2763, 2768, 2771, 2778, 2783, 2796, 2868];
const BACKUP = "tracked_signals_backup_neon_zombie_20261029";
const M15 = 15 * 60 * 1000;
const LIFETIME_MS = 4 * 24 * 60 * 60 * 1000;
const BU_AT = 8, FIRST_TARGET = 10, TRAIL_AT = 15, TRAIL_GAP = 10;

type C = { time: number; open: number; high: number; low: number; close: number };
type Row = {
  id: number; symbol: string; status: string; entry_price: number; detected_ms: string;
  stop_loss_pct: number | null; peak_price: number | null; exit_price: number | null;
  pnl_percent: number | null; closed_at_text: string | null; sentiment_key: string;
};

async function klines15m(symbol: string, start: number, end: number): Promise<C[]> {
  const out = new Map<number, C>();
  for (let cur = start; cur < end; cur += M15 * 1000) {
    const url = `https://open-api.bingx.com/openApi/swap/v3/quote/klines?symbol=${symbol}` +
      `&interval=15m&startTime=${cur}&endTime=${Math.min(end, cur + M15 * 1000)}&limit=1000`;
    const j = (await (await fetch(url)).json()) as { code: number; data?: Array<Record<string, string>> };
    if (j.code !== 0) throw new Error(`klines ${symbol}: code ${j.code}`);
    for (const k of j.data ?? []) {
      const t = Number(k.time);
      out.set(t, { time: t, open: +k.open, high: +k.high, low: +k.low, close: +k.close });
    }
  }
  return [...out.values()].filter((c) => c.time + M15 <= end).sort((a, b) => a.time - b.time);
}

function replay(row: Row, cs: C[]) {
  const entry = Number(row.entry_price);
  const stopPct = Number(row.stop_loss_pct ?? 10);
  const pct = (p: number) => (p / entry - 1) * 100;
  let peak = entry;
  for (const c of cs) {
    const peakPct = pct(peak);
    const trailing = peakPct >= TRAIL_AT ? entry * (1 + (peakPct - TRAIL_GAP) / 100) : null;
    const bu = peakPct >= BU_AT;
    const stop = trailing ?? (bu ? entry : entry * (1 - stopPct / 100));
    if (c.low <= stop) {
      const status = trailing ? "profit" : bu ? "bu_stop" : "stop_loss";
      const exit = bu && !trailing ? entry : stop;
      return { status, exitPrice: exit, pnl: status === "bu_stop" ? 0 : pct(exit),
        closedAt: new Date(c.time + M15), peak, evidence: `15m ${new Date(c.time).toISOString()} low ${c.low} <= stop ${stop}` };
    }
    peak = Math.max(peak, c.high);
  }
  const last = cs[cs.length - 1]!;
  const peakPct = pct(peak);
  const trailingActive = peakPct >= TRAIL_AT;
  const protectedBe = peakPct >= BU_AT;
  const pnlNow = pct(last.close);
  const status = trailingActive ? "profit" : protectedBe ? "bu_stop"
    : pnlNow < 0 ? "stop_loss" : pnlNow >= 5 ? "profit" : "expired";
  const exit = status === "bu_stop" ? entry : last.close;
  return { status, exitPrice: exit, pnl: status === "bu_stop" ? 0 : pct(exit),
    closedAt: new Date(last.time + M15), peak, evidence: `lifetime 4d, last 15m close ${last.close} at ${new Date(last.time + M15).toISOString()}` };
}

function milestone(peakPct: number): number | null {
  return peakPct >= TRAIL_AT ? TRAIL_AT : peakPct >= FIRST_TARGET ? FIRST_TARGET : peakPct >= BU_AT ? BU_AT : null;
}

// The shell cannot reach the production DB (Replit gives it only through its
// SQL tool), so the rows come from the reviewed 25.10 recalc data and the
// script prints SQL to run there: a backup, then guarded UPDATEs that only
// touch a row still closed exactly as the watcher closed it on 29.10.
const CURRENT: Record<number, { status: string; closedAt: string }> = {
  2763: { status: "stop_loss", closedAt: "2026-10-29 05:59:17.412" },
  2768: { status: "stop_loss", closedAt: "2026-10-29 05:59:32.183" },
  2771: { status: "stop_loss", closedAt: "2026-10-29 05:59:20.414" },
  2778: { status: "stop_loss", closedAt: "2026-10-29 05:59:28.927" },
  2783: { status: "stop_loss", closedAt: "2026-10-29 05:59:25.923" },
  2796: { status: "bu_stop", closedAt: "2026-10-29 05:57:28.56" },
  2868: { status: "expired", closedAt: "2026-10-29 05:59:23.169" },
};

async function main() {
  const sql: string[] = [
    "BEGIN;",
    `CREATE TABLE IF NOT EXISTS ${BACKUP} (LIKE tracked_signals INCLUDING DEFAULTS);`,
    `INSERT INTO ${BACKUP} SELECT * FROM tracked_signals WHERE id IN (${IDS.join(",")});`,
  ];
  for (const id of IDS) {
    const src = NEON_NO_WAIT_ROWS.find((r) => r.id === id);
    if (!src) { console.log(`${id}: not in the 25.10 recalc data — skipped`); continue; }
    const row: Row = { id, symbol: src.symbol, status: src.status, entry_price: src.entryPrice,
      detected_ms: String(Date.parse(src.detectedAt)), stop_loss_pct: src.stopPct, peak_price: src.peakPrice,
      exit_price: null, pnl_percent: null, closed_at_text: CURRENT[id]!.closedAt, sentiment_key: "neon_support_bounce" };
    const start = Number(row.detected_ms);
    const end = Math.min(start + LIFETIME_MS, Date.now());
    const cs = await klines15m(row.symbol, start, end);
    if (!cs.length) { console.log(`${id} ${row.symbol}: no candles — skipped`); continue; }
    const r = replay(row, cs);
    const entry = Number(row.entry_price);
    const peakPct = r.peak / entry * 100 - 100;
    console.log(`${id} ${row.symbol} entry ${entry} from ${new Date(start).toISOString()} candles ${cs.length}`);
    console.log(`   now:    ${CURRENT[id]!.status} closed ${CURRENT[id]!.closedAt}`);
    console.log(`   replay: ${r.status} pnl ${r.pnl.toFixed(4)} exit ${r.exitPrice} closed ${r.closedAt.toISOString()} peak ${peakPct.toFixed(2)}% | ${r.evidence}`);
    const trail = r.status === "profit" && peakPct >= TRAIL_AT ? String(r.exitPrice) : "NULL";
    const ms = milestone(peakPct);
    sql.push(
      `UPDATE tracked_signals SET status = '${r.status}'::tracked_status, exit_price = ${r.exitPrice}, ` +
      `pnl_percent = ${r.pnl.toFixed(6)}, closed_at = '${r.closedAt.toISOString().replace("T", " ").replace("Z", "")}', ` +
      `peak_price = GREATEST(${r.peak}, entry_price), last_milestone = ${ms ?? "NULL"}, trailing_stop_level = ${trail}, ` +
      `updated_at = now() WHERE id = ${id} AND status::text = '${CURRENT[id]!.status}' AND closed_at = '${CURRENT[id]!.closedAt}';`);
  }
  sql.push("COMMIT;");
  console.log("\n-- SQL for production (run only after the owner's OK):");
  console.log(sql.join("\n"));
}

main().catch((e) => { console.error(e); process.exit(1); });
