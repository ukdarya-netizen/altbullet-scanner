import { pool } from "@workspace/db";
import { ABNEON_MAX_ENTRY_ABOVE_TOP_PCT, LUCY_LONG_BARS, entryAboveZoneTopPct, firstTouchTime, touchVolumeNotGrey } from "./abneon-volume-gate.js";
import { findLowBounce } from "./abneon-low-bounce.js";
import { getKlinesRange } from "./bingx.js";
import { getAggFuturesVolumeByInterval } from "./coinglass_taker.js";
import { getAggSpotVolumeByInterval } from "./coinglass_spot_taker.js";

/**
 * Owner order 2026-11-12 (one-time, with Lucy's VSA rule and the entry-at-the-level rule): every OPEN ABNeon position
 * that the new rules would not have let through at its signal is closed neutrally — status 'reclassified', no exit,
 * no PnL; the tracker trigger sends cancel_entry to the trading bot.
 *   zone bounce: the touch 4H candle or one of the next two not grey by Lucy's VSA rule (futures + spot), and the
 *                1H bounce close not above the zone top;
 *   bounce from a fresh low: findLowBounce with Lucy's VSA rule finds the same trigger.
 * GRVT, ZEST and OKB are never touched (the owner keeps them). A row without its detector event is kept open.
 * A row whose market data could not be loaded is retried on the next start; after 3 starts it is kept open.
 * Every open row gets a verdict in abneon_lucy_level_review.
 *
 * It can never repeat (the Stealth lesson): marker abneon_lucy_level_close_20261112, and only rows detected before
 * ABNEON_LUCY_LEVEL_CUTOFF_UTC. Production only.
 */
export const ABNEON_LUCY_LEVEL_CLOSE_REASON = "abneon_lucy_vsa_entry_level_neutral_close";
const MARKER = "abneon_lucy_level_close_20261112";
export const ABNEON_LUCY_LEVEL_CUTOFF_UTC = "2026-11-13 00:00:00+00";
const KEEP_SYMBOLS = ["GRVT-USDT", "GRVTUSDT", "ZEST-USDT", "ZESTUSDT", "OKB-USDT", "OKBUSDT"];
const H1 = 3_600_000;
const H4 = 4 * H1;
const MAX_ATTEMPTS = 3;

type Candle = { time: number; open: number; high: number; low: number; close: number };
const toCandles = (rows: { time: number; open: string; high: string; low: string; close: string }[]): Candle[] =>
  rows.map((k) => ({ time: k.time, open: Number(k.open), high: Number(k.high), low: Number(k.low), close: Number(k.close) }));

type Verdict = { verdict: "pass" | "close" | "no_event" | "no_data"; detail: string; aboveTopPct: number | null; colours: string };

