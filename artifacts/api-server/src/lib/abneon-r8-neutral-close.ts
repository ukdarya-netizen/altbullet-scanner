import { pool } from "@workspace/db";
import { LUCY_LONG_BARS, touchVolumeNotGrey } from "./abneon-volume-gate.js";
import { ABNEON_RULE_VERSION, resistancesAbove, ruleEntryOnArm } from "./abneon-rule-entry.js";
import { computeSupportZones, resolveFrozenZone } from "./stealth-abneon-detectors.js";
import { getKlinesRange } from "./bingx.js";
import { getAggFuturesVolumeByInterval } from "./coinglass_taker.js";
import { getAggSpotVolumeByInterval } from "./coinglass_spot_taker.js";

/**
 * Owner order 2026-11-12 (one-time, with the R8 entry — lib/abneon-rule-entry.ts): every OPEN ABNeon position is
 * checked against the new rules as at its signal:
 *   - zone bounce: R8 on the detector's arm gives an entry within 1 hour of the position's signal → it passes and
 *     gets the new exit (take at the nearest resistance: decision_metrics.neonLevel.resistances + rule version);
 *     otherwise (no R8 entry, a voided arm, or an R8 entry at another time) → closed neutrally;
 *   - bounce from a fresh low: not part of the new rules → closed neutrally.
 * Neutral close = status 'reclassified', no exit, no PnL (backup in decision_metrics.beforeNeutralClose); the tracker
 * trigger sends cancel_entry to the trading bot.
 * GRVT, ZEST and OKB are never touched (the owner keeps them). A row without its detector event is kept open.
 * A row whose market data could not be loaded is retried on the next start; after 3 starts it is kept open.
 * Every open row gets its verdict in decision_metrics.abneonR8Review (no new table: a runtime table would make the
 * publish propose DROP).
 *
 * It can never repeat (the Stealth lesson): marker abneon_r8_close_20261112, and only rows detected before
 * ABNEON_R8_CUTOFF_UTC. Production only. Replaces the Lucy / 1%-level one-time close (its call is removed).
 */
export const ABNEON_R8_CLOSE_REASON = "abneon_r8_rules_neutral_close";
const MARKER = "abneon_r8_close_20261112";
export const ABNEON_R8_CUTOFF_UTC = "2026-11-14 00:00:00+00";
const KEEP_SYMBOLS = ["GRVT-USDT", "GRVTUSDT", "ZEST-USDT", "ZESTUSDT", "OKB-USDT", "OKBUSDT"];
const H1 = 3_600_000;
const H4 = 4 * H1;
const MAX_ATTEMPTS = 3;

type Candle = { time: number; open: number; high: number; low: number; close: number; volume: number };
const toCandles = (rows: { time: number; open: string; high: string; low: string; close: string; volume: string }[]): Candle[] =>
  rows.map((k) => ({ time: k.time, open: Number(k.open), high: Number(k.high), low: Number(k.low), close: Number(k.close), volume: Number(k.volume) }));

type Verdict = {
  verdict: "pass" | "close" | "no_event" | "no_data";
  detail: string;
  r8EntryAt: number | null;
  resistances: number[] | null;
};

