import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { logger } from "./logger.js";
import type { ShadowDetectorResult } from "./stealth-abneon-detectors.js";
export {
  canClaimAbneonSupportBounce,
  classifyAbneonFirePersistenceFailure,
  isLiveEligibleShadowMethod,
  monotonicShadowStatus,
  ownsAbneonSupportBounceClaim,
  neonConfluenceLabel,
  routePersistedNeonSupportBounces,
  liveEligibilityForShadowUpsert,
  supportBounceQualificationTime,
} from "./stealth-abneon-shadow-pure.js";
import {
  isLiveEligibleShadowMethod,
  neonConfluenceLabel,
  type QualifiedNeonRoutingRow,
} from "./stealth-abneon-shadow-pure.js";

type FrozenArm = {
  level: number;
  armedAt: number;
  evidence: Record<string, unknown> | null;
};
const ACTIVE_CACHE_TTL_MS = 60_000;
let activeCache:
  | { expiresAt: number; values: Map<string, FrozenArm> }
  | undefined;

function cacheKey(
  symbol: string,
  method: ShadowDetectorResult["method"],
): string {
  return `${symbol}:${method}`;
}

async function loadActiveCache(): Promise<Map<string, FrozenArm>> {
  if (activeCache && activeCache.expiresAt > Date.now())
    return activeCache.values;
  // Owner 2026-10-20: a qualified Neon support event that produced no entry
  // within 72h is closed (never touches a claimed/firing event).
  await db.execute(sql`
    UPDATE stealth_abneon_shadow_candidates
    SET status = 'terminal',
        terminal_reason = 'qualified_no_entry_72h',
        updated_at = now()
    WHERE detection_method = 'abneon_support_bounce'
      AND status = 'qualified'
      AND trigger_candle_at IS NOT NULL
      AND trigger_candle_at < now() - interval '72 hours'
      AND (fire_claim_expires_at IS NULL OR fire_claim_expires_at < now())
  `);
  const result = await db.execute(sql`
    SELECT symbol, detection_method, frozen_level, volume_evidence,
      EXTRACT(EPOCH FROM armed_at) * 1000 AS armed_at
    FROM stealth_abneon_shadow_candidates
    WHERE status IN ('armed', 'qualified', 'firing')
    ORDER BY updated_at DESC, id DESC
  `);
  const values = new Map<string, FrozenArm>();
  for (const row of result.rows as Array<Record<string, unknown>>) {
    const key = cacheKey(
      String(row.symbol),
      row.detection_method as ShadowDetectorResult["method"],
    );
    if (!values.has(key)) {
      values.set(key, {
        level: Number(row.frozen_level),
        armedAt: Number(row.armed_at),
        evidence:
          ((row.volume_evidence as Record<string, unknown> | null)
            ?.detectorEvidence as Record<string, unknown> | null) ?? null,
      });
    }
  }
  activeCache = { expiresAt: Date.now() + ACTIVE_CACHE_TTL_MS, values };
  return values;
}

/** Durable shadow ledger. It never claims a live signal or sends Telegram. */
export type PersistedStealthAbneonShadow = {
  method: ShadowDetectorResult["method"];
  status: ShadowDetectorResult["status"];
  frozenLevel: number;
  armCandleTime: number;
  triggerCandleTime: number | null;
  liveEligible: boolean;
  volumeEvidence: Record<string, unknown>;
  detectorEvidence: Record<string, unknown> | null;
};

