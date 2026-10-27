import {
  db,
  patternBackfillCandlesTable,
  patternDecisionSnapshotsTable,
  prescanTrackerTable,
} from "@workspace/db";
import { withAggregatedKlineVolume } from "./aggregated-kline-volume.js";
import { randomUUID } from "node:crypto";
import { inArray, sql } from "drizzle-orm";
import { getKlinesRange } from "./bingx.js";
import { dbWriteBestEffort } from "./dbWriteFast.js";
import {
  ACTIVE_PATTERN_KEYS,
  PRESERVED_DECOMMISSIONED_PATTERN_KEYS,
} from "./dead-patterns.js";
import { logger } from "./logger.js";
import { getCoinglassTakerFlow } from "./coinglass_taker.js";
import { getSpotTakerFlow } from "./coinglass_spot_taker.js";

const FIFTEEN_MINUTES_MS = 15 * 60 * 1000;
const TRAJECTORY_WINDOW_MS = 72 * 60 * 60 * 1000;
const BUSINESS_OPPORTUNITY_WINDOW_MS = 12 * 60 * 60 * 1000;
const EVENTS_PER_RUN = 64;
const CONCURRENCY = 4;
const CLASSIFY_PER_RUN = 50_000;
const MAX_TRAJECTORY_ATTEMPTS = 8;
const REQUEUE_REJECTS_SINCE = new Date("2026-09-02T00:00:00Z");
const REQUEUE_REJECTS_PER_RUN = 5_000;
const TRAJECTORY_PATTERN_KEYS = [
  ...ACTIVE_PATTERN_KEYS,
  ...PRESERVED_DECOMMISSIONED_PATTERN_KEYS,
] as readonly string[];
const TRAJECTORY_PATTERN_KEYS_SQL = sql.join(
  TRAJECTORY_PATTERN_KEYS.map((key) => sql`${key}`),
  sql`, `,
);
const TRAJECTORY_PATTERN_KEY_SET = new Set(TRAJECTORY_PATTERN_KEYS);
const ACTIVE_PATTERN_ORDER_SQL = sql`CASE pattern_key
  WHEN 'liquidation_cascade' THEN 0
  WHEN 'balanced_grind' THEN 2
  WHEN 'stealth_breakout' THEN 3
  WHEN 'neon_support_bounce' THEN 4
  WHEN 'price_led_momentum' THEN 5
  WHEN 'impulse_buy' THEN 6
  ELSE 99 END`;
export type PatternDecisionKind =
  | "fired"
  | "missed"
  | "rejected"
  | "blocked"
  | "watching"
  | "expired"
  | "deferred";

export type PatternDecisionEventInput = {
  eventKey: string;
  symbol: string;
  patternKey: string;
  decisionKind: PatternDecisionKind;
  reason?: string | null;
  decisionAt: Date;
  entryPrice?: number | null;
  metrics?: unknown;
  provenance?: unknown;
  completeness?: unknown;
  source: string;
  trackedSignalId?: number | null;
  missedSignalId?: number | null;
  signalId?: number | null;
  isShort?: boolean | null;
};

export type TrajectoryAdmissionClass =
  | "full"
  | "sampled"
  | "audit_only"
  | "no_price";

export const FINAL_GATE_REASON_PREFIXES = {
  impulse_buy: [
    "p24h_5_to_10pct",
    "price3h_ge_20pct",
    "price24h_unavailable",
    "price3h_unavailable",
    "oi30m_unavailable",
    "fut_volume_unavailable",
    "volume_placeholder_1x",
    "funding_below_minus_0_1pct",
    "oi1h_above_20pct",
    "oi30m_below_0_26pct",
    "long_liq24h_unavailable",
    "long_liq24h_below_47k",
    "spot_volume_unavailable",
    "spot_volume_below_2x",
    // retired (history keeps the old reasons):
    "spot_volume_above_4x",
    "oi4h_above_20pct",
    "spot_volume_below_1x",
    "spot_volume_above_2x",
    "cvd_complete_not_all_bullish",
  ],
  balanced_grind: ["p24h_"],
  stealth_breakout: ["armed_"],
  bullish_accumulation: [
    "late_entry_price3h",
    "oi1h_negative",
    "oi4h_unwinding",
    "price24h_too_high_5pct",
    "fut_vol_low",
  ],
  whale_watch: [
    "stage_progression",
    "stage2_condition",
    "stage3_condition",
    "insufficient_stages",
    "insufficient_stage_history",
    "cvd_bearish",
    "oi1h_out_of_range",
    "spot_volume_below_threshold",
  ],
  price_led_momentum: [
    "p24h_high",
    "p3h_low",
    "p3h_high",
    "snf_negative_1h",
    "cvd_count_",
  ],
  liquidation_cascade: ["liq_not_exhausted"],
} as const satisfies Readonly<Record<string, readonly string[]>>;

const FINAL_GATE_SOURCE_EXCEPTIONS = [
  "liq_cascade_candidate_capture",
  "liq_cascade_fire_reject",
] as const;

const FINAL_GATE_REASON_SQL = sql.join(
  Object.entries(FINAL_GATE_REASON_PREFIXES).map(
    ([patternKey, prefixes]) => sql`(
      d.pattern_key = ${patternKey}
      AND reason_part.value LIKE ANY (
        ARRAY[${sql.join(
          prefixes.map((prefix) => sql`${`${prefix}%`}`),
          sql`, `,
        )}]
      )
    )`,
  ),
  sql` OR `,
);

const DECISION_GRADE_TRAJECTORY_SQL = sql`(
  d.decision_kind IN ('fired', 'missed', 'watching', 'expired')
  OR d.source IN (${sql.join(
    FINAL_GATE_SOURCE_EXCEPTIONS.map((source) => sql`${source}`),
    sql`, `,
  )})
  OR EXISTS (
    SELECT 1
    FROM unnest(string_to_array(COALESCE(d.decision_reason, ''), '+'))
      AS reason_part(value)
    WHERE ${FINAL_GATE_REASON_SQL}
  )
)`;

export function isFinalGateNearMissReason(
  patternKey: string,
  reason: string | null | undefined,
): boolean {
  const prefixes =
    FINAL_GATE_REASON_PREFIXES[
      patternKey as keyof typeof FINAL_GATE_REASON_PREFIXES
    ];
  if (!prefixes) return false;
  return (reason ?? "")
    .split("+")
    .some((part) => prefixes.some((prefix) => part.startsWith(prefix)));
}

function isNearMissDecision(input: PatternDecisionEventInput): boolean {
  if (
    (FINAL_GATE_SOURCE_EXCEPTIONS as readonly string[]).includes(input.source)
  ) {
    return true;
  }
  return isFinalGateNearMissReason(input.patternKey, input.reason);
}

export function classifyTrajectoryAdmission(
  input: PatternDecisionEventInput,
): TrajectoryAdmissionClass {
  if (input.entryPrice == null || input.entryPrice <= 0) return "no_price";
  if (!TRAJECTORY_PATTERN_KEY_SET.has(input.patternKey)) return "audit_only";
  if (
    input.decisionKind === "fired" ||
    input.decisionKind === "missed" ||
    input.decisionKind === "watching" ||
    input.decisionKind === "expired" ||
    isNearMissDecision(input)
  ) {
    return "full";
  }
  // Every priced decision is kept with its full path (owner policy).
  return "full";
}

export function buildTrajectoryAdmissionFields(
  input: PatternDecisionEventInput,
): {
  trajectoryStatus: "pending" | "unavailable";
  trajectoryLastError: string | null;
} {
  const admission = classifyTrajectoryAdmission(input);
  return {
    trajectoryStatus:
      admission === "full" || admission === "sampled"
        ? "pending"
        : "unavailable",
    trajectoryLastError:
      admission === "no_price"
        ? "entry_price_not_recorded"
        : admission === "audit_only"
          ? TRAJECTORY_PATTERN_KEY_SET.has(input.patternKey)
            ? "not_admitted_low_value_reject"
            : "retired_pattern_no_backfill"
          : null,
  };
}

/**
 * Owner policy: every decision (fired, watching, rejected, ...) of every
 * pattern stores the full flow snapshot (OI, CVD, taker, spot volume, ...).
 * Events that do not already carry one get the prescan tracker row of the
 * same cycle. Best effort: a failed lookup never blocks the decision write.
 */