async function verdictFor(symbol: string, detectedAt: Date, lowBounceRow: boolean): Promise<Verdict> {
  if (lowBounceRow) return { verdict: "close", detail: "bounce from a fresh low (not in the new rules)", r8EntryAt: null, resistances: null };
  const det = new Date(detectedAt).getTime();
  const ev = await pool.query<{ frozen_level: number; armed_at: Date; trigger_candle_at: Date; low_bounce: boolean }>(
    `SELECT frozen_level, armed_at, trigger_candle_at,
            (volume_evidence #> '{detectorEvidence,lowBounce}') IS NOT NULL AS low_bounce
       FROM stealth_abneon_shadow_candidates
      WHERE symbol = $1 AND detection_method = 'abneon_support_bounce' AND trigger_candle_at IS NOT NULL
        AND trigger_candle_at <= to_timestamp($2 / 1000.0) + interval '2 hours'
      ORDER BY trigger_candle_at DESC LIMIT 1`,
    [symbol, det],
  );
  const e = ev.rows[0];
  const trig = e ? new Date(e.trigger_candle_at).getTime() : null;
  if (!e || trig === null || Math.abs(det - trig) > 8 * H1) return { verdict: "no_event", detail: "no detector event", r8EntryAt: null, resistances: null };
  if (e.low_bounce) return { verdict: "close", detail: "bounce from a fresh low (not in the new rules)", r8EntryAt: null, resistances: null };
  const arm = new Date(e.armed_at).getTime();
  const level = Number(e.frozen_level);
  const end = Math.min(Date.now(), arm + 50 * H1);
  const start4h = arm - 700 * H4;
  const bars4h = Math.min(4500, Math.ceil((Date.now() - (arm - (LUCY_LONG_BARS + 20) * H4)) / H4) + 5);
  const [k4, k1, fut, spot] = await Promise.all([
    getKlinesRange(symbol, "4h", start4h, end),
    getKlinesRange(symbol, "1h", arm - 2 * H1, end),
    getAggFuturesVolumeByInterval(symbol, "4h", bars4h, Date.now(), "low", 60_000).catch(() => null),
    getAggSpotVolumeByInterval(symbol, "4h", bars4h).catch(() => null),
  ]);
  if (!fut || k4.length === 0 || k1.length === 0) {
    return { verdict: "no_data", detail: !fut ? "no futures volume" : "no candles", r8EntryAt: null, resistances: null };
  }
  const c4 = toCandles(k4), c1 = toCandles(k1);
  const zone = resolveFrozenZone(c4.filter((c) => c.time + H4 <= arm + H1), arm, level);
  const rule = await ruleEntryOnArm({
    candles1h: c1,
    candles4h: c4,
    zone: { bottom: zone.bottom, top: zone.top },
    armTime: arm,
    nowMs: end,
    lucy: async (triggerCandleTime, closeAt) => touchVolumeNotGrey({
      candles1h: c1, candles4h: c4, agg4hUsdByTime: fut, spot4hUsdByTime: spot,
      armCandleTime: arm, triggerCandleTime, zoneTop: level, nowMs: closeAt,
    }),
  });
  if (rule.status === "waiting") {
    return rule.reason === "awaiting_touch_4h_close"
      ? { verdict: "no_data", detail: "touch 4H candle not closed", r8EntryAt: null, resistances: null }
      : { verdict: "close", detail: `no R8 entry (${rule.reason})`, r8EntryAt: null, resistances: null };
  }
  if (rule.status === "void") return { verdict: "close", detail: `R8 void: ${rule.reason}`, r8EntryAt: null, resistances: null };
  // The position's signal is the close of its trigger 1H candle (trig + 1h); R8 must enter within an hour of it.
  if (Math.abs(rule.closeAt - (trig + H1)) > H1) {
    return { verdict: "close", detail: `R8 entry at another time (${new Date(rule.closeAt).toISOString()})`, r8EntryAt: rule.closeAt, resistances: null };
  }
  const zonesAtSignal = computeSupportZones(c4.filter((c) => c.time + H4 <= trig + H1));
  return { verdict: "pass", detail: "passes R8", r8EntryAt: rule.closeAt, resistances: resistancesAbove(zonesAtSignal, zone.top) };
}

async function closeNeutral(trackedId: number, signalId: number): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('abneon_r8_close'))");
    const updated = await client.query(
      `UPDATE tracked_signals AS t
          SET decision_metrics = CASE
                WHEN COALESCE(t.decision_metrics, '{}'::jsonb) ? 'beforeNeutralClose' THEN t.decision_metrics
                ELSE COALESCE(t.decision_metrics, '{}'::jsonb) || jsonb_build_object('beforeNeutralClose', jsonb_build_object(
                  'status', t.status::text, 'pnlPercent', t.pnl_percent, 'exitPrice', t.exit_price,
                  'closedAt', t.closed_at, 'peakPrice', t.peak_price, 'cancelReason', t.cancel_reason,
                  'reason', $2::text, 'at', NOW()))
              END,
              status = 'reclassified', cancel_reason = $2::text,
              exit_price = NULL, pnl_percent = NULL, closed_at = NULL,
              trailing_stop_level = NULL, trailing_stop_armed_at = NULL, last_smart_cancel_check_at = NULL,
              pending_milestone = NULL, pending_milestone_kind = NULL, pending_milestone_price = NULL,
              pending_milestone_trailing_stop = NULL, pending_milestone_status = NULL,
              pending_milestone_lease_until = NULL,
              updated_at = NOW()
        WHERE t.id = $1
          AND t.sentiment_key = 'neon_support_bounce'
          AND t.status::text IN ('active', 'in_run')
          AND t.detected_at < $3::timestamptz
          AND NOT (t.symbol = ANY($4::text[]))
        RETURNING t.id`,
      [trackedId, ABNEON_R8_CLOSE_REASON, ABNEON_R8_CUTOFF_UTC, KEEP_SYMBOLS],
    );
    if (updated.rows.length > 0) {
      await client.query(
        `UPDATE milestone_notification_deliveries
            SET status = 'abandoned', lease_until = NULL, claim_token = NULL, last_error = $2
          WHERE tracked_signal_id = $1 AND status IN ('ready', 'retry', 'failed')`,
        [trackedId, ABNEON_R8_CLOSE_REASON],
      );
      const relay = await client.query("SELECT to_regclass('public.trading_signal_deliveries') AS relation");
      if ((relay.rows[0] as { relation: string | null }).relation !== null) {
        await client.query(
          `UPDATE trading_signal_deliveries
              SET status = 'quarantined', claim_token = NULL, claim_until = NULL, last_error = $2
            WHERE source_signal_id = $1 AND status = 'pending'`,
          [signalId, ABNEON_R8_CLOSE_REASON],
        );
      }
    }
    await client.query("COMMIT");
    return updated.rows.length > 0;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/** A passing position gets the new exit: the take at the nearest resistance (the watcher reads it). */
