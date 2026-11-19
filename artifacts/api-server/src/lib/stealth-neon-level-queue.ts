import { randomUUID } from "node:crypto";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import type { NeonLevelBreakout } from "./stealth-neon-level-breakout.js";

const H4_MS = 4 * 60 * 60_000;
const DAY_MS = 24 * 60 * 60_000;
const VOLUME_CLAIM_OWNER = "stealth-neon-level-volume";

export type StealthNeonLevelQueueEvent = NeonLevelBreakout & {
  symbol: string;
  detectedAt: number;
  quoteVolume24h: number | null;
  volumeColour: string | null;
};

export type PersistedStealthNeonLevelEvent = {
  id: number;
  symbol: string;
  candidateKey: string;
  detectionMethod: NeonLevelBreakout["method"];
  status: string;
  terminalReason: string | null;
  frozenLevel: number;
  event: StealthNeonLevelQueueEvent | null;
  readyToFire: boolean;
  volumeReadCount: number;
  nextVolumeCheckAtMs: number | null;
  lastVolumeColour: string | null;
};

export type ClaimedStealthNeonLevelVolumeCheck = {
  candidate: PersistedStealthNeonLevelEvent;
  claimToken: string;
};

type QueueRow = Record<string, unknown>;

function asObject(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }
  return null;
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function parseEvent(
  value: unknown,
  expectedSymbol: string,
): StealthNeonLevelQueueEvent | null {
  const event = asObject(value);
  const level = asObject(event?.level);
  if (
    !event ||
    !level ||
    event.symbol !== expectedSymbol ||
    (event.tf !== "4h" && event.tf !== "1d") ||
    typeof event.method !== "string" ||
    !finite(event.candleTime) ||
    !finite(event.open) ||
    !finite(event.close) ||
    !finite(event.prevClose) ||
    !finite(level.top) ||
    !finite(level.bottom) ||
    !finite(level.count) ||
    !finite(event.stopPrice) ||
    !finite(event.detectedAt)
  ) {
    return null;
  }
  return event as unknown as StealthNeonLevelQueueEvent;
}

function fromRow(row: QueueRow): PersistedStealthNeonLevelEvent {
  const id = Number(row.id);
  const symbol = String(row.symbol ?? "");
  const evidence = asObject(row.volume_evidence);
  const queue = asObject(evidence?.volumeCheckState);
  return {
    id,
    symbol,
    candidateKey: String(row.candidate_key ?? ""),
    detectionMethod: String(
      row.detection_method,
    ) as NeonLevelBreakout["method"],
    status: String(row.status ?? ""),
    terminalReason:
      row.terminal_reason == null ? null : String(row.terminal_reason),
    frozenLevel: Number(row.frozen_level),
    event: parseEvent(evidence?.stealthNeonLevelEvent, symbol),
    readyToFire: queue?.readyToFire === true,
    volumeReadCount: Math.max(0, Number(queue?.volumeReadCount) || 0),
    nextVolumeCheckAtMs: finite(queue?.nextVolumeCheckAtMs)
      ? queue.nextVolumeCheckAtMs
      : null,
    lastVolumeColour:
      typeof queue?.lastVolumeColour === "string"
        ? queue.lastVolumeColour
        : null,
  };
}

const RETURNING_QUEUE_COLUMNS = sql`
  id, symbol, candidate_key, detection_method, status, terminal_reason,
  frozen_level, volume_evidence
`;

