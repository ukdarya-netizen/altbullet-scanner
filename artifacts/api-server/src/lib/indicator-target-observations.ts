import {
  db,
  indicatorTargetObservationExperimentsTable,
  indicatorTargetObservationsTable,
  trackedSignalsTable,
} from "@workspace/db";
import { and, asc, eq, gt, gte, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { getKlinesRange, type BingXKline } from "./bingx.js";
import { logger } from "./logger.js";

export async function ensureIndicatorTargetObservationsSchema(): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext('indicator_target_observations_schema'))`,
    );
    await tx.execute(sql`
      CREATE TABLE IF NOT EXISTS indicator_target_observation_experiments (
        experiment_version text PRIMARY KEY,
        start_at timestamptz NOT NULL,
        CONSTRAINT indicator_target_observation_experiment_start_unique
          UNIQUE (experiment_version, start_at)
      )
    `);
    await tx.execute(sql`
      INSERT INTO indicator_target_observation_experiments
        (experiment_version, start_at)
      VALUES (${INDICATOR_TARGET_OBSERVATION_VERSION}, now())
      ON CONFLICT (experiment_version) DO NOTHING
    `);
    await tx.execute(sql`
      CREATE TABLE IF NOT EXISTS indicator_target_observations (
        id serial PRIMARY KEY,
        signal_id integer NOT NULL,
        tracked_signal_id integer NOT NULL,
        experiment_version text NOT NULL,
        target_pct double precision NOT NULL,
        hypothesis_label text NOT NULL,
        symbol text NOT NULL,
        pattern text NOT NULL,
        is_short boolean NOT NULL DEFAULT false,
        entry_price double precision NOT NULL,
        target_price double precision NOT NULL,
        signal_at timestamptz NOT NULL,
        trade_closed_at timestamptz,
        trade_status text,
        entry_metrics_snapshot jsonb NOT NULL,
        indicator_provenance_status text NOT NULL,
        indicator_provenance jsonb,
        abneon_snapshot_status text NOT NULL DEFAULT 'awaiting_entry_snapshot',
        abneon_indicator_version text,
        abneon_snapshot_captured_at timestamptz,
        abneon_snapshot_context jsonb,
        status text NOT NULL DEFAULT 'awaiting_hit',
        hit_at timestamptz,
        hit_price double precision,
        hit_source text,
        hit_candle_opened_at timestamptz,
        followup_status text NOT NULL DEFAULT 'not_started',
        followup_deadline timestamptz,
        next_retry_at timestamptz,
        history_retry_started_at timestamptz,
        price_at_72h double precision,
        price_at_72h_observed_at timestamptz,
        price_at_72h_change_pct double precision,
        max_favorable_pct double precision,
        min_favorable_pct double precision,
        followup_sample_count integer,
        followup_expected_sample_count integer,
        followup_first_sample_at timestamptz,
        followup_last_sample_at timestamptz,
        observation_source text,
        observation_error text,
        lease_until timestamptz,
        claim_token text,
        attempts integer NOT NULL DEFAULT 0,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await tx.execute(sql`
      CREATE UNIQUE INDEX IF NOT EXISTS indicator_target_observation_tracked_target_unique
      ON indicator_target_observations (tracked_signal_id, experiment_version, target_pct)
    `);
    await tx.execute(sql`
      ALTER TABLE indicator_target_observations
        ADD COLUMN IF NOT EXISTS entry_metrics_snapshot jsonb,
        ADD COLUMN IF NOT EXISTS abneon_snapshot_status text NOT NULL DEFAULT 'awaiting_entry_snapshot',
        ADD COLUMN IF NOT EXISTS abneon_indicator_version text,
        ADD COLUMN IF NOT EXISTS abneon_snapshot_captured_at timestamptz,
        ADD COLUMN IF NOT EXISTS abneon_snapshot_context jsonb,
        ADD COLUMN IF NOT EXISTS next_retry_at timestamptz,
        ADD COLUMN IF NOT EXISTS history_retry_started_at timestamptz
    `);
    await tx.execute(sql`
      UPDATE indicator_target_observations
      SET entry_metrics_snapshot = jsonb_build_object(
        'coverageStatus', 'missing',
        'source', 'entry_metrics_snapshot_backfill',
        'reason', 'No frozen tracker metric payload was available during schema upgrade'
      )
      WHERE entry_metrics_snapshot IS NULL
    `);
    await tx.execute(sql`
      ALTER TABLE indicator_target_observations
        ALTER COLUMN entry_metrics_snapshot SET NOT NULL
    `);
    await tx.execute(sql`
      CREATE INDEX IF NOT EXISTS indicator_target_observation_due_retry_fair_idx
      ON indicator_target_observations
        (status, followup_status, next_retry_at, lease_until, updated_at)
    `);
    await tx.execute(sql`
      CREATE INDEX IF NOT EXISTS indicator_target_observation_history_retry_idx
      ON indicator_target_observations
        (status, trade_closed_at, history_retry_started_at, lease_until)
    `);
    await tx.execute(sql`
      CREATE INDEX IF NOT EXISTS indicator_target_observation_tracker_idx
      ON indicator_target_observations (tracked_signal_id)
    `);
    await tx.execute(sql`
      CREATE OR REPLACE FUNCTION capture_indicator_target_trade_close()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $indicator_target_close$
      BEGIN
        IF NEW.closed_at IS NULL THEN
          RETURN NEW;
        END IF;
        IF TG_OP = 'UPDATE' THEN
          IF OLD.closed_at IS NOT NULL
             AND OLD.status IS NOT DISTINCT FROM NEW.status THEN
            RETURN NEW;
          END IF;
        END IF;
        UPDATE indicator_target_observations observation
        SET trade_closed_at = COALESCE(observation.trade_closed_at, NEW.closed_at),
            trade_status = COALESCE(observation.trade_status, NEW.status::text),
            updated_at = now()
        WHERE observation.tracked_signal_id = NEW.id
          AND (
            observation.trade_closed_at IS NULL
            OR observation.trade_status IS NULL
          );
        RETURN NEW;
      END;
      $indicator_target_close$
    `);
    await tx.execute(sql`
      DO $indicator_target_trigger$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_trigger
          WHERE tgname = 'tracked_signals_indicator_target_close_capture'
            AND tgrelid = 'tracked_signals'::regclass
            AND NOT tgisinternal
        ) THEN
          CREATE TRIGGER tracked_signals_indicator_target_close_capture
          AFTER INSERT OR UPDATE OF closed_at, status ON tracked_signals
          FOR EACH ROW
          EXECUTE FUNCTION capture_indicator_target_trade_close();
        END IF;
      END;
      $indicator_target_trigger$
    `);
  });
}