async function verdictFor(symbol: string, detectedAt: Date): Promise<Verdict> {
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
  if (!e || trig === null || Math.abs(det - trig) > 8 * H1) return { verdict: "no_event", detail: "no detector event", aboveTopPct: null, colours: "" };
  const arm = new Date(e.armed_at).getTime();
  const level = Number(e.frozen_level);
  const start4h = Math.min(arm, trig) - (LUCY_LONG_BARS + 20) * H4;
  const bars4h = Math.min(4500, Math.ceil((Date.now() - start4h) / H4) + 5);
  const [k4, fut, spot] = await Promise.all([
    getKlinesRange(symbol, "4h", start4h, trig + 3 * H4),
    getAggFuturesVolumeByInterval(symbol, "4h", bars4h, Date.now(), "low", 60_000).catch(() => null),
    getAggSpotVolumeByInterval(symbol, "4h", bars4h).catch(() => null),
  ]);
  if (!fut || k4.length === 0) return { verdict: "no_data", detail: !fut ? "no futures volume" : "no 4h candles", aboveTopPct: null, colours: "" };
  const c4 = toCandles(k4);

  if (e.low_bounce) {
    // The trigger is the 4H candle at trigger_candle_at: the bounce as the detector saw it at that close.
    const upTo = c4.filter((c) => c.time <= trig);
    const lb = findLowBounce({ candles4h: upTo, agg4hUsdByTime: fut, spot4hUsdByTime: spot });
    return lb && lb.triggerTime === trig
      ? { verdict: "pass", detail: "low bounce passes Lucy", aboveTopPct: null, colours: `${lb.lowColour}/${lb.colour}` }
      : { verdict: "close", detail: "low bounce grey by Lucy", aboveTopPct: null, colours: "" };
  }

  const k1 = await getKlinesRange(symbol, "1h", arm - 26 * H1, trig + 2 * H1);
  if (k1.length === 0) return { verdict: "no_data", detail: "no 1h candles", aboveTopPct: null, colours: "" };
  const c1 = toCandles(k1);
  const trigBar = c1.find((c) => c.time === trig);
  const above = trigBar ? entryAboveZoneTopPct(trigBar.close, level) : null;
  const aboveTopPct = above === null ? null : Math.round(above * 100) / 100;
  if (above === null) return { verdict: "no_data", detail: "no trigger candle", aboveTopPct, colours: "" };
  // The level rule alone decides when the entry is above the zone top (no volume needed).
  if (above > ABNEON_MAX_ENTRY_ABOVE_TOP_PCT) return { verdict: "close", detail: "entry above the zone top", aboveTopPct, colours: "" };
  // Lucy's rule on the touch 4H candle: as at the signal; if the touch 4H candle was still open then, as at its close
  // (the first run found 7 such rows — the touch candle closes after the 1H bounce).
  const gate = (nowMs: number) => touchVolumeNotGrey({
    candles1h: c1, candles4h: c4, agg4hUsdByTime: fut, spot4hUsdByTime: spot,
    armCandleTime: arm, triggerCandleTime: trig, zoneTop: level, nowMs,
  });
  let tv = gate(det);
  if (!tv.ok && tv.reason === "touch_bar_not_closed") {
    const touch = firstTouchTime(c1, arm, trig, level);
    if (touch !== null) tv = gate(Math.max(det, Math.floor(touch / H4) * H4 + H4));
  }
  const colours = tv.colours.join("");
  if (!tv.ok && tv.reason === "touch_bar_not_closed") return { verdict: "no_data", detail: "touch bar not closed", aboveTopPct, colours };
  if (!tv.ok) return { verdict: "close", detail: `touch ${tv.reason}`, aboveTopPct, colours };
  return { verdict: "pass", detail: "passes Lucy and the level", aboveTopPct, colours };
}