export async function persistStealthAbneonShadow(input: {
  symbol: string;
  result: ShadowDetectorResult;
  observedAt: number;
}): Promise<PersistedStealthAbneonShadow | null> {
  if (input.result.frozenLevel == null || input.result.armCandleTime == null)
    return null;
  const values = await loadActiveCache();
  const lookupKey = cacheKey(input.symbol, input.result.method);
  const key = `${input.result.armCandleTime}:${input.result.frozenLevel.toPrecision(12)}`;
  const persisted = await db.execute(sql`
    INSERT INTO stealth_abneon_shadow_candidates
      (symbol, detection_method, candidate_key, frozen_level, armed_at,
       trigger_candle_at, status, terminal_reason, volume_evidence, updated_at,
       live_eligible)
    VALUES
      (${input.symbol}, ${input.result.method}, ${key}, ${input.result.frozenLevel},
       to_timestamp(${input.result.armCandleTime / 1000.0}),
       CASE WHEN ${input.result.triggerCandleTime}::double precision IS NULL
         THEN NULL ELSE to_timestamp(${input.result.triggerCandleTime}::double precision / 1000.0) END,
       ${input.result.status}, ${input.result.reason},
        ${JSON.stringify({
          ...input.result.volumeEvidence,
          detectorEvidence: input.result.evidence ?? null,
          latestObservation: input.result.evidence?.latestObservation ?? null,
        })}::jsonb, now(),
        ${
          isLiveEligibleShadowMethod(input.result.method) &&
          (input.result.status === "armed" ||
            input.result.status === "qualified")
        })
    ON CONFLICT (symbol, detection_method, candidate_key) DO UPDATE SET
       live_eligible = CASE
          WHEN stealth_abneon_shadow_candidates.detection_method =
            'order_block_support_bounce'
            THEN false
          WHEN stealth_abneon_shadow_candidates.detection_method =
            'abneon_support_bounce'
            AND stealth_abneon_shadow_candidates.live_eligible
           THEN true
          WHEN stealth_abneon_shadow_candidates.detection_method =
            'abneon_support_bounce'
            AND stealth_abneon_shadow_candidates.status = 'armed'
           AND EXCLUDED.status = 'qualified'
           THEN true
         ELSE false
       END,
      trigger_candle_at = CASE
        WHEN stealth_abneon_shadow_candidates.status IN ('firing', 'fired')
          THEN stealth_abneon_shadow_candidates.trigger_candle_at
         WHEN stealth_abneon_shadow_candidates.status = 'qualified'
           AND EXCLUDED.status IN ('armed', 'qualified', 'terminal')
           THEN stealth_abneon_shadow_candidates.trigger_candle_at
        ELSE EXCLUDED.trigger_candle_at
      END,
      status = CASE
        WHEN stealth_abneon_shadow_candidates.status IN ('firing', 'fired')
          THEN stealth_abneon_shadow_candidates.status
         WHEN stealth_abneon_shadow_candidates.status = 'qualified'
           AND EXCLUDED.status IN ('armed', 'qualified', 'terminal')
           THEN stealth_abneon_shadow_candidates.status
        WHEN stealth_abneon_shadow_candidates.status = 'terminal'
          AND EXCLUDED.status IN ('armed', 'qualified')
          THEN stealth_abneon_shadow_candidates.status
        ELSE EXCLUDED.status
      END,
      terminal_reason = CASE
        WHEN stealth_abneon_shadow_candidates.status IN ('firing', 'fired', 'terminal')
          AND EXCLUDED.status IN ('armed', 'qualified')
          THEN stealth_abneon_shadow_candidates.terminal_reason
        ELSE EXCLUDED.terminal_reason
      END,
      volume_evidence = CASE
         WHEN stealth_abneon_shadow_candidates.status IN ('firing', 'fired')
          THEN stealth_abneon_shadow_candidates.volume_evidence
         WHEN stealth_abneon_shadow_candidates.status = 'qualified'
           AND EXCLUDED.status IN ('armed', 'qualified', 'terminal')
           THEN stealth_abneon_shadow_candidates.volume_evidence
         ELSE jsonb_set(
           EXCLUDED.volume_evidence,
           '{detectorEvidence}',
           COALESCE(
             stealth_abneon_shadow_candidates.volume_evidence->'detectorEvidence',
             EXCLUDED.volume_evidence->'detectorEvidence'
           ),
           true
         )
      END,
      updated_at = CASE
        WHEN stealth_abneon_shadow_candidates.status IN ('firing', 'fired')
          OR (
            stealth_abneon_shadow_candidates.status = 'terminal'
           AND EXCLUDED.status IN ('armed', 'qualified', 'terminal')
          )
          THEN stealth_abneon_shadow_candidates.updated_at
        ELSE now()
      END
   RETURNING symbol, detection_method, frozen_level, armed_at,
      status, trigger_candle_at, live_eligible, volume_evidence,
      EXTRACT(EPOCH FROM armed_at) * 1000 AS armed_at_ms
   `);
  const row = persisted.rows[0] as Record<string, unknown> | undefined;
  if (!row) return null;
  const effectiveStatus = String(row.status);
  if (["armed", "qualified", "firing"].includes(effectiveStatus)) {
    const effectiveEvidence =
      ((row.volume_evidence as Record<string, unknown> | null)
        ?.detectorEvidence as Record<string, unknown> | null) ?? null;
    values.set(lookupKey, {
      level: Number(row.frozen_level),
      armedAt: new Date(String(row.armed_at)).getTime(),
      evidence: effectiveEvidence,
    });
  } else {
    values.delete(lookupKey);
  }
  const effectiveVolumeEvidence =
    (row.volume_evidence as Record<string, unknown> | null) ?? {};
  const triggerValue = row.trigger_candle_at;
  return {
    method: String(row.detection_method) as ShadowDetectorResult["method"],
    status: effectiveStatus as ShadowDetectorResult["status"],
    frozenLevel: Number(row.frozen_level),
    armCandleTime: Number(row.armed_at_ms),
    triggerCandleTime:
      triggerValue == null ? null : new Date(String(triggerValue)).getTime(),
    liveEligible: Boolean(row.live_eligible),
    volumeEvidence: effectiveVolumeEvidence,
    detectorEvidence:
      (effectiveVolumeEvidence.detectorEvidence as Record<
        string,
        unknown
      > | null) ?? null,
  };
}