/**
 * Observation-only calibration cohort. These are hypotheses, never live exits.
 * This version is deliberately separate from the retired ABNeon TP-shadow.
 *
 * Analytics-worker data contract:
 * - Read one row per (tracked_signal_id, experiment_version, target_pct);
 *   signal_id is the immutable source-signal link. target_pct is
 *   exactly 8/12/16 and hypothesis_label explicitly says it is not an exit.
 * - status is awaiting_hit, hit, no_hit_before_close, or unknown. A hit carries
 *   hit_at (conservative 15m candle close), hit_price and hit_source; no-hit is
 *   only assigned when closed 15m history is contiguous through actual close.
 * - followup_status is not_started/pending/delayed/complete/partial/unavailable/
 *   not_applicable. 72h fields are price_at_72h, price_at_72h_observed_at,
 *   price_at_72h_change_pct, max_favorable_pct, min_favorable_pct and sample
 *   counts. Complete means the exact endpoint + all 288 contiguous candles; partial and
 *   unavailable rows must not be analyzed as exact 72h outcomes.
 * - indicator_provenance_status and indicator_provenance freeze either
 *   immutable entry telemetry with field provenance or an explicit missing
 *   coverage reason. Rows deliberately have no tracker/signal foreign keys so
 *   archive evidence survives tracker cleanup.
 */
export const INDICATOR_TARGET_OBSERVATION_VERSION =
  "indicator-target-ohlc-hypotheses-v1";
export const INDICATOR_TARGET_HYPOTHESES = [
  { pct: 8, label: "hypothesis_+8pct_not_trade_exit" },
  { pct: 12, label: "hypothesis_+12pct_not_trade_exit" },
  { pct: 16, label: "hypothesis_+16pct_not_trade_exit" },
] as const;
const CANDLE_MS = 15 * 60_000;
const FOLLOWUP_MS = 72 * 60 * 60_000;
const FOLLOWUP_RETRY_WINDOW_MS = 7 * 24 * 60 * 60_000;
const CLOSED_HISTORY_RETRY_WINDOW_MS = 7 * 24 * 60 * 60_000;
const FOLLOWUP_RETRY_DELAY_MS = 12 * 60 * 60_000;
const TRANSIENT_RETRY_DELAY_MS = 15 * 60_000;
const CLAIM_MS = 4 * 60_000;
const OPEN_HIT_RECHECK_MS = 30 * 60_000;

type IndicatorTargetWorkerHealth = {
  lastAttemptAt: Date | null;
  lastSuccessAt: Date | null;
  lastErrorAt: Date | null;
  lastError: string | null;
  lastEnrolled: number;
  lastProcessed: number;
};

const workerHealth: IndicatorTargetWorkerHealth = {
  lastAttemptAt: null,
  lastSuccessAt: null,
  lastErrorAt: null,
  lastError: null,
  lastEnrolled: 0,
  lastProcessed: 0,
};

/** Process-local liveness; durable coverage and progress live in the observations table. */
export function getIndicatorTargetObservationWorkerHealth(): IndicatorTargetWorkerHealth {
  return { ...workerHealth };
}

export async function runIndicatorTargetObservationCycle(): Promise<void> {
  workerHealth.lastAttemptAt = new Date();
  try {
    const result = await reconcileIndicatorTargetObservations(12);
    const firstSuccessfulRun = workerHealth.lastSuccessAt === null;
    workerHealth.lastSuccessAt = new Date();
    workerHealth.lastError = null;
    workerHealth.lastEnrolled = result.enrolled;
    workerHealth.lastProcessed = result.processed;
    if (firstSuccessfulRun || result.enrolled > 0 || result.processed > 0) {
      logger.info(result, "Indicator target observations reconciled");
    }
  } catch (error) {
    workerHealth.lastErrorAt = new Date();
    workerHealth.lastError = String(error).slice(0, 500);
    throw error;
  }
}

export function createKlineRangeCache(
  fetchRange: typeof getKlinesRange = getKlinesRange,
) {
  const requests = new Map<string, ReturnType<typeof getKlinesRange>>();
  return (
    symbol: string,
    interval: Parameters<typeof getKlinesRange>[1],
    startTime: number,
    endTime: number,
    options: Parameters<typeof getKlinesRange>[4] = {},
  ) => {
    const key = JSON.stringify([
      symbol,
      interval,
      startTime,
      endTime,
      options.strictPayload ?? false,
    ]);
    const existing = requests.get(key);
    if (existing) return existing;
    const pending = fetchRange(symbol, interval, startTime, endTime, options);
    requests.set(key, pending);
    return pending;
  };
}

type KlineRangeCache = ReturnType<typeof createKlineRangeCache>;

export type TargetObservationCandidate = {
  signalId: number;
  trackedSignalId: number;
  entryPrice: number;
  targetPct: number;
  isShort: boolean;
};

export function buildIndicatorTargetCandidates(input: {
  signalId: number;
  trackedSignalId: number;
  entryPrice: number;
  isShort: boolean;
}): TargetObservationCandidate[] {
  if (!Number.isFinite(input.entryPrice) || input.entryPrice <= 0) return [];
  return INDICATOR_TARGET_HYPOTHESES.map(({ pct }) => ({
    signalId: input.signalId,
    trackedSignalId: input.trackedSignalId,
    entryPrice: input.entryPrice,
    targetPct: pct,
    isShort: input.isShort,
  }));
}

export function calculateHypothesisTargetPrice(input: {
  entryPrice: number;
  targetPct: number;
  isShort: boolean;
}): number {
  return (
    input.entryPrice * (1 + ((input.isShort ? -1 : 1) * input.targetPct) / 100)
  );
}