async function closeNeutral(trackedId: number, signalId: number): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('abneon_lucy_level_close'))");
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
      [trackedId, ABNEON_LUCY_LEVEL_CLOSE_REASON, ABNEON_LUCY_LEVEL_CUTOFF_UTC, KEEP_SYMBOLS],
    );
    if (updated.rows.length > 0) {
      await client.query(
        `UPDATE milestone_notification_deliveries
            SET status = 'abandoned', lease_until = NULL, claim_token = NULL, last_error = $2
          WHERE tracked_signal_id = $1 AND status IN ('ready', 'retry', 'failed')`,
        [trackedId, ABNEON_LUCY_LEVEL_CLOSE_REASON],
      );
      const relay = await client.query("SELECT to_regclass('public.trading_signal_deliveries') AS relation");
      if ((relay.rows[0] as { relation: string | null }).relation !== null) {
        await client.query(
          `UPDATE trading_signal_deliveries
              SET status = 'quarantined', claim_token = NULL, claim_until = NULL, last_error = $2
            WHERE source_signal_id = $1 AND status = 'pending'`,
          [signalId, ABNEON_LUCY_LEVEL_CLOSE_REASON],
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

export async function runAbneonLucyLevelNeutralClose(): Promise<{
  skipped?: string;
  reviewed: number;
  closed: string[];
  kept: string[];
  retry: string[];
}> {
  if (process.env.NODE_ENV !== "production") return { skipped: "not_production", reviewed: 0, closed: [], kept: [], retry: [] };
  await pool.query(
    `CREATE TABLE IF NOT EXISTS neon_recalc_markers (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`,
  );
  const done = await pool.query("SELECT 1 FROM neon_recalc_markers WHERE name = $1", [MARKER]);
  if (done.rows.length > 0) return { skipped: "already_applied", reviewed: 0, closed: [], kept: [], retry: [] };
  await pool.query(
    `CREATE TABLE IF NOT EXISTS abneon_lucy_level_review (
       tracked_id integer PRIMARY KEY,
       symbol text NOT NULL,
       status_before text NOT NULL,
       detected_at timestamptz,
       verdict text NOT NULL,
       detail text,
       entry_above_top_pct double precision,
       colours text,
       action text NOT NULL,
       attempts integer NOT NULL DEFAULT 1,
       reviewed_at timestamptz NOT NULL DEFAULT now()
     )`,
  );
  const rows = (
    await pool.query<{ id: number; signal_id: number; symbol: string; status: string; detected_at: Date }>(
      `SELECT id, signal_id, symbol, status::text AS status, detected_at
         FROM tracked_signals
        WHERE sentiment_key = 'neon_support_bounce'
          AND status::text IN ('active', 'in_run')
          AND detected_at < $1::timestamptz
          AND NOT (symbol = ANY($2::text[]))
        ORDER BY id`,
      [ABNEON_LUCY_LEVEL_CUTOFF_UTC, KEEP_SYMBOLS],
    )
  ).rows;
  const closed: string[] = [], kept: string[] = [], retry: string[] = [];
  for (const r of rows) {
    let v: Verdict;
    try {
      v = await verdictFor(r.symbol, r.detected_at);
    } catch (err) {
      v = { verdict: "no_data", detail: `error ${String(err).slice(0, 60)}`, aboveTopPct: null, colours: "" };
    }
    const prev = await pool.query<{ attempts: number }>("SELECT attempts FROM abneon_lucy_level_review WHERE tracked_id = $1", [r.id]);
    const attempts = (prev.rows[0]?.attempts ?? 0) + 1;
    let action: string;
    if (v.verdict === "close") {
      action = (await closeNeutral(r.id, r.signal_id)) ? "closed_neutral" : "already_closed_meanwhile";
      if (action === "closed_neutral") closed.push(`${r.symbol} #${r.id}`);
    } else if (v.verdict === "no_data" && attempts < MAX_ATTEMPTS) {
      action = "retry_next_start";
      retry.push(`${r.symbol} #${r.id}`);
    } else {
      action = "kept_open";
      kept.push(`${r.symbol} #${r.id}`);
    }
    await pool.query(
      `INSERT INTO abneon_lucy_level_review
         (tracked_id, symbol, status_before, detected_at, verdict, detail, entry_above_top_pct, colours, action, attempts, reviewed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now())
       ON CONFLICT (tracked_id) DO UPDATE SET
         verdict = EXCLUDED.verdict, detail = EXCLUDED.detail, entry_above_top_pct = EXCLUDED.entry_above_top_pct,
         colours = EXCLUDED.colours, action = EXCLUDED.action, attempts = EXCLUDED.attempts, reviewed_at = now()
       WHERE abneon_lucy_level_review.action <> 'closed_neutral'`,
      [r.id, r.symbol, r.status, r.detected_at, v.verdict, v.detail, v.aboveTopPct, v.colours, action, attempts],
    );
  }
  if (retry.length === 0) {
    await pool.query("INSERT INTO neon_recalc_markers (name) VALUES ($1) ON CONFLICT DO NOTHING", [MARKER]);
  }
  return { reviewed: rows.length, closed, kept, retry };
}
