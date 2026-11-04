import { db } from "@workspace/db";
import { withAggregatedKlineVolume } from "./aggregated-kline-volume.js";
import { sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { getKlinesRange, type BingXKline } from "./bingx.js";
import { logger } from "./logger.js";

const TABLE = "lc_rapid_rebound_observations";
const BAR_MS = 5 * 60_000;
const SCAN_BARS = 6;
const MAX_PER_CYCLE = 4;
const MAX_ATTEMPTS = 8;
const LEASE_MS = 5 * 60_000;
const RETRY_MS = 5 * 60_000;
const FORWARD_MINUTES = [15, 30, 60, 120] as const;
export const RAPID_REBOUND_METHODOLOGY =
  "Observation-only. Detect-time BingX perpetual price snapshots are frozen separately from CoinGlass cross-exchange liquidation estimates and closed BingX perpetual 5m OHLCV evidence. The candidate window is the six 5m bars anchored at the watch bar. A wick requires prior-close-to-low >=3%, close >=1.5% above low, and volume >=3x the median volume of the preceding six closed bars. Present cases measure forward OHLC MFE/MAE and close returns from the wick-confirmation candle close; absent controls use the close of the last closed scan-window bar as their forward baseline. Both use contiguous CLOSED BingX 5m candles for equal 15/30/60/120m horizons; gaps are unknown. No future candles or outcomes are used as entry features. CoinGlass liquidation values and rebound timing overlap observationally and do not establish causality.";

export interface RapidReboundCandle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
}