export function findFirstConfirmedTargetHit(input: {
  candles: BingXKline[];
  targetPrice: number;
  isShort: boolean;
  signalAt: Date;
  tradeClosedAt: Date | null;
  now: Date;
}): { hitAt: Date; hitPrice: number; candleOpenedAt: Date } | null {
  for (const candle of input.candles) {
    const openedAt = Number(candle.time);
    const high = Number(candle.high);
    const low = Number(candle.low);
    const candleClosedAt = openedAt + CANDLE_MS;
    if (
      !Number.isFinite(openedAt) ||
      !Number.isFinite(high) ||
      !Number.isFinite(low) ||
      openedAt < input.signalAt.getTime() ||
      candleClosedAt > input.now.getTime() ||
      (input.tradeClosedAt != null &&
        candleClosedAt > input.tradeClosedAt.getTime())
    ) {
      continue;
    }
    const touched = input.isShort
      ? low <= input.targetPrice
      : high >= input.targetPrice;
    if (touched) {
      return {
        // A candle high/low cannot establish intrabar ordering. Its close is
        // the conservative event timestamp used for close-order comparisons.
        hitAt: new Date(candleClosedAt),
        hitPrice: input.targetPrice,
        candleOpenedAt: new Date(openedAt),
      };
    }
  }
  return null;
}

export function hasContinuousClosed15mCoverage(input: {
  candles: BingXKline[];
  startAt: Date;
  endAt: Date;
}): boolean {
  const firstOpen = Math.ceil(input.startAt.getTime() / CANDLE_MS) * CANDLE_MS;
  const lastOpen =
    Math.floor((input.endAt.getTime() - CANDLE_MS) / CANDLE_MS) * CANDLE_MS;
  if (lastOpen < firstOpen) {
    return input.endAt.getTime() === input.startAt.getTime();
  }
  const byTime = new Set(
    input.candles
      .map((candle) => Number(candle.time))
      .filter(
        (time) =>
          Number.isFinite(time) &&
          time >= firstOpen &&
          time <= lastOpen &&
          time + CANDLE_MS <= input.endAt.getTime(),
      ),
  );
  for (let time = firstOpen; time <= lastOpen; time += CANDLE_MS) {
    if (!byTime.has(time)) return false;
  }
  return true;
}

export function hasCompleteNoHitBoundaryEvidence(input: {
  candles: BingXKline[];
  startAt: Date;
  endAt: Date;
  now: Date;
}): boolean {
  if (input.endAt.getTime() === input.startAt.getTime()) return true;
  if (input.endAt.getTime() < input.startAt.getTime()) return false;
  const firstOpen = Math.floor(input.startAt.getTime() / CANDLE_MS) * CANDLE_MS;
  const lastOpen =
    Math.floor((input.endAt.getTime() - 1) / CANDLE_MS) * CANDLE_MS;
  const byTime = new Map(
    input.candles
      .map((candle) => ({
        openedAt: Number(candle.time),
        high: Number(candle.high),
        low: Number(candle.low),
      }))
      .filter(
        (candle) =>
          Number.isFinite(candle.openedAt) &&
          Number.isFinite(candle.high) &&
          Number.isFinite(candle.low),
      )
      .map((candle) => [candle.openedAt, candle]),
  );
  for (let openedAt = firstOpen; openedAt <= lastOpen; openedAt += CANDLE_MS) {
    const candle = byTime.get(openedAt);
    if (!candle || openedAt + CANDLE_MS > input.now.getTime()) {
      return false;
    }
  }
  return true;
}

export function hasAmbiguousSignalOverlap(input: {
  candles: BingXKline[];
  targetPrice: number;
  isShort: boolean;
  signalAt: Date;
}): boolean {
  return input.candles.some((candle) => {
    const openedAt = Number(candle.time);
    if (
      !Number.isFinite(openedAt) ||
      openedAt >= input.signalAt.getTime() ||
      openedAt + CANDLE_MS <= input.signalAt.getTime()
    ) {
      return false;
    }
    const high = Number(candle.high);
    const low = Number(candle.low);
    return input.isShort
      ? Number.isFinite(low) && low <= input.targetPrice
      : Number.isFinite(high) && high >= input.targetPrice;
  });
}

export function hasAmbiguousTradeCloseOverlap(input: {
  candles: BingXKline[];
  targetPrice: number;
  isShort: boolean;
  tradeClosedAt: Date;
}): boolean {
  return input.candles.some((candle) => {
    const openedAt = Number(candle.time);
    if (
      !Number.isFinite(openedAt) ||
      openedAt >= input.tradeClosedAt.getTime() ||
      openedAt + CANDLE_MS <= input.tradeClosedAt.getTime()
    ) {
      return false;
    }
    const high = Number(candle.high);
    const low = Number(candle.low);
    return input.isShort
      ? Number.isFinite(low) && low <= input.targetPrice
      : Number.isFinite(high) && high >= input.targetPrice;
  });
}

export function classifyNoHitHistoryOutcome(input: {
  continuousCoverage: boolean;
  tradeClosedAt: Date | null;
  retryWindowExpired?: boolean;
}): {
  status: "awaiting_hit" | "no_hit_before_close" | "unknown";
  followupStatus: "not_started" | "not_applicable" | "unavailable";
} {
  if (!input.tradeClosedAt) {
    // An open position remains retryable regardless of how old its signal is.
    return { status: "awaiting_hit", followupStatus: "not_started" };
  }
  if (input.continuousCoverage) {
    return { status: "no_hit_before_close", followupStatus: "not_applicable" };
  }
  return input.retryWindowExpired
    ? { status: "unknown", followupStatus: "unavailable" }
    : { status: "awaiting_hit", followupStatus: "not_started" };
}

export function resolveTargetHitOrder(input: {
  candles: BingXKline[];
  targetPrice: number;
  isShort: boolean;
  signalAt: Date;
  tradeClosedAt: Date | null;
  now: Date;
}):
  | {
      kind: "confirmed_hit";
      hit: NonNullable<ReturnType<typeof findFirstConfirmedTargetHit>>;
    }
  | {
      kind: "ambiguous_signal" | "ambiguous_trade_close" | "no_hit";
      hit: null;
    } {
  if (
    hasAmbiguousSignalOverlap({
      candles: input.candles,
      targetPrice: input.targetPrice,
      isShort: input.isShort,
      signalAt: input.signalAt,
    })
  ) {
    return { kind: "ambiguous_signal", hit: null };
  }
  const hit = findFirstConfirmedTargetHit(input);
  if (hit) return { kind: "confirmed_hit", hit };
  if (
    input.tradeClosedAt &&
    hasAmbiguousTradeCloseOverlap({
      candles: input.candles,
      targetPrice: input.targetPrice,
      isShort: input.isShort,
      tradeClosedAt: input.tradeClosedAt,
    })
  ) {
    return { kind: "ambiguous_trade_close", hit: null };
  }
  return { kind: "no_hit", hit: null };
}