export type QualifiedAbneonSupportBounce = QualifiedNeonRoutingRow & {
  id: number;
};

/**
 * Reads the durable delivery queue, oldest first. The bound prevents a
 * backlog from monopolizing a scan; ordering by qualification/update time
 * gives older rows fair precedence on every subsequent scan.
 */
export async function listQualifiedAbneonSupportBounces(
  limit = 100,
): Promise<QualifiedAbneonSupportBounce[]> {
  const boundedLimit = Math.max(1, Math.min(100, Math.floor(limit)));
  const result = await db.execute(sql`
    SELECT id, symbol, detection_method, status, live_eligible, frozen_level,
      EXTRACT(EPOCH FROM armed_at) * 1000 AS arm_candle_time,
      EXTRACT(EPOCH FROM trigger_candle_at) * 1000 AS trigger_candle_time,
      volume_evidence->'detectorEvidence' AS detector_evidence
    FROM stealth_abneon_shadow_candidates
    WHERE detection_method = 'abneon_support_bounce'
      AND (
        status = 'qualified'
        OR (
          status = 'firing'
          AND (
            fire_claim_expires_at IS NULL
            OR fire_claim_expires_at < now()
          )
        )
      )
      AND live_eligible = true
      AND trigger_candle_at IS NOT NULL
    ORDER BY updated_at ASC, id ASC
    LIMIT ${boundedLimit}
  `);
  return (result.rows as Array<Record<string, unknown>>).map((row) => ({
    id: Number(row.id),
    symbol: String(row.symbol),
    method: row.detection_method as QualifiedAbneonSupportBounce["method"],
    status: row.status as QualifiedAbneonSupportBounce["status"],
    liveEligible: Boolean(row.live_eligible),
    frozenLevel: Number(row.frozen_level),
    armCandleTime: Number(row.arm_candle_time),
    triggerCandleTime: Number(row.trigger_candle_time),
    confluence: neonConfluenceLabel(row.detector_evidence),
  }));
}

export async function getFrozenStealthAbneonLevel(input: {
  symbol: string;
  method: ShadowDetectorResult["method"];
}): Promise<{
  level: number;
  armedAt: number;
  evidence: Record<string, unknown> | null;
} | null> {
  const values = await loadActiveCache();
  return values.get(cacheKey(input.symbol, input.method)) ?? null;
}

/**
 * Atomically consumes one qualified support-bounce event for live delivery.
 *
 * The claim is deliberately made against the immutable detector identity
 * (symbol + frozen arm + trigger candle), rather than "the latest candidate".
 * This keeps two scanner workers from turning one event into two positions and
 * no longer gives a quiet-zone Stealth arm precedence (owner 2026-10-22).
 */