function numeric(value: string | number | null | undefined): number | null {
  if (value == null || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function normalizeRapidReboundCandle(
  candle: BingXKline,
): RapidReboundCandle | null {
  const open = numeric(candle.open);
  const high = numeric(candle.high);
  const low = numeric(candle.low);
  const close = numeric(candle.close);
  const volume = numeric(candle.volume);
  if (
    open === null ||
    high === null ||
    low === null ||
    close === null ||
    !Number.isFinite(candle.time)
  ) {
    return null;
  }
  return { time: candle.time, open, high, low, close, volume };
}

export function evaluateRapidReboundWick(
  candles: RapidReboundCandle[],
  detectedAt: number,
  now: number,
): {
  state: "present" | "absent" | "unknown" | "pending";
  confirmedAt: number | null;
  low: number | null;
  close: number | null;
  volumeMultiple: number | null;
  rawWindow: RapidReboundCandle[];
  reason: string | null;
} {
  const start = Math.floor(detectedAt / BAR_MS) * BAR_MS;
  const scanEnd = start + SCAN_BARS * BAR_MS;
  const byTime = new Map(
    candles
      .filter((candle) => candle.time + BAR_MS <= now)
      .map((candle) => [candle.time, candle]),
  );
  const rawWindow: RapidReboundCandle[] = [];
  for (let time = start - 6 * BAR_MS; time < scanEnd; time += BAR_MS) {
    const candle = byTime.get(time);
    if (candle) rawWindow.push(candle);
  }
  if (now < scanEnd) {
    return {
      state: "pending",
      confirmedAt: null,
      low: null,
      close: null,
      volumeMultiple: null,
      rawWindow,
      reason: "watch_window_not_closed",
    };
  }

  for (let time = start; time < scanEnd; time += BAR_MS) {
    const candle = byTime.get(time);
    const previous = byTime.get(time - BAR_MS);
    if (!candle || !previous) {
      return {
        state: "unknown",
        confirmedAt: null,
        low: null,
        close: null,
        volumeMultiple: null,
        rawWindow,
        reason: "closed_candle_gap",
      };
    }
    const priorVolumes: number[] = [];
    let priorVolumeMissing = false;
    for (let offset = 1; offset <= 6; offset += 1) {
      const prior = byTime.get(time - offset * BAR_MS);
      if (!prior) {
        return {
          state: "unknown",
          confirmedAt: null,
          low: null,
          close: null,
          volumeMultiple: null,
          rawWindow,
          reason: "prior_candle_gap",
        };
      }
      if (prior.volume === null || prior.volume < 0) priorVolumeMissing = true;
      else priorVolumes.push(prior.volume);
    }
    const priorCloseDropPct =
      ((previous.close - candle.low) / previous.close) * 100;
    const reboundFromLowPct = ((candle.close - candle.low) / candle.low) * 100;
    if (priorCloseDropPct < 3 || reboundFromLowPct < 1.5) continue;
    if (
      priorVolumeMissing ||
      candle.volume === null ||
      priorVolumes.length !== 6
    ) {
      return {
        state: "unknown",
        confirmedAt: null,
        low: candle.low,
        close: candle.close,
        volumeMultiple: null,
        rawWindow,
        reason: "volume_unavailable",
      };
    }
    const orderedVolumes = [...priorVolumes].sort(
      (left, right) => left - right,
    );
    const median = (orderedVolumes[2]! + orderedVolumes[3]!) / 2;
    if (median <= 0) {
      return {
        state: "unknown",
        confirmedAt: null,
        low: candle.low,
        close: candle.close,
        volumeMultiple: null,
        rawWindow,
        reason: "prior_volume_median_unavailable",
      };
    }
    const volumeMultiple = candle.volume / median;
    if (volumeMultiple >= 3) {
      return {
        state: "present",
        confirmedAt: time + BAR_MS,
        low: candle.low,
        close: candle.close,
        volumeMultiple,
        rawWindow,
        reason: null,
      };
    }
  }
  return {
    state: "absent",
    confirmedAt: null,
    low: null,
    close: null,
    volumeMultiple: null,
    rawWindow,
    reason: null,
  };
}

export type RapidReboundForwardOutcome =
  | {
      status: "pending" | "unknown";
      reason: string;
      expectedCandles: number;
      observedCandles: number;
    }
  | {
      status: "complete";
      closeReturnPct: number;
      maxPct: number;
      minPct: number;
      expectedCandles: number;
      observedCandles: number;
      measuredFrom: string;
      measuredThrough: string;
      entryPrice: number;
    };

export function evaluateRapidReboundForward(
  candles: RapidReboundCandle[],
  confirmationCloseAt: number,
  entryPrice: number,
  now: number,
): {
  outcomes: Record<string, RapidReboundForwardOutcome>;
  allComplete: boolean;
  nextDueAt: number | null;
  rawWindow: RapidReboundCandle[];
} {
  const byTime = new Map(
    candles
      .filter((candle) => candle.time + BAR_MS <= now)
      .map((candle) => [candle.time, candle]),
  );
  const outcomes: Record<string, RapidReboundForwardOutcome> = {};
  const rawWindow = [...byTime.values()]
    .filter(
      (candle) =>
        candle.time >= confirmationCloseAt &&
        candle.time < confirmationCloseAt + 120 * 60_000,
    )
    .sort((left, right) => left.time - right.time);
  let allComplete = true;
  let nextDueAt: number | null = null;
  for (const minutes of FORWARD_MINUTES) {
    const count = minutes / 5;
    const deadline = confirmationCloseAt + minutes * 60_000;
    const window: RapidReboundCandle[] = [];
    for (let offset = 0; offset < count; offset += 1) {
      const candle = byTime.get(confirmationCloseAt + offset * BAR_MS);
      if (!candle) break;
      window.push(candle);
    }
    if (window.length !== count) {
      allComplete = false;
      if (now < deadline && (nextDueAt === null || deadline < nextDueAt)) {
        nextDueAt = deadline;
      }
      outcomes[String(minutes)] = {
        status: now < deadline ? "pending" : "unknown",
        reason:
          now < deadline ? "forward_window_not_closed" : "closed_candle_gap",
        expectedCandles: count,
        observedCandles: window.length,
      };
      continue;
    }
    outcomes[String(minutes)] = {
      status: "complete",
      closeReturnPct:
        ((window[count - 1]!.close - entryPrice) / entryPrice) * 100,
      maxPct:
        ((Math.max(...window.map((candle) => candle.high)) - entryPrice) /
          entryPrice) *
        100,
      minPct:
        ((Math.min(...window.map((candle) => candle.low)) - entryPrice) /
          entryPrice) *
        100,
      expectedCandles: count,
      observedCandles: count,
      measuredFrom: new Date(confirmationCloseAt).toISOString(),
      measuredThrough: new Date(deadline).toISOString(),
      entryPrice,
    };
  }
  return { outcomes, allComplete, nextDueAt, rawWindow };
}

export function chooseRapidReboundForwardAnchor(
  wick: {
    state: "present" | "absent" | "unknown" | "pending";
    confirmedAt: number | null;
    close: number | null;
  },
  candles: RapidReboundCandle[],
  scanEnd: number,
  now: number,
): { at: number; price: number } | null {
  if (
    wick.state === "present" &&
    wick.confirmedAt !== null &&
    wick.close !== null
  ) {
    return { at: wick.confirmedAt, price: wick.close };
  }
  if (wick.state !== "absent" || now < scanEnd) return null;
  const finalScanBar = candles.find(
    (candle) => candle.time === scanEnd - BAR_MS && candle.time + BAR_MS <= now,
  );
  return finalScanBar ? { at: scanEnd, price: finalScanBar.close } : null;
}

export function rapidReboundRetryDisposition(
  failureAttempts: number,
  cause: "pending" | "gap" | "error",
): { status: "pending" | "unavailable"; nextFailureAttempts: number } {
  if (cause === "pending") {
    return { status: "pending", nextFailureAttempts: failureAttempts };
  }
  const nextFailureAttempts = failureAttempts + 1;
  return {
    status: nextFailureAttempts >= MAX_ATTEMPTS ? "unavailable" : "pending",
    nextFailureAttempts,
  };
}

export async function ensureLcRapidReboundSchema(): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext('lc_rapid_rebound_schema'))`,
    );
    await tx.execute(sql`
      CREATE TABLE IF NOT EXISTS ${sql.raw(TABLE)} (
        watch_id integer PRIMARY KEY,
        symbol text NOT NULL,
        detected_at timestamptz NOT NULL,
        watch_reason text,
        snapshot_source text NOT NULL DEFAULT 'bingx_perpetual_coinglass_liquidation',
        detect_snapshot jsonb NOT NULL,
        status text NOT NULL DEFAULT 'pending',
        wick_state text NOT NULL DEFAULT 'unknown',
        wick_confirmed_at timestamptz,
        wick_low double precision,
        wick_close double precision,
        volume_multiple double precision,
        wick_window jsonb,
        forward_anchor_at timestamptz,
        forward_anchor_price double precision,
        forward_window jsonb,
        coverage jsonb,
        forward_outcomes jsonb,
        next_retry_at timestamptz NOT NULL DEFAULT now(),
        lease_until timestamptz,
        claim_token text,
        attempts integer NOT NULL DEFAULT 0,
        failure_attempts integer NOT NULL DEFAULT 0,
        last_error text,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await tx.execute(sql`
      ALTER TABLE ${sql.raw(TABLE)}
      ADD COLUMN IF NOT EXISTS forward_anchor_at timestamptz,
      ADD COLUMN IF NOT EXISTS forward_anchor_price double precision,
      ADD COLUMN IF NOT EXISTS forward_window jsonb,
      ADD COLUMN IF NOT EXISTS failure_attempts integer NOT NULL DEFAULT 0
    `);
    await tx.execute(sql`
      ALTER TABLE ${sql.raw(TABLE)}
      ALTER COLUMN snapshot_source
      SET DEFAULT 'bingx_perpetual_coinglass_liquidation'
    `);
    await tx.execute(sql`
      UPDATE ${sql.raw(TABLE)}
      SET snapshot_source = 'bingx_perpetual_coinglass_liquidation',
          detect_snapshot = (detect_snapshot - 'source') || jsonb_build_object(
            'priceSource', 'bingx_perpetual',
            'candleSource', 'bingx_perpetual',
            'liquidationUsdSource', 'coinglass_cross_exchange_estimate',
            'liquidationOrderStreamSource', 'cross_exchange_rolling_15m'
          )
      WHERE snapshot_source = 'bingx_perpetual_watch'
         OR detect_snapshot ? 'source'
    `);
    await tx.execute(sql`
      CREATE INDEX IF NOT EXISTS lc_rapid_rebound_due_idx
      ON ${sql.raw(TABLE)} (status, next_retry_at, lease_until)
    `);
    await tx.execute(sql`
      CREATE INDEX IF NOT EXISTS lc_rapid_rebound_detected_idx
      ON ${sql.raw(TABLE)} (detected_at DESC)
    `);
  });
}