export function calculateTargetFollowup(input: {
  candles: BingXKline[];
  hitAt: Date;
  hitPrice: number;
  isShort: boolean;
  now: Date;
}): {
  status: "complete" | "partial" | "unavailable";
  deadline: Date;
  priceAt72h: number | null;
  priceAt72hObservedAt: Date | null;
  priceAt72hChangePct: number | null;
  maxFavorablePct: number | null;
  minFavorablePct: number | null;
  sampleCount: number;
  expectedSampleCount: number;
  firstSampleAt: Date | null;
  lastSampleAt: Date | null;
} {
  const deadline = new Date(input.hitAt.getTime() + FOLLOWUP_MS);
  const postHitCandidates = input.candles
    .map((candle) => ({
      openedAt: Number(candle.time),
      high: Number(candle.high),
      low: Number(candle.low),
      close: Number(candle.close),
    }))
    .filter(
      (candle) =>
        Number.isFinite(candle.openedAt) &&
        Number.isFinite(candle.high) &&
        Number.isFinite(candle.low) &&
        Number.isFinite(candle.close) &&
        candle.openedAt >= input.hitAt.getTime() &&
        candle.openedAt + CANDLE_MS <= input.now.getTime() &&
        candle.openedAt + CANDLE_MS <= deadline.getTime(),
    )
    .sort((a, b) => a.openedAt - b.openedAt);
  const expectedSampleCount = FOLLOWUP_MS / CANDLE_MS;
  const uniqueByOpen = new Map<number, (typeof postHitCandidates)[number]>();
  for (const candle of postHitCandidates) {
    if (!uniqueByOpen.has(candle.openedAt)) {
      uniqueByOpen.set(candle.openedAt, candle);
    }
  }
  const postHit = [...uniqueByOpen.values()].sort(
    (a, b) => a.openedAt - b.openedAt,
  );
  const endpoint = postHit.find(
    (candle) => candle.openedAt + CANDLE_MS === deadline.getTime(),
  );
  const noDuplicateCandles = uniqueByOpen.size === postHitCandidates.length;
  const contiguous = postHit.every(
    (candle, index) =>
      candle.openedAt === input.hitAt.getTime() + index * CANDLE_MS,
  );
  const highs = postHit.map((candle) => candle.high);
  const lows = postHit.map((candle) => candle.low);
  const favorablePrices = input.isShort ? lows : highs;
  const adversePrices = input.isShort ? highs : lows;
  const directionChangePct = (price: number) =>
    ((input.isShort ? input.hitPrice - price : price - input.hitPrice) /
      input.hitPrice) *
    100;
  const favorable = favorablePrices.map(directionChangePct);
  const adverse = adversePrices.map(directionChangePct);
  const coverageComplete =
    endpoint != null &&
    postHit.length === expectedSampleCount &&
    noDuplicateCandles &&
    contiguous;
  const sampleCount = postHit.length;
  const status =
    sampleCount === 0
      ? "unavailable"
      : coverageComplete
        ? "complete"
        : "partial";
  return {
    status,
    deadline,
    priceAt72h: endpoint?.close ?? null,
    priceAt72hObservedAt: endpoint
      ? new Date(endpoint.openedAt + CANDLE_MS)
      : null,
    priceAt72hChangePct:
      endpoint && input.hitPrice > 0
        ? ((endpoint.close - input.hitPrice) / input.hitPrice) * 100
        : null,
    maxFavorablePct: favorable.length ? Math.max(...favorable) : null,
    minFavorablePct: adverse.length ? Math.min(...adverse) : null,
    sampleCount,
    expectedSampleCount,
    firstSampleAt: postHit[0]
      ? new Date(postHit[0].openedAt + CANDLE_MS)
      : null,
    lastSampleAt: postHit.at(-1)
      ? new Date(postHit.at(-1)!.openedAt + CANDLE_MS)
      : null,
  };
}

export function freezeIndicatorProvenance(row: {
  entryIndicatorTelemetry?: Record<string, Record<string, unknown>> | null;
  entryIndicatorTimeframe?: string | null;
  entryIndicatorCandleCloseAt?: Date | null;
  entryIndicatorSource?: string | null;
  entryMetricsProvenance: Record<
    string,
    { source: string; observedAt: string }
  > | null;
}): { status: string; payload: Record<string, unknown> | null } {
  if (!row.entryIndicatorTelemetry) {
    return {
      status: "missing_entry_indicator_telemetry",
      payload: {
        coverage: "missing",
        reason: "No immutable entry_indicator_telemetry existed at enrollment",
        source: row.entryIndicatorSource,
        timeframe: row.entryIndicatorTimeframe,
        candleCloseAt: row.entryIndicatorCandleCloseAt?.toISOString() ?? null,
        fieldProvenance: row.entryMetricsProvenance
          ? structuredClone(row.entryMetricsProvenance)
          : null,
      },
    };
  }
  return {
    status: "entry_indicator_telemetry_frozen",
    payload: {
      coverage: "frozen_entry_telemetry_link",
      source: row.entryIndicatorSource,
      timeframe: row.entryIndicatorTimeframe,
      candleCloseAt: row.entryIndicatorCandleCloseAt?.toISOString() ?? null,
      fieldProvenance: row.entryMetricsProvenance
        ? structuredClone(row.entryMetricsProvenance)
        : null,
      values: structuredClone(row.entryIndicatorTelemetry),
    },
  };
}

export function freezeEntryMetricsSnapshot<
  T extends {
    detectedAt: Date;
    entryMetricsProvenance?: Record<
      string,
      { source: string; observedAt: string }
    > | null;
  },