async function withFlowSnapshots(
  events: PatternDecisionEventInput[],
): Promise<PatternDecisionEventInput[]> {
  const flowOf = (event: PatternDecisionEventInput) => {
    const m = event.metrics as Record<string, unknown> | null | undefined;
    const f = m && typeof m === "object" ? m.flowSnapshot : undefined;
    return f && typeof f === "object"
      ? (f as Record<string, unknown>)
      : undefined;
  };
  // Events without a snapshot, or with one lacking either taker value.
  const missing = events.filter((event) => {
    const f = flowOf(event);
    return !f || f.netBuyPct == null || f.spotTakerNetBuy == null;
  });
  if (missing.length === 0) return events;
  try {
    const symbols = [...new Set(missing.map((event) => event.symbol))];
    const rows: (typeof prescanTrackerTable.$inferSelect)[] = [];
    for (let i = 0; i < symbols.length; i += 400) {
      rows.push(
        ...(await db
          .select()
          .from(prescanTrackerTable)
          .where(
            inArray(prescanTrackerTable.symbol, symbols.slice(i, i + 400)),
          )),
      );
    }
    const bySymbol = new Map(rows.map((row) => [row.symbol, row]));
    const capturedAt = Date.now();
    const missingSet = new Set(missing);
    // Owner policy: taker is written for every decision. Where the prescan row
    // has no taker value, fetch aggregated CoinGlass taker on demand (cached,
    // shared CoinGlass admission; bounded wait). Failure stays an explicit null.
    type PrescanTaker = {
      lastNetBuyPct?: number | null;
      lastSpotTakerNetBuy?: number | null;
      lastSpotTakerDominance?: string | null;
    };
    const known = (event: PatternDecisionEventInput) => {
      const f = flowOf(event);
      const row = bySymbol.get(event.symbol) as PrescanTaker | undefined;
      return {
        fut: (f?.netBuyPct as number | null | undefined) ?? row?.lastNetBuyPct,
        spot:
          (f?.spotTakerNetBuy as number | null | undefined) ??
          row?.lastSpotTakerNetBuy,
        dom:
          (f?.spotTakerDominance as string | null | undefined) ??
          row?.lastSpotTakerDominance,
      };
    };
    const needTaker = [
      ...new Set(
        missing
          .filter((event) => {
            const k = known(event);
            return k.fut == null || k.spot == null;
          })
          .map((event) => event.symbol),
      ),
    ];
    const live = new Map<
      string,
      { fut: number | null; spot: number | null; dom: string | null }
    >();
    const deadline = Date.now() + 20_000;
    let cursor = 0;
    const worker = async () => {
      while (cursor < needTaker.length && Date.now() < deadline) {
        const sym = needTaker[cursor++]!;
        const [fut, spot] = await Promise.all([
          getCoinglassTakerFlow(sym).catch(() => null),
          getSpotTakerFlow(sym).catch(() => null),
        ]);
        live.set(sym, {
          fut: fut?.available ? fut.netBuyPct : null,
          spot: spot?.available ? spot.netBuyPct : null,
          dom: spot?.available ? spot.dominance : null,
        });
      }
    };
    await Promise.all(Array.from({ length: 4 }, worker));
    return events.map((event) => {
      if (!missingSet.has(event)) return event;
      const row = bySymbol.get(event.symbol);
      const l = live.get(event.symbol);
      const existing = flowOf(event);
      const base: Record<string, unknown> = existing
        ? existing
        : row
          ? { ...row, capturedAt }
          : { capturedAt, available: false };
      const k = known(event);
      const flowSnapshot = {
        ...base,
        netBuyPct: k.fut ?? l?.fut ?? null,
        spotTakerNetBuy: k.spot ?? l?.spot ?? null,
        spotTakerDominance: k.dom ?? l?.dom ?? null,
        ...(l
          ? {
              takerOnDemand: {
                source: "coinglass_aggregated_on_demand",
                fetchedAt: Date.now(),
                futuresFetched: k.fut == null,
                spotFetched: k.spot == null,
              },
            }
          : {}),
      };
      return {
        ...event,
        metrics: {
          ...((event.metrics ?? {}) as Record<string, unknown>),
          flowSnapshot,
        },
      };
    });
  } catch (err) {
    logger.warn({ err }, "pattern decision flow snapshot lookup failed");
    return events;
  }
}

/** Durable, idempotent event capture. It deliberately never changes trade flow. */
export async function recordPatternDecisionEvent(
  input: PatternDecisionEventInput,
): Promise<void> {
  await recordPatternDecisionEventsBatch([input]);
}

/** Batches high-volume scanner/detector decisions into bounded DB writes. */
export async function recordPatternDecisionEventsBatch(
  inputs: PatternDecisionEventInput[],
): Promise<boolean> {
  if (inputs.length === 0) return true;
  const unique = await withFlowSnapshots([
    ...new Map(inputs.map((input) => [input.eventKey, input])).values(),
  ]);
  for (let cursor = 0; cursor < unique.length; cursor += 500) {
    const batch = unique.slice(cursor, cursor + 500);
    const written = await dbWriteBestEffort(
      `patternDecision:batch:${batch[0]!.source}`,
      () =>
        db
          .insert(patternDecisionSnapshotsTable)
          .values(
            batch.map((input) => {
              const admission = buildTrajectoryAdmissionFields(input);
              return {
                eventKey: input.eventKey,
                trackedSignalId: input.trackedSignalId ?? null,
                missedSignalId: input.missedSignalId ?? null,
                signalId: input.signalId ?? null,
                symbol: input.symbol,
                patternKey: input.patternKey,
                decisionKind: input.decisionKind,
                decisionReason: input.reason ?? null,
                decisionAt: input.decisionAt,
                isShort: input.isShort ?? false,
                entryPrice: input.entryPrice ?? null,
                entryMetrics: input.metrics ?? {},
                provenance: input.provenance ?? {},
                completeness: input.completeness ?? {},
                source: input.source,
                ...admission,
              };
            }),
          )
          .onConflictDoNothing(),
      { perAttemptTimeoutMs: 8000, attempts: 2, retryDelayMs: 1000 },
    );
    if (written === null) return false;
  }
  return true;
}

export function scannerRejectedDecisionEventKey(
  cycleAt: Date,
  patternKey: string,
  symbol: string,
  reason: string,
  decisionKind: Extract<
    PatternDecisionKind,
    "rejected" | "blocked" | "deferred"
  > = "rejected",
): string {
  const bucket = Math.floor(cycleAt.getTime() / BUSINESS_OPPORTUNITY_WINDOW_MS);
  return `scanner-${decisionKind}:${bucket}:${patternKey}:${symbol}:${patternDecisionReasonGroup(reason)}`;
}

export function patternDecisionReasonGroup(reason: string): string {
  if (reason.startsWith("funding_neg_")) return "funding_neg";
  if (reason.startsWith("wi_bearish_")) return "wi_bearish";
  return reason.split("=", 1)[0] ?? reason;
}

export function oiWatchDecisionEventKey(
  id: number,
  outcome: "watching" | "fired" | "expired",
): string {
  return `oi-watch:${id}:${outcome}`;
}

export function liqWatchDecisionEventKey(
  id: number,
  outcome: "watching" | "fired" | "expired",
): string {
  return `liq-watch:${id}:${outcome}`;
}

export function liqCascadeRejectedDecisionEventKey(
  symbol: string,
  bucket: number,
  reason: string,
): string {
  return `liq-rejected:${symbol}:${bucket}:${reason}`;
}

export function patternDecisionOpportunityBucket(decisionAt: Date): number {
  return Math.floor(decisionAt.getTime() / BUSINESS_OPPORTUNITY_WINDOW_MS);
}

export function trackedDecisionEventKey(
  trackedSignalId: number,
  reentryDecisionAt?: Date,
): string {
  // A normal tracker row has one immutable event. A deliberately recycled row
  // needs a distinct identity; its timestamp is the persisted new decision time.
  return reentryDecisionAt
    ? `tracked:${trackedSignalId}:reentry:${reentryDecisionAt.toISOString()}`
    : `tracked:${trackedSignalId}`;
}