type ClaimedRow = {
  watch_id: number;
  symbol: string;
  detected_at: Date | string;
  watch_reason: string | null;
  detect_snapshot: Record<string, unknown>;
  status: string;
  attempts: number;
  failure_attempts: number;
  claim_token: string;
};

function asDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

async function processClaim(row: ClaimedRow): Promise<void> {
  const now = Date.now();
  const detectedAt = asDate(row.detected_at).getTime();
  const scanStart = Math.floor(detectedAt / BAR_MS) * BAR_MS;
  const scanEnd = scanStart + SCAN_BARS * BAR_MS;
  // Only the bounded forward window is relevant. Fetching up to "now" for a
  // 14-day-old watch would request thousands of needless 5m candles.
  const rangeEnd = Math.max(scanEnd, Math.min(now, scanEnd + 120 * 60_000));
  const rawCandles = await withAggregatedKlineVolume(
    row.symbol,
    "5m",
    await getKlinesRange(row.symbol, "5m", scanStart - 6 * BAR_MS, rangeEnd, {
      strictPayload: true,
    }),
  );
  const candles = rawCandles
    .map(normalizeRapidReboundCandle)
    .filter((candle): candle is RapidReboundCandle => candle !== null);
  const wick = evaluateRapidReboundWick(candles, detectedAt, now);
  if (wick.state === "pending") {
    await db.execute(sql`
      UPDATE ${sql.raw(TABLE)}
      SET next_retry_at = now() + (${RETRY_MS} * interval '1 millisecond'),
          coverage = ${JSON.stringify({ scanStart, scanEnd, reason: wick.reason })}::jsonb,
          wick_window = ${JSON.stringify(wick.rawWindow)}::jsonb,
          updated_at = now()
      WHERE watch_id = ${row.watch_id} AND claim_token = ${row.claim_token}
    `);
    return;
  }

  const scanHasGap =
    wick.reason === "closed_candle_gap" || wick.reason === "prior_candle_gap";
  if (scanHasGap) {
    const disposition = rapidReboundRetryDisposition(
      row.failure_attempts,
      "gap",
    );
    await db.execute(sql`
      UPDATE ${sql.raw(TABLE)}
      SET status = ${disposition.status},
          failure_attempts = ${disposition.nextFailureAttempts},
          wick_state = 'unknown',
          wick_window = ${JSON.stringify(wick.rawWindow)}::jsonb,
          coverage = ${JSON.stringify({ scanStart, scanEnd, complete: false, reason: wick.reason })}::jsonb,
          last_error = ${disposition.status === "unavailable" ? "closed_5m_candle_gap_after_retries" : wick.reason},
          next_retry_at = CASE WHEN ${disposition.status === "unavailable"} THEN 'infinity'::timestamptz
                               ELSE now() + (${RETRY_MS} * interval '1 millisecond') END,
          updated_at = now()
      WHERE watch_id = ${row.watch_id} AND claim_token = ${row.claim_token}
    `);
    return;
  }

  const anchor = chooseRapidReboundForwardAnchor(wick, candles, scanEnd, now);
  const forward =
    anchor === null
      ? null
      : evaluateRapidReboundForward(candles, anchor.at, anchor.price, now);
  const forwardComplete = forward?.allComplete ?? false;
  const readyAt = anchor === null ? null : anchor.at + 120 * 60_000;
  const futurePending = forward !== null && readyAt !== null && now < readyAt;
  const gapsAfterMaturity =
    forward !== null &&
    readyAt !== null &&
    now >= readyAt &&
    Object.values(forward.outcomes).some(
      (outcome) =>
        typeof outcome === "object" &&
        outcome !== null &&
        "reason" in outcome &&
        outcome.reason === "closed_candle_gap",
    );
  const disposition =
    gapsAfterMaturity && forward !== null
      ? rapidReboundRetryDisposition(row.failure_attempts, "gap")
      : null;
  const exhausted = disposition?.status === "unavailable";
  const status = exhausted
    ? "unavailable"
    : wick.state === "unknown" || (forward !== null && forwardComplete)
      ? "complete"
      : "pending";
  const nextRetryAt = futurePending
    ? new Date(readyAt!)
    : new Date(now + RETRY_MS);
  await db.execute(sql`
    UPDATE ${sql.raw(TABLE)}
    SET status = ${status},
        wick_state = ${wick.state},
        wick_confirmed_at = ${wick.confirmedAt === null ? null : new Date(wick.confirmedAt)},
        wick_low = ${wick.low},
        wick_close = ${wick.close},
        volume_multiple = ${wick.volumeMultiple},
        wick_window = ${JSON.stringify(wick.rawWindow)}::jsonb,
        forward_anchor_at = ${anchor === null ? null : new Date(anchor.at)},
        forward_anchor_price = ${anchor?.price ?? null},
        forward_window = ${forward === null ? null : JSON.stringify(forward.rawWindow)}::jsonb,
        coverage = ${JSON.stringify({
          scanStart,
          scanEnd,
          complete: true,
          closedCandles: candles.length,
          reason: wick.reason,
          forwardAnchorAt:
            anchor === null ? null : new Date(anchor.at).toISOString(),
          forwardAnchorPrice: anchor?.price ?? null,
        })}::jsonb,
        forward_outcomes = ${forward === null ? null : JSON.stringify(forward.outcomes)}::jsonb,
        failure_attempts = ${disposition?.nextFailureAttempts ?? row.failure_attempts},
        next_retry_at = CASE WHEN ${status} IN ('complete', 'unavailable')
                             THEN 'infinity'::timestamptz ELSE ${nextRetryAt} END,
        last_error = ${exhausted ? "forward_candle_gaps_after_retries" : gapsAfterMaturity ? "forward_closed_candle_gap" : wick.reason},
        updated_at = now()
    WHERE watch_id = ${row.watch_id} AND claim_token = ${row.claim_token}
  `);
}