>(row: T, enrollmentAt = new Date()): Record<string, unknown> {
  const availableAtEnrollment = Object.fromEntries(
    Object.entries(row).filter(
      ([key]) =>
        (key.startsWith("entry") && key !== "entryMetricsProvenance") ||
        key === "price24hAtFire",
    ),
  );
  const fieldCoverage = Object.fromEntries(
    Object.entries(availableAtEnrollment).map(([key, value]) => [
      key,
      value == null ? "missing" : "available",
    ]),
  );
  const availableCount = Object.values(fieldCoverage).filter(
    (coverage) => coverage === "available",
  ).length;
  const sourceProvenance = row.entryMetricsProvenance ?? {};
  const fieldProvenance = Object.fromEntries(
    Object.entries(availableAtEnrollment).map(([key, value]) => {
      const provenance = sourceProvenance[key];
      return [
        key,
        value == null
          ? { status: "missing" }
          : provenance
            ? {
                status: "provenanced",
                source: provenance.source,
                observedAt: provenance.observedAt,
              }
            : {
                status: "unknown_observation_time",
                reason:
                  "No per-field entryMetricsProvenance existed at enrollment",
              },
      ];
    }),
  );
  const availableFieldKeys = Object.entries(availableAtEnrollment)
    .filter(([, value]) => value != null)
    .map(([key]) => key);
  const provenancedCount = availableFieldKeys.filter(
    (key) => sourceProvenance[key] != null,
  ).length;
  const hasReconstructedValues = availableFieldKeys.some(
    (key) => sourceProvenance[key]?.source === "prescan_snapshot",
  );
  const hasUnknownObservationTimes =
    provenancedCount < availableFieldKeys.length;
  return {
    source: "tracked_signals_values_frozen_at_target_enrollment",
    enrollmentAt: enrollmentAt.toISOString(),
    signalAt: row.detectedAt.toISOString(),
    coverageStatus:
      availableCount === 0
        ? "missing"
        : availableCount === Object.keys(fieldCoverage).length
          ? "complete"
          : "partial",
    provenanceStatus:
      availableFieldKeys.length === 0
        ? "not_applicable"
        : provenancedCount === availableFieldKeys.length
          ? "provenanced"
          : provenancedCount > 0
            ? "partial"
            : "unknown_observation_time",
    cohortKind:
      availableFieldKeys.length === 0
        ? "no_available_metrics"
        : hasReconstructedValues && hasUnknownObservationTimes
          ? "mixed_reconstructed_and_unknown"
          : hasReconstructedValues
            ? "reconstructed_prescan_snapshot"
            : hasUnknownObservationTimes
              ? "unknown_observation_time"
              : "entry_time_provenance_confirmed",
    fieldCoverage,
    fieldProvenance,
    entryMetricsProvenance: structuredClone(sourceProvenance),
    values: structuredClone(availableAtEnrollment),
  };
}

type TrackedObservationEnrollment = {
  id: number;
  signalId: number | null;
  symbol: string;
  sentimentKey: string | null;
  entryPrice: number;
  detectedAt: Date;
  entryIndicatorTelemetry?: Record<string, Record<string, unknown>> | null;
  entryIndicatorTimeframe?: string | null;
  entryIndicatorCandleCloseAt?: Date | null;
  entryIndicatorSource?: string | null;
  entryMetricsProvenance: Record<
    string,
    { source: string; observedAt: string }
  > | null;
  entryMetricsSnapshot: Record<string, unknown>;
};

async function getIndicatorTargetExperimentStartAt(): Promise<Date> {
  const [experiment] = await db
    .select({
      startAt: indicatorTargetObservationExperimentsTable.startAt,
    })
    .from(indicatorTargetObservationExperimentsTable)
    .where(
      eq(
        indicatorTargetObservationExperimentsTable.experimentVersion,
        INDICATOR_TARGET_OBSERVATION_VERSION,
      ),
    )
    .limit(1);
  if (!experiment) {
    throw new Error(
      `Missing durable start for indicator target experiment ${INDICATOR_TARGET_OBSERVATION_VERSION}`,
    );
  }
  return experiment.startAt;
}

async function insertTrackedSignalTargetCandidates(
  row: TrackedObservationEnrollment,
): Promise<number> {
  if (row.signalId == null || !Number.isFinite(row.entryPrice)) return 0;
  const provenance = freezeIndicatorProvenance(row);
  const candidates = buildIndicatorTargetCandidates({
    signalId: row.signalId,
    trackedSignalId: row.id,
    entryPrice: row.entryPrice,
    isShort: false,
  });
  if (candidates.length === 0) return 0;
  const inserted = await db
    .insert(indicatorTargetObservationsTable)
    .values(
      candidates.map((candidate) => ({
        signalId: candidate.signalId,
        trackedSignalId: candidate.trackedSignalId,
        experimentVersion: INDICATOR_TARGET_OBSERVATION_VERSION,
        targetPct: candidate.targetPct,
        hypothesisLabel: INDICATOR_TARGET_HYPOTHESES.find(
          (hypothesis) => hypothesis.pct === candidate.targetPct,
        )!.label,
        symbol: row.symbol,
        pattern: row.sentimentKey ?? "unknown_pattern",
        isShort: false,
        entryPrice: candidate.entryPrice,
        targetPrice: calculateHypothesisTargetPrice(candidate),
        signalAt: row.detectedAt,
        entryMetricsSnapshot: row.entryMetricsSnapshot,
        indicatorProvenanceStatus: provenance.status,
        indicatorProvenance: provenance.payload,
      })),
    )
    .onConflictDoNothing()
    .returning({ id: indicatorTargetObservationsTable.id });
  return inserted.length;
}

/** Immediate nonblocking trigger from the primary trackSignal success path. */
export async function enrollIndicatorTargetCandidatesForTrackedSignal(
  trackedSignalId: number,
): Promise<number> {
  const [row] = await db
    .select()
    .from(trackedSignalsTable)
    .where(
      and(
        eq(trackedSignalsTable.id, trackedSignalId),
        eq(trackedSignalsTable.isShort, false),
      ),
    )
    .limit(1);
  if (!row) return 0;
  const cohortStartAt = await getIndicatorTargetExperimentStartAt();
  return row.detectedAt >= cohortStartAt
    ? insertTrackedSignalTargetCandidates({
        ...row,
        entryMetricsSnapshot: freezeEntryMetricsSnapshot(row),
      })
    : 0;
}

/**
 * Durable worker contract: call at startup and periodically. It first enrolls
 * all cohort-eligible tracked long signals idempotently, then claims at most
 * `limit` rows across workers. Eligibility begins at the durable experiment
 * start seeded once by the schema gate; pre-cohort tracker history is excluded.
 * Candidate rows retain frozen entry telemetry or explicit missing coverage
 * and are never deleted with tracker cleanup.
 */