export async function claimAbneonSupportBounceForFire(input: {
  symbol: string;
  frozenLevel: number;
  armCandleTime: number;
  triggerCandleTime: number;
  owner: string;
}): Promise<{ id: number; token: string } | null> {
  const candidateKey = `${input.armCandleTime}:${input.frozenLevel.toPrecision(12)}`;
  const token = randomUUID();
  const result = await db.execute(sql`
    UPDATE stealth_abneon_shadow_candidates
    SET
      status = 'firing',
      terminal_reason = 'signal_persistence_claimed',
      fire_claim_owner = ${input.owner},
      fire_claim_token = ${token},
      fire_claim_expires_at = now() + interval '30 minutes',
      updated_at = now()
    WHERE symbol = ${input.symbol}
      AND detection_method = 'abneon_support_bounce'
      AND candidate_key = ${candidateKey}
      AND (
        status = 'qualified'
        OR (
          status = 'firing'
          AND (
            fire_claim_expires_at IS NULL
            OR fire_claim_expires_at < now()
          )
        )
      )
      AND live_eligible = true
      AND trigger_candle_at = to_timestamp(${input.triggerCandleTime / 1000.0})
    RETURNING id, fire_claim_token
  `);
  const row = result.rows[0] as
    | { id?: number; fire_claim_token?: string }
    | undefined;
  return row?.id && row.fire_claim_token
    ? { id: row.id, token: row.fire_claim_token }
    : null;
}

/** Renews and revalidates ownership immediately before a side effect. */
export async function renewAbneonSupportBounceClaim(input: {
  id: number;
  owner: string;
  token: string;
}): Promise<boolean> {
  const result = await db.execute(sql`
    UPDATE stealth_abneon_shadow_candidates
    SET
      fire_claim_expires_at = now() + interval '30 minutes',
      updated_at = now()
    WHERE id = ${input.id}
      AND status = 'firing'
      AND fire_claim_owner = ${input.owner}
      AND fire_claim_token = ${input.token}
      AND (
        fire_claim_expires_at IS NULL
        OR fire_claim_expires_at > now()
      )
    RETURNING id
  `);
  return result.rows.length > 0;
}

/** Releases a retryable claim without losing the qualified event. */
export async function releaseAbneonSupportBounceClaim(input: {
  id: number;
  owner: string;
  token: string;
  reason: string;
}): Promise<boolean> {
  const result = await db.execute(sql`
    UPDATE stealth_abneon_shadow_candidates
    SET
      status = 'qualified',
      terminal_reason = ${input.reason},
      fire_claim_owner = NULL,
      fire_claim_token = NULL,
      fire_claim_expires_at = NULL,
      updated_at = now()
    WHERE id = ${input.id}
      AND status = 'firing'
      AND fire_claim_owner = ${input.owner}
      AND fire_claim_token = ${input.token}
    RETURNING id
  `);
  return result.rows.length > 0;
}

/** Marks a claimed event as consumed after signal and tracker persistence. */
export async function markAbneonSupportBounceConsumed(input: {
  id: number;
  owner: string;
  token: string;
  reason: string;
}): Promise<boolean> {
  const result = await db.execute(sql`
    UPDATE stealth_abneon_shadow_candidates
    SET
      status = 'fired',
      terminal_reason = ${input.reason},
      fire_claim_owner = NULL,
      fire_claim_token = NULL,
      fire_claim_expires_at = NULL,
      updated_at = now()
    WHERE id = ${input.id}
      AND status = 'firing'
      AND fire_claim_owner = ${input.owner}
      AND fire_claim_token = ${input.token}
    RETURNING id
  `);
  return result.rows.length > 0;
}

/**
 * Owner 2026-10-20: a qualified support event whose zone is broken can never
 * be delivered. Terminalize it (only while still qualified, never a claimed
 * fire) so the detector can arm the next support zone below.
 */