export async function runLcRapidReboundCycle(): Promise<void> {
  await ensureLcRapidReboundSchema();
  await db.execute(sql`
    INSERT INTO ${sql.raw(TABLE)}
      (watch_id, symbol, detected_at, watch_reason, detect_snapshot)
    SELECT w.id, w.symbol, w.detected_at, w.entry_reason,
           jsonb_build_object(
              'priceSource', 'bingx_perpetual',
              'candleSource', 'bingx_perpetual',
              'liquidationUsdSource', 'coinglass_cross_exchange_estimate',
              'liquidationOrderStreamSource', 'cross_exchange_rolling_15m',
             'priceAtDetect', w.price_at_detect,
             'price24hAtDetect', w.price24h_at_detect,
             'price1hAtDetect', w.price1h_at_detect,
             'longLiq1hAtDetect', w.long_liq1h_at_detect,
             'longLiq4hAtDetect', w.long_liq4h_at_detect,
             'longLiq24hAtDetect', w.long_liq24h_at_detect,
             'liqOrdersCountAtDetect', w.liq_orders_count_at_detect,
             'liqOrdersUsdAtDetect', w.liq_orders_usd_at_detect
           )
    FROM liq_cascade_watch w
    WHERE w.detected_at >= now() - interval '14 days'
      AND NOT EXISTS (
        SELECT 1 FROM ${sql.raw(TABLE)} o WHERE o.watch_id = w.id
      )
    ORDER BY w.detected_at DESC
    LIMIT 500
    ON CONFLICT (watch_id) DO NOTHING
  `);
  const claimToken = randomUUID();
  const claimed = await db.execute<ClaimedRow>(sql`
    WITH due AS (
      SELECT watch_id
      FROM ${sql.raw(TABLE)}
      WHERE status = 'pending'
        AND next_retry_at <= now()
        AND (lease_until IS NULL OR lease_until < now())
      ORDER BY CASE WHEN attempts = 0 THEN 0 ELSE 1 END, detected_at DESC
      FOR UPDATE SKIP LOCKED
      LIMIT ${MAX_PER_CYCLE}
    )
    UPDATE ${sql.raw(TABLE)} o
    SET lease_until = now() + (${LEASE_MS} * interval '1 millisecond'),
        claim_token = ${claimToken},
        attempts = attempts + 1,
        updated_at = now()
    FROM due
    WHERE o.watch_id = due.watch_id
    RETURNING o.*
  `);
  const rows = claimed.rows ?? [];
  for (const row of rows) {
    try {
      await processClaim(row);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const disposition = rapidReboundRetryDisposition(
        row.failure_attempts,
        "error",
      );
      logger.warn(
        { watchId: row.watch_id, symbol: row.symbol, error: message },
        "LC rapid rebound observation retry",
      );
      await db.execute(sql`
        UPDATE ${sql.raw(TABLE)}
        SET status = ${disposition.status},
            failure_attempts = ${disposition.nextFailureAttempts},
            wick_state = 'unknown',
            last_error = ${message.slice(0, 1000)},
            next_retry_at = CASE WHEN ${disposition.status === "unavailable"} THEN 'infinity'::timestamptz
                                 ELSE now() + (${RETRY_MS} * interval '1 millisecond') END,
            updated_at = now()
        WHERE watch_id = ${row.watch_id} AND claim_token = ${row.claim_token}
      `);
    } finally {
      await db.execute(sql`
        UPDATE ${sql.raw(TABLE)}
        SET lease_until = NULL, claim_token = NULL, updated_at = now()
        WHERE watch_id = ${row.watch_id} AND claim_token = ${row.claim_token}
      `);
    }
  }
  logger.info(
    { claimed: rows.length },
    "LC rapid rebound observation cycle complete",
  );
}