export async function reconcileIndicatorTargetObservations(
  limit = 6,
  now = new Date(),
): Promise<{ enrolled: number; processed: number }> {
  // Refresh close metadata independently of target/follow-up claims, including
  // rows whose 72h follow-up completed while the tracked position was open.
  await db.execute(sql`
    UPDATE indicator_target_observations observation
    SET trade_closed_at = COALESCE(observation.trade_closed_at, tracked.closed_at),
        trade_status = COALESCE(observation.trade_status, tracked.status::text),
        updated_at = ${now}
    FROM tracked_signals tracked
    WHERE tracked.id = observation.tracked_signal_id
      AND tracked.closed_at IS NOT NULL
      AND (
        observation.trade_closed_at IS NULL
        OR observation.trade_status IS NULL
      )
  `);

  await db.execute(sql`
    UPDATE indicator_target_observations
    SET status = 'unknown',
        followup_status = 'unavailable',
        next_retry_at = NULL,
        observation_error = COALESCE(
          observation_error,
          'Closed-trade OHLC history remained incomplete through the bounded retry window'
        ),
        lease_until = NULL,
        claim_token = NULL,
        updated_at = ${now}
    WHERE status = 'awaiting_hit'
      AND trade_closed_at IS NOT NULL
      AND history_retry_started_at IS NOT NULL
      AND history_retry_started_at + interval '7 days' <= ${now}
      AND (lease_until IS NULL OR lease_until < ${now})
  `);

  // Entry ABNeon snapshots are captured asynchronously after primary delivery.
  // Attach them exactly once when they become terminally ready/unavailable.
  await db.execute(sql`
    UPDATE indicator_target_observations observation
    SET abneon_snapshot_status = snapshot.status,
        abneon_indicator_version = snapshot.indicator_version,
        abneon_snapshot_captured_at = snapshot.captured_at,
        abneon_snapshot_context = jsonb_build_object(
          'status', snapshot.status,
          'checks', snapshot.checks,
          'context', snapshot.context,
          'audit', snapshot.audit,
          'error', snapshot.error
        ),
        updated_at = ${now}
    FROM altbullet_indicator_snapshots snapshot
    WHERE observation.signal_id = snapshot.signal_id
      AND observation.abneon_snapshot_status = 'awaiting_entry_snapshot'
      AND snapshot.status IN ('ready', 'unavailable')
  `);

  await db.execute(sql`
    UPDATE indicator_target_observations
    SET followup_status = CASE
          WHEN COALESCE(followup_sample_count, 0) > 0 THEN 'partial'
          ELSE 'unavailable'
        END,
        next_retry_at = NULL,
        observation_error = COALESCE(
          observation_error,
          '72h market-history retry window expired without complete coverage'
        ),
        updated_at = ${now}
    WHERE status = 'hit'
      AND followup_status IN ('delayed', 'retry', 'partial', 'unavailable')
      AND followup_deadline + interval '7 days' <= ${now}
  `);

  const missingTracked = await db
    .select({ tracker: trackedSignalsTable })
    .from(trackedSignalsTable)
    .innerJoin(
      indicatorTargetObservationExperimentsTable,
      eq(
        indicatorTargetObservationExperimentsTable.experimentVersion,
        INDICATOR_TARGET_OBSERVATION_VERSION,
      ),
    )
    .where(
      and(
        eq(trackedSignalsTable.isShort, false),
        sql`${trackedSignalsTable.signalId} IS NOT NULL`,
        gt(trackedSignalsTable.entryPrice, 0),
        gte(
          trackedSignalsTable.detectedAt,
          indicatorTargetObservationExperimentsTable.startAt,
        ),
        // Repair partial enrollments too: one surviving target row must not
        // hide the other two from durable reconciliation.
        sql`(
          SELECT count(DISTINCT observation.target_pct)
          FROM indicator_target_observations observation
          WHERE observation.tracked_signal_id = ${trackedSignalsTable.id}
            AND observation.experiment_version = ${INDICATOR_TARGET_OBSERVATION_VERSION}
            AND observation.target_pct IN (8, 12, 16)
        ) < 3`,
      ),
    )
    .orderBy(asc(trackedSignalsTable.detectedAt), asc(trackedSignalsTable.id))
    .limit(100);
  // No pattern allowlist: every tracker-linked long pattern, including future
  // keys and terminal rows, is recoverable here.
  let enrolled = 0;
  for (const { tracker } of missingTracked) {
    enrolled += await insertTrackedSignalTargetCandidates({
      ...tracker,
      entryMetricsSnapshot: freezeEntryMetricsSnapshot(tracker),
    });
  }

  const claimToken = randomUUID();
  const claimedResult = await db.execute(sql`
    WITH due AS (
      SELECT observation.id
      FROM indicator_target_observations observation
      WHERE observation.experiment_version = ${INDICATOR_TARGET_OBSERVATION_VERSION}
        AND (
          (
            observation.status = 'awaiting_hit'
            AND observation.followup_status = 'not_started'
          )
          OR (
            observation.status = 'hit'
            AND observation.followup_status = 'pending'
            AND observation.followup_deadline <= ${now}
          )
          OR (
            observation.status = 'hit'
            AND observation.followup_status IN (
              'retry', 'delayed', 'partial', 'unavailable'
            )
            AND observation.followup_deadline <= ${now}
            AND observation.followup_deadline + interval '7 days' > ${now}
          )
        )
        AND (observation.next_retry_at IS NULL OR observation.next_retry_at <= ${now})
        AND (observation.lease_until IS NULL OR observation.lease_until < ${now})
      ORDER BY
        CASE WHEN observation.status = 'hit' THEN 0 ELSE 1 END,
        observation.updated_at,
        observation.signal_at,
        observation.id
      LIMIT ${Math.max(1, Math.min(limit, 12))}
      FOR UPDATE SKIP LOCKED
    )
    UPDATE indicator_target_observations observation
    SET claim_token = ${claimToken},
        lease_until = ${new Date(now.getTime() + CLAIM_MS)},
        attempts = observation.attempts + 1,
        trade_closed_at = COALESCE(
          observation.trade_closed_at,
          (SELECT tracked.closed_at FROM tracked_signals tracked
           WHERE tracked.id = observation.tracked_signal_id)
        ),
        trade_status = COALESCE(
          observation.trade_status,
          (SELECT CASE WHEN tracked.closed_at IS NOT NULL
                       THEN tracked.status::text ELSE NULL END
           FROM tracked_signals tracked
           WHERE tracked.id = observation.tracked_signal_id)
        ),
        updated_at = ${now}
    FROM due
    WHERE observation.id = due.id
    RETURNING observation.id, observation.signal_id, observation.tracked_signal_id,
      observation.symbol, observation.pattern, observation.is_short,
      observation.entry_price, observation.target_price, observation.signal_at,
      observation.status, observation.hit_at, observation.hit_price,
      observation.trade_closed_at,
      observation.history_retry_started_at,
      observation.followup_deadline, observation.followup_sample_count,
      EXISTS (
        SELECT 1 FROM tracked_signals tracked
        WHERE tracked.id = observation.tracked_signal_id
      ) AS tracker_exists
  `);
  const claimed = claimedResult.rows as Array<{
    id: number;
    signal_id: number;
    tracked_signal_id: number;
    symbol: string;
    pattern: string;
    is_short: boolean;
    entry_price: number;
    target_price: number;
    signal_at: Date;
    status: string;
    hit_at: Date | null;
    hit_price: number | null;
    trade_closed_at: Date | null;
    history_retry_started_at: Date | null;
    tracker_exists: boolean;
    followup_deadline: Date | null;
    followup_sample_count: number | null;
  }>;
  let processed = 0;
  const getKlinesForBatch = createKlineRangeCache();
  for (const candidate of claimed) {
    try {
      if (candidate.status === "awaiting_hit") {
        await reconcileHit(candidate, claimToken, now, getKlinesForBatch);
      } else {
        const hitAt = candidate.hit_at;
        const hitPrice = candidate.hit_price;
        if (hitAt != null && hitPrice != null) {
          await reconcileFollowup(
            { ...candidate, hit_at: hitAt, hit_price: hitPrice },
            claimToken,
            now,
            getKlinesForBatch,
          );
        }
      }
      processed += 1;
    } catch (error) {
      const followupRetryExpired =
        candidate.status === "hit" &&
        candidate.followup_deadline != null &&
        now.getTime() >=
          candidate.followup_deadline.getTime() + FOLLOWUP_RETRY_WINDOW_MS;
      const failurePatch = {
        observationError: String(error).slice(0, 500),
        leaseUntil: null,
        claimToken: null,
        nextRetryAt: followupRetryExpired
          ? null
          : new Date(now.getTime() + TRANSIENT_RETRY_DELAY_MS),
        historyRetryStartedAt:
          candidate.status === "awaiting_hit" &&
          candidate.trade_closed_at != null
            ? (candidate.history_retry_started_at ?? now)
            : candidate.history_retry_started_at,
        updatedAt: now,
      };
      await db
        .update(indicatorTargetObservationsTable)
        .set({
          ...failurePatch,
          ...(candidate.status === "hit"
            ? {
                followupStatus: followupRetryExpired
                  ? candidate.followup_sample_count
                    ? "partial"
                    : "unavailable"
                  : "delayed",
              }
            : {}),
        })
        .where(
          and(
            eq(indicatorTargetObservationsTable.id, candidate.id),
            eq(indicatorTargetObservationsTable.claimToken, claimToken),
          ),
        );
      logger.warn(
        { error, signalId: candidate.signal_id, targetRowId: candidate.id },
        "Indicator target observation deferred",
      );
    }
  }
  return { enrolled, processed };
}