export async function snapshotTrackedDecision(
  trackedSignalId: number,
  options: { reentryDecisionAt?: Date; source?: string } = {},
): Promise<void> {
  const eventKey = trackedDecisionEventKey(
    trackedSignalId,
    options.reentryDecisionAt,
  );
  await db.execute(sql`
    INSERT INTO pattern_decision_snapshots (
      event_key, tracked_signal_id, signal_id, symbol, pattern_key,
      decision_kind, decision_at, is_short, entry_price,
      trajectory_status, trajectory_last_error, entry_metrics,
      provenance, completeness, source
    )
    SELECT
      ${eventKey}, t.id, t.signal_id, t.symbol, COALESCE(t.sentiment_key, t.signal_type, 'unknown'),
      'fired', t.detected_at, t.is_short, t.entry_price,
       CASE
         WHEN t.entry_price IS NULL OR t.entry_price <= 0 THEN 'unavailable'
         WHEN COALESCE(t.sentiment_key, t.signal_type, 'unknown') IN (${TRAJECTORY_PATTERN_KEYS_SQL}) THEN 'pending'
         ELSE 'unavailable'
       END,
       CASE
         WHEN t.entry_price IS NULL OR t.entry_price <= 0 THEN 'entry_price_not_recorded'
         WHEN COALESCE(t.sentiment_key, t.signal_type, 'unknown') NOT IN (${TRAJECTORY_PATTERN_KEYS_SQL}) THEN 'retired_pattern_no_backfill'
         ELSE NULL
       END,
        (to_jsonb(t) - ARRAY[
          'entry_williams_r_21', 'entry_williams_r_21_ema_13',
          'entry_rsi_5', 'entry_rsi_5_divergence',
          'entry_rsi_5_regular_bullish', 'entry_rsi_5_hidden_bullish',
          'entry_rsi_5_regular_bearish', 'entry_rsi_5_hidden_bearish',
          'entry_indicator_timeframe', 'entry_indicator_candle_close_at',
          'entry_indicator_source', 'entry_indicator_telemetry',
          'entry_adx_14', 'entry_plus_di_14', 'entry_minus_di_14',
          'entry_adx_slope_3', 'entry_atr_14_percent',
          'entry_atr_percentile_60d', 'entry_atr_change_3',
          'entry_bollinger_bandwidth', 'entry_bollinger_bandwidth_percentile_60d',
          'entry_bollinger_expansion_3', 'entry_bollinger_position',
          'entry_anchored_vwap', 'entry_anchored_vwap_distance_percent',
          'entry_anchored_vwap_distance_atr', 'entry_anchored_vwap_above',
          'entry_anchored_vwap_reclaim', 'entry_indicator_anchor_at',
          'entry_indicator_anchor_kind', 'entry_candle_analysis'
        ]::text[])
          || (
            COALESCE(t.impulse_decision_metrics, '{}'::jsonb)
            - ARRAY[
              'entryWilliamsR21', 'entryWilliamsR21Ema13', 'entryRsi5',
              'entryRsi5Divergence', 'entryRsi5RegularBullish',
              'entryRsi5HiddenBullish', 'entryRsi5RegularBearish',
              'entryRsi5HiddenBearish', 'entryIndicatorTimeframe',
              'entryIndicatorCandleCloseAt', 'entryIndicatorSource',
              'entryIndicatorTelemetry', 'entryAdx14', 'entryPlusDi14',
              'entryMinusDi14', 'entryAdxSlope3', 'entryAtr14Percent',
              'entryAtrPercentile60d', 'entryAtrChange3',
              'entryBollingerBandwidth',
              'entryBollingerBandwidthPercentile60d',
              'entryBollingerExpansion3', 'entryBollingerPosition',
              'entryAnchoredVwap', 'entryAnchoredVwapDistancePercent',
              'entryAnchoredVwapDistanceAtr', 'entryAnchoredVwapAbove',
              'entryAnchoredVwapReclaim', 'entryIndicatorAnchorAt',
              'entryIndicatorAnchorKind', 'entryCandleAnalysis'
            ]::text[]
          )
          || (
            COALESCE(t.decision_metrics, '{}'::jsonb)
            - ARRAY[
              'entryWilliamsR21', 'entryWilliamsR21Ema13', 'entryRsi5',
              'entryRsi5Divergence', 'entryRsi5RegularBullish',
              'entryRsi5HiddenBullish', 'entryRsi5RegularBearish',
              'entryRsi5HiddenBearish', 'entryIndicatorTimeframe',
              'entryIndicatorCandleCloseAt', 'entryIndicatorSource',
              'entryIndicatorTelemetry', 'entryAdx14', 'entryPlusDi14',
              'entryMinusDi14', 'entryAdxSlope3', 'entryAtr14Percent',
              'entryAtrPercentile60d', 'entryAtrChange3',
              'entryBollingerBandwidth',
              'entryBollingerBandwidthPercentile60d',
              'entryBollingerExpansion3', 'entryBollingerPosition',
              'entryAnchoredVwap', 'entryAnchoredVwapDistancePercent',
              'entryAnchoredVwapDistanceAtr', 'entryAnchoredVwapAbove',
              'entryAnchoredVwapReclaim', 'entryIndicatorAnchorAt',
              'entryIndicatorAnchorKind', 'entryCandleAnalysis'
            ]::text[]
          ),
      jsonb_build_object(
        'record', 'tracked_signals',
        'capture', 'persisted_at_fire',
        'entry_metrics_provenance', COALESCE(t.entry_metrics_provenance, '{}'::jsonb),
        'decision_metrics_capture',
           CASE
             WHEN t.decision_metrics IS NULL
               AND t.impulse_decision_metrics IS NULL THEN 'not_provided'
            ELSE 'scanner_decision_time'
          END
      ),
      jsonb_build_object(
        'legacy', false,
        'entry_metrics', 'persisted_tracked_signals_row',
        'trajectory', 'pending_or_partial'
      ),
      ${options.source ?? "tracked_signals"}
    FROM tracked_signals t
    WHERE t.id = ${trackedSignalId}
    ON CONFLICT (event_key) DO NOTHING
  `);
}

/**
 * Repairs pre-feature tracker rows without pretending that absent historic
 * fields were observed at fire time. `to_jsonb` also preserves newly introduced
 * universal metrics without a second, fragile column list.
 */