export async function persistStealthNeonLevelEvent(input: {
  event: StealthNeonLevelQueueEvent;
  nowMs: number;
}): Promise<PersistedStealthNeonLevelEvent> {
  const { event } = input;
  const closeAt =
    event.candleTime + (event.tf === "4h" ? H4_MS : DAY_MS);
  const candidateKey = `${event.tf}:${event.candleTime}:${event.level.top.toPrecision(12)}`;
  const initialEvidence = JSON.stringify({
    stealthNeonLevelEvent: event,
    volumeCheckState: {
      readyToFire: false,
      volumeReadCount: 0,
      nextVolumeCheckAtMs: input.nowMs,
      lastVolumeColour: null,
    },
  });

  await db.execute(sql`
    INSERT INTO stealth_abneon_shadow_candidates
      (symbol, detection_method, candidate_key, frozen_level, armed_at,
       trigger_candle_at, status, terminal_reason, volume_evidence,
       updated_at, live_eligible)
    VALUES
      (${event.symbol}, ${event.method}, ${candidateKey}, ${event.level.top},
       to_timestamp(${closeAt / 1000}), to_timestamp(${event.candleTime / 1000}),
       'queued', NULL, ${initialEvidence}::jsonb, now(), true)
    ON CONFLICT (symbol, detection_method, candidate_key) DO NOTHING
  `);

  const result = await db.execute(sql`
    SELECT ${RETURNING_QUEUE_COLUMNS}
    FROM stealth_abneon_shadow_candidates
    WHERE symbol = ${event.symbol}
      AND detection_method = ${event.method}
      AND candidate_key = ${candidateKey}
    LIMIT 1
  `);
  const row = result.rows[0] as QueueRow | undefined;
  if (!row) {
    throw new Error("queued candidate insert/read returned no row");
  }
  return fromRow(row);
}

function makeEvidence(
  candidate: PersistedStealthNeonLevelEvent,
  state: {
    readyToFire: boolean;
    volumeReadCount: number;
    nextVolumeCheckAtMs: number | null;
    lastVolumeColour: string | null;
  },
  event: StealthNeonLevelQueueEvent,
): string {
  return JSON.stringify({
    stealthNeonLevelEvent: event,
    volumeCheckState: {
      readyToFire: state.readyToFire,
      volumeReadCount: state.volumeReadCount,
      nextVolumeCheckAtMs: state.nextVolumeCheckAtMs,
      lastVolumeColour: state.lastVolumeColour,
      candidateKey: candidate.candidateKey,
    },
  });
}

export async function updateStealthNeonLevelVolumeState(input: {
  candidate: PersistedStealthNeonLevelEvent;
  event: StealthNeonLevelQueueEvent;
  readyToFire: boolean;
  volumeReadCount: number;
  nextVolumeCheckAtMs: number | null;
  lastVolumeColour: string | null;
  claimToken?: string;
}): Promise<boolean> {
  const evidence = makeEvidence(
    input.candidate,
    {
      readyToFire: input.readyToFire,
      volumeReadCount: input.volumeReadCount,
      nextVolumeCheckAtMs: input.nextVolumeCheckAtMs,
      lastVolumeColour: input.lastVolumeColour,
    },
    input.event,
  );
  const claimGuard =
    input.claimToken === undefined
      ? sql`AND fire_claim_token IS NULL`
      : sql`AND fire_claim_token = ${input.claimToken}`;
  const clearClaim =
    input.claimToken === undefined
      ? sql``
      : sql`,
          fire_claim_owner = NULL,
          fire_claim_token = NULL,
          fire_claim_expires_at = NULL`;
  const result = await db.execute(sql`
    UPDATE stealth_abneon_shadow_candidates
    SET volume_evidence = ${evidence}::jsonb,
        updated_at = now()
        ${clearClaim}
    WHERE id = ${input.candidate.id}
      AND detection_method IN ('neon_level_4h_breakout', 'neon_level_1d_breakout')
      AND status = 'queued'
      ${claimGuard}
    RETURNING id
  `);
  return result.rows.length > 0;
}

export async function listReadyStealthNeonLevelEvents(
  limit = 100,
): Promise<PersistedStealthNeonLevelEvent[]> {
  const boundedLimit = Math.max(1, Math.min(500, Math.floor(limit)));
  const result = await db.execute(sql`
    SELECT ${RETURNING_QUEUE_COLUMNS}
    FROM stealth_abneon_shadow_candidates
    WHERE detection_method IN ('neon_level_4h_breakout', 'neon_level_1d_breakout')
      AND status = 'queued'
      AND live_eligible = true
      AND volume_evidence #>> '{volumeCheckState,readyToFire}' = 'true'
    ORDER BY trigger_candle_at ASC NULLS FIRST, id ASC
    LIMIT ${boundedLimit}
  `);
  return (result.rows as QueueRow[]).map(fromRow);
}