async function attachNewExit(trackedId: number, resistances: number[]): Promise<boolean> {
  const updated = await pool.query(
    `UPDATE tracked_signals
        SET decision_metrics = jsonb_set(
              COALESCE(decision_metrics, '{}'::jsonb),
              '{neonLevel}',
              COALESCE(decision_metrics->'neonLevel', '{}'::jsonb)
                || jsonb_build_object('resistances', $2::jsonb, 'rule', $3::text, 'ruleAttachedAt', NOW()),
              true),
            updated_at = NOW()
      WHERE id = $1 AND sentiment_key = 'neon_support_bounce' AND status::text IN ('active', 'in_run')
      RETURNING id`,
    [trackedId, JSON.stringify(resistances), ABNEON_RULE_VERSION],
  );
  return updated.rows.length > 0;
}

export async function runAbneonR8NeutralClose(): Promise<{
  skipped?: string;
  reviewed: number;
  closed: string[];
  passed: string[];
  kept: string[];
  retry: string[];
}> {
  if (process.env.NODE_ENV !== "production") return { skipped: "not_production", reviewed: 0, closed: [], passed: [], kept: [], retry: [] };
  await pool.query(
    `CREATE TABLE IF NOT EXISTS neon_recalc_markers (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`,
  );
  const done = await pool.query("SELECT 1 FROM neon_recalc_markers WHERE name = $1", [MARKER]);
  if (done.rows.length > 0) return { skipped: "already_applied", reviewed: 0, closed: [], passed: [], kept: [], retry: [] };
  const rows = (
    await pool.query<{ id: number; signal_id: number; symbol: string; status: string; detected_at: Date; low_bounce: boolean; attempts: number }>(
      `SELECT id, signal_id, symbol, status::text AS status, detected_at,
              COALESCE((decision_metrics #>> '{neonLevel,lowBounce}')::boolean, false) AS low_bounce,
              COALESCE((decision_metrics #>> '{abneonR8Review,attempts}')::int, 0) AS attempts
         FROM tracked_signals
        WHERE sentiment_key = 'neon_support_bounce'
          AND status::text IN ('active', 'in_run')
          AND detected_at < $1::timestamptz
          AND NOT (symbol = ANY($2::text[]))
          AND COALESCE(decision_metrics #>> '{neonLevel,rule}', '') <> $3
        ORDER BY id`,
      [ABNEON_R8_CUTOFF_UTC, KEEP_SYMBOLS, ABNEON_RULE_VERSION],
    )
  ).rows;
  const closed: string[] = [], passed: string[] = [], kept: string[] = [], retry: string[] = [];
  for (const r of rows) {
    let v: Verdict;
    try {
      v = await verdictFor(r.symbol, r.detected_at, r.low_bounce);
    } catch (err) {
      v = { verdict: "no_data", detail: `error ${String(err).slice(0, 60)}`, r8EntryAt: null, resistances: null };
    }
    const attempts = r.attempts + 1;
    let action: string;
    if (v.verdict === "close") {
      action = (await closeNeutral(r.id, r.signal_id)) ? "closed_neutral" : "already_closed_meanwhile";
      if (action === "closed_neutral") closed.push(`${r.symbol} #${r.id}`);
    } else if (v.verdict === "pass") {
      action = (await attachNewExit(r.id, v.resistances ?? [])) ? "new_exit_attached" : "already_closed_meanwhile";
      if (action === "new_exit_attached") passed.push(`${r.symbol} #${r.id}`);
    } else if (v.verdict === "no_data" && attempts < MAX_ATTEMPTS) {
      action = "retry_next_start";
      retry.push(`${r.symbol} #${r.id}`);
    } else {
      action = "kept_open";
      kept.push(`${r.symbol} #${r.id}`);
    }
    await pool.query(
      `UPDATE tracked_signals
          SET decision_metrics = COALESCE(decision_metrics, '{}'::jsonb) || jsonb_build_object('abneonR8Review', jsonb_build_object(
                'verdict', $2::text, 'detail', $3::text, 'r8EntryAt', $4::double precision, 'action', $5::text,
                'attempts', $6::int, 'at', NOW()))
        WHERE id = $1`,
      [r.id, v.verdict, v.detail, v.r8EntryAt, action, attempts],
    );
  }
  if (retry.length === 0) {
    await pool.query("INSERT INTO neon_recalc_markers (name) VALUES ($1) ON CONFLICT DO NOTHING", [MARKER]);
  }
  return { reviewed: rows.length, closed, passed, kept, retry };
}
