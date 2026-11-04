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

const router: IRouter = Router();

/** Flattens one level of a JSON object into prefixed columns; deeper values stay JSON text. */
export function flatten(prefix: string, v: unknown, out: Record<string, unknown>): void {
  if (v === null || v === undefined) return;
  if (typeof v !== "object" || Array.isArray(v)) { out[prefix] = Array.isArray(v) ? JSON.stringify(v) : v; return; }
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    out[`${prefix}_${k}`] = x !== null && typeof x === "object" ? JSON.stringify(x) : x;
  }
}

const JSON_COLS: Record<string, string> = { decision_metrics: "dm", impulse_decision_metrics: "idm", entry_metrics_provenance: "prov" };
const SKIP = new Set(["take_targets", "protected_close_evidence", "entry_score_breakdown", "health_sent_types"]);

router.get("/signals-export", requireAdminToken, async (req, res) => {
  const days = Math.min(120, Math.max(1, Number(req.query.days) || 30));
  const { rows } = await pool.query(
    `SELECT t.*, d.min_pct_from_entry AS worst_pct, v.metrics AS vsa, w.metrics AS wy
     FROM tracked_signals t
     LEFT JOIN signal_drawdown_extrema d ON d.signal_id = t.id
     LEFT JOIN vsa_entry_metrics v ON v.tracked_signal_id = t.id
     LEFT JOIN wyckoff_entry_metrics w ON w.tracked_signal_id = t.id
     WHERE t.detected_at > now() - make_interval(days => $1)
     ORDER BY t.detected_at DESC`, [days]);
  const flat = rows.map((r) => {
    const o: Record<string, unknown> = {};
    const entry = Number(r.entry_price), peak = Number(r.peak_price);
    o.peak_pct = entry > 0 && peak > 0 ? Math.round(((r.is_short ? entry / peak - 1 : peak / entry - 1) * 100) * 100) / 100 : null;
    for (const [k, v] of Object.entries(r)) {
      if (SKIP.has(k) || k === "vsa" || k === "wy") continue;
      if (JSON_COLS[k]) { flatten(JSON_COLS[k]!, v, o); continue; }
      o[k] = v instanceof Date ? v.toISOString() : v !== null && typeof v === "object" ? JSON.stringify(v) : v;
    }
    flatten("vsa", r.vsa, o);
    flatten("wy", r.wy, o);
    return o;
  });
  const first = ["id", "symbol", "sentiment_key", "sentiment", "stealth_detection_method", "is_short", "status", "detected_at", "closed_at",
    "entry_price", "peak_pct", "worst_pct", "stop_loss_pct", "pnl_percent", "core_pnl_percent", "runner_pnl_percent", "cancel_reason"];
  const all = new Set<string>();
  for (const o of flat) for (const k of Object.keys(o)) all.add(k);
  const columns = [...first.filter((c) => all.has(c)), ...[...all].filter((c) => !first.includes(c)).sort()];
  res.setHeader("Cache-Control", "no-store");
  res.json({ days, columns, rows: flat.map((o) => columns.map((c) => o[c] ?? null)) });
});

export default router;
