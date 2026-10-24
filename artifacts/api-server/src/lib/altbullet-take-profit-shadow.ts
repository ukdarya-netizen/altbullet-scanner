import {
  altBulletIndicatorSnapshotsTable,
  altBulletTakeProfitShadowTable,
  db,
  trackedSignalsTable,
} from "@workspace/db";
import { and, eq, isNull, sql } from "drizzle-orm";
import { dbWriteBestEffort } from "./dbWriteFast.js";
import { logger } from "./logger.js";
import { buildAltBulletTpCandidates } from "./altbullet-take-profit-shadow-policy.js";

export const ALT_BULLET_TP_EXPERIMENT_VERSION = "abneon-tp-shadow-v1";

function finitePositive(value: unknown): number | null {
  const numeric =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value)
        : Number.NaN;
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

function dateFromContext(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

export async function ensureAltBulletTpShadowForSignal(
  signalId: number,
): Promise<number> {
  const rows = await db
    .select({
      signalId: altBulletIndicatorSnapshotsTable.signalId,
      symbol: altBulletIndicatorSnapshotsTable.symbol,
      snapshotPattern: altBulletIndicatorSnapshotsTable.sentimentKey,
      indicatorVersion: altBulletIndicatorSnapshotsTable.indicatorVersion,
      snapshotStatus: altBulletIndicatorSnapshotsTable.status,
      context: altBulletIndicatorSnapshotsTable.context,
      capturedAt: altBulletIndicatorSnapshotsTable.capturedAt,
      trackedSignalId: trackedSignalsTable.id,
      trackedPattern: trackedSignalsTable.sentimentKey,
      entryPrice: trackedSignalsTable.entryPrice,
      isShort: trackedSignalsTable.isShort,
      tradeStatus: trackedSignalsTable.status,
      peakPrice: trackedSignalsTable.peakPrice,
      closedAt: trackedSignalsTable.closedAt,
      pnlPercent: trackedSignalsTable.pnlPercent,
    })
    .from(altBulletIndicatorSnapshotsTable)
    .innerJoin(
      trackedSignalsTable,
      eq(
        trackedSignalsTable.signalId,
        altBulletIndicatorSnapshotsTable.signalId,
      ),
    )
    .where(eq(altBulletIndicatorSnapshotsTable.signalId, signalId))
    .limit(1);
  const row = rows[0];
  if (!row || row.snapshotStatus !== "ready") return 0;

  const resistancePrice = finitePositive(row.context?.nearestResistance);
  const atr14 = finitePositive(row.context?.atr14);
  const candidates = buildAltBulletTpCandidates({
    entryPrice: row.entryPrice,
    resistancePrice,
    atr14,
    isShort: row.isShort,
  });
  const isTerminal = row.closedAt != null;
  const requestedAt = dateFromContext(row.context?.requestedAt);

  const inserted = await db
    .insert(altBulletTakeProfitShadowTable)
    .values(
      candidates.map((candidate) => {
        const historicallyReached =
          candidate.targetPrice != null &&
          row.peakPrice != null &&
          row.peakPrice >= candidate.targetPrice;
        const status =
          candidate.status === "not_eligible"
            ? "not_eligible"
            : historicallyReached
              ? "historical_ambiguous"
              : isTerminal
                ? "completed"
                : "tracking";
        const outcome =
          candidate.status === "not_eligible"
            ? "not_eligible"
            : historicallyReached
              ? "peak_reached_order_unknown"
              : isTerminal
                ? "ambiguous"
                : null;
        return {
          signalId: row.signalId,
          trackedSignalId: row.trackedSignalId,
          symbol: row.symbol,
          sentimentKey: row.trackedPattern ?? row.snapshotPattern,
          indicatorVersion: row.indicatorVersion,
          experimentVersion: ALT_BULLET_TP_EXPERIMENT_VERSION,
          variant: candidate.variant,
          status,
          eligibilityReason: candidate.eligibilityReason,
          referenceEntryPrice: row.entryPrice,
          resistancePrice,
          atr14,
          targetPrice: candidate.targetPrice,
          targetPct: candidate.targetPct,
          targetAtr: candidate.targetAtr,
          snapshotRequestedAt: requestedAt,
          snapshotCapturedAt: row.capturedAt,
          maxObservedPrice: row.peakPrice,
          terminalAt: row.closedAt,
          terminalStatus: isTerminal ? row.tradeStatus : null,
          terminalPnlPercent: isTerminal ? row.pnlPercent : null,
          outcome,
        };
      }),
    )
    .onConflictDoNothing()
    .returning({ id: altBulletTakeProfitShadowTable.id });
  return inserted.length;
}

export async function reconcileAltBulletTpShadowObservations(
  limit = 30,
): Promise<number> {
  const missing = await db
    .select({ signalId: altBulletIndicatorSnapshotsTable.signalId })
    .from(altBulletIndicatorSnapshotsTable)
    .innerJoin(
      trackedSignalsTable,
      eq(
        trackedSignalsTable.signalId,
        altBulletIndicatorSnapshotsTable.signalId,
      ),
    )
    .leftJoin(
      altBulletTakeProfitShadowTable,
      and(
        eq(
          altBulletTakeProfitShadowTable.signalId,
          altBulletIndicatorSnapshotsTable.signalId,
        ),
        eq(
          altBulletTakeProfitShadowTable.experimentVersion,
          ALT_BULLET_TP_EXPERIMENT_VERSION,
        ),
      ),
    )
    .where(
      and(
        eq(altBulletIndicatorSnapshotsTable.status, "ready"),
        isNull(altBulletTakeProfitShadowTable.id),
      ),
    )
    .limit(limit);
  let inserted = 0;
  for (const row of missing) {
    inserted += await ensureAltBulletTpShadowForSignal(row.signalId);
  }

  await db.execute(sql`
    UPDATE altbullet_take_profit_shadow shadow
    SET status = 'completed',
        terminal_at = tracked.closed_at,
        terminal_status = tracked.status::text,
        terminal_pnl_percent = tracked.pnl_percent,
        outcome = CASE
          WHEN shadow.hit_at IS NOT NULL
            AND shadow.hit_at <= tracked.closed_at
            THEN 'target_before_terminal'
          WHEN shadow.hit_at IS NULL
            THEN 'ambiguous'
          ELSE 'ambiguous'
        END,
        updated_at = now()
    FROM tracked_signals tracked
    WHERE shadow.tracked_signal_id = tracked.id
      AND shadow.experiment_version = ${ALT_BULLET_TP_EXPERIMENT_VERSION}
      AND shadow.status IN ('tracking', 'hit')
      AND tracked.closed_at IS NOT NULL
  `);
  return inserted;
}

export async function recordAltBulletTpShadowPrices(
  observations: Array<{
    signalId: number | null;
    price: number;
  }>,
  observedAt: Date,
): Promise<void> {
  const valid = observations.filter(
    (
      item,
    ): item is {
      signalId: number;
      price: number;
    } => item.signalId != null && Number.isFinite(item.price) && item.price > 0,
  );
  if (valid.length === 0) return;
  const values = valid.map(
    (item) => sql`(${item.signalId}::integer, ${item.price}::double precision)`,
  );
  await dbWriteBestEffort(
    "altbullet-tp-shadow/price-batch",
    () =>
      db.execute(sql`
        WITH observed(signal_id, price) AS (
          VALUES ${sql.join(values, sql`, `)}
        )
        UPDATE altbullet_take_profit_shadow shadow
        SET first_observed_at = COALESCE(shadow.first_observed_at, ${observedAt}),
            first_observed_price = COALESCE(shadow.first_observed_price, observed.price),
            last_observed_at = ${observedAt},
            last_observed_price = observed.price,
            max_observed_at = CASE
              WHEN shadow.max_observed_price IS NULL
                OR observed.price > shadow.max_observed_price
                THEN ${observedAt}
              ELSE shadow.max_observed_at
            END,
            max_observed_price = GREATEST(
              COALESCE(shadow.max_observed_price, observed.price),
              observed.price
            ),
            hit_at = CASE
              WHEN shadow.hit_at IS NULL AND observed.price >= shadow.target_price
                THEN ${observedAt}
              ELSE shadow.hit_at
            END,
            hit_price = CASE
              WHEN shadow.hit_at IS NULL AND observed.price >= shadow.target_price
                THEN observed.price
              ELSE shadow.hit_price
            END,
            status = CASE
              WHEN shadow.hit_at IS NULL AND observed.price >= shadow.target_price
                THEN 'hit'
              ELSE shadow.status
            END,
            updated_at = ${observedAt}
        FROM observed
        WHERE shadow.signal_id = observed.signal_id
          AND shadow.experiment_version = ${ALT_BULLET_TP_EXPERIMENT_VERSION}
          AND shadow.status IN ('tracking', 'hit')
      `),
    { attempts: 1, perAttemptTimeoutMs: 2_500 },
  );
}

export function logAltBulletTpShadowEnrollmentFailure(
  error: unknown,
  signalId: number,
): void {
  logger.warn(
    { error, signalId },
    "ABNeon TP shadow enrollment deferred to reconciliation",
  );
}