export async function listDueStealthNeonLevelVolumeChecks(
  nowMs: number,
  limit = 100,
): Promise<PersistedStealthNeonLevelEvent[]> {
  const boundedLimit = Math.max(1, Math.min(500, Math.floor(limit)));
  const result = await db.execute(sql`
    SELECT ${RETURNING_QUEUE_COLUMNS}
    FROM stealth_abneon_shadow_candidates
    WHERE detection_method IN ('neon_level_4h_breakout', 'neon_level_1d_breakout')
      AND status = 'queued'
      AND live_eligible = true
      AND COALESCE(
        volume_evidence #>> '{volumeCheckState,readyToFire}',
        'false'
      ) <> 'true'
      AND CASE
        WHEN volume_evidence #>> '{volumeCheckState,nextVolumeCheckAtMs}' ~ '^[0-9]+$'
          THEN (volume_evidence #>> '{volumeCheckState,nextVolumeCheckAtMs}')::bigint
        ELSE 0
      END <= ${nowMs}
      AND (
        fire_claim_expires_at IS NULL
        OR fire_claim_expires_at < now()
      )
    ORDER BY trigger_candle_at ASC NULLS FIRST, id ASC
    LIMIT ${boundedLimit}
  `);
  return (result.rows as QueueRow[]).map(fromRow);
}

export async function claimStealthNeonLevelVolumeCheck(
  candidate: PersistedStealthNeonLevelEvent,
  nowMs: number,
): Promise<ClaimedStealthNeonLevelVolumeCheck | null> {
  const claimToken = randomUUID();
  const result = await db.execute(sql`
    UPDATE stealth_abneon_shadow_candidates
    SET fire_claim_owner = ${VOLUME_CLAIM_OWNER},
        fire_claim_token = ${claimToken},
        fire_claim_expires_at = now() + interval '3 minutes',
        updated_at = now()
    WHERE id = ${candidate.id}
      AND detection_method IN ('neon_level_4h_breakout', 'neon_level_1d_breakout')
      AND status = 'queued'
      AND live_eligible = true
      AND COALESCE(
        volume_evidence #>> '{volumeCheckState,readyToFire}',
        'false'
      ) <> 'true'
      AND CASE
        WHEN volume_evidence #>> '{volumeCheckState,nextVolumeCheckAtMs}' ~ '^[0-9]+$'
          THEN (volume_evidence #>> '{volumeCheckState,nextVolumeCheckAtMs}')::bigint
        ELSE 0
      END <= ${nowMs}
      AND (
        fire_claim_expires_at IS NULL
        OR fire_claim_expires_at < now()
      )
    RETURNING ${RETURNING_QUEUE_COLUMNS}
  `);
  const row = result.rows[0] as QueueRow | undefined;
  if (!row) return null;
  return { candidate: fromRow(row), claimToken };
}

export async function finishStealthNeonLevelCandidate(input: {
  id: number;
  status: "fired" | "blocked";
  reason: string;
}): Promise<boolean> {
  const result = await db.execute(sql`
    UPDATE stealth_abneon_shadow_candidates
    SET status = ${input.status},
        terminal_reason = ${input.reason.slice(0, 500)},
        live_eligible = false,
        fire_claim_owner = NULL,
        fire_claim_token = NULL,
        fire_claim_expires_at = NULL,
        updated_at = now()
    WHERE id = ${input.id}
      AND detection_method IN ('neon_level_4h_breakout', 'neon_level_1d_breakout')
      AND status = 'queued'
    RETURNING id
  `);
  return result.rows.length > 0;
}

/** Writes a background-detector rejection directly; `_symRej` is cycle-local. */
export async function persistStealthNeonLevelReject(input: {
  symbol: string;
  reason: string;
}): Promise<void> {
  const reason = input.reason.replace(/\s+/g, " ").slice(0, 500);
  await db.execute(sql`
    INSERT INTO scan_reject_log (cycle_at, symbol, pattern, reason)
    SELECT now(), ${input.symbol}, 'stealth_breakout', ${reason}
    WHERE NOT EXISTS (
      SELECT 1
      FROM scan_reject_log
      WHERE symbol = ${input.symbol}
        AND pattern = 'stealth_breakout'
        AND reason = ${reason}
        AND cycle_at >= now() - interval '5 minutes'
    )
  `);
}

export function stealthNeonLevelEventCloseAt(
  event: Pick<StealthNeonLevelQueueEvent, "tf" | "candleTime">,
): number {
  return event.candleTime + (event.tf === "4h" ? H4_MS : DAY_MS);
}
