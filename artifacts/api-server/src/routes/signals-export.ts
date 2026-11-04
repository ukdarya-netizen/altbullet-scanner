/**
 * Our signals with every metric recorded at the signal (owner 2026-11-04: analysis on our own
 * signals, by name — Impulse Buy, Stealth, ABNeon, Liquidation Cascade). One row per tracked
 * signal of the last `days` days (default 30): pattern, status, entry, peak and worst move so far
 * (open signals included: a signal that already went +10% counts as good), stop, result, every
 * entry_* column, the decision metrics (dm_*), Impulse decision metrics (idm_*), VSA (vsa_*) and
 * Wyckoff (wy_*) readings. Owner only; the dashboard turns it into a CSV file.
 */
import { Router, type IRouter } from "express";
import { pool } from "@workspace/db";
import { requireAdminToken } from "../middleware/adminAuth.js";
import { entryReadingsCoverage } from "../lib/entry-readings.js";

const router: IRouter = Router();

/** Flattens a JSON object into prefixed columns, `depth` levels deep; deeper values and arrays stay JSON text. */
export function flatten(prefix: string, v: unknown, out: Record<string, unknown>, depth = 1): void {
  if (v === null || v === undefined) return;
  if (typeof v !== "object" || Array.isArray(v)) { out[prefix] = Array.isArray(v) ? JSON.stringify(v) : v; return; }
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    if (x !== null && typeof x === "object" && !Array.isArray(x) && depth > 1) flatten(`${prefix}_${k}`, x, out, depth - 1);
    else out[`${prefix}_${k}`] = x !== null && typeof x === "object" ? JSON.stringify(x) : x;
  }
}

const JSON_COLS: Record<string, string> = { decision_metrics: "dm", impulse_decision_metrics: "idm", entry_metrics_provenance: "prov" };
const SKIP = new Set(["take_targets", "protected_close_evidence", "entry_score_breakdown", "health_sent_types"]);

/** Optional tables (VSA, Wyckoff, drawdown) are joined only when they exist in this database. */
async function existing(names: string[]): Promise<Set<string>> {
  const r = await pool.query<{ name: string }>(
    "SELECT name FROM unnest($1::text[]) AS name WHERE to_regclass('public.' || name) IS NOT NULL", [names]);
  return new Set(r.rows.map((x) => x.name));
}

router.get("/signals-export", requireAdminToken, async (req, res) => {
  try {
    const days = Math.min(120, Math.max(1, Math.round(Number(req.query.days)) || 30));
    const have = await existing(["signal_drawdown_extrema", "vsa_entry_metrics", "wyckoff_entry_metrics"]);
    const sel = ["t.*"], joins: string[] = [];
    if (have.has("signal_drawdown_extrema")) { sel.push("d.min_pct_from_entry AS worst_pct"); joins.push("LEFT JOIN signal_drawdown_extrema d ON d.signal_id = t.id"); }
    if (have.has("vsa_entry_metrics")) { sel.push("v.metrics AS vsa"); joins.push("LEFT JOIN vsa_entry_metrics v ON v.tracked_signal_id = t.id"); }
    if (have.has("wyckoff_entry_metrics")) { sel.push("w.metrics AS wy"); joins.push("LEFT JOIN wyckoff_entry_metrics w ON w.tracked_signal_id = t.id"); }
    const { rows } = await pool.query(
      `SELECT ${sel.join(", ")} FROM tracked_signals t ${joins.join(" ")}
       WHERE t.detected_at > now() - ($1::int * interval '1 day') ORDER BY t.detected_at DESC`, [days]);
    const flat = rows.map((r) => {
      const o: Record<string, unknown> = {};
      const entry = Number(r.entry_price), peak = Number(r.peak_price);
      o.peak_pct = entry > 0 && peak > 0 ? Math.round(((r.is_short ? entry / peak - 1 : peak / entry - 1) * 100) * 100) / 100 : null;
      for (const [k, v] of Object.entries(r)) {
        if (SKIP.has(k) || k === "vsa" || k === "wy") continue;
        if (JSON_COLS[k]) { flatten(JSON_COLS[k]!, v, o); continue; }
        o[k] = v instanceof Date ? v.toISOString() : typeof v === "bigint" ? Number(v) : v !== null && typeof v === "object" ? JSON.stringify(v) : v;
      }
      flatten("vsa", r.vsa, o, 2);
      flatten("wy", r.wy, o, 2);
      return o;
    });
    const first = ["id", "symbol", "sentiment_key", "sentiment", "stealth_detection_method", "is_short", "status", "detected_at", "closed_at",
      "entry_price", "peak_pct", "worst_pct", "stop_loss_pct", "pnl_percent", "core_pnl_percent", "runner_pnl_percent", "cancel_reason"];
    const all = new Set<string>();
    for (const o of flat) for (const k of Object.keys(o)) all.add(k);
    const columns = [...first.filter((c) => all.has(c)), ...[...all].filter((c) => !first.includes(c)).sort()];
    res.setHeader("Cache-Control", "no-store");
    res.json({ days, joined: [...have], columns, rows: flat.map((o) => columns.map((c) => o[c] ?? null)) });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message.slice(0, 400) : String(e) });
  }
});

/** How many signals already have VSA / Wyckoff at the entry, per pattern (owner 2026-11-04). */
router.get("/signals-export/coverage", requireAdminToken, async (_req, res) => {
  try {
    res.setHeader("Cache-Control", "no-store");
    res.json(await entryReadingsCoverage());
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message.slice(0, 400) : String(e) });
  }
});

export default router;
