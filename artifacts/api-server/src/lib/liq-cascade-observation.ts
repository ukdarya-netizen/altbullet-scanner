import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { dbWriteBestEffort } from "./dbWriteFast.js";
import {
  liqWatchDecisionEventKey,
  recordPatternDecisionEvent,
} from "./pattern-decision-history.js";
import {
  liqCascadeObservationBucket,
  liqCascadeObservationEventKey,
  type LiqCascadeObservationStage,
} from "./liq-cascade-observation-identity.js";

export async function recordLiqCascadeObservation(input: {
  watchId: number;
  symbol: string;
  detectedAt: Date;
  observedAt?: Date;
  stage: LiqCascadeObservationStage;
  reason?: string | null;
  price?: number | null;
  metrics?: Record<string, unknown>;
  signalId?: number | null;
}): Promise<boolean> {
  const observedAt = input.observedAt ?? new Date();
  const bucketAt = liqCascadeObservationBucket(observedAt);
  const eventKey = liqCascadeObservationEventKey({
    watchId: input.watchId,
    stage: input.stage,
    reason: input.reason,
    observedAt,
  });
  const metricsJson = JSON.stringify(input.metrics ?? {});
  const written = await dbWriteBestEffort(
    `liqCascadeObservation:${input.watchId}:${input.stage}`,
    () =>
      input.stage === "rejected"
        ? db.execute(sql`
            WITH canonical_observation AS (
              INSERT INTO liq_cascade_candidate_observations AS existing (
                event_key, watch_id, signal_id, symbol, detected_at,
                observed_at, bucket_at, stage, reason, price, metrics
              ) VALUES (
                ${eventKey}, ${input.watchId}, ${input.signalId ?? null},
                ${input.symbol}, ${input.detectedAt}, ${observedAt}, ${bucketAt},
                ${input.stage}, ${input.reason ?? null}, ${input.price},
                ${metricsJson}::jsonb
              )
              ON CONFLICT (event_key) DO UPDATE
                SET observed_at = CASE
                      WHEN existing.price IS NULL OR existing.price <= 0
                        THEN EXCLUDED.observed_at
                      ELSE existing.observed_at
                    END,
                    bucket_at = CASE
                      WHEN existing.price IS NULL OR existing.price <= 0
                        THEN EXCLUDED.bucket_at
                      ELSE existing.bucket_at
                    END,
                    reason = CASE
                      WHEN existing.price IS NULL OR existing.price <= 0
                        THEN EXCLUDED.reason
                      ELSE existing.reason
                    END,
                    price = CASE
                      WHEN existing.price IS NULL OR existing.price <= 0
                        THEN EXCLUDED.price
                      ELSE existing.price
                    END,
                    metrics = CASE
                      WHEN existing.price IS NULL OR existing.price <= 0
                        THEN EXCLUDED.metrics
                      ELSE existing.metrics
                    END
              RETURNING watch_id, symbol, observed_at, reason, price, metrics
            )
            INSERT INTO pattern_decision_snapshots (
              event_key, symbol, pattern_key, decision_kind, decision_reason,
              decision_at, is_short, entry_price, trajectory_status,
              trajectory_last_error, entry_metrics, provenance, completeness,
              source
            )
            SELECT
              'liq-watch-observation:' || o.watch_id::text ||
                CASE WHEN o.reason = 'weak_liq_continued_decline'
                  THEN ':rejected-trajectory:weak_liq_continued_decline'
                  ELSE ':rejected-trajectory' END,
              o.symbol, 'liquidation_cascade', 'rejected', o.reason,
              o.observed_at, false, o.price,
              CASE WHEN o.price IS NULL OR o.price <= 0
                THEN 'unavailable' ELSE 'pending' END,
              CASE WHEN o.price IS NULL OR o.price <= 0
                THEN 'entry_price_not_recorded' ELSE NULL END,
              CASE WHEN o.metrics ? 'flowSnapshot' THEN o.metrics
                ELSE COALESCE(o.metrics, '{}'::jsonb) || jsonb_build_object(
                  'flowSnapshot',
                  COALESCE(
                    (SELECT to_jsonb(p) || jsonb_build_object(
                       'capturedAt', (extract(epoch FROM now()) * 1000)::bigint)
                       FROM prescan_tracker p WHERE p.symbol = o.symbol
                       LIMIT 1),
                    jsonb_build_object(
                      'capturedAt', (extract(epoch FROM now()) * 1000)::bigint,
                      'available', false)
                  )
                ) END,
              jsonb_build_object(
                'record', 'liq_cascade_candidate_observations',
                'capture', 'live_fire_stage_rejection',
                'timestamp_semantics', 'observed_at_is_rejection_time',
                'entry_price', 'bingx_ticker_at_rejection'
              ),
              jsonb_build_object(
                'missing_semantics',
                'null_or_absent_means_not_recorded_not_reconstructed',
                'entryPrice', o.price IS NOT NULL AND o.price > 0
              ),
              'liq_cascade_fire_reject'
            FROM canonical_observation o
            ON CONFLICT (event_key) DO NOTHING
          `)
        : db.execute(sql`
            INSERT INTO liq_cascade_candidate_observations (
              event_key, watch_id, signal_id, symbol, detected_at, observed_at,
              bucket_at, stage, reason, price, metrics
            ) VALUES (
              ${eventKey}, ${input.watchId}, ${input.signalId ?? null},
              ${input.symbol}, ${input.detectedAt}, ${observedAt}, ${bucketAt},
              ${input.stage}, ${input.reason ?? null}, ${input.price ?? null},
              ${metricsJson}::jsonb
            )
            ON CONFLICT (event_key) DO NOTHING
          `),
    { perAttemptTimeoutMs: 5_000, attempts: 2, retryDelayMs: 500 },
  );
  return written !== null;
}

export async function recordLiqCascadeWatchStart(input: {
  watchId: number;
  symbol: string;
  detectedAt: Date;
  entryPrice: number | null;
  reason: string;
  metrics: Record<string, unknown>;
}): Promise<void> {
  await Promise.all([
    recordLiqCascadeObservation({
      ...input,
      stage: "watching",
      observedAt: input.detectedAt,
      price: input.entryPrice,
    }),
    recordPatternDecisionEvent({
      eventKey: liqWatchDecisionEventKey(input.watchId, "watching"),
      symbol: input.symbol,
      patternKey: "liquidation_cascade",
      decisionKind: "watching",
      reason: input.reason,
      decisionAt: input.detectedAt,
      entryPrice: input.entryPrice,
      metrics: input.metrics,
      provenance: {
        record: "liq_cascade_watch",
        capture: "live_candidate_start",
        timestamp_semantics: "detected_at_is_watch_start",
      },
      completeness: {
        missing_semantics:
          "null_or_absent_means_not_recorded_not_reconstructed",
      },
      source: "liq_cascade_candidate_capture",
    }),
  ]);
}
