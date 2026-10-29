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
 * Run (from artifacts/api-server, production DB):
 *   npx tsx scripts/neon-recalc-zombie-replay.ts            # read-only report
 *   npx tsx scripts/neon-recalc-zombie-replay.ts --apply    # backup + write
 */
import { pool } from "@workspace/db";

const IDS = [2763, 2768, 2771, 2778, 2783, 2796, 2868];
const MARKER = "neon_zombie_replay_2026_10_29_v1";
const BACKUP = "tracked_signals_backup_neon_zombie_20261029";
const M15 = 15 * 60 * 1000;
const LIFETIME_MS = 4 * 24 * 60 * 60 * 1000;
const BU_AT = 8, FIRST_TARGET = 10, TRAIL_AT = 15, TRAIL_GAP = 10;
const APPLY = process.argv.includes("--apply");

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

async function main() {
  const { rows } = await pool.query(
    `SELECT id, symbol, status::text AS status, entry_price,
            (extract(epoch FROM detected_at AT TIME ZONE 'UTC') * 1000)::bigint::text AS detected_ms,
            stop_loss_pct, peak_price, exit_price, pnl_percent, closed_at::text AS closed_at_text, sentiment_key
       FROM tracked_signals WHERE id = ANY($1::int[]) ORDER BY id`, [IDS]);
  const plans: Array<{ row: Row; r: ReturnType<typeof replay> }> = [];
  for (const row of rows as Row[]) {
    if (row.sentiment_key !== "neon_support_bounce") { console.log(`${row.id} skipped: not ABNeon`); continue; }
    const start = Number(row.detected_ms);
    const end = Math.min(start + LIFETIME_MS, Date.now());
    const cs = await klines15m(row.symbol, start, end);
    if (!cs.length) { console.log(`${row.id} ${row.symbol} skipped: no candles`); continue; }
    const r = replay(row, cs);
    plans.push({ row, r });
    const entry = Number(row.entry_price);
    console.log(`${row.id} ${row.symbol} entry ${entry} detected ${new Date(start).toISOString()} candles ${cs.length}`);
    console.log(`   now:    ${row.status} pnl ${row.pnl_percent} closed ${row.closed_at_text ?? "-"}`);
    console.log(`   replay: ${r.status} pnl ${r.pnl.toFixed(4)} exit ${r.exitPrice} closed ${r.closedAt.toISOString()} peak ${(r.peak / entry * 100 - 100).toFixed(2)}% | ${r.evidence}`);
  }
  if (!APPLY) { console.log("\nread-only: nothing written (add --apply to write)"); await pool.end(); return; }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("CREATE TABLE IF NOT EXISTS neon_recalc_markers (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
    if ((await client.query("SELECT 1 FROM neon_recalc_markers WHERE name = $1", [MARKER])).rowCount) {
      console.log("already applied"); await client.query("COMMIT"); return;
    }
    await client.query(`CREATE TABLE IF NOT EXISTS ${BACKUP} (LIKE tracked_signals INCLUDING DEFAULTS)`);
    await client.query(`INSERT INTO ${BACKUP} SELECT * FROM tracked_signals WHERE id = ANY($1::int[])`, [plans.map((p) => p.row.id)]);
    for (const { row, r } of plans) {
      const entry = Number(row.entry_price);
      const peakPct = r.peak / entry * 100 - 100;
      // Only the row exactly as read (status and closed_at unchanged since).
      const res = await client.query(
        `UPDATE tracked_signals SET status = $2::tracked_status, exit_price = $3, pnl_percent = $4,
           closed_at = $5::timestamptz AT TIME ZONE 'UTC', peak_price = GREATEST($6, entry_price),
           last_milestone = $7, trailing_stop_level = $8, updated_at = now()
         WHERE id = $1 AND status::text = $9 AND closed_at::text IS NOT DISTINCT FROM $10`,
        [row.id, r.status, r.exitPrice, r.pnl, r.closedAt.toISOString(), r.peak, milestone(peakPct),
          r.status === "profit" && peakPct >= TRAIL_AT ? r.exitPrice : null, row.status, row.closed_at_text]);
      console.log(`${row.id} ${row.symbol}: ${res.rowCount ? "written" : "NOT written (row changed since read)"}`);
    }
    await client.query("INSERT INTO neon_recalc_markers (name) VALUES ($1)", [MARKER]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
