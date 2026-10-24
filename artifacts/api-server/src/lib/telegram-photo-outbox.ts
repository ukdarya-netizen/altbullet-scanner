import { createHash, randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { and, asc, eq, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import { photoPathForTimeoutDelivery } from "./timeout-exit-policy.js";
import { photoPathForQueuedTargetHit } from "./milestone-photo-policy.js";
import {
  db,
  pool,
  telegramDeliveryAttemptAuditTable,
  telegramDeliveryEventsTable,
  telegramPhotoDeliveriesTable,
  signalsTable,
} from "@workspace/db";
import {
  sendMessageResult,
  sendPhotoByFileIdResult,
  sendPhotoCaptionResult,
  getOperationalTelegramRecipientId,
} from "./telegram.js";
import {
  getTelegramPhotoFileId,
  type TelegramApiCallResult,
  type TelegramPhotoMessage,
} from "./telegram-api.js";
import {
  getTelegramPhotoDeliveryKey,
  isExplicitInvalidTelegramPhotoFileId,
  shouldFallbackToTextAfterPhotoFailure,
  shouldRetryExplicitPhotoFailure,
} from "./photo-delivery-policy.js";
import {
  buildTelegramPhotoDeliveryRows,
  buildTelegramTextDeliveryRows,
  classifyTelegramAttempt,
  getTelegramRetryDelayMs,
  getPendingTelegramTextParts,
  getTelegramPhotoResultTransition,
  runTelegramPhotoClaimTransaction,
  shouldRetryTelegramAttempt,
  TELEGRAM_DELIVERY_POLICY_VERSION,
  TELEGRAM_MAX_DELIVERY_ATTEMPTS,
  type TelegramPhotoDeliveryPhase,
} from "./telegram-photo-outbox-policy.js";
import {
  isTelegramHtmlParseError,
  prepareTelegramHtmlForEnqueue,
  telegramReportPlainText,
} from "./telegram-html.js";
import { logger } from "./logger.js";
import { withPrimarySignalTiming } from "./telegram-signal-timing.js";
import {
  assertMarketCycleLeaseOwnership,
  runOutsideMarketCycleLease,
} from "./schedulerLease.js";
import {
  loadTelegramRecipientEligibility,
  requireEligibleTelegramRecipients,
} from "./telegram-recipient-eligibility.js";

const LEASE_MS = 120_000;
const WORKER_CONCURRENCY = 4;
const OUTBOX_RECOVERY_RETRY_MS = 15_000;
const TEST_GLOBAL_RATE_INTERVAL_MS =
  process.env.RUN_TELEGRAM_OUTBOX_DB_TESTS === "1"
    ? Number(process.env.TELEGRAM_OUTBOX_TEST_GLOBAL_INTERVAL_MS)
    : Number.NaN;
const TEST_RECIPIENT_RATE_INTERVAL_MS =
  process.env.RUN_TELEGRAM_OUTBOX_DB_TESTS === "1"
    ? Number(process.env.TELEGRAM_OUTBOX_TEST_RECIPIENT_INTERVAL_MS)
    : Number.NaN;
const GLOBAL_SEND_INTERVAL_MS = Number.isFinite(TEST_GLOBAL_RATE_INTERVAL_MS)
  ? TEST_GLOBAL_RATE_INTERVAL_MS
  : 40;
const RECIPIENT_SEND_INTERVAL_MS = Number.isFinite(
  TEST_RECIPIENT_RATE_INTERVAL_MS,
)
  ? TEST_RECIPIENT_RATE_INTERVAL_MS
  : 1_000;

/**
 * Standalone Stealth TA observations are disabled. Quarantine any rows created
 * by an older deployment before the recovery drain can send them.
 */
export async function quarantineDisabledStealthObservationDeliveries(): Promise<number> {
  const result = await db.transaction(async (tx) => {
    const deliveries = await tx.execute(sql`
      UPDATE telegram_photo_deliveries
      SET status = 'abandoned',
          lease_until = NULL,
          claim_token = NULL,
          send_attempted_at = NULL,
          repeat_notice = false,
          last_error = 'Standalone Stealth TA observations are disabled',
          updated_at = now()
      WHERE dedup_key LIKE 'stealth-ta:%'
        AND status IN ('ready', 'retry', 'processing')
      RETURNING id
    `);
    await tx.execute(sql`
      UPDATE telegram_delivery_events
      SET status = 'attention',
          attention_at = coalesce(attention_at, now()),
          last_error = 'Standalone Stealth TA observations are disabled',
          updated_at = now()
      WHERE event_key LIKE 'stealth-ta:%'
        AND status <> 'delivered'
    `);
    return deliveries.rows.length;
  });
  return result;
}

/**
 * A policy migration briefly emitted one owner alert per historical delivery
 * row. Stop any unsent alert flood without touching the underlying trading
 * delivery or its audit trail.
 */
export async function quarantinePendingOperatorFailureAlerts(): Promise<number> {
  const result = await db.transaction(async (tx) => {
    const deliveries = await tx.execute(sql`
      UPDATE telegram_photo_deliveries
      SET status = 'abandoned',
          lease_until = NULL,
          claim_token = NULL,
          send_attempted_at = NULL,
          repeat_notice = false,
          last_error = 'Operator alert flood quarantined; underlying delivery audit retained',
          updated_at = now()
      WHERE dedup_key LIKE 'operator-alert:%'
        AND status IN ('ready', 'retry', 'processing')
      RETURNING id
    `);
    await tx.execute(sql`
      UPDATE telegram_delivery_events
      SET status = 'attention',
          attention_at = coalesce(attention_at, now()),
          last_error = 'Operator alert flood quarantined; underlying delivery audit retained',
          updated_at = now()
      WHERE event_key LIKE 'operator-alert:%'
        AND status <> 'delivered'
    `);
    return deliveries.rows.length;
  });
  return result;
}
const MEDIA_CACHE_LEASE_MS = 90_000;
const MEDIA_CACHE_WAIT_MS = 3_000;
const MEDIA_CACHE_WAIT_RETRY_MS = 1_000;
const CURRENT_DELIVERY_POLICY_VERSION = TELEGRAM_DELIVERY_POLICY_VERSION;
const MAX_AMBIGUOUS_RECOVERY_ATTEMPTS = 1;
const AMBIGUOUS_RECOVERY_DELAY_MS = 60_000;

type DeliveryRow = typeof telegramPhotoDeliveriesTable.$inferSelect;
type DeliveryInsert = typeof telegramPhotoDeliveriesTable.$inferInsert;
type DeliveryPhase = TelegramPhotoDeliveryPhase;
export type TelegramDeliveryHealthRow = {
  recipientRole: "channel" | "direct_chat";
  status: string;
  reason: string;
  queueClass: "active" | "historical";
  rows: number;
  oldestAt: Date | null;
};

type PatternMediaResolution =
  | { kind: "cached"; mediaKey: string; fileId: string }
  | { kind: "upload"; mediaKey: string; claimToken: string }
  | { kind: "waiting"; mediaKey: string }
  | { kind: "ambiguous"; mediaKey: string };

const photoMediaKeyCache = new Map<
  string,
  { mtimeMs: number; size: number; mediaKey: string }
>();
export type TelegramPhotoOutboxTransaction = Parameters<
  Parameters<typeof db.transaction>[0]
>[0];

function recipientRole(target: string | number): "channel" | "direct_chat" {
  const value = String(target);
  return value.startsWith("@") || value.startsWith("-100")
    ? "channel"
    : "direct_chat";
}

function recipientRoleCounts(targets: Array<string | number>): {
  channelRecipients: number;
  directRecipients: number;
} {
  return targets.reduce(
    (counts, target) => {
      if (recipientRole(target) === "channel") counts.channelRecipients++;
      else counts.directRecipients++;
      return counts;
    },
    { channelRecipients: 0, directRecipients: 0 },
  );
}

function normalizePhase(phase: string): DeliveryPhase {
  if (phase === "continuation") return "continuation";
  if (phase === "fallback" || phase === "text") return "fallback";
  return "photo";
}

function canScheduleAmbiguousRecovery(row: DeliveryRow): boolean {
  return (
    row.deliveryPolicyVersion === CURRENT_DELIVERY_POLICY_VERSION &&
    row.ambiguousRetryCount < MAX_AMBIGUOUS_RECOVERY_ATTEMPTS
  );
}

async function reserveTelegramRateLimitSlot(target: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const globalBucket = "global";
    const recipientBucket = `recipient:${target}`;
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext($1)), pg_advisory_xact_lock(hashtext($2))",
      [globalBucket, recipientBucket],
    );
    await client.query(
      `INSERT INTO telegram_delivery_rate_limits (bucket_key, next_allowed_at)
       VALUES ($1, now()), ($2, now())
       ON CONFLICT (bucket_key) DO NOTHING`,
      [globalBucket, recipientBucket],
    );
    const reservation = await client.query<{ slot_at: Date }>(
      `SELECT GREATEST(
         now(),
         max(next_allowed_at) FILTER (WHERE bucket_key = $1),
         max(next_allowed_at) FILTER (WHERE bucket_key = $2)
       ) AS slot_at
       FROM telegram_delivery_rate_limits
       WHERE bucket_key IN ($1, $2)`,
      [globalBucket, recipientBucket],
    );
    const slotAt = reservation.rows[0]?.slot_at ?? new Date();
    await client.query(
      `UPDATE telegram_delivery_rate_limits
       SET next_allowed_at = CASE
         WHEN bucket_key = $1 THEN $3::timestamp + ($4 * interval '1 millisecond')
         ELSE $3::timestamp + ($5 * interval '1 millisecond')
       END,
       updated_at = now()
       WHERE bucket_key IN ($1, $2)`,
      [
        globalBucket,
        recipientBucket,
        slotAt,
        GLOBAL_SEND_INTERVAL_MS,
        RECIPIENT_SEND_INTERVAL_MS,
      ],
    );
    await client.query("COMMIT");
    const waitMs = slotAt.getTime() - Date.now();
    if (waitMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

function withRecoveryNotice(text: string, repeatNotice: boolean): string {
  const prefix = "↻ Повтор доставки\n";
  // Text messages are already chunked at Telegram's 4,000-character limit.
  // Never turn a valid maximum-size chunk into a rejected request merely to
  // add a cosmetic recovery marker; the outbox state still records recovery.
  return repeatNotice && text.length + prefix.length <= 4_000
    ? `${prefix}${text}`
    : text;
}

function getPhotoMediaKey(photoPath: string): string {
  const stat = statSync(photoPath);
  const cached = photoMediaKeyCache.get(photoPath);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return cached.mediaKey;
  }

  const mediaKey = `sha256:${createHash("sha256")
    .update(readFileSync(photoPath))
    .digest("hex")}`;
  photoMediaKeyCache.set(photoPath, {
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    mediaKey,
  });
  return mediaKey;
}

async function resolvePatternMedia(
  photoPath: string,
  eventKey: string,
): Promise<PatternMediaResolution> {
  const mediaKey = getPhotoMediaKey(photoPath);
  await pool.query(
    `INSERT INTO telegram_pattern_media_cache (media_key)
     VALUES ($1)
     ON CONFLICT (media_key) DO NOTHING`,
    [mediaKey],
  );

  const cached = await pool.query<{
    file_id: string | null;
    lease_until: Date | null;
    upload_attempted_at: Date | null;
    upload_event_key: string | null;
  }>(
    `SELECT file_id, lease_until, upload_attempted_at, upload_event_key
     FROM telegram_pattern_media_cache
     WHERE media_key = $1`,
    [mediaKey],
  );
  const cachedRow = cached.rows[0];
  const fileId = cachedRow?.file_id?.trim();
  if (fileId) return { kind: "cached", mediaKey, fileId };
  if (cachedRow?.upload_attempted_at) {
    // An active uploader may still return a reusable file ID. Once its lease
    // expires, the upload outcome is unknowable and must never be replaced
    // automatically with a second multipart request.
    if (cachedRow.lease_until && cachedRow.lease_until.getTime() > Date.now()) {
      return { kind: "waiting", mediaKey };
    }
    if (cachedRow.upload_event_key === eventKey) {
      return { kind: "ambiguous", mediaKey };
    }
  }

  const claimToken = randomUUID();
  const claimed = await pool.query(
    `UPDATE telegram_pattern_media_cache
     SET lease_until = now() + ($2 * interval '1 millisecond'),
         claim_token = $3,
         upload_attempted_at = NULL,
         upload_event_key = $4,
         updated_at = now()
     WHERE media_key = $1
       AND file_id IS NULL
       AND (
         upload_attempted_at IS NULL
         OR (
           upload_event_key IS DISTINCT FROM $4
           AND (lease_until IS NULL OR lease_until <= now())
         )
       )
     RETURNING media_key`,
    [mediaKey, MEDIA_CACHE_LEASE_MS, claimToken, eventKey],
  );
  if (claimed.rowCount === 1) {
    return { kind: "upload", mediaKey, claimToken };
  }

  // An uploader may have completed while this worker was trying to claim the
  // row. Re-read once before classifying it as in-flight.
  const refreshed = await pool.query<{
    file_id: string | null;
    lease_until: Date | null;
    upload_attempted_at: Date | null;
    upload_event_key: string | null;
  }>(
    `SELECT file_id, lease_until, upload_attempted_at, upload_event_key
     FROM telegram_pattern_media_cache
     WHERE media_key = $1`,
    [mediaKey],
  );
  const refreshedRow = refreshed.rows[0];
  const refreshedFileId = refreshedRow?.file_id?.trim();
  if (refreshedFileId) {
    return { kind: "cached", mediaKey, fileId: refreshedFileId };
  }
  if (refreshedRow?.upload_attempted_at) {
    if (
      refreshedRow.lease_until &&
      refreshedRow.lease_until.getTime() > Date.now()
    ) {
      return { kind: "waiting", mediaKey };
    }
    if (refreshedRow.upload_event_key === eventKey) {
      return { kind: "ambiguous", mediaKey };
    }
  }
  return { kind: "waiting", mediaKey };
}

async function waitForPatternMedia(
  photoPath: string,
  eventKey: string,
): Promise<PatternMediaResolution> {
  let resolution = await resolvePatternMedia(photoPath, eventKey);
  const deadline = Date.now() + MEDIA_CACHE_WAIT_MS;
  while (resolution.kind === "waiting" && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    resolution = await resolvePatternMedia(photoPath, eventKey);
  }
  return resolution;
}

async function storePatternMediaFileId(
  mediaKey: string,
  claimToken: string,
  fileId: string,
): Promise<void> {
  const stored = await pool.query(
    `UPDATE telegram_pattern_media_cache
     SET file_id = $3,
         lease_until = NULL,
         claim_token = NULL,
         upload_attempted_at = NULL,
         upload_event_key = NULL,
         updated_at = now()
     WHERE media_key = $1
       AND claim_token = $2`,
    [mediaKey, claimToken, fileId],
  );
  if (stored.rowCount !== 1) {
    throw new Error("Telegram media cache uploader lost its claim");
  }
}

async function recordPatternMediaUploadAttempt(
  mediaKey: string,
  claimToken: string,
  eventKey: string,
): Promise<void> {
  const recorded = await pool.query(
    `UPDATE telegram_pattern_media_cache
     SET upload_attempted_at = now(),
         upload_event_key = $3,
         lease_until = now() + ($4 * interval '1 millisecond'),
         updated_at = now()
     WHERE media_key = $1
       AND claim_token = $2
       AND file_id IS NULL
       AND upload_attempted_at IS NULL`,
    [mediaKey, claimToken, eventKey, LEASE_MS],
  );
  if (recorded.rowCount !== 1) {
    throw new Error("Telegram media cache upload fence was not persisted");
  }
}

async function releasePatternMediaUpload(
  mediaKey: string,
  claimToken: string,
  { clearUploadFence }: { clearUploadFence: boolean },
): Promise<void> {
  await pool.query(
    `UPDATE telegram_pattern_media_cache
     SET lease_until = NULL,
         claim_token = NULL,
         upload_attempted_at = CASE
           WHEN $3 THEN NULL
           ELSE upload_attempted_at
         END,
         upload_event_key = CASE
           WHEN $3 THEN NULL
           ELSE upload_event_key
         END,
         updated_at = now()
     WHERE media_key = $1
       AND claim_token = $2`,
    [mediaKey, claimToken, clearUploadFence],
  );
}

async function invalidatePatternMediaFileId(
  mediaKey: string,
  fileId: string,
): Promise<void> {
  await pool.query(
    `UPDATE telegram_pattern_media_cache
     SET file_id = NULL,
         lease_until = NULL,
         claim_token = NULL,
         updated_at = now()
     WHERE media_key = $1
       AND file_id = $2`,
    [mediaKey, fileId],
  );
}

function uniqueTargets(
  targets: Array<number | string>,
): Array<number | string> {
  const seen = new Set<string>();
  return targets.filter((target) => {
    const key = String(target);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function describeFailure(result: TelegramApiCallResult): string {
  return [
    result.status == null ? null : `HTTP ${result.status}`,
    result.description,
  ]
    .filter(Boolean)
    .join(": ")
    .slice(0, 1_000);
}

export async function getTelegramDeliveryHealth(): Promise<
  TelegramDeliveryHealthRow[]
> {
  const result = await db.execute(sql`
    SELECT
      CASE
        WHEN target LIKE '@%' OR target LIKE '-100%' THEN 'channel'
        ELSE 'direct_chat'
      END AS "recipientRole",
      status,
      CASE
        WHEN status = 'retry' AND ambiguous_retry_count > 0 THEN 'bounded_recovery'
        WHEN last_error ILIKE '%timed out%' THEN 'timeout'
        WHEN last_error ILIKE '%network%' THEN 'network'
        WHEN last_error LIKE 'HTTP 5%' THEN 'telegram_5xx'
        WHEN last_error LIKE 'HTTP 429%' THEN 'explicit_429'
        WHEN last_error ILIKE '%persisted send%' THEN 'persisted_send_fence'
        WHEN status = 'retry' THEN 'explicit_rejection'
        WHEN status = 'abandoned' THEN 'explicit_rejection'
        ELSE 'unknown'
      END AS reason,
      CASE
        WHEN status IN ('ambiguous', 'abandoned')
          AND created_at < now() - interval '24 hours'
          THEN 'historical'
        ELSE 'active'
      END AS "queueClass",
      count(*)::int AS rows,
      min(created_at) AS "oldestAt"
    FROM telegram_photo_deliveries
    WHERE status IN ('ready', 'retry', 'processing', 'ambiguous', 'abandoned')
    GROUP BY 1, status, 3, 4
    ORDER BY 4, 1, status, 3
  `);
  return result.rows as unknown as TelegramDeliveryHealthRow[];
}

/**
 * Produces an audit-safe health snapshot. It intentionally never includes a
 * target, event key, or message body in logs; only state/reason aggregates
 * are emitted.
 */
export async function logTelegramDeliveryHealth(
  context: string,
): Promise<TelegramDeliveryHealthRow[]> {
  const rows = await getTelegramDeliveryHealth();
  logger.warn(
    {
      context,
      deliveryStates: rows,
    },
    "Telegram critical delivery health",
  );
  return rows;
}

async function recordDeliveryAttemptAudit(
  row: Pick<
    DeliveryRow,
    | "id"
    | "dedupKey"
    | "target"
    | "phase"
    | "nextPartIndex"
    | "attempts"
    | "sendAttemptedAt"
    | "updatedAt"
  >,
  result: TelegramApiCallResult,
  outcome: string,
  requestKind = "telegram",
): Promise<void> {
  const observedAt = new Date();
  const sendAttemptedAt = row.sendAttemptedAt ?? row.updatedAt ?? observedAt;
  // The timestamp is evidence, not identity: the in-memory claimed row may
  // predate its persisted send fence, while a restart reloads that fence.
  // The delivery/attempt/part tuple identifies one external request across
  // both paths, so reconciliation cannot append a duplicate audit record.
  const auditKey = [
    row.id,
    row.phase,
    row.nextPartIndex,
    row.attempts,
    requestKind,
  ].join(":");
  const classification = classifyTelegramAttempt(result);
  const reason =
    describeFailure(result) ||
    (result.ok ? "Telegram accepted request" : classification);
  await db
    .insert(telegramDeliveryAttemptAuditTable)
    .values({
      auditKey,
      deliveryId: row.id,
      dedupKey: row.dedupKey,
      target: row.target,
      phase: row.phase,
      partIndex: row.nextPartIndex,
      outcome,
      httpStatus: result.status,
      classification,
      retryAfterSeconds: result.retryAfterSeconds,
      reason: reason.slice(0, 1_000),
      attempt: row.attempts,
      sendAttemptedAt,
      observedAt,
    })
    .onConflictDoNothing({
      target: telegramDeliveryAttemptAuditTable.auditKey,
    });
}

async function recordDeliveryAttemptStarted(
  row: Parameters<typeof recordDeliveryAttemptAudit>[0],
  requestKind: string,
): Promise<void> {
  const observedAt = new Date();
  await db
    .insert(telegramDeliveryAttemptAuditTable)
    .values({
      auditKey: [
        row.id,
        row.phase,
        row.nextPartIndex,
        row.attempts,
        requestKind,
        "started",
      ].join(":"),
      deliveryId: row.id,
      dedupKey: row.dedupKey,
      target: row.target,
      phase: row.phase,
      partIndex: row.nextPartIndex,
      outcome: "started",
      httpStatus: null,
      classification: "dispatch_started",
      reason: "Telegram request dispatch started",
      attempt: row.attempts,
      sendAttemptedAt: observedAt,
      observedAt,
    })
    .onConflictDoNothing({
      target: telegramDeliveryAttemptAuditTable.auditKey,
    });
}

async function recordDeliveryAttemptOutcomeBestEffort(
  row: Parameters<typeof recordDeliveryAttemptAudit>[0],
  result: TelegramApiCallResult,
  outcome: string,
  requestKind: string,
): Promise<void> {
  try {
    await recordDeliveryAttemptAudit(
      row,
      result,
      outcome,
      `${requestKind}:outcome`,
    );
  } catch (error) {
    logger.error(
      {
        err: error,
        deliveryId: row.id,
        attempt: row.attempts,
        requestKind,
      },
      "Telegram attempt outcome audit failed after durable dispatch audit",
    );
  }
}

async function recordAmbiguousDeliveryAudit(
  row: Parameters<typeof recordDeliveryAttemptAudit>[0],
  reason: string,
): Promise<void> {
  await recordDeliveryAttemptAudit(
    row,
    {
      ok: false,
      status: null,
      retryable: true,
      description: reason,
    },
    "ambiguous",
    "reconciliation",
  );
}

/**
 * Integration-test-only rendezvous placed between candidate selection and the
 * conditional claim update. Two independent workers must select the same due
 * row before either can proceed, proving the UPDATE predicate fences one out.
 */
let testClaimBarrierPromise: Promise<void> | null = null;

async function waitForTestClaimBarrier(): Promise<void> {
  const barrierKey = process.env.TELEGRAM_OUTBOX_TEST_CLAIM_BARRIER;
  if (!barrierKey) return;
  const workerId = process.env.OUTBOX_WORKER_ID;
  if (!workerId) {
    throw new Error("Telegram outbox test claim barrier is missing worker ID");
  }
  if (testClaimBarrierPromise) return testClaimBarrierPromise;

  testClaimBarrierPromise = (async () => {
    await pool.query(
      `INSERT INTO outbox_test_claim_workers (barrier_key, worker_id)
       VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [barrierKey, workerId],
    );

    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const state = await pool.query(
        `SELECT count(*)::int AS worker_count
         FROM outbox_test_claim_workers
         WHERE barrier_key = $1`,
        [barrierKey],
      );
      if (state.rows[0]?.worker_count >= 2) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error("Telegram outbox test claim barrier timed out");
  })();
  return testClaimBarrierPromise;
}

async function updateClaimed(
  row: DeliveryRow,
  claimToken: string,
  values: Partial<DeliveryInsert>,
): Promise<void> {
  const updated = await db
    .update(telegramPhotoDeliveriesTable)
    .set({
      ...values,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(telegramPhotoDeliveriesTable.id, row.id),
        eq(telegramPhotoDeliveriesTable.claimToken, claimToken),
      ),
    )
    .returning({ id: telegramPhotoDeliveriesTable.id });
  if (updated.length === 0) {
    throw new Error(`Telegram delivery ${row.id} lost its claim`);
  }
}

/**
 * Persist the send boundary before contacting Telegram. A crash or DB outage
 * after this write cannot be safely retried because Telegram may have accepted
 * the request; recovery will surface it as ambiguous instead.
 */
async function recordSendAttempt(
  row: DeliveryRow,
  claimToken: string,
  phase: DeliveryPhase,
  nextPartIndex: number,
): Promise<void> {
  await updateClaimed(row, claimToken, {
    status: "processing",
    phase,
    nextPartIndex,
    leaseUntil: new Date(Date.now() + LEASE_MS),
    sendAttemptedAt: new Date(),
  });
}

async function markRetry(
  row: DeliveryRow,
  claimToken: string,
  phase: DeliveryPhase,
  nextPartIndex: number,
  error: string,
  result: TelegramApiCallResult,
): Promise<void> {
  if (row.attempts >= TELEGRAM_MAX_DELIVERY_ATTEMPTS) {
    await markAbandoned(
      row,
      claimToken,
      phase,
      nextPartIndex,
      `Retry budget exhausted: ${error}`,
    );
    return;
  }
  const delayMs = getTelegramRetryDelayMs(result, row.attempts);
  await updateClaimed(row, claimToken, {
    status: "retry",
    phase,
    nextPartIndex,
    nextAttemptAt: new Date(Date.now() + delayMs),
    leaseUntil: null,
    claimToken: null,
    sendAttemptedAt: null,
    repeatNotice: row.repeatNotice,
    deliveryPolicyVersion: CURRENT_DELIVERY_POLICY_VERSION,
    lastError: error.slice(0, 1_000),
  });
  logger.warn(
    {
      deliveryId: row.id,
      recipientRole: recipientRole(row.target),
      phase,
      attempts: row.attempts,
      retryAfterMs: delayMs,
      error,
    },
    "Telegram photo delivery scheduled for retry",
  );
}

async function enqueueOperatorFailureAlert(
  row: DeliveryRow,
  error: string,
): Promise<void> {
  if (row.dedupKey.startsWith("operator-alert:")) return;
  const eventKey = `operator-alert:${row.id}`;
  const target = getOperationalTelegramRecipientId();
  const text = [
    "TELEGRAM DELIVERY TERMINAL FAILURE",
    `Event: ${row.dedupKey}`,
    `Recipient role: ${recipientRole(row.target)}`,
    `Attempts: ${row.attempts}`,
    `Reason: ${error.slice(0, 500)}`,
  ].join("\n");
  const rows = buildTelegramTextDeliveryRows(
    { text, targets: [target] },
    eventKey,
  ).map((delivery) => ({ ...delivery, plainText: true }));
  const inserted = await persistTelegramDeliveryRows(
    eventKey,
    [target],
    () => rows,
  );
  if (inserted.length > 0) scheduleTelegramPhotoOutboxDrain();
}

async function deferUntilPatternMediaReady(
  row: DeliveryRow,
  claimToken: string,
): Promise<void> {
  await updateClaimed(row, claimToken, {
    status: "ready",
    phase: "photo",
    nextPartIndex: 0,
    nextAttemptAt: new Date(Date.now() + MEDIA_CACHE_WAIT_RETRY_MS),
    leaseUntil: null,
    claimToken: null,
    sendAttemptedAt: null,
    // A cache wait does not contact Telegram and therefore is not a delivery
    // attempt. Keep the counters meaningful for health diagnostics.
    attempts: Math.max(0, row.attempts - 1),
    photoAttempts: Math.max(0, row.photoAttempts - 1),
  });
  scheduleOutboxRecovery(MEDIA_CACHE_WAIT_RETRY_MS);
}

async function markAbandoned(
  row: DeliveryRow,
  claimToken: string,
  phase: DeliveryPhase,
  nextPartIndex: number,
  error: string,
): Promise<void> {
  await updateClaimed(row, claimToken, {
    status: "abandoned",
    phase,
    nextPartIndex,
    leaseUntil: null,
    claimToken: null,
    sendAttemptedAt: null,
    lastError: error.slice(0, 1_000),
  });
  logger.error(
    {
      deliveryId: row.id,
      recipientRole: recipientRole(row.target),
      phase,
      attempts: row.attempts,
      error,
    },
    "Telegram photo delivery abandoned",
  );
  await refreshDeliveryEventStatus(row.dedupKey);
  try {
    await enqueueOperatorFailureAlert(row, error);
  } catch (operatorAlertError) {
    logger.error(
      { err: operatorAlertError, deliveryId: row.id },
      "Telegram terminal failure operator alert could not be queued",
    );
  }
}

async function markRecipientSuppressed(
  row: DeliveryRow,
  claimToken: string,
  phase: DeliveryPhase,
  nextPartIndex: number,
): Promise<void> {
  await updateClaimed(row, claimToken, {
    status: "suppressed",
    phase,
    nextPartIndex,
    leaseUntil: null,
    claimToken: null,
    sendAttemptedAt: null,
    repeatNotice: false,
    lastError: "Recipient subscription expired before Telegram dispatch",
  });
  logger.info(
    {
      deliveryId: row.id,
      recipientRole: recipientRole(row.target),
      phase,
    },
    "Telegram delivery suppressed after subscription expiry",
  );
  await refreshDeliveryEventStatus(row.dedupKey);
}

async function deferRecipientEligibilityCheck(
  row: DeliveryRow,
  claimToken: string,
  phase: DeliveryPhase,
  nextPartIndex: number,
  error: unknown,
): Promise<void> {
  await updateClaimed(row, claimToken, {
    status: "ready",
    phase,
    nextPartIndex,
    nextAttemptAt: new Date(Date.now() + OUTBOX_RECOVERY_RETRY_MS),
    leaseUntil: null,
    claimToken: null,
    sendAttemptedAt: null,
    lastError: "Recipient eligibility unavailable; Telegram dispatch deferred",
  });
  logger.warn(
    {
      err: error,
      deliveryId: row.id,
      recipientRole: recipientRole(row.target),
      phase,
    },
    "Telegram recipient eligibility unavailable — delivery deferred",
  );
  scheduleOutboxRecovery(OUTBOX_RECOVERY_RETRY_MS);
}

async function prepareRecipientDispatch(
  row: DeliveryRow,
  claimToken: string,
  phase: DeliveryPhase,
  nextPartIndex: number,
): Promise<boolean> {
  await reserveTelegramRateLimitSlot(row.target);
  const eligibility = await loadTelegramRecipientEligibility(row.target);
  if (eligibility.kind === "eligible") return true;
  if (eligibility.kind === "expired") {
    await markRecipientSuppressed(row, claimToken, phase, nextPartIndex);
    return false;
  }
  await deferRecipientEligibilityCheck(
    row,
    claimToken,
    phase,
    nextPartIndex,
    eligibility.error,
  );
  return false;
}

/**
 * Telegram does not offer an idempotency key or read receipt. After the
 * pre-send fence is written, any timeout/network/5xx/DB-finalization failure
 * is unknown. New v3 rows get one visibly marked recovery; the next unknown
 * result remains terminal to bound duplicate risk.
 */
async function markAmbiguous(
  row: DeliveryRow,
  claimToken: string,
  phase: DeliveryPhase,
  nextPartIndex: number,
  error: string,
): Promise<void> {
  const recover = canScheduleAmbiguousRecovery(row);
  await updateClaimed(row, claimToken, {
    status: recover ? "retry" : "ambiguous",
    phase,
    nextPartIndex,
    nextAttemptAt: recover
      ? new Date(Date.now() + AMBIGUOUS_RECOVERY_DELAY_MS)
      : row.nextAttemptAt,
    leaseUntil: null,
    claimToken: null,
    sendAttemptedAt: null,
    ambiguousRetryCount: recover
      ? row.ambiguousRetryCount + 1
      : row.ambiguousRetryCount,
    repeatNotice: recover,
    deliveryPolicyVersion: CURRENT_DELIVERY_POLICY_VERSION,
    lastError: error.slice(0, 1_000),
  });
  try {
    await recordAmbiguousDeliveryAudit({ ...row, phase, nextPartIndex }, error);
  } catch (auditErr) {
    // The terminal outbox state is already durable. Reconciliation will retry
    // the audit insert without ever reopening the Telegram request.
    logger.error(
      { err: auditErr, deliveryId: row.id, reason: error },
      "Telegram ambiguous delivery audit could not be persisted",
    );
  }
  logger.warn(
    {
      deliveryId: row.id,
      recipientRole: recipientRole(row.target),
      phase,
      attempts: row.attempts,
      recoveryScheduled: recover,
      error,
    },
    recover
      ? "Telegram delivery outcome unknown — one bounded recovery scheduled"
      : "Telegram delivery outcome unknown — recovery budget exhausted",
  );
  if (recover) scheduleOutboxRecovery(AMBIGUOUS_RECOVERY_DELAY_MS);
  await refreshDeliveryEventStatus(row.dedupKey);
  if (!recover) {
    try {
      await enqueueOperatorFailureAlert(row, error);
    } catch (operatorAlertError) {
      logger.error(
        { err: operatorAlertError, deliveryId: row.id },
        "Telegram ambiguous terminal operator alert could not be queued",
      );
    }
  }
}

async function markDelivered(
  row: DeliveryRow,
  claimToken: string,
  phase: DeliveryPhase,
  nextPartIndex: number,
): Promise<void> {
  const acceptedAt = new Date();
  await updateClaimed(row, claimToken, {
    status: "delivered",
    phase,
    nextPartIndex,
    leaseUntil: null,
    claimToken: null,
    lastError: null,
    acceptedAt,
    deliveredAt: acceptedAt,
  });
  logger.info(
    {
      deliveryId: row.id,
      recipientRole: recipientRole(row.target),
      phase,
      attempts: row.attempts,
    },
    "Telegram photo delivery completed",
  );
  await refreshDeliveryEventStatus(row.dedupKey);
}

async function refreshDeliveryEventStatus(dedupKey: string): Promise<void> {
  try {
    const result = await db.execute(sql`
      SELECT
        count(*)::int AS total,
        count(*) FILTER (WHERE status IN ('delivered', 'suppressed'))::int AS delivered,
        count(*) FILTER (WHERE status IN ('ambiguous', 'abandoned'))::int AS attention
      FROM telegram_photo_deliveries
      WHERE dedup_key = ${dedupKey}
    `);
    const row = result.rows[0] as
      | { total: number; delivered: number; attention: number }
      | undefined;
    if (!row || row.total === 0) return;

    const status =
      row.attention > 0
        ? "attention"
        : row.delivered === row.total
          ? "delivered"
          : "queued";
    const now = new Date();
    await db
      .update(telegramDeliveryEventsTable)
      .set({
        status,
        attentionAt: status === "attention" ? now : null,
        completedAt: status === "delivered" ? now : null,
        updatedAt: now,
      })
      .where(eq(telegramDeliveryEventsTable.eventKey, dedupKey));
  } catch (err) {
    logger.warn({ err }, "Telegram delivery event status refresh failed");
  }
}

async function claimNext(onlyDedupKey?: string): Promise<DeliveryRow | null> {
  for (let collisionAttempt = 0; collisionAttempt < 8; collisionAttempt++) {
    const now = new Date();
    const due = or(
      and(
        eq(telegramPhotoDeliveriesTable.status, "ready"),
        lte(telegramPhotoDeliveriesTable.nextAttemptAt, now),
      ),
      and(
        eq(telegramPhotoDeliveriesTable.status, "retry"),
        eq(
          telegramPhotoDeliveriesTable.deliveryPolicyVersion,
          CURRENT_DELIVERY_POLICY_VERSION,
        ),
        lte(telegramPhotoDeliveriesTable.nextAttemptAt, now),
      ),
      and(
        eq(telegramPhotoDeliveriesTable.status, "processing"),
        lte(telegramPhotoDeliveriesTable.leaseUntil, now),
        isNull(telegramPhotoDeliveriesTable.sendAttemptedAt),
      ),
    );
    const where = onlyDedupKey
      ? and(due, eq(telegramPhotoDeliveriesTable.dedupKey, onlyDedupKey))
      : due;
    const [candidate] = await db
      .select()
      .from(telegramPhotoDeliveriesTable)
      .where(where)
      .orderBy(
        asc(telegramPhotoDeliveriesTable.nextAttemptAt),
        asc(telegramPhotoDeliveriesTable.id),
      )
      .limit(1);
    if (!candidate) return null;

    await waitForTestClaimBarrier();
    const claimToken = randomUUID();
    const phase = normalizePhase(candidate.phase);
    const claimed = await db
      .update(telegramPhotoDeliveriesTable)
      .set({
        status: "processing",
        attempts: candidate.attempts + 1,
        photoAttempts:
          phase === "photo"
            ? candidate.photoAttempts + 1
            : candidate.photoAttempts,
        leaseUntil: new Date(Date.now() + LEASE_MS),
        claimToken,
        updatedAt: now,
      })
      .where(
        and(
          eq(telegramPhotoDeliveriesTable.id, candidate.id),
          or(
            and(
              eq(telegramPhotoDeliveriesTable.status, "ready"),
              lte(telegramPhotoDeliveriesTable.nextAttemptAt, now),
            ),
            and(
              eq(telegramPhotoDeliveriesTable.status, "retry"),
              eq(
                telegramPhotoDeliveriesTable.deliveryPolicyVersion,
                CURRENT_DELIVERY_POLICY_VERSION,
              ),
              lte(telegramPhotoDeliveriesTable.nextAttemptAt, now),
            ),
            and(
              eq(telegramPhotoDeliveriesTable.status, "processing"),
              lte(telegramPhotoDeliveriesTable.leaseUntil, now),
              isNull(telegramPhotoDeliveriesTable.sendAttemptedAt),
            ),
          ),
        ),
      )
      .returning();
    if (claimed[0]) return claimed[0];
  }
  return null;
}

/**
 * A row with a persisted pre-send fence has crossed the point where a retry is
 * safe. If its worker disappears before recording Telegram's response, keep
 * the event for audit rather than releasing it back into the send queue.
 */
export async function quarantineExpiredTelegramSendAttempts(): Promise<number> {
  const now = new Date();
  const candidates = await db
    .select()
    .from(telegramPhotoDeliveriesTable)
    .where(
      and(
        eq(telegramPhotoDeliveriesTable.status, "processing"),
        isNotNull(telegramPhotoDeliveriesTable.sendAttemptedAt),
        lte(telegramPhotoDeliveriesTable.leaseUntil, now),
      ),
    );
  let recoveredOrQuarantined = 0;
  for (const row of candidates) {
    const recover = canScheduleAmbiguousRecovery(row);
    const [updated] = await db
      .update(telegramPhotoDeliveriesTable)
      .set({
        status: recover ? "retry" : "ambiguous",
        nextAttemptAt: recover
          ? new Date(Date.now() + AMBIGUOUS_RECOVERY_DELAY_MS)
          : row.nextAttemptAt,
        leaseUntil: null,
        claimToken: null,
        sendAttemptedAt: null,
        ambiguousRetryCount: recover
          ? row.ambiguousRetryCount + 1
          : row.ambiguousRetryCount,
        repeatNotice: recover,
        deliveryPolicyVersion: CURRENT_DELIVERY_POLICY_VERSION,
        lastError:
          row.lastError ??
          "Telegram outcome unknown after persisted send attempt",
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(telegramPhotoDeliveriesTable.id, row.id),
          eq(telegramPhotoDeliveriesTable.status, "processing"),
          lte(telegramPhotoDeliveriesTable.leaseUntil, now),
          isNotNull(telegramPhotoDeliveriesTable.sendAttemptedAt),
        ),
      )
      .returning();
    if (!updated) continue;
    recoveredOrQuarantined++;
    try {
      await recordAmbiguousDeliveryAudit(
        updated,
        updated.lastError ??
          "Telegram outcome unknown after persisted send attempt",
      );
      await refreshDeliveryEventStatus(updated.dedupKey);
    } catch (err) {
      logger.error(
        { err, deliveryId: updated.id },
        "Expired Telegram send was quarantined but audit reconciliation failed",
      );
    }
    if (recover) scheduleOutboxRecovery(AMBIGUOUS_RECOVERY_DELAY_MS);
    else {
      try {
        await enqueueOperatorFailureAlert(
          updated,
          updated.lastError ??
            "Telegram outcome unknown after persisted send attempt",
        );
      } catch (operatorAlertError) {
        logger.error(
          { err: operatorAlertError, deliveryId: updated.id },
          "Expired Telegram send operator alert could not be queued",
        );
      }
    }
  }
  if (recoveredOrQuarantined > 0) {
    logger.warn(
      { recoveredOrQuarantined },
      "Expired Telegram sends recovered or quarantined",
    );
  }
  return recoveredOrQuarantined;
}

async function deliverTextParts(
  row: DeliveryRow,
  claimToken: string,
  phase: Exclude<DeliveryPhase, "photo">,
  startIndex: number,
  forcePlainText = row.plainText,
): Promise<boolean> {
  const parts = getPendingTelegramTextParts(row, phase, startIndex);
  if (parts.length === 0) {
    await markDelivered(row, claimToken, phase, startIndex);
    return true;
  }

  for (let offset = 0; offset < parts.length; offset++) {
    const index = startIndex + offset;
    if (!(await prepareRecipientDispatch(row, claimToken, phase, index))) {
      return false;
    }
    await recordSendAttempt(row, claimToken, phase, index);
    await recordDeliveryAttemptStarted(
      { ...row, phase, nextPartIndex: index },
      forcePlainText ? "plain-text" : "html-text",
    );
    let result = await sendMessageResult(
      row.target,
      forcePlainText
        ? telegramReportPlainText(parts[offset]!)
        : withRecoveryNotice(
            parts[offset]!,
            row.repeatNotice && startIndex + offset === 0,
          ),
      {
        parseMode: forcePlainText ? null : "HTML",
        auditSource: "telegram-photo-outbox.deliverTextParts",
        auditEventKey: row.dedupKey,
        auditDeliveryPath: "outbox",
      },
    );
    await recordDeliveryAttemptOutcomeBestEffort(
      { ...row, phase, nextPartIndex: index },
      result,
      result.ok ? "delivered" : "failed",
      forcePlainText ? "plain-text" : "html-text",
    );
    if (
      !result.ok &&
      !forcePlainText &&
      isTelegramHtmlParseError(result.description)
    ) {
      await updateClaimed(row, claimToken, {
        plainText: true,
        sendAttemptedAt: null,
        leaseUntil: new Date(Date.now() + LEASE_MS),
      });
      if (!(await prepareRecipientDispatch(row, claimToken, phase, index))) {
        return false;
      }
      await recordSendAttempt(row, claimToken, phase, index);
      await recordDeliveryAttemptStarted(
        { ...row, phase, nextPartIndex: index },
        "plain-text-fallback",
      );
      result = await sendMessageResult(
        row.target,
        telegramReportPlainText(
          withRecoveryNotice(
            parts[offset]!,
            row.repeatNotice && startIndex + offset === 0,
          ),
        ),
        {
          parseMode: null,
          auditSource: "telegram-photo-outbox.deliverTextParts",
          auditEventKey: row.dedupKey,
          auditDeliveryPath: "outbox",
        },
      );
      await recordDeliveryAttemptOutcomeBestEffort(
        { ...row, phase, nextPartIndex: index },
        result,
        result.ok
          ? "delivered_plain_text_fallback"
          : "failed_plain_text_fallback",
        "plain-text-fallback",
      );
    }
    if (!result.ok && result.description === "recipient subscription expired") {
      await markRecipientSuppressed(row, claimToken, phase, index);
      return false;
    }
    if (!result.ok) {
      const error = describeFailure(result) || "Telegram text delivery failed";
      if (shouldRetryTelegramAttempt(result)) {
        await markRetry(row, claimToken, phase, index, error, result);
      } else {
        await markAbandoned(row, claimToken, phase, index, error);
      }
      return false;
    }

    const nextPartIndex = index + 1;
    if (offset === parts.length - 1) {
      await markDelivered(row, claimToken, phase, nextPartIndex);
      return true;
    }
    await updateClaimed(row, claimToken, {
      status: "processing",
      phase,
      nextPartIndex,
      leaseUntil: new Date(Date.now() + LEASE_MS),
      sendAttemptedAt: null,
      lastError: null,
    });
  }
  return true;
}

async function deliverClaimed(row: DeliveryRow): Promise<boolean> {
  const claimToken = row.claimToken;
  if (!claimToken) return false;

  let phase = normalizePhase(row.phase);
  let nextPartIndex = row.nextPartIndex;
  try {
    // Existing outbox rows may predate the timing line. Resolve the immutable
    // signal timestamp at dispatch, so retries reflect the actual wait.
    const signalMatch = /^signal(?:-resend)?:([0-9]+)(?::|$)/.exec(
      row.dedupKey,
    );
    if (signalMatch) {
      const [signal] = await db
        .select({ detectedAt: signalsTable.detectedAt })
        .from(signalsTable)
        .where(eq(signalsTable.id, Number(signalMatch[1])))
        .limit(1);
      if (!signal)
        throw new Error(
          `Signal ${signalMatch[1]} missing for Telegram delivery`,
        );
      const deliveryAt = new Date();
      row = {
        ...row,
        caption: withPrimarySignalTiming(
          row.caption,
          signal.detectedAt,
          deliveryAt,
          1_000,
        ),
        fallbackText: withPrimarySignalTiming(
          row.fallbackText,
          signal.detectedAt,
          deliveryAt,
        ),
      };
    }
    if (phase !== "photo") {
      return await deliverTextParts(row, claimToken, phase, nextPartIndex);
    }

    row = {
      ...row,
      photoPath: photoPathForQueuedTargetHit(
        row.dedupKey,
        photoPathForTimeoutDelivery(row.dedupKey, row.photoPath),
      ),
    };
    let media = await waitForPatternMedia(row.photoPath, row.dedupKey);
    if (media.kind === "waiting") {
      await deferUntilPatternMediaReady(row, claimToken);
      return false;
    }
    if (media.kind === "ambiguous") {
      await markAmbiguous(
        row,
        claimToken,
        "photo",
        0,
        "Shared Telegram pattern image upload outcome unknown; automatic recipient send disabled",
      );
      return false;
    }

    let result: TelegramApiCallResult;
    let uploadedPhotoResult: TelegramApiCallResult<TelegramPhotoMessage> | null =
      null;
    let uploadClaim:
      | Extract<PatternMediaResolution, { kind: "upload" }>
      | undefined;
    if (media.kind === "cached") {
      if (!(await prepareRecipientDispatch(row, claimToken, "photo", 0))) {
        return false;
      }
      await recordSendAttempt(row, claimToken, "photo", 0);
      await recordDeliveryAttemptStarted(
        { ...row, phase: "photo", nextPartIndex: 0 },
        "photo-file-id-initial",
      );
      result = await sendPhotoByFileIdResult(
        row.target,
        media.fileId,
        withRecoveryNotice(row.caption, row.repeatNotice),
        {
          auditSource: "telegram-photo-outbox.deliverClaimed",
          auditEventKey: row.dedupKey,
          auditDeliveryPath: "outbox",
        },
      );
      await recordDeliveryAttemptOutcomeBestEffort(
        { ...row, phase: "photo", nextPartIndex: 0 },
        result,
        result.ok ? "delivered" : "failed",
        "photo-file-id-initial",
      );

      if (isExplicitInvalidTelegramPhotoFileId(result)) {
        // Telegram explicitly refused this media reference before accepting the
        // message, so this recipient may safely take part in replacing it.
        await invalidatePatternMediaFileId(media.mediaKey, media.fileId);
        media = await waitForPatternMedia(row.photoPath, row.dedupKey);
        if (media.kind === "waiting") {
          await deferUntilPatternMediaReady(row, claimToken);
          return false;
        }
        if (media.kind === "ambiguous") {
          await markAmbiguous(
            row,
            claimToken,
            "photo",
            0,
            "Shared Telegram pattern image upload outcome unknown; automatic recipient send disabled",
          );
          return false;
        }
        if (media.kind === "cached") {
          if (!(await prepareRecipientDispatch(row, claimToken, "photo", 0))) {
            return false;
          }
          await recordSendAttempt(row, claimToken, "photo", 0);
          await recordDeliveryAttemptStarted(
            { ...row, phase: "photo", nextPartIndex: 0 },
            "photo-file-id-refreshed",
          );
          result = await sendPhotoByFileIdResult(
            row.target,
            media.fileId,
            withRecoveryNotice(row.caption, row.repeatNotice),
            {
              auditSource: "telegram-photo-outbox.deliverClaimed",
              auditEventKey: row.dedupKey,
              auditDeliveryPath: "outbox",
            },
          );
          await recordDeliveryAttemptOutcomeBestEffort(
            { ...row, phase: "photo", nextPartIndex: 0 },
            result,
            result.ok ? "delivered" : "failed",
            "photo-file-id-refreshed",
          );
        } else {
          uploadClaim = media;
          await recordPatternMediaUploadAttempt(
            uploadClaim.mediaKey,
            uploadClaim.claimToken,
            row.dedupKey,
          );
          if (!(await prepareRecipientDispatch(row, claimToken, "photo", 0))) {
            return false;
          }
          await recordSendAttempt(row, claimToken, "photo", 0);
          await recordDeliveryAttemptStarted(
            { ...row, phase: "photo", nextPartIndex: 0 },
            "photo-upload-replacement",
          );
          uploadedPhotoResult = await sendPhotoCaptionResult(
            row.target,
            row.photoPath,
            withRecoveryNotice(row.caption, row.repeatNotice),
            undefined,
            {
              auditSource: "telegram-photo-outbox.deliverClaimed",
              auditEventKey: row.dedupKey,
              auditDeliveryPath: "outbox",
            },
          );
          result = uploadedPhotoResult;
          await recordDeliveryAttemptOutcomeBestEffort(
            { ...row, phase: "photo", nextPartIndex: 0 },
            result,
            result.ok ? "delivered" : "failed",
            "photo-upload-replacement",
          );
        }
      }
    } else {
      uploadClaim = media;
      await recordPatternMediaUploadAttempt(
        uploadClaim.mediaKey,
        uploadClaim.claimToken,
        row.dedupKey,
      );
      if (!(await prepareRecipientDispatch(row, claimToken, "photo", 0))) {
        return false;
      }
      await recordSendAttempt(row, claimToken, "photo", 0);
      await recordDeliveryAttemptStarted(
        { ...row, phase: "photo", nextPartIndex: 0 },
        "photo-upload",
      );
      uploadedPhotoResult = await sendPhotoCaptionResult(
        row.target,
        row.photoPath,
        withRecoveryNotice(row.caption, row.repeatNotice),
        undefined,
        {
          auditSource: "telegram-photo-outbox.deliverClaimed",
          auditEventKey: row.dedupKey,
          auditDeliveryPath: "outbox",
        },
      );
      result = uploadedPhotoResult;
      await recordDeliveryAttemptOutcomeBestEffort(
        { ...row, phase: "photo", nextPartIndex: 0 },
        result,
        result.ok ? "delivered" : "failed",
        "photo-upload",
      );
    }

    if (!result.ok && result.description === "recipient subscription expired") {
      if (uploadClaim) {
        await releasePatternMediaUpload(
          uploadClaim.mediaKey,
          uploadClaim.claimToken,
          { clearUploadFence: true },
        );
      }
      await markRecipientSuppressed(row, claimToken, "photo", 0);
      return false;
    }

    if (uploadClaim) {
      if (result.ok) {
        const fileId = uploadedPhotoResult
          ? getTelegramPhotoFileId(uploadedPhotoResult)
          : null;
        if (fileId) {
          await storePatternMediaFileId(
            uploadClaim.mediaKey,
            uploadClaim.claimToken,
            fileId,
          );
        } else {
          // Telegram accepted this recipient's photo but did not provide the
          // reusable ID. Release the lease so a later recipient can safely
          // establish the cache rather than blocking the outbox indefinitely.
          logger.warn(
            { deliveryId: row.id },
            "Telegram accepted photo without a reusable media ID",
          );
          await releasePatternMediaUpload(
            uploadClaim.mediaKey,
            uploadClaim.claimToken,
            { clearUploadFence: false },
          );
        }
      } else {
        await releasePatternMediaUpload(
          uploadClaim.mediaKey,
          uploadClaim.claimToken,
          {
            clearUploadFence:
              shouldRetryExplicitPhotoFailure(result) ||
              shouldFallbackToTextAfterPhotoFailure(result),
          },
        );
      }
    }

    if (shouldRetryTelegramAttempt(result)) {
      await markRetry(
        row,
        claimToken,
        "photo",
        0,
        describeFailure(result) || "Telegram photo rate limited",
        result,
      );
      return false;
    }

    const transition = getTelegramPhotoResultTransition(
      result,
      row.continuationTexts.length > 0,
    );
    if (transition.status === "delivered") {
      await markDelivered(row, claimToken, "photo", 0);
      return true;
    }
    if (transition.status === "retry") {
      await markRetry(
        row,
        claimToken,
        "photo",
        0,
        describeFailure(result) || "Ambiguous Telegram photo delivery failure",
        result,
      );
      return false;
    }
    if (transition.status === "ambiguous") {
      await markAmbiguous(
        row,
        claimToken,
        "photo",
        0,
        describeFailure(result) || "Ambiguous Telegram photo delivery failure",
      );
      return false;
    }

    phase = transition.phase === "fallback" ? "fallback" : "continuation";
    nextPartIndex = 0;
    await updateClaimed(row, claimToken, {
      status: "processing",
      phase,
      nextPartIndex,
      leaseUntil: new Date(Date.now() + LEASE_MS),
      sendAttemptedAt: null,
      lastError:
        phase === "fallback"
          ? describeFailure(result) || "Photo rejected; sending text fallback"
          : null,
      plainText: isTelegramHtmlParseError(result.description),
    });
    return await deliverTextParts(
      { ...row, plainText: isTelegramHtmlParseError(result.description) },
      claimToken,
      phase,
      nextPartIndex,
      isTelegramHtmlParseError(result.description),
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    try {
      await markAmbiguous(row, claimToken, phase, nextPartIndex, message);
    } catch (finalizeErr) {
      logger.error(
        {
          err: finalizeErr,
          deliveryId: row.id,
          recipientRole: recipientRole(row.target),
          phase,
          attempts: row.attempts,
          originalError: message,
        },
        "Telegram photo delivery failed and retry state was not persisted",
      );
    }
    return false;
  }
}

/**
 * Older rows were created under an at-most-once policy. They must never receive
 * the new bounded recovery after deploy: their first external request is already
 * historical and can no longer be distinguished from a lost acknowledgement.
 */
export async function quarantineAmbiguousTelegramRetries(): Promise<number> {
  const quarantinedRetries = await db
    .update(telegramPhotoDeliveriesTable)
    .set({
      status: "ambiguous",
      leaseUntil: null,
      claimToken: null,
      repeatNotice: false,
      ambiguousRetryCount: MAX_AMBIGUOUS_RECOVERY_ATTEMPTS,
      deliveryPolicyVersion: CURRENT_DELIVERY_POLICY_VERSION,
      lastError: sql`COALESCE(${telegramPhotoDeliveriesTable.lastError}, 'Legacy retry quarantined during Telegram delivery policy migration')`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(telegramPhotoDeliveriesTable.status, "retry"),
        lte(
          telegramPhotoDeliveriesTable.deliveryPolicyVersion,
          CURRENT_DELIVERY_POLICY_VERSION - 1,
        ),
      ),
    )
    .returning();
  const quarantinedUnknown = await db
    .update(telegramPhotoDeliveriesTable)
    .set({
      ambiguousRetryCount: MAX_AMBIGUOUS_RECOVERY_ATTEMPTS,
      repeatNotice: false,
      deliveryPolicyVersion: CURRENT_DELIVERY_POLICY_VERSION,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(telegramPhotoDeliveriesTable.status, "ambiguous"),
        lte(
          telegramPhotoDeliveriesTable.deliveryPolicyVersion,
          CURRENT_DELIVERY_POLICY_VERSION - 1,
        ),
      ),
    )
    .returning();
  for (const row of [...quarantinedRetries, ...quarantinedUnknown]) {
    try {
      await recordAmbiguousDeliveryAudit(
        row,
        row.lastError ??
          "Legacy Telegram delivery quarantined during policy migration",
      );
      await refreshDeliveryEventStatus(row.dedupKey);
    } catch (err) {
      logger.error(
        { err, deliveryId: row.id },
        "Legacy Telegram retry was quarantined but audit reconciliation failed",
      );
    }
  }
  const quarantined = quarantinedRetries.length + quarantinedUnknown.length;
  if (quarantined > 0) {
    logger.warn(
      { quarantined },
      "Legacy Telegram deliveries quarantined; per-row owner alerts suppressed",
    );
  }
  return quarantined;
}

/**
 * A database failure immediately after Telegram accepts a request can leave
 * only the fenced outbox row. Rebuild missing audit rows from terminal
 * ambiguous state without changing delivery status or making another request.
 */
export async function reconcileAmbiguousTelegramDeliveryAudit(): Promise<number> {
  const rows = await db
    .select()
    .from(telegramPhotoDeliveriesTable)
    .where(eq(telegramPhotoDeliveriesTable.status, "ambiguous"));
  let audited = 0;
  for (const row of rows) {
    await recordAmbiguousDeliveryAudit(
      row,
      row.lastError ?? "Telegram delivery outcome unknown",
    );
    audited++;
  }
  return audited;
}

async function drainTelegramPhotoOutboxInternal(
  onlyDedupKey?: string,
): Promise<number> {
  await quarantineExpiredTelegramSendAttempts();
  await reconcileAmbiguousTelegramDeliveryAudit();
  let delivered = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const row = await claimNext(onlyDedupKey);
      if (!row) return;
      if (await deliverClaimed(row)) delivered++;
    }
  };
  await Promise.all(Array.from({ length: WORKER_CONCURRENCY }, () => worker()));
  await logTelegramDeliveryHealth("outbox-drain");
  return delivered;
}

let activeDrain: Promise<number> | null = null;
let drainRequested = false;
let recoveryTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleOutboxRecovery(delayMs = OUTBOX_RECOVERY_RETRY_MS): void {
  if (recoveryTimer) return;
  recoveryTimer = setTimeout(() => {
    recoveryTimer = null;
    void runOutsideMarketCycleLease(() =>
      drainTelegramPhotoOutbox().catch((err) =>
        logger.warn({ err }, "Telegram photo outbox recovery drain failed"),
      ),
    );
  }, delayMs);
  recoveryTimer.unref?.();
}

export function drainTelegramPhotoOutbox(
  onlyDedupKey?: string,
): Promise<number> {
  if (activeDrain) {
    drainRequested = true;
    return activeDrain;
  }

  activeDrain = (async () => {
    let delivered = 0;
    do {
      drainRequested = false;
      delivered += await drainTelegramPhotoOutboxInternal(onlyDedupKey);
    } while (drainRequested);
    return delivered;
  })()
    .catch((err: unknown) => {
      scheduleOutboxRecovery();
      throw err;
    })
    .finally(() => {
      activeDrain = null;
    });
  return activeDrain;
}

function scheduleTelegramPhotoOutboxDrain(): void {
  setTimeout(() => {
    void runOutsideMarketCycleLease(() =>
      drainTelegramPhotoOutbox().catch((err) =>
        logger.warn({ err }, "Telegram photo outbox immediate drain failed"),
      ),
    );
  }, 0);
}

async function persistTelegramDeliveryRows(
  dedupKey: string,
  targets: Array<number | string>,
  buildRows: (targets: Array<number | string>) => DeliveryInsert[],
): Promise<Array<{ id: number }>> {
  return db.transaction(async (tx) => {
    const eligibleTargets = await requireEligibleTelegramRecipients(
      targets,
      tx,
    );
    if (eligibleTargets.length === 0) return [];
    const rows = buildRows(eligibleTargets);
    const [createdEvent] = await tx
      .insert(telegramDeliveryEventsTable)
      .values({
        eventKey: dedupKey,
        expectedRecipientCount: eligibleTargets.length,
      })
      .onConflictDoNothing()
      .returning({ eventKey: telegramDeliveryEventsTable.eventKey });

    // The first transaction owns the immutable recipient snapshot. A retry
    // after a successful commit must not compare it with a later subscriber
    // list or add a late subscriber to an already-created business event.
    if (!createdEvent) return [];

    const insertedRows = await tx
      .insert(telegramPhotoDeliveriesTable)
      .values(rows)
      .onConflictDoNothing({
        target: [
          telegramPhotoDeliveriesTable.dedupKey,
          telegramPhotoDeliveriesTable.target,
        ],
      })
      .returning({ id: telegramPhotoDeliveriesTable.id });
    const persistedRows = await tx
      .select({ target: telegramPhotoDeliveriesTable.target })
      .from(telegramPhotoDeliveriesTable)
      .where(eq(telegramPhotoDeliveriesTable.dedupKey, dedupKey));
    const expectedTargets = new Set(
      eligibleTargets.map((target) => String(target)),
    );
    const persistedTargets = new Set(persistedRows.map((row) => row.target));
    if (
      persistedRows.length !== expectedTargets.size ||
      [...expectedTargets].some((target) => !persistedTargets.has(target))
    ) {
      throw new Error(
        `Telegram delivery recipient snapshot is incomplete for ${dedupKey}`,
      );
    }
    return insertedRows;
  });
}

export async function enqueueTelegramPhotoBroadcast(params: {
  photoPath: string;
  text: string;
  targets: Array<number | string>;
  eventKey?: string;
}): Promise<number> {
  assertMarketCycleLeaseOwnership("Telegram outbox enqueue");
  if (params.targets.length === 0) return 0;

  const dedupKey = getTelegramPhotoDeliveryKey(params.eventKey);
  const targets = uniqueTargets(params.targets);
  const prepared = prepareTelegramHtmlForEnqueue(params.text);
  if (prepared.repaired) {
    logger.error(
      { dedupKey, reason: prepared.reason },
      "Invalid Telegram HTML repaired before durable enqueue",
    );
  }
  const inserted = await persistTelegramDeliveryRows(
    dedupKey,
    targets,
    (eligibleTargets) =>
      buildTelegramPhotoDeliveryRows(
        { ...params, text: prepared.html, targets: eligibleTargets },
        dedupKey,
      ),
  );

  logger.info(
    {
      dedupKey,
      requestedRecipients: targets.length,
      ...recipientRoleCounts(targets),
      queuedRecipients: inserted.length,
    },
    "Telegram photo deliveries queued",
  );
  if (inserted.length > 0) scheduleTelegramPhotoOutboxDrain();
  return inserted.length;
}

export async function enqueueTelegramTextBroadcast(params: {
  text: string;
  targets: Array<number | string>;
  eventKey: string;
}): Promise<number> {
  assertMarketCycleLeaseOwnership("Telegram text outbox enqueue");
  if (params.targets.length === 0) return 0;

  const targets = uniqueTargets(params.targets);
  const prepared = prepareTelegramHtmlForEnqueue(params.text);
  if (prepared.repaired) {
    logger.error(
      { dedupKey: params.eventKey, reason: prepared.reason },
      "Invalid Telegram HTML repaired before durable enqueue",
    );
  }
  const inserted = await persistTelegramDeliveryRows(
    params.eventKey,
    targets,
    (eligibleTargets) =>
      buildTelegramTextDeliveryRows(
        { text: prepared.html, targets: eligibleTargets },
        params.eventKey,
      ),
  );
  logger.info(
    {
      dedupKey: params.eventKey,
      requestedRecipients: targets.length,
      ...recipientRoleCounts(targets),
      queuedRecipients: inserted.length,
    },
    "Telegram text deliveries queued",
  );
  if (inserted.length > 0) scheduleTelegramPhotoOutboxDrain();
  return inserted.length;
}

export async function enqueueTelegramPhotoBroadcastAfterClaim(params: {
  photoPath: string | (() => string);
  text: string | (() => string);
  targets: Array<number | string>;
  eventKey: string;
  claim: (tx: TelegramPhotoOutboxTransaction) => Promise<boolean>;
}): Promise<{ claimed: boolean; queued: number }> {
  assertMarketCycleLeaseOwnership("transactional Telegram outbox enqueue");
  const result = await db.transaction(async (tx) => {
    const targets = await requireEligibleTelegramRecipients(params.targets, tx);
    return runTelegramPhotoClaimTransaction({
      transaction: tx,
      rows: [],
      forceInsertAfterClaim: true,
      claim: params.claim,
      insert: async (transaction, _deliveryRows) => {
        const prepared = prepareTelegramHtmlForEnqueue(
          typeof params.text === "function" ? params.text() : params.text,
        );
        const rows = buildTelegramPhotoDeliveryRows(
          {
            ...params,
            photoPath:
              typeof params.photoPath === "function"
                ? params.photoPath()
                : params.photoPath,
            text: prepared.html,
            targets,
          },
          params.eventKey,
        );
        if (rows.length === 0) return 0;
        const inserted = await transaction
          .insert(telegramPhotoDeliveriesTable)
          .values(rows)
          .onConflictDoNothing({
            target: [
              telegramPhotoDeliveriesTable.dedupKey,
              telegramPhotoDeliveriesTable.target,
            ],
          })
          .returning({ id: telegramPhotoDeliveriesTable.id });
        return inserted.length;
      },
    });
  });

  logger.info(
    {
      dedupKey: params.eventKey,
      requestedRecipients: params.targets.length,
      ...recipientRoleCounts(params.targets),
      queuedRecipients: result.queued,
      claimed: result.claimed,
    },
    "Transactional Telegram photo deliveries queued",
  );
  if (result.queued > 0) scheduleTelegramPhotoOutboxDrain();
  return result;
}

const RECIPIENT_RESOLUTION_PENDING = "recipient_resolution_pending";

type PendingRecipientResolutionPayload = {
  photoPath: string;
  text: string;
};

/**
 * Recipient discovery can fail independently of the economic transaction.
 * Persist the claim and its notification payload under the normal event key in
 * one transaction; recovery later freezes the recipient snapshot and creates
 * the ordinary recipient-level outbox rows.
 */
export async function enqueueTelegramPhotoClaimPendingRecipientResolution(params: {
  photoPath: string | (() => string);
  text: string | (() => string);
  eventKey: string;
  claim: (tx: TelegramPhotoOutboxTransaction) => Promise<boolean>;
}): Promise<{ claimed: boolean; queued: number }> {
  assertMarketCycleLeaseOwnership("pending Telegram recipient resolution");
  return db.transaction(async (tx) => {
    if (!(await params.claim(tx))) return { claimed: false, queued: 0 };
    const prepared = prepareTelegramHtmlForEnqueue(
      typeof params.text === "function" ? params.text() : params.text,
    );
    const photoPath =
      typeof params.photoPath === "function"
        ? params.photoPath()
        : params.photoPath;
    await tx
      .insert(telegramDeliveryEventsTable)
      .values({
        eventKey: params.eventKey,
        expectedRecipientCount: 0,
        status: RECIPIENT_RESOLUTION_PENDING,
        lastError: JSON.stringify({
          photoPath,
          text: prepared.html,
        } satisfies PendingRecipientResolutionPayload),
      })
      .onConflictDoNothing();
    return { claimed: true, queued: 0 };
  });
}

export async function recoverTelegramPhotoRecipientResolution(
  resolveTargets: () => Promise<Array<number | string>>,
): Promise<number> {
  const pending = await db
    .select({
      eventKey: telegramDeliveryEventsTable.eventKey,
      payload: telegramDeliveryEventsTable.lastError,
    })
    .from(telegramDeliveryEventsTable)
    .where(eq(telegramDeliveryEventsTable.status, RECIPIENT_RESOLUTION_PENDING))
    .limit(25);
  if (pending.length === 0) return 0;

  const targets = await resolveTargets();
  let queued = 0;
  for (const event of pending) {
    let payload: PendingRecipientResolutionPayload;
    try {
      payload = JSON.parse(
        event.payload ?? "",
      ) as PendingRecipientResolutionPayload;
      if (!payload.photoPath || !payload.text)
        throw new Error("missing payload");
    } catch (err) {
      logger.error(
        { err, eventKey: event.eventKey },
        "Pending Telegram recipient payload is invalid",
      );
      continue;
    }
    queued += await db.transaction(async (tx) => {
      const claimed = await tx
        .update(telegramDeliveryEventsTable)
        .set({
          status: "recipient_resolution_processing",
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(telegramDeliveryEventsTable.eventKey, event.eventKey),
            eq(
              telegramDeliveryEventsTable.status,
              RECIPIENT_RESOLUTION_PENDING,
            ),
          ),
        )
        .returning({ eventKey: telegramDeliveryEventsTable.eventKey });
      if (claimed.length === 0) return 0;
      const eligibleTargets = await requireEligibleTelegramRecipients(
        targets,
        tx,
      );
      if (eligibleTargets.length === 0) {
        await tx
          .update(telegramDeliveryEventsTable)
          .set({
            status: RECIPIENT_RESOLUTION_PENDING,
            updatedAt: new Date(),
          })
          .where(eq(telegramDeliveryEventsTable.eventKey, event.eventKey));
        return 0;
      }
      const rows = buildTelegramPhotoDeliveryRows(
        { ...payload, targets: eligibleTargets },
        event.eventKey,
      );
      const inserted = await tx
        .insert(telegramPhotoDeliveriesTable)
        .values(rows)
        .onConflictDoNothing({
          target: [
            telegramPhotoDeliveriesTable.dedupKey,
            telegramPhotoDeliveriesTable.target,
          ],
        })
        .returning({ id: telegramPhotoDeliveriesTable.id });
      await tx
        .update(telegramDeliveryEventsTable)
        .set({
          expectedRecipientCount: eligibleTargets.length,
          status: "queued",
          lastError: null,
          updatedAt: new Date(),
        })
        .where(eq(telegramDeliveryEventsTable.eventKey, event.eventKey));
      return inserted.length;
    });
  }
  if (queued > 0) scheduleTelegramPhotoOutboxDrain();
  return queued;
}