export async function reconcilePatternDecisionSnapshots(): Promise<number> {
  const tracked = await db.execute(sql`
    INSERT INTO pattern_decision_snapshots (
      event_key, tracked_signal_id, signal_id, symbol, pattern_key,
      decision_kind, decision_at, is_short, entry_price,
      trajectory_status, trajectory_last_error, entry_metrics,
      provenance, completeness, source
    )
    SELECT
      'tracked:' || t.id::text, t.id, t.signal_id, t.symbol, COALESCE(t.sentiment_key, t.signal_type, 'unknown'),
      'fired', t.detected_at, t.is_short, t.entry_price,
      CASE
        WHEN t.entry_price IS NULL OR t.entry_price <= 0 THEN 'unavailable'
        WHEN COALESCE(t.sentiment_key, t.signal_type, 'unknown') IN (${TRAJECTORY_PATTERN_KEYS_SQL}) THEN 'pending'
        ELSE 'unavailable'
      END,
      CASE
        WHEN t.entry_price IS NULL OR t.entry_price <= 0 THEN 'entry_price_not_recorded'
        WHEN COALESCE(t.sentiment_key, t.signal_type, 'unknown') NOT IN (${TRAJECTORY_PATTERN_KEYS_SQL}) THEN 'retired_pattern_no_backfill'
        ELSE NULL
      END,
       (to_jsonb(t) - ARRAY[
         'entry_williams_r_21', 'entry_williams_r_21_ema_13',
         'entry_rsi_5', 'entry_rsi_5_divergence',
         'entry_rsi_5_regular_bullish', 'entry_rsi_5_hidden_bullish',
         'entry_rsi_5_regular_bearish', 'entry_rsi_5_hidden_bearish',
         'entry_indicator_timeframe', 'entry_indicator_candle_close_at',
         'entry_indicator_source', 'entry_indicator_telemetry',
         'entry_adx_14', 'entry_plus_di_14', 'entry_minus_di_14',
         'entry_adx_slope_3', 'entry_atr_14_percent',
         'entry_atr_percentile_60d', 'entry_atr_change_3',
         'entry_bollinger_bandwidth', 'entry_bollinger_bandwidth_percentile_60d',
         'entry_bollinger_expansion_3', 'entry_bollinger_position',
         'entry_anchored_vwap', 'entry_anchored_vwap_distance_percent',
         'entry_anchored_vwap_distance_atr', 'entry_anchored_vwap_above',
         'entry_anchored_vwap_reclaim', 'entry_indicator_anchor_at',
         'entry_indicator_anchor_kind', 'entry_candle_analysis'
       ]::text[])
         || (
           COALESCE(t.impulse_decision_metrics, '{}'::jsonb)
           - ARRAY[
             'entryWilliamsR21', 'entryWilliamsR21Ema13', 'entryRsi5',
             'entryRsi5Divergence', 'entryRsi5RegularBullish',
             'entryRsi5HiddenBullish', 'entryRsi5RegularBearish',
             'entryRsi5HiddenBearish', 'entryIndicatorTimeframe',
             'entryIndicatorCandleCloseAt', 'entryIndicatorSource',
             'entryIndicatorTelemetry', 'entryAdx14', 'entryPlusDi14',
             'entryMinusDi14', 'entryAdxSlope3', 'entryAtr14Percent',
             'entryAtrPercentile60d', 'entryAtrChange3',
             'entryBollingerBandwidth',
             'entryBollingerBandwidthPercentile60d',
             'entryBollingerExpansion3', 'entryBollingerPosition',
             'entryAnchoredVwap', 'entryAnchoredVwapDistancePercent',
             'entryAnchoredVwapDistanceAtr', 'entryAnchoredVwapAbove',
             'entryAnchoredVwapReclaim', 'entryIndicatorAnchorAt',
             'entryIndicatorAnchorKind', 'entryCandleAnalysis'
           ]::text[]
         )
         || (
           COALESCE(t.decision_metrics, '{}'::jsonb)
           - ARRAY[
             'entryWilliamsR21', 'entryWilliamsR21Ema13', 'entryRsi5',
             'entryRsi5Divergence', 'entryRsi5RegularBullish',
             'entryRsi5HiddenBullish', 'entryRsi5RegularBearish',
             'entryRsi5HiddenBearish', 'entryIndicatorTimeframe',
             'entryIndicatorCandleCloseAt', 'entryIndicatorSource',
             'entryIndicatorTelemetry', 'entryAdx14', 'entryPlusDi14',
             'entryMinusDi14', 'entryAdxSlope3', 'entryAtr14Percent',
             'entryAtrPercentile60d', 'entryAtrChange3',
             'entryBollingerBandwidth',
             'entryBollingerBandwidthPercentile60d',
             'entryBollingerExpansion3', 'entryBollingerPosition',
             'entryAnchoredVwap', 'entryAnchoredVwapDistancePercent',
             'entryAnchoredVwapDistanceAtr', 'entryAnchoredVwapAbove',
             'entryAnchoredVwapReclaim', 'entryIndicatorAnchorAt',
             'entryIndicatorAnchorKind', 'entryCandleAnalysis'
           ]::text[]
         ),
      jsonb_build_object(
        'record', 'tracked_signals',
        'capture',
          CASE
             WHEN t.decision_metrics IS NULL
               AND t.impulse_decision_metrics IS NULL THEN 'legacy_reconciliation'
            ELSE 'persisted_tracker_reconciliation'
          END,
        'decision_metrics_capture',
          CASE
             WHEN t.decision_metrics IS NULL
               AND t.impulse_decision_metrics IS NULL THEN 'not_provided'
            ELSE 'scanner_decision_time'
          END
      ),
      jsonb_build_object(
        'legacy', t.decision_metrics IS NULL AND t.impulse_decision_metrics IS NULL,
        'entry_metrics',
          CASE
             WHEN t.decision_metrics IS NULL
               AND t.impulse_decision_metrics IS NULL THEN 'only_columns_persisted_on_legacy_row'
            ELSE 'scanner_decision_time_payload'
          END,
        'missing_semantics', 'null_or_absent_means_not_recorded_not_reconstructed',
        'trajectory', 'pending_or_partial'
      ),
      CASE
        WHEN t.decision_metrics IS NULL
          AND t.impulse_decision_metrics IS NULL THEN 'tracked_signals_legacy'
        ELSE 'tracked_signals'
      END
    FROM tracked_signals t
    WHERE NOT EXISTS (
      SELECT 1 FROM pattern_decision_snapshots d
      WHERE d.event_key = 'tracked:' || t.id::text
    )
    ORDER BY t.id ASC
    LIMIT ${EVENTS_PER_RUN}
    ON CONFLICT (event_key) DO NOTHING
  `);
  const missed = await db.execute(sql`
    INSERT INTO pattern_decision_snapshots (
      event_key, missed_signal_id, symbol, pattern_key, decision_kind,
      decision_at, is_short, entry_price, trajectory_status,
      trajectory_last_error, entry_metrics, provenance,
      completeness, source
    )
    SELECT
      'missed:' || m.id::text, m.id, m.symbol, COALESCE(m.pattern, m.source, 'unknown'),
      'missed', m.logged_at, false, m.price_at_log,
       CASE
         WHEN m.price_at_log IS NULL OR m.price_at_log <= 0 THEN 'unavailable'
         WHEN COALESCE(m.pattern, m.source, 'unknown') IN (${TRAJECTORY_PATTERN_KEYS_SQL}) THEN 'pending'
         ELSE 'unavailable'
       END,
       CASE
         WHEN m.price_at_log IS NULL OR m.price_at_log <= 0 THEN 'entry_price_not_recorded'
         WHEN COALESCE(m.pattern, m.source, 'unknown') NOT IN (${TRAJECTORY_PATTERN_KEYS_SQL}) THEN 'retired_pattern_no_backfill'
         ELSE NULL
       END,
      to_jsonb(m),
      jsonb_build_object('record', 'missed_signals_log', 'capture', 'persisted_decision_log'),
      jsonb_build_object(
        'legacy', false,
        'decision_metrics', 'preserved_from_decision_metrics_json_and_explicit_columns',
        'missing_semantics', 'null_or_absent_means_not_recorded_not_reconstructed',
        'trajectory', 'pending_or_partial'
      ),
      'missed_signals_log'
    FROM missed_signals_log m
    WHERE NOT EXISTS (
      SELECT 1 FROM pattern_decision_snapshots d
      WHERE d.event_key = 'missed:' || m.id::text
    )
    ORDER BY m.id ASC
    LIMIT ${EVENTS_PER_RUN}
    ON CONFLICT (event_key) DO NOTHING
  `);
  const oiWatching = await db.execute(sql`
    INSERT INTO pattern_decision_snapshots (
      event_key, symbol, pattern_key, decision_kind, decision_reason, decision_at,
      is_short, entry_price, trajectory_status, trajectory_last_error,
      entry_metrics, provenance, completeness, source
    )
    SELECT 'oi-watch:' || w.id::text || ':watching', w.symbol,
      COALESCE(w.sentiment_key, w.trigger_tf, 'unknown'), 'watching',
      COALESCE(w.vol_status_reason, w.status::text), w.added_at, false,
      w.price_at_entry,
       CASE
         WHEN w.price_at_entry IS NULL OR w.price_at_entry <= 0 THEN 'unavailable'
         WHEN COALESCE(w.sentiment_key, w.trigger_tf, 'unknown') IN (${TRAJECTORY_PATTERN_KEYS_SQL}) THEN 'pending'
         ELSE 'unavailable'
       END,
       CASE
         WHEN w.price_at_entry IS NULL OR w.price_at_entry <= 0 THEN 'entry_price_not_recorded'
         WHEN COALESCE(w.sentiment_key, w.trigger_tf, 'unknown') NOT IN (${TRAJECTORY_PATTERN_KEYS_SQL}) THEN 'retired_pattern_no_backfill'
         ELSE NULL
       END,
      to_jsonb(w),
      jsonb_build_object('record', 'oi_watch', 'capture', 'reconciliation', 'timestamp_semantics', 'added_at_is_watch_start'),
      jsonb_build_object('missing_semantics', 'null_or_absent_means_not_recorded_not_reconstructed'),
      'oi_watch_reconciliation'
    FROM oi_watch w
    WHERE NOT EXISTS (
      SELECT 1 FROM pattern_decision_snapshots d
      WHERE d.event_key = 'oi-watch:' || w.id::text || ':watching'
    )
    ORDER BY w.id ASC LIMIT ${EVENTS_PER_RUN}
    ON CONFLICT (event_key) DO NOTHING
  `);
  const oiTerminal = await db.execute(sql`
    INSERT INTO pattern_decision_snapshots (
      event_key, symbol, pattern_key, decision_kind, decision_reason, decision_at,
      is_short, entry_price, trajectory_status, trajectory_last_error,
      entry_metrics, provenance, completeness, source
    )
    SELECT 'oi-watch:' || w.id::text || ':' || w.status, w.symbol,
      COALESCE(w.sentiment_key, w.trigger_tf, 'unknown'), w.status::text,
      COALESCE(w.vol_status_reason, w.status::text),
      CASE WHEN w.status = 'fired' THEN COALESCE(w.fired_at, w.added_at) ELSE w.expires_at END,
      false, w.price_at_entry,
       CASE
         WHEN w.price_at_entry IS NULL OR w.price_at_entry <= 0 THEN 'unavailable'
         WHEN COALESCE(w.sentiment_key, w.trigger_tf, 'unknown') IN (${TRAJECTORY_PATTERN_KEYS_SQL}) THEN 'pending'
         ELSE 'unavailable'
       END,
       CASE
         WHEN w.price_at_entry IS NULL OR w.price_at_entry <= 0 THEN 'entry_price_not_recorded'
         WHEN COALESCE(w.sentiment_key, w.trigger_tf, 'unknown') NOT IN (${TRAJECTORY_PATTERN_KEYS_SQL}) THEN 'retired_pattern_no_backfill'
         ELSE NULL
       END,
      to_jsonb(w),
      jsonb_build_object('record', 'oi_watch', 'capture', 'reconciliation', 'timestamp_semantics', 'fired_at_or_added_at_for_legacy_fired__expires_at_for_expired'),
      jsonb_build_object('missing_semantics', 'null_or_absent_means_not_recorded_not_reconstructed'),
      'oi_watch_reconciliation'
    FROM oi_watch w
    WHERE w.status IN ('fired', 'expired')
      AND NOT EXISTS (
        SELECT 1 FROM pattern_decision_snapshots d
        WHERE d.event_key = 'oi-watch:' || w.id::text || ':' || w.status
      )
    ORDER BY w.id ASC LIMIT ${EVENTS_PER_RUN}
    ON CONFLICT (event_key) DO NOTHING
  `);
  const liqWatching = await db.execute(sql`
    INSERT INTO pattern_decision_snapshots (
      event_key, symbol, pattern_key, decision_kind, decision_reason, decision_at,
      is_short, entry_price, trajectory_status, trajectory_last_error,
      entry_metrics, provenance, completeness, source
    )
    SELECT 'liq-watch:' || w.id::text || ':watching', w.symbol, 'liquidation_cascade',
      'watching', COALESCE(w.entry_reason, w.status), w.detected_at, false,
      w.price_at_detect,
      CASE WHEN w.price_at_detect IS NULL OR w.price_at_detect <= 0 THEN 'unavailable' ELSE 'pending' END,
      CASE WHEN w.price_at_detect IS NULL OR w.price_at_detect <= 0 THEN 'entry_price_not_recorded' ELSE NULL END,
      to_jsonb(w),
      jsonb_build_object('record', 'liq_cascade_watch', 'capture', 'reconciliation', 'timestamp_semantics', 'detected_at_is_watch_start'),
      jsonb_build_object('missing_semantics', 'null_or_absent_means_not_recorded_not_reconstructed'),
      'liq_cascade_watch_reconciliation'
    FROM liq_cascade_watch w
    WHERE NOT EXISTS (
      SELECT 1 FROM pattern_decision_snapshots d
      WHERE d.event_key = 'liq-watch:' || w.id::text || ':watching'
    )
    ORDER BY w.id ASC LIMIT ${EVENTS_PER_RUN}
    ON CONFLICT (event_key) DO NOTHING
  `);
  const liqTerminal = await db.execute(sql`
    INSERT INTO pattern_decision_snapshots (
      event_key, symbol, pattern_key, decision_kind, decision_reason, decision_at,
      is_short, entry_price, trajectory_status, trajectory_last_error,
      entry_metrics, provenance, completeness, source
    )
    SELECT 'liq-watch:' || w.id::text || ':' || w.status, w.symbol, 'liquidation_cascade',
      w.status, COALESCE(w.miss_reason, w.entry_reason, w.status),
      CASE WHEN w.status = 'expired' THEN w.expires_at ELSE w.detected_at END,
      false, w.price_at_detect,
      CASE WHEN w.price_at_detect IS NULL OR w.price_at_detect <= 0 THEN 'unavailable' ELSE 'pending' END,
      CASE WHEN w.price_at_detect IS NULL OR w.price_at_detect <= 0 THEN 'entry_price_not_recorded' ELSE NULL END,
      to_jsonb(w),
      jsonb_build_object('record', 'liq_cascade_watch', 'capture', 'reconciliation', 'timestamp_semantics', 'detected_at_for_fired_without_fired_at__expires_at_for_expired'),
      jsonb_build_object('missing_semantics', 'null_or_absent_means_not_recorded_not_reconstructed'),
      'liq_cascade_watch_reconciliation'
    FROM liq_cascade_watch w
    WHERE w.status IN ('fired', 'expired')
      AND NOT EXISTS (
        SELECT 1 FROM pattern_decision_snapshots d
        WHERE d.event_key = 'liq-watch:' || w.id::text || ':' || w.status
      )
    ORDER BY w.id ASC LIMIT ${EVENTS_PER_RUN}
    ON CONFLICT (event_key) DO NOTHING
  `);
  const liqRejected = await db.execute(sql`
    WITH first_rejected AS (
      SELECT DISTINCT ON (o.watch_id, o.reason = 'weak_liq_continued_decline')
        o.watch_id, o.symbol, o.reason, o.observed_at, o.price, o.metrics
      FROM liq_cascade_candidate_observations o
      WHERE o.stage = 'rejected'
        AND o.price IS NOT NULL
        AND o.price > 0
      ORDER BY o.watch_id, o.reason = 'weak_liq_continued_decline',
        o.observed_at ASC, o.id ASC
    )
    INSERT INTO pattern_decision_snapshots (
      event_key, symbol, pattern_key, decision_kind, decision_reason,
      decision_at, is_short, entry_price, trajectory_status,
      trajectory_last_error, entry_metrics, provenance, completeness, source
    )
    SELECT
      'liq-watch-observation:' || r.watch_id::text ||
        CASE WHEN r.reason = 'weak_liq_continued_decline'
          THEN ':rejected-trajectory:weak_liq_continued_decline'
          ELSE ':rejected-trajectory' END,
      r.symbol, 'liquidation_cascade', 'rejected', r.reason,
      r.observed_at, false, r.price, 'pending', NULL, r.metrics,
      jsonb_build_object(
        'record', 'liq_cascade_candidate_observations',
        'capture', 'reconciliation',
        'timestamp_semantics', 'observed_at_is_rejection_time',
        'entry_price', 'persisted_rejection_price'
      ),
      jsonb_build_object(
        'missing_semantics', 'null_or_absent_means_not_recorded_not_reconstructed',
        'entryPrice', true
      ),
      'liq_cascade_fire_reject'
    FROM first_rejected r
    WHERE NOT EXISTS (
      SELECT 1
      FROM pattern_decision_snapshots d
      WHERE d.event_key =
        'liq-watch-observation:' || r.watch_id::text ||
        CASE WHEN r.reason = 'weak_liq_continued_decline'
          THEN ':rejected-trajectory:weak_liq_continued_decline'
          ELSE ':rejected-trajectory' END
    )
    ORDER BY r.watch_id ASC
    LIMIT ${EVENTS_PER_RUN}
    ON CONFLICT (event_key) DO NOTHING
  `);
  return [
    tracked,
    missed,
    oiWatching,
    oiTerminal,
    liqWatching,
    liqTerminal,
    liqRejected,
  ].reduce((count, result) => count + (result.rowCount ?? 0), 0);
}