export async function terminalizeBrokenQualifiedNeonSupport(input: {
  symbol: string;
  frozenLevel: number;
  armCandleTime: number;
  triggerCandleTime: number;
}): Promise<boolean> {
  const candidateKey = `${input.armCandleTime}:${input.frozenLevel.toPrecision(12)}`;
  const result = await db.execute(sql`
    UPDATE stealth_abneon_shadow_candidates
    SET status = 'terminal',
        terminal_reason = 'support_broken_switch_to_lower_zone',
        updated_at = now()
    WHERE symbol = ${input.symbol}
      AND detection_method = 'abneon_support_bounce'
      AND candidate_key = ${candidateKey}
      AND status = 'qualified'
      AND trigger_candle_at = to_timestamp(${input.triggerCandleTime / 1000.0})
    RETURNING id
  `);
  if (result.rows.length > 0) activeCache = undefined;
  return result.rows.length > 0;
}

/**
 * Owner 2026-10-25: a qualified Neon event that was offered to a scan and did
 * not fire is closed; it never waits for later gates at a higher price.
 */
export async function expireOfferedNeonSupportEvents(
  ids: readonly number[],
): Promise<number> {
  if (ids.length === 0) return 0;
  const result = await db.execute(sql`
    UPDATE stealth_abneon_shadow_candidates
    SET status = 'terminal',
        terminal_reason = 'neon_not_entered_at_detection',
        updated_at = now()
    WHERE id IN (${sql.join(
      ids.map((id) => sql`${id}`),
      sql`, `,
    )})
      AND detection_method = 'abneon_support_bounce'
      AND (
        status = 'qualified'
        OR (
          status = 'firing'
          AND (fire_claim_expires_at IS NULL OR fire_claim_expires_at < now())
        )
      )
    RETURNING id
  `);
  if (result.rows.length > 0) activeCache = undefined;
  return result.rows.length;
}

/** Terminalizes a nonretryable duplicate/conflict without claiming it fired. */
export async function terminalizeAbneonSupportBounceClaim(input: {
  id: number;
  owner: string;
  token: string;
  reason: string;
}): Promise<boolean> {
  const result = await db.execute(sql`
    UPDATE stealth_abneon_shadow_candidates
    SET
      status = 'terminal',
      terminal_reason = ${input.reason},
      fire_claim_owner = NULL,
      fire_claim_token = NULL,
      fire_claim_expires_at = NULL,
      updated_at = now()
    WHERE id = ${input.id}
      AND status = 'firing'
      AND fire_claim_owner = ${input.owner}
      AND fire_claim_token = ${input.token}
    RETURNING id
  `);
  return result.rows.length > 0;
}

/**
 * Immutable per-evaluation market snapshot (CoinGlass aggregates only).
 * Unavailable metrics are stored as null; nothing is substituted from BingX
 * or a single exchange. Rows are append-only and never updated.
 */
export type NeonEvaluationMetrics = {
  spotVolMult: number | null;
  spotVol1hUsd: number | null;
  spotVol24hUsd: number | null;
  spotNetBuyPct1h: number | null;
  futTakerNetBuyPct15m: number | null;
  spotCvd: {
    cvd15m: boolean | null;
    cvd30m: boolean | null;
    cvd1h: boolean | null;
    cvd4h: boolean | null;
  } | null;
  oiUsd: number | null;
  oiChange30m: number | null;
  oiChange1h: number | null;
  oiChange4h: number | null;
  oiChange24h: number | null;
  fundingRate: number | null;
  referencePrice: number | null;
  zoneDistancePct: number | null;
};

export async function persistNeonEvaluationSnapshot(input: {
  symbol: string;
  result: ShadowDetectorResult;
  observedAt: number;
  metrics: NeonEvaluationMetrics;
}): Promise<void> {
  if (input.result.frozenLevel == null || input.result.armCandleTime == null)
    return;
  const candidateKey = `${input.result.armCandleTime}:${input.result.frozenLevel.toPrecision(12)}`;
  try {
    await db.execute(sql`
      INSERT INTO stealth_abneon_shadow_evaluations
        (symbol, detection_method, candidate_key, observed_at, status, reason, metrics)
      VALUES
        (${input.symbol}, ${input.result.method}, ${candidateKey},
         to_timestamp(${input.observedAt / 1000.0}), ${input.result.status},
         ${input.result.reason}, ${JSON.stringify(input.metrics)}::jsonb)
    `);
  } catch (error) {
    logger.warn(
      { symbol: input.symbol, error: (error as Error).message },
      "Neon evaluation snapshot write failed",
    );
  }
}