type ReportRow = {
  watch_id: number;
  symbol: string;
  detected_at: Date | string;
  status: string;
  wick_state: "present" | "absent" | "unknown";
  watch_reason: string | null;
  detect_snapshot: Record<string, unknown>;
  wick_confirmed_at: Date | string | null;
  wick_low: number | null;
  wick_close: number | null;
  volume_multiple: number | null;
  forward_outcomes: Record<string, Record<string, unknown>> | null;
  snapshot_source: string;
};

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export async function getLcRapidReboundReport(): Promise<{
  observationOnly: true;
  methodology: string;
  minCohortSize: 20;
  summary: {
    total: number;
    complete: number;
    present: number;
    absent: number;
    unknown: number;
    pending: number;
  };
  groups: Array<{
    state: "present" | "absent";
    total: number;
    withFullForward: number;
    reboundOver5PctWithin120m: number;
    stopLikeDropOver5PctWithin120m: number;
  }>;
  recent: Array<{
    watchId: number;
    symbol: string;
    detectedAt: string;
    status: string;
    wickState: "present" | "absent" | "unknown";
    watchReason: string | null;
    liquidationUsd1h: number | null;
    liquidationUsd24h: number | null;
    wickConfirmedAt: string | null;
    wickLow: number | null;
    wickClose: number | null;
    volumeMultiple: number | null;
    forward120mReturnPct: number | null;
    forward120mMaxPct: number | null;
    forward120mMinPct: number | null;
    source: string;
  }>;
}> {
  await ensureLcRapidReboundSchema();
  const [aggregate, groupResult, recentResult] = await Promise.all([
    db.execute<{
      total: number;
      complete: number;
      present: number;
      absent: number;
      unknown: number;
      pending: number;
    }>(sql`
      SELECT count(*)::integer AS total,
             count(*) FILTER (WHERE status = 'complete')::integer AS complete,
             count(*) FILTER (WHERE wick_state = 'present')::integer AS present,
             count(*) FILTER (WHERE wick_state = 'absent')::integer AS absent,
             count(*) FILTER (WHERE wick_state = 'unknown' OR status = 'unavailable')::integer AS unknown,
             count(*) FILTER (WHERE status = 'pending')::integer AS pending
      FROM ${sql.raw(TABLE)}
    `),
    db.execute<{
      state: "present" | "absent";
      total: number;
      with_full_forward: number;
      rebounds: number;
      stop_like_drops: number;
    }>(sql`
      SELECT wick_state AS state,
             count(*)::integer AS total,
             count(*) FILTER (
               WHERE forward_outcomes->'120'->>'status' = 'complete'
             )::integer AS with_full_forward,
             count(*) FILTER (
               WHERE forward_outcomes->'120'->>'status' = 'complete'
                 AND (forward_outcomes->'120'->>'maxPct')::double precision > 5
             )::integer AS rebounds,
             count(*) FILTER (
               WHERE forward_outcomes->'120'->>'status' = 'complete'
                 AND (forward_outcomes->'120'->>'minPct')::double precision < -5
             )::integer AS stop_like_drops
      FROM ${sql.raw(TABLE)}
      WHERE wick_state IN ('present', 'absent')
      GROUP BY wick_state
    `),
    db.execute<ReportRow>(sql`
      SELECT watch_id, symbol, detected_at, status, wick_state, watch_reason,
             detect_snapshot, wick_confirmed_at, wick_low, wick_close,
             volume_multiple, forward_outcomes, snapshot_source
      FROM ${sql.raw(TABLE)}
      ORDER BY detected_at DESC, watch_id DESC
      LIMIT 500
    `),
  ]);
  const rows = recentResult.rows ?? [];
  const cohortRows = groupResult.rows ?? [];
  const groups = (["present", "absent"] as const).map((state) => {
    const cohort = cohortRows.find((row) => row.state === state);
    return {
      state,
      total: cohort?.total ?? 0,
      withFullForward: cohort?.with_full_forward ?? 0,
      reboundOver5PctWithin120m: cohort?.rebounds ?? 0,
      stopLikeDropOver5PctWithin120m: cohort?.stop_like_drops ?? 0,
    };
  });
  const recent = rows.slice(0, 100).map((row) => {
    const outcome = row.forward_outcomes?.["120"];
    const snapshot = row.detect_snapshot ?? {};
    return {
      watchId: row.watch_id,
      symbol: row.symbol,
      detectedAt: asDate(row.detected_at).toISOString(),
      status: row.status,
      wickState: row.wick_state,
      watchReason: row.watch_reason,
      liquidationUsd1h: numberOrNull(snapshot.longLiq1hAtDetect),
      liquidationUsd24h: numberOrNull(snapshot.longLiq24hAtDetect),
      wickConfirmedAt:
        row.wick_confirmed_at === null
          ? null
          : asDate(row.wick_confirmed_at).toISOString(),
      wickLow: row.wick_low,
      wickClose: row.wick_close,
      volumeMultiple: row.volume_multiple,
      forward120mReturnPct:
        outcome?.status === "complete"
          ? numberOrNull(outcome.closeReturnPct)
          : null,
      forward120mMaxPct:
        outcome?.status === "complete" ? numberOrNull(outcome.maxPct) : null,
      forward120mMinPct:
        outcome?.status === "complete" ? numberOrNull(outcome.minPct) : null,
      source: row.snapshot_source,
    };
  });
  return {
    observationOnly: true,
    methodology: `${RAPID_REBOUND_METHODOLOGY} Group total is the full wick-state cohort; rebound/drop counts and any derived rates use withFullForward as the denominator. Compare rates only when both present and absent groups each have at least 20 withFullForward rows.`,
    minCohortSize: 20,
    summary: aggregate.rows?.[0] ?? {
      total: 0,
      complete: 0,
      present: 0,
      absent: 0,
      unknown: 0,
      pending: 0,
    },
    groups,
    recent,
  };
}