type BackfillCandidate = {
  id: number;
  symbol: string;
  decision_at: Date;
  latest_candle_at: Date | null;
  trajectory_attempts: number;
};

export type PatternTrajectoryClaim = {
  claimToken: string;
  candidates: BackfillCandidate[];
};
export type PatternTrajectoryBacklogStatus = {
  asOf: string;
  admissionPolicy: {
    fullTrajectoryKinds: string[];
    lowValueRejectSamplePercent: number;
    trajectoryPatternKeys: string[];
  };
  rows: {
    pending: number;
    partial: number;
    retry: number;
    complete: number;
    unavailable: number;
    auditOnly: number;
    missingEntryPriceAwaitingClassification: number;
  };
  independentBacklog: number;
  independentDue: number;
  decisionGradeBacklog: number;
  decisionGradeDue: number;
  auditSampleBacklog: number;
  auditSampleDue: number;
  oldestDueAt: string | null;
  completedLast6h: number;
  completionRatePerHour: number | null;
  etaSeconds: number | null;
  dueByPattern: Record<string, number>;
  decisionGradeDueByPattern: Record<string, number>;
  auditSampleDueByPattern: Record<string, number>;
  replay: Array<{
    patternKey: string;
    reasonGroup: string;
    total: number;
    complete: number;
    partial: number;
    unavailable: number;
    pending: number;
    covered24h: number;
    covered72h: number;
    tp5BeforeSl10: number;
    tp10BeforeSl10: number;
    tp15BeforeSl10: number;
    sl10BeforeTp10: number;
    ambiguousTp10AndSl10SameCandle: number;
    ambiguousTp5AndSl10SameCandle: number;
    ambiguousTp15AndSl10SameCandle: number;
    avgMfe24h: number | null;
    avgMae24h: number | null;
    avgMfe72h: number | null;
    avgMae72h: number | null;
  }>;
};

export function estimateTrajectoryEtaSeconds(
  due: number,
  completedInWindow: number,
  windowHours: number,
): number | null {
  if (
    due <= 0 ||
    completedInWindow <= 0 ||
    !Number.isFinite(windowHours) ||
    windowHours <= 0
  ) {
    return due <= 0 ? 0 : null;
  }
  return Math.ceil((due / (completedInWindow / windowHours)) * 60 * 60);
}