async function reconcileHit(
  row: {
    id: number;
    tracked_signal_id: number;
    symbol: string;
    is_short: boolean;
    target_price: number;
    signal_at: Date;
    trade_closed_at: Date | null;
    history_retry_started_at: Date | null;
    tracker_exists: boolean;
  },
  claimToken: string,
  now: Date,
  getKlines: KlineRangeCache,
): Promise<void> {
  if (!row.tracker_exists && row.trade_closed_at == null) {
    await db
      .update(indicatorTargetObservationsTable)
      .set({
        status: "unknown",
        followupStatus: "unavailable",
        observationSource: "tracker_cleanup_before_close_time_capture",
        observationError:
          "Tracked trade was removed before its close timestamp could be frozen",
        leaseUntil: null,
        claimToken: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(indicatorTargetObservationsTable.id, row.id),
          eq(indicatorTargetObservationsTable.claimToken, claimToken),
        ),
      );
    return;
  }
  const closedAt = row.trade_closed_at;
  const queryEnd = closedAt && closedAt < now ? closedAt : now;
  const candles = await getKlines(
    row.symbol,
    "15m",
    Math.floor(row.signal_at.getTime() / CANDLE_MS) * CANDLE_MS,
    queryEnd.getTime(),
    { strictPayload: true },
  );
  const eventOrder = resolveTargetHitOrder({
    candles,
    targetPrice: row.target_price,
    isShort: row.is_short,
    signalAt: row.signal_at,
    tradeClosedAt: closedAt,
    now,
  });
  if (eventOrder.kind === "ambiguous_signal") {
    await db
      .update(indicatorTargetObservationsTable)
      .set({
        status: "unknown",
        followupStatus: "unavailable",
        observationSource: "bingx_15m_ohlc_signal_overlapping_candle_ambiguous",
        observationError:
          "The 15m candle overlaps signal time and its high/low cannot order a target hit",
        leaseUntil: null,
        claimToken: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(indicatorTargetObservationsTable.id, row.id),
          eq(indicatorTargetObservationsTable.claimToken, claimToken),
        ),
      );
    return;
  }
  const hit = eventOrder.kind === "confirmed_hit" ? eventOrder.hit : null;
  if (hit) {
    if (
      !hasCompleteNoHitBoundaryEvidence({
        candles,
        startAt: row.signal_at,
        endAt: hit.hitAt,
        now,
      })
    ) {
      const tradeAlreadyClosed = closedAt != null;
      const historyRetryExpired =
        tradeAlreadyClosed &&
        row.history_retry_started_at != null &&
        now.getTime() >=
          row.history_retry_started_at.getTime() +
            CLOSED_HISTORY_RETRY_WINDOW_MS;
      await db
        .update(indicatorTargetObservationsTable)
        .set({
          status: historyRetryExpired ? "unknown" : "awaiting_hit",
          followupStatus: historyRetryExpired ? "unavailable" : "not_started",
          nextRetryAt: historyRetryExpired
            ? null
            : new Date(now.getTime() + TRANSIENT_RETRY_DELAY_MS),
          historyRetryStartedAt:
            tradeAlreadyClosed && !historyRetryExpired
              ? (row.history_retry_started_at ?? now)
              : row.history_retry_started_at,
          observationSource:
            "bingx_15m_ohlc_historical_reconciliation_incomplete",
          observationError: historyRetryExpired
            ? "Closed-trade OHLC gap before possible first hit persisted through retry window; outcome unknown"
            : "Historical gap precedes candidate hit; retrying before classifying outcome",
          leaseUntil: null,
          claimToken: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(indicatorTargetObservationsTable.id, row.id),
            eq(indicatorTargetObservationsTable.claimToken, claimToken),
          ),
        );
      return;
    }
    await db
      .update(indicatorTargetObservationsTable)
      .set({
        status: "hit",
        hitAt: hit.hitAt,
        hitPrice: hit.hitPrice,
        hitCandleOpenedAt: hit.candleOpenedAt,
        hitSource: "bingx_15m_ohlc_high_low_conservative_candle_close",
        observationSource: "bingx_15m_ohlc_historical_reconciliation",
        followupStatus: "pending",
        followupDeadline: new Date(hit.hitAt.getTime() + FOLLOWUP_MS),
        nextRetryAt: null,
        historyRetryStartedAt: null,
        leaseUntil: null,
        claimToken: null,
        observationError: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(indicatorTargetObservationsTable.id, row.id),
          eq(indicatorTargetObservationsTable.claimToken, claimToken),
        ),
      );
    return;
  }
  if (eventOrder.kind === "ambiguous_trade_close") {
    await db
      .update(indicatorTargetObservationsTable)
      .set({
        status: "unknown",
        followupStatus: "unavailable",
        observationSource: "bingx_15m_ohlc_trade_closing_candle_ambiguous",
        observationError:
          "The target threshold and trade close overlap one 15m candle; ordering is unknown",
        leaseUntil: null,
        claimToken: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(indicatorTargetObservationsTable.id, row.id),
          eq(indicatorTargetObservationsTable.claimToken, claimToken),
        ),
      );
    return;
  }
  const coverageIsAdequate = closedAt
    ? hasCompleteNoHitBoundaryEvidence({
        candles,
        startAt: row.signal_at,
        endAt: closedAt,
        now,
      })
    : hasContinuousClosed15mCoverage({
        candles,
        startAt: row.signal_at,
        endAt: queryEnd,
      });
  const expectedCandles = Math.max(
    0,
    queryEnd.getTime() <= row.signal_at.getTime()
      ? 0
      : Math.floor(
          (queryEnd.getTime() - 1) / CANDLE_MS -
            Math.floor(row.signal_at.getTime() / CANDLE_MS),
        ) + 1,
  );
  const historyRetryExpired =
    closedAt != null &&
    row.history_retry_started_at != null &&
    now.getTime() >=
      row.history_retry_started_at.getTime() + CLOSED_HISTORY_RETRY_WINDOW_MS;
  const historyOutcome = classifyNoHitHistoryOutcome({
    continuousCoverage: coverageIsAdequate,
    tradeClosedAt: closedAt,
    retryWindowExpired: historyRetryExpired,
  });
  const noHistory = historyOutcome.status === "unknown";
  const retryingClosedGap =
    closedAt != null && !coverageIsAdequate && !historyRetryExpired;
  await db
    .update(indicatorTargetObservationsTable)
    .set({
      status: historyOutcome.status,
      followupStatus: historyOutcome.followupStatus,
      nextRetryAt:
        historyOutcome.status === "awaiting_hit" && !coverageIsAdequate
          ? new Date(now.getTime() + TRANSIENT_RETRY_DELAY_MS)
          : historyOutcome.status === "awaiting_hit"
            ? new Date(now.getTime() + OPEN_HIT_RECHECK_MS)
            : null,
      historyRetryStartedAt: retryingClosedGap
        ? (row.history_retry_started_at ?? now)
        : null,
      observationSource: candles.length
        ? "bingx_15m_ohlc_historical_reconciliation"
        : null,
      observationError: noHistory
        ? `15m historical coverage remained incomplete at trade close (${candles.length}/${expectedCandles}); bounded retries expired, outcome unknown`
        : retryingClosedGap
          ? `15m historical coverage incomplete at trade close (${candles.length}/${expectedCandles}); retrying before classifying no-hit`
          : coverageIsAdequate
            ? null
            : `15m historical coverage temporarily incomplete (${candles.length}/${expectedCandles}); open trade remains retryable`,
      leaseUntil: null,
      claimToken: null,
      updatedAt: now,
    })
    .where(
      and(
        eq(indicatorTargetObservationsTable.id, row.id),
        eq(indicatorTargetObservationsTable.claimToken, claimToken),
      ),
    );
}