function numeric(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export async function getPatternTrajectoryBacklogStatus(): Promise<PatternTrajectoryBacklogStatus> {
  const [countsResult, dueResult, replayResult] = await Promise.all([
    db.execute<{
      trajectory_status: string;
      count: string;
      missing_entry: string;
      audit_only: string;
    }>(sql`
      SELECT trajectory_status, COUNT(*)::text AS count,
        COUNT(*) FILTER (
          WHERE (entry_price IS NULL OR entry_price <= 0)
            AND trajectory_status IN ('pending', 'partial', 'retry')
        )::text AS missing_entry,
        COUNT(*) FILTER (
          WHERE trajectory_last_error IN (
            'not_admitted_low_value_reject',
            'retired_pattern_no_backfill'
          )
        )::text AS audit_only
      FROM pattern_decision_snapshots
      GROUP BY trajectory_status
    `),
    db.execute<{
      independent_backlog: string;
      independent_due: string;
      decision_grade_backlog: string;
      decision_grade_due: string;
      audit_sample_backlog: string;
      audit_sample_due: string;
      oldest_due_at: Date | null;
      completed_last_6h: string;
      due_by_pattern: Record<string, number> | null;
      decision_grade_due_by_pattern: Record<string, number> | null;
      audit_sample_due_by_pattern: Record<string, number> | null;
    }>(sql`
      WITH backlog AS (
        SELECT d.*,
          CASE
            WHEN d.decision_kind IN ('rejected', 'blocked', 'deferred')
              THEN d.pattern_key || ':' || d.symbol || ':' || d.decision_kind || ':' ||
                CASE
                  WHEN d.decision_reason LIKE 'funding_neg_%' THEN 'funding_neg'
                  WHEN d.decision_reason LIKE 'wi_bearish_%' THEN 'wi_bearish'
                  ELSE split_part(COALESCE(d.decision_reason, ''), '=', 1)
                END || ':' ||
                floor(extract(epoch FROM d.decision_at) / 43200)::text
            ELSE d.event_key
          END AS opportunity_key,
          (
            d.trajectory_next_attempt_at IS NULL
            OR d.trajectory_next_attempt_at <= now()
          ) AS due_now,
          ${DECISION_GRADE_TRAJECTORY_SQL} AS decision_grade
        FROM pattern_decision_snapshots d
        WHERE d.entry_price > 0
          AND d.pattern_key IN (${TRAJECTORY_PATTERN_KEYS_SQL})
          AND d.decision_at <= now() - interval '15 minutes'
          AND d.trajectory_status IN ('pending', 'partial', 'retry')
      ),
      by_pattern AS (
        SELECT pattern_key,
          COUNT(DISTINCT opportunity_key)::int AS count,
          COUNT(DISTINCT opportunity_key) FILTER (
            WHERE decision_grade
          )::int AS decision_grade_count,
          COUNT(DISTINCT opportunity_key) FILTER (
            WHERE NOT decision_grade
          )::int AS audit_sample_count
        FROM backlog
        WHERE due_now
        GROUP BY pattern_key
      ),
      completed AS (
        SELECT
          CASE
            WHEN d.decision_kind IN ('rejected', 'blocked', 'deferred')
              THEN d.pattern_key || ':' || d.symbol || ':' || d.decision_kind || ':' ||
                CASE
                  WHEN d.decision_reason LIKE 'funding_neg_%' THEN 'funding_neg'
                  WHEN d.decision_reason LIKE 'wi_bearish_%' THEN 'wi_bearish'
                  ELSE split_part(COALESCE(d.decision_reason, ''), '=', 1)
                END || ':' ||
                floor(extract(epoch FROM d.decision_at) / 43200)::text
            ELSE d.event_key
          END AS opportunity_key
        FROM pattern_decision_snapshots d
        WHERE d.trajectory_completed_at >= now() - interval '6 hours'
      )
      SELECT
        (SELECT COUNT(DISTINCT opportunity_key)::text FROM backlog)
          AS independent_backlog,
        (SELECT COUNT(DISTINCT opportunity_key)::text FROM backlog WHERE due_now)
          AS independent_due,
        (SELECT COUNT(DISTINCT opportunity_key)::text
          FROM backlog WHERE decision_grade) AS decision_grade_backlog,
        (SELECT COUNT(DISTINCT opportunity_key)::text
          FROM backlog WHERE decision_grade AND due_now) AS decision_grade_due,
        (SELECT COUNT(DISTINCT opportunity_key)::text
          FROM backlog WHERE NOT decision_grade) AS audit_sample_backlog,
        (SELECT COUNT(DISTINCT opportunity_key)::text
          FROM backlog WHERE NOT decision_grade AND due_now) AS audit_sample_due,
        (SELECT MIN(decision_at) FROM backlog WHERE due_now) AS oldest_due_at,
        (SELECT COUNT(DISTINCT opportunity_key)::text FROM completed)
          AS completed_last_6h,
        COALESCE(
          (SELECT jsonb_object_agg(pattern_key, count)
            FROM by_pattern),
          '{}'::jsonb
        ) AS due_by_pattern,
        COALESCE(
          (SELECT jsonb_object_agg(pattern_key, decision_grade_count)
            FROM by_pattern WHERE decision_grade_count > 0),
          '{}'::jsonb
        ) AS decision_grade_due_by_pattern,
        COALESCE(
          (SELECT jsonb_object_agg(pattern_key, audit_sample_count)
            FROM by_pattern WHERE audit_sample_count > 0),
          '{}'::jsonb
        ) AS audit_sample_due_by_pattern
    `),
    db.execute<{
      pattern_key: string;
      reason_group: string;
      total: string;
      complete: string;
      partial: string;
      unavailable: string;
      pending: string;
      covered_24h: string;
      covered_72h: string;
      tp5_before_sl10: string;
      tp10_before_sl10: string;
      tp15_before_sl10: string;
      sl10_before_tp10: string;
      ambiguous_tp10_sl10: string;
      ambiguous_tp5_sl10: string;
      ambiguous_tp15_sl10: string;
      avg_mfe_24h: string | null;
      avg_mae_24h: string | null;
      avg_mfe_72h: string | null;
      avg_mae_72h: string | null;
    }>(sql`
      WITH trajectories AS (
        SELECT
          d.id,
          d.pattern_key,
          CASE
            WHEN d.decision_reason LIKE 'funding_neg_%' THEN 'funding_neg'
            WHEN d.decision_reason LIKE 'wi_bearish_%' THEN 'wi_bearish'
            ELSE split_part(COALESCE(d.decision_reason, ''), '=', 1)
          END AS reason_group,
          d.trajectory_status,
          MAX(c.candle_at) >= to_timestamp(
            floor(
              (
                extract(epoch FROM (d.decision_at + interval '24 hours'))
                - 900
              ) / 900
            ) * 900
          ) AS covered_24h,
          MAX(c.candle_at) >= to_timestamp(
            floor(
              (
                extract(epoch FROM (d.decision_at + interval '72 hours'))
                - 900
              ) / 900
            ) * 900
          ) AS covered_72h,
          MIN(c.candle_at) FILTER (
            WHERE c.high >= d.entry_price * 1.05
          ) AS tp5_at,
          MIN(c.candle_at) FILTER (
            WHERE c.high >= d.entry_price * 1.10
          ) AS tp10_at,
          MIN(c.candle_at) FILTER (
            WHERE c.high >= d.entry_price * 1.15
          ) AS tp15_at,
          MIN(c.candle_at) FILTER (
            WHERE c.low <= d.entry_price * 0.90
          ) AS sl10_at,
          MAX((c.high / d.entry_price - 1) * 100) FILTER (
            WHERE c.candle_at <= d.decision_at + interval '24 hours'
          ) AS mfe_24h,
          MIN((c.low / d.entry_price - 1) * 100) FILTER (
            WHERE c.candle_at <= d.decision_at + interval '24 hours'
          ) AS mae_24h,
          MAX((c.high / d.entry_price - 1) * 100) AS mfe_72h,
          MIN((c.low / d.entry_price - 1) * 100) AS mae_72h
        FROM pattern_decision_snapshots d
        LEFT JOIN pattern_backfill_candles c
          ON c.decision_snapshot_id = d.id
          AND c.interval = '15m'
        WHERE d.entry_price > 0
          AND (
            (
              d.pattern_key = 'balanced_grind'
              AND d.decision_kind = 'rejected'
              AND d.decision_reason LIKE 'p24h_%'
            )
            OR d.source = 'liq_cascade_fire_reject'
          )
        GROUP BY d.id
      )
      SELECT
        pattern_key,
        reason_group,
        COUNT(*)::text AS total,
        COUNT(*) FILTER (WHERE trajectory_status = 'complete')::text AS complete,
        COUNT(*) FILTER (WHERE trajectory_status = 'partial')::text AS partial,
        COUNT(*) FILTER (WHERE trajectory_status = 'unavailable')::text AS unavailable,
        COUNT(*) FILTER (
          WHERE trajectory_status IN ('pending', 'retry')
        )::text AS pending,
        COUNT(*) FILTER (WHERE covered_24h)::text AS covered_24h,
        COUNT(*) FILTER (WHERE covered_72h)::text AS covered_72h,
        COUNT(*) FILTER (
          WHERE tp5_at IS NOT NULL
            AND (sl10_at IS NULL OR tp5_at < sl10_at)
        )::text AS tp5_before_sl10,
        COUNT(*) FILTER (
          WHERE tp5_at IS NOT NULL
            AND sl10_at IS NOT NULL
            AND tp5_at = sl10_at
        )::text AS ambiguous_tp5_sl10,
        COUNT(*) FILTER (
          WHERE tp10_at IS NOT NULL
            AND (sl10_at IS NULL OR tp10_at < sl10_at)
        )::text AS tp10_before_sl10,
        COUNT(*) FILTER (
          WHERE tp15_at IS NOT NULL
            AND (sl10_at IS NULL OR tp15_at < sl10_at)
        )::text AS tp15_before_sl10,
        COUNT(*) FILTER (
          WHERE sl10_at IS NOT NULL
            AND (tp10_at IS NULL OR sl10_at < tp10_at)
        )::text AS sl10_before_tp10,
        COUNT(*) FILTER (
          WHERE tp10_at IS NOT NULL
            AND sl10_at IS NOT NULL
            AND tp10_at = sl10_at
        )::text AS ambiguous_tp10_sl10,
        COUNT(*) FILTER (
          WHERE tp15_at IS NOT NULL
            AND sl10_at IS NOT NULL
            AND tp15_at = sl10_at
        )::text AS ambiguous_tp15_sl10,
        ROUND((AVG(mfe_24h) FILTER (WHERE covered_24h))::numeric, 2)::text
          AS avg_mfe_24h,
        ROUND((AVG(mae_24h) FILTER (WHERE covered_24h))::numeric, 2)::text
          AS avg_mae_24h,
        ROUND((AVG(mfe_72h) FILTER (WHERE covered_72h))::numeric, 2)::text
          AS avg_mfe_72h,
        ROUND((AVG(mae_72h) FILTER (WHERE covered_72h))::numeric, 2)::text
          AS avg_mae_72h
      FROM trajectories
      GROUP BY pattern_key, reason_group
      ORDER BY pattern_key, reason_group
    `),
  ]);

  const rows = {
    pending: 0,
    partial: 0,
    retry: 0,
    complete: 0,
    unavailable: 0,
    auditOnly: 0,
    missingEntryPriceAwaitingClassification: 0,
  };
  for (const row of countsResult.rows) {
    if (row.trajectory_status in rows) {
      rows[
        row.trajectory_status as keyof Omit<
          typeof rows,
          "auditOnly" | "missingEntryPriceAwaitingClassification"
        >
      ] = numeric(row.count);
    }
    rows.auditOnly += numeric(row.audit_only);
    rows.missingEntryPriceAwaitingClassification += numeric(row.missing_entry);
  }
  const due = dueResult.rows[0];
  const independentBacklog = numeric(due?.independent_backlog);
  const independentDue = numeric(due?.independent_due);
  const decisionGradeBacklog = numeric(due?.decision_grade_backlog);
  const decisionGradeDue = numeric(due?.decision_grade_due);
  const auditSampleBacklog = numeric(due?.audit_sample_backlog);
  const auditSampleDue = numeric(due?.audit_sample_due);
  const completedLast6h = numeric(due?.completed_last_6h);
  return {
    asOf: new Date().toISOString(),
    admissionPolicy: {
      fullTrajectoryKinds: [
        "fired",
        "missed",
        "watching",
        "expired",
        "near_miss",
      ],
      lowValueRejectSamplePercent: 100,
      trajectoryPatternKeys: [...TRAJECTORY_PATTERN_KEYS],
    },
    rows,
    independentBacklog,
    independentDue,
    decisionGradeBacklog,
    decisionGradeDue,
    auditSampleBacklog,
    auditSampleDue,
    oldestDueAt: due?.oldest_due_at
      ? new Date(due.oldest_due_at).toISOString()
      : null,
    completedLast6h,
    completionRatePerHour:
      completedLast6h > 0 ? Number((completedLast6h / 6).toFixed(2)) : null,
    etaSeconds: estimateTrajectoryEtaSeconds(
      independentBacklog,
      completedLast6h,
      6,
    ),
    dueByPattern: due?.due_by_pattern ?? {},
    decisionGradeDueByPattern: due?.decision_grade_due_by_pattern ?? {},
    auditSampleDueByPattern: due?.audit_sample_due_by_pattern ?? {},
    replay: replayResult.rows.map((row) => ({
      patternKey: row.pattern_key,
      reasonGroup: row.reason_group,
      total: numeric(row.total),
      complete: numeric(row.complete),
      partial: numeric(row.partial),
      unavailable: numeric(row.unavailable),
      pending: numeric(row.pending),
      covered24h: numeric(row.covered_24h),
      covered72h: numeric(row.covered_72h),
      tp5BeforeSl10: numeric(row.tp5_before_sl10),
      tp10BeforeSl10: numeric(row.tp10_before_sl10),
      tp15BeforeSl10: numeric(row.tp15_before_sl10),
      sl10BeforeTp10: numeric(row.sl10_before_tp10),
      ambiguousTp10AndSl10SameCandle: numeric(row.ambiguous_tp10_sl10),
      ambiguousTp5AndSl10SameCandle: numeric(row.ambiguous_tp5_sl10),
      ambiguousTp15AndSl10SameCandle: numeric(row.ambiguous_tp15_sl10),
      avgMfe24h: row.avg_mfe_24h == null ? null : numeric(row.avg_mfe_24h),
      avgMae24h: row.avg_mae_24h == null ? null : numeric(row.avg_mae_24h),
      avgMfe72h: row.avg_mfe_72h == null ? null : numeric(row.avg_mfe_72h),
      avgMae72h: row.avg_mae_72h == null ? null : numeric(row.avg_mae_72h),
    })),
  };
}

function expectedClosedBucket(
  decisionAt: number,
  endAt: number,
): number | null {
  const first = Math.ceil(decisionAt / FIFTEEN_MINUTES_MS) * FIFTEEN_MINUTES_MS;
  const last =
    Math.floor((endAt - FIFTEEN_MINUTES_MS) / FIFTEEN_MINUTES_MS) *
    FIFTEEN_MINUTES_MS;
  return first <= last ? last : null;
}

export function expectedTrajectoryCoverageBucket(
  decisionAt: Date,
  horizonMs: number,
): Date | null {
  const decisionMs = decisionAt.getTime();
  const bucket = expectedClosedBucket(decisionMs, decisionMs + horizonMs);
  return bucket == null ? null : new Date(bucket);
}

function retryDelayMs(attempt: number): number {
  return Math.min(6 * 60 * 60 * 1000, 60_000 * 2 ** Math.min(attempt, 8));
}

export async function claimPatternDecisionTrajectories(
  limit = EVENTS_PER_RUN,
): Promise<PatternTrajectoryClaim> {
  const claimToken = randomUUID();
  const candidates = await db.execute<BackfillCandidate>(sql`
    WITH keys AS (
      SELECT unnest(ARRAY[${TRAJECTORY_PATTERN_KEYS_SQL}]::text[]) AS pattern_key
    ),
    -- Bounded per-pattern prefilter (2026-10-21): the former full-backlog
    -- join + GROUP BY over ~250k pending rows exceeded the read timeout, so
    -- no trajectory was claimed after 2026-10-06. Fired rows and the oldest
    -- other rows of each pattern are taken first; priority and the latest
    -- candle are evaluated only for this small set.
    prefilter AS (
      SELECT x.*
      FROM keys k
      CROSS JOIN LATERAL (
        (
          SELECT d.id, d.symbol, d.pattern_key, d.decision_kind,
            d.decision_reason, d.decision_at, d.source,
            d.trajectory_attempts, d.trajectory_next_attempt_at
          FROM pattern_decision_snapshots d
          WHERE d.pattern_key = k.pattern_key
            AND d.decision_kind = 'fired'
            AND d.entry_price > 0
            AND d.decision_at <= now() - interval '15 minutes'
            AND d.trajectory_status IN ('pending', 'partial', 'retry')
            AND (d.trajectory_next_attempt_at IS NULL OR d.trajectory_next_attempt_at <= now())
            AND (d.trajectory_claim_expires_at IS NULL OR d.trajectory_claim_expires_at <= now())
          ORDER BY d.decision_at ASC, d.id ASC
          LIMIT ${limit * 2}
        )
        UNION ALL
        (
          SELECT d.id, d.symbol, d.pattern_key, d.decision_kind,
            d.decision_reason, d.decision_at, d.source,
            d.trajectory_attempts, d.trajectory_next_attempt_at
          FROM pattern_decision_snapshots d
          WHERE d.pattern_key = k.pattern_key
            AND d.decision_kind <> 'fired'
            AND d.entry_price > 0
            AND d.decision_at <= now() - interval '15 minutes'
            AND d.trajectory_status IN ('pending', 'partial', 'retry')
            AND (d.trajectory_next_attempt_at IS NULL OR d.trajectory_next_attempt_at <= now())
            AND (d.trajectory_claim_expires_at IS NULL OR d.trajectory_claim_expires_at <= now())
          ORDER BY d.decision_at ASC, d.id ASC
          LIMIT ${limit * 2}
        )
      ) x
    ),
    eligible AS (
      SELECT d.id, d.symbol, d.pattern_key, d.decision_kind,
        d.decision_reason, d.decision_at, d.source,
        d.trajectory_attempts, d.trajectory_next_attempt_at,
        CASE
          WHEN d.decision_kind = 'fired' THEN 0
          WHEN ${DECISION_GRADE_TRAJECTORY_SQL} THEN 1
          ELSE 2
        END AS trajectory_priority,
        (
          SELECT MAX(c.candle_at) FROM pattern_backfill_candles c
          WHERE c.decision_snapshot_id = d.id AND c.interval = '15m'
        ) AS latest_candle_at
      FROM prefilter d
    ),
    ranked AS (
      SELECT eligible.*,
        ROW_NUMBER() OVER (
          PARTITION BY pattern_key
          ORDER BY
            trajectory_priority ASC,
            trajectory_next_attempt_at ASC NULLS FIRST,
            decision_at ASC, id ASC
        ) AS pattern_rank,
        CASE
          WHEN pattern_key IN (${TRAJECTORY_PATTERN_KEYS_SQL}) THEN 0
          ELSE 1
        END AS lifecycle_rank
      FROM eligible
    ),
    selected AS (
      SELECT id, latest_candle_at
      FROM ranked
      ORDER BY lifecycle_rank ASC, pattern_rank ASC,
        trajectory_priority ASC, ${ACTIVE_PATTERN_ORDER_SQL} ASC,
        trajectory_next_attempt_at ASC NULLS FIRST, decision_at ASC, id ASC
      LIMIT ${limit}
    )
    UPDATE pattern_decision_snapshots d
    SET trajectory_claim_token = ${claimToken},
        trajectory_claimed_at = now(),
        trajectory_claim_expires_at = now() + interval '15 minutes'
    FROM selected s
    WHERE d.id = s.id
      AND d.entry_price > 0
      AND d.pattern_key IN (${TRAJECTORY_PATTERN_KEYS_SQL})
      AND d.decision_at <= now() - interval '15 minutes'
      AND d.trajectory_status IN ('pending', 'partial', 'retry')
      AND (
        d.trajectory_next_attempt_at IS NULL
        OR d.trajectory_next_attempt_at <= now()
      )
      AND (
        d.trajectory_claim_expires_at IS NULL
        OR d.trajectory_claim_expires_at <= now()
      )
    RETURNING d.id, d.symbol, d.decision_at, d.trajectory_attempts,
      s.latest_candle_at
  `);
  return { claimToken, candidates: candidates.rows };
}
export async function backfillPatternDecisionTrajectories(): Promise<number> {
  const { claimToken, candidates } = await claimPatternDecisionTrajectories();
  let written = 0;
  for (let cursor = 0; cursor < candidates.length; cursor += CONCURRENCY) {
    const batch = candidates.slice(cursor, cursor + CONCURRENCY);
    const results = await Promise.all(
      batch.map(async (decision) => {
        const decisionAt = new Date(decision.decision_at).getTime();
        const end = Math.min(Date.now(), decisionAt + TRAJECTORY_WINDOW_MS);
        const start = Math.max(
          decisionAt,
          decision.latest_candle_at
            ? new Date(decision.latest_candle_at).getTime() + FIFTEEN_MINUTES_MS
            : decisionAt,
        );
        const expected = expectedClosedBucket(decisionAt, end);
        try {
          const candles =
            start <= end
              ? await withAggregatedKlineVolume(
                  decision.symbol,
                  "15m",
                  await getKlinesRange(decision.symbol, "15m", start, end),
                )
              : [];
          const closedAt = Date.now();
          const rows = candles.flatMap((candle) => {
            const open = Number(candle.open);
            const high = Number(candle.high);
            const low = Number(candle.low);
            const close = Number(candle.close);
            const volume = Number(candle.volume);
            if (
              candle.time < decisionAt ||
              candle.time + FIFTEEN_MINUTES_MS > closedAt ||
              ![open, high, low, close].every(Number.isFinite)
            ) {
              return [];
            }
            return [
              {
                decisionSnapshotId: decision.id,
                interval: "15m",
                candleAt: new Date(candle.time),
                open,
                high,
                low,
                close,
                volume: Number.isFinite(volume) ? volume : null,
                source: "bingx_15m",
                fetchedAt: new Date(),
              },
            ];
          });
          if (rows.length > 0) {
            await db
              .insert(patternBackfillCandlesTable)
              .values(rows)
              .onConflictDoNothing();
          }
          const latest =
            rows.at(-1)?.candleAt.getTime() ??
            (decision.latest_candle_at
              ? new Date(decision.latest_candle_at).getTime()
              : null);
          const mature = Date.now() >= decisionAt + TRAJECTORY_WINDOW_MS;
          // One bucket tolerance accommodates exchange range boundary behavior,
          // but never turns an empty mature trajectory into a completion.
          const reached =
            expected != null &&
            latest != null &&
            latest >= expected - FIFTEEN_MINUTES_MS;
          if (mature && !reached) {
            await markTrajectoryRetry(
              decision.id,
              decision.trajectory_attempts,
              claimToken,
              "BingX returned no usable candle through expected closed bucket",
            );
          } else {
            const status = mature && reached ? "complete" : "partial";
            await db.execute(sql`
                UPDATE pattern_decision_snapshots
                SET trajectory_status = ${status},
                    trajectory_attempts = 0,
                    trajectory_last_attempt_at = now(),
                    trajectory_next_attempt_at = CASE WHEN ${status} = 'complete' THEN NULL ELSE now() + interval '6 hours' END,
                    trajectory_completed_at = CASE WHEN ${status} = 'complete' THEN now() ELSE NULL END,
                    trajectory_last_error = NULL,
                    trajectory_claim_token = NULL,
                    trajectory_claimed_at = NULL,
                    trajectory_claim_expires_at = NULL,
                    trajectory_candle_count = (
                      SELECT COUNT(*)::int FROM pattern_backfill_candles
                      WHERE decision_snapshot_id = ${decision.id} AND interval = '15m'
                    )
                WHERE id = ${decision.id}
                  AND trajectory_claim_token = ${claimToken}
              `);
          }
          return rows.length;
        } catch (err) {
          await markTrajectoryRetry(
            decision.id,
            decision.trajectory_attempts,
            claimToken,
            err instanceof Error
              ? err.message
              : "unknown BingX trajectory error",
          );
          logger.warn(
            { err, decisionSnapshotId: decision.id, symbol: decision.symbol },
            "Pattern decision trajectory backfill failed; will retry",
          );
          return 0;
        }
      }),
    );
    written += results.reduce((sum, value) => sum + value, 0);
  }
  return written;
}

export async function classifyUnfillablePatternDecisionTrajectories(): Promise<{
  missingEntryPrice: number;
  duplicateOpportunity: number;
  lowValueReject: number;
  retiredPattern: number;
}> {
  const missing = await db.execute(sql`
    WITH candidates AS (
      SELECT id
      FROM pattern_decision_snapshots
      WHERE (entry_price IS NULL OR entry_price <= 0)
        AND trajectory_status IN ('pending', 'partial', 'retry')
        AND (
          trajectory_claim_expires_at IS NULL
          OR trajectory_claim_expires_at <= now()
        )
      ORDER BY id ASC
      LIMIT ${CLASSIFY_PER_RUN}
    )
    UPDATE pattern_decision_snapshots d
    SET trajectory_status = 'unavailable',
        trajectory_next_attempt_at = NULL,
        trajectory_last_error = 'entry_price_not_recorded',
        trajectory_claim_token = NULL,
        trajectory_claimed_at = NULL,
        trajectory_claim_expires_at = NULL
    FROM candidates c
    WHERE d.id = c.id
      AND (d.entry_price IS NULL OR d.entry_price <= 0)
      AND d.trajectory_status IN ('pending', 'partial', 'retry')
      AND (
        d.trajectory_claim_expires_at IS NULL
        OR d.trajectory_claim_expires_at <= now()
      )
  `);

  // Owner policy (2026-10-10): every priced decision of a trajectory pattern
  // gets a full price path. Rows earlier demoted as "low value" since the
  // cutoff are re-queued gradually instead of being demoted.
  const lowValue = await db.execute(sql`
    WITH candidates AS (
      SELECT d.id
      FROM pattern_decision_snapshots d
      WHERE d.trajectory_last_error = 'not_admitted_low_value_reject'
        AND d.trajectory_status = 'unavailable'
        AND d.entry_price > 0
        AND d.decision_at >= ${REQUEUE_REJECTS_SINCE}
        AND d.pattern_key IN (${TRAJECTORY_PATTERN_KEYS_SQL})
      ORDER BY d.id DESC
      LIMIT ${REQUEUE_REJECTS_PER_RUN}
    )
    UPDATE pattern_decision_snapshots d
    SET trajectory_status = 'pending',
        trajectory_next_attempt_at = NULL,
        trajectory_last_error = NULL
    FROM candidates c
    WHERE d.id = c.id
  `);

  const retired = await db.execute(sql`
    WITH candidates AS (
      SELECT d.id
      FROM pattern_decision_snapshots d
      WHERE d.pattern_key NOT IN (${TRAJECTORY_PATTERN_KEYS_SQL})
        AND d.trajectory_status IN ('pending', 'partial', 'retry')
        AND (
          d.trajectory_claim_expires_at IS NULL
          OR d.trajectory_claim_expires_at <= now()
        )
      ORDER BY d.id ASC
      LIMIT ${CLASSIFY_PER_RUN}
    )
    UPDATE pattern_decision_snapshots d
    SET trajectory_status = 'unavailable',
        trajectory_next_attempt_at = NULL,
        trajectory_last_error = 'retired_pattern_no_backfill',
        trajectory_claim_token = NULL,
        trajectory_claimed_at = NULL,
        trajectory_claim_expires_at = NULL
    FROM candidates c
    WHERE d.id = c.id
      AND d.pattern_key NOT IN (${TRAJECTORY_PATTERN_KEYS_SQL})
      AND d.trajectory_status IN ('pending', 'partial', 'retry')
      AND (
        d.trajectory_claim_expires_at IS NULL
        OR d.trajectory_claim_expires_at <= now()
      )
  `);

  return {
    missingEntryPrice: missing.rowCount ?? 0,
    // Live scanner event keys already collapse one pattern/reason/symbol into a
    // 12-hour business opportunity. Do not run a recurring historical window
    // rank here: once its canonical row completes, the next duplicate would be
    // promoted and bias replay while repeatedly sorting the large history table.
    duplicateOpportunity: 0,
    lowValueReject: lowValue.rowCount ?? 0,
    retiredPattern: retired.rowCount ?? 0,
  };
}

async function markTrajectoryRetry(
  id: number,
  previousAttempts: number,
  claimToken: string,
  error: string,
): Promise<void> {
  const attempts = previousAttempts + 1;
  const unavailable = attempts >= MAX_TRAJECTORY_ATTEMPTS;
  await db.execute(sql`
    UPDATE pattern_decision_snapshots
    SET trajectory_status = ${unavailable ? "unavailable" : "retry"},
        trajectory_attempts = ${attempts},
        trajectory_last_attempt_at = now(),
        trajectory_next_attempt_at = ${unavailable ? null : new Date(Date.now() + retryDelayMs(attempts))},
        trajectory_last_error = ${error.slice(0, 1000)},
        trajectory_claim_token = NULL,
        trajectory_claimed_at = NULL,
        trajectory_claim_expires_at = NULL,
        trajectory_candle_count = (
          SELECT COUNT(*)::int FROM pattern_backfill_candles
          WHERE decision_snapshot_id = ${id} AND interval = '15m'
        )
    WHERE id = ${id}
      AND trajectory_claim_token = ${claimToken}
  `);
}