async function reconcileFollowup(
  row: {
    id: number;
    symbol: string;
    is_short: boolean;
    hit_at: Date;
    hit_price: number;
  },
  claimToken: string,
  now: Date,
  getKlines: KlineRangeCache,
): Promise<void> {
  const followup = calculateTargetFollowup({
    candles: await getKlines(
      row.symbol,
      "15m",
      row.hit_at.getTime(),
      Math.min(now.getTime(), row.hit_at.getTime() + FOLLOWUP_MS + CANDLE_MS),
      { strictPayload: true },
    ),
    hitAt: row.hit_at,
    hitPrice: row.hit_price,
    isShort: row.is_short,
    now,
  });
  const retryWindowExpired =
    now.getTime() >= followup.deadline.getTime() + FOLLOWUP_RETRY_WINDOW_MS;
  const retryableIncomplete =
    followup.status !== "complete" && !retryWindowExpired;
  await db
    .update(indicatorTargetObservationsTable)
    .set({
      followupStatus: now < followup.deadline ? "pending" : followup.status,
      nextRetryAt: retryableIncomplete
        ? new Date(now.getTime() + FOLLOWUP_RETRY_DELAY_MS)
        : null,
      priceAt72h: followup.priceAt72h,
      priceAt72hObservedAt: followup.priceAt72hObservedAt,
      priceAt72hChangePct: followup.priceAt72hChangePct,
      maxFavorablePct: followup.maxFavorablePct,
      minFavorablePct: followup.minFavorablePct,
      followupSampleCount: followup.sampleCount,
      followupExpectedSampleCount: followup.expectedSampleCount,
      followupFirstSampleAt: followup.firstSampleAt,
      followupLastSampleAt: followup.lastSampleAt,
      observationSource: "bingx_15m_ohlc_post_hit_72h_reconciliation",
      observationError:
        followup.status === "complete"
          ? null
          : retryWindowExpired
            ? `72h follow-up retry window expired; ${followup.sampleCount}/${followup.expectedSampleCount} unique closed candles`
            : `72h follow-up ${followup.status}; ${followup.sampleCount}/${followup.expectedSampleCount} unique closed candles; retry scheduled`,
      leaseUntil: null,
      claimToken: null,
      updatedAt: now,
    })
    .where(
      and(
        eq(indicatorTargetObservationsTable.id, row.id),
        eq(indicatorTargetObservationsTable.claimToken, claimToken),
      ),
    );
}
