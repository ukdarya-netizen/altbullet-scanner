import { db, trackedSignalsTable } from "@workspace/db";
import { sql } from "drizzle-orm";

export type ImpulseRunnerCloseTransaction = Parameters<
  Parameters<typeof db.transaction>[0]
>[0];

export type ClaimedImpulseRunnerClose = {
  id: number;
  exitPrice: number | null;
  coreExitPrice: number | null;
  corePnlPercent: number | null;
  runnerExitPrice: number | null;
  runnerPnlPercent: number | null;
  pnlPercent: number | null;
  status: string;
  peakPrice: number | null;
  entryPrice: number;
  originalEntryPrice: number | null;
};

export type ClaimedImpulseRunnerCoreClose = {
  id: number;
  coreExitPrice: number | null;
  corePnlPercent: number | null;
  peakPrice: number | null;
  entryPrice: number;
};

export async function claimImpulseRunnerCoreClose(
  tx: ImpulseRunnerCloseTransaction,
  input: {
    trackedSignalId: number;
    policyVersion: string;
    eventKey: string;
    trailingStop: number;
    peakPrice: number;
    runnerPeakPrice: number;
    runnerTrailingStop: number | null;
    observedAt: Date;
    closedAt: Date;
  },
): Promise<ClaimedImpulseRunnerCoreClose | null> {
  const effectiveCoreExit = sql<number>`GREATEST(
    COALESCE(${trackedSignalsTable.trailingStopLevel}, 0),
    ${input.trailingStop}
  )`;
  const effectiveCorePnl = sql<number>`(
    ${effectiveCoreExit} - ${trackedSignalsTable.entryPrice}
  ) / NULLIF(${trackedSignalsTable.entryPrice}, 0) * 100`;

  const claimed = await tx
    .update(trackedSignalsTable)
    .set({
      runnerState: "open",
      coreClosedAt: input.closedAt,
      coreExitPrice: effectiveCoreExit,
      corePnlPercent: effectiveCorePnl,
      coreCloseEventKey: input.eventKey,
      runnerPeakPrice: sql<number>`GREATEST(
        COALESCE(${trackedSignalsTable.runnerPeakPrice}, 0),
        ${input.runnerPeakPrice}
      )`,
      runnerTrailingStopLevel:
        input.runnerTrailingStop == null
          ? trackedSignalsTable.runnerTrailingStopLevel
          : sql<number>`GREATEST(
              COALESCE(${trackedSignalsTable.runnerTrailingStopLevel}, 0),
              ${input.runnerTrailingStop}
            )`,
      runnerTrailingStopArmedAt:
        input.runnerTrailingStop == null
          ? trackedSignalsTable.runnerTrailingStopArmedAt
          : sql<Date>`COALESCE(
              ${trackedSignalsTable.runnerTrailingStopArmedAt},
              ${input.observedAt}
            )`,
      pnlPercent: effectiveCorePnl,
      peakPrice: sql<number>`GREATEST(
        COALESCE(${trackedSignalsTable.peakPrice}, 0),
        ${input.peakPrice}
      )`,
      trailingStopLevel: sql<number>`GREATEST(
        COALESCE(${trackedSignalsTable.trailingStopLevel}, 0),
        ${input.trailingStop}
      )`,
      trailingStopArmedAt: sql<Date>`COALESCE(
        ${trackedSignalsTable.trailingStopArmedAt},
        ${input.observedAt}
      )`,
      updatedAt: input.closedAt,
    })
    .where(
      sql`${trackedSignalsTable.id} = ${input.trackedSignalId}
        AND ${trackedSignalsTable.status} = 'in_run'
        AND ${trackedSignalsTable.policyVersion} = ${input.policyVersion}
        AND ${trackedSignalsTable.coreClosedAt} IS NULL
        AND ${trackedSignalsTable.pendingMilestone} IS NULL`,
    )
    .returning({
      id: trackedSignalsTable.id,
      coreExitPrice: trackedSignalsTable.coreExitPrice,
      corePnlPercent: trackedSignalsTable.corePnlPercent,
      peakPrice: trackedSignalsTable.peakPrice,
      entryPrice: trackedSignalsTable.entryPrice,
    });

  return claimed[0] ?? null;
}

export async function claimImpulseRunnerFinalClose(
  tx: ImpulseRunnerCloseTransaction,
  input: {
    trackedSignalId: number;
    policyVersion: string;
    exitPrice: number;
    runnerPeakPrice: number;
    eventKey: string;
    closedAt: Date;
    lifetimeClose?: boolean;
  },
): Promise<ClaimedImpulseRunnerClose | null> {
  // A stale worker may provide both a low exit and a stale stored stop. Rebuild
  // the stop from the highest durable peak in the same UPDATE. The 30-point
  // gap is percentage points, not 30% of peak.
  const durablePeak = sql<number>`GREATEST(
    COALESCE(${trackedSignalsTable.runnerPeakPrice}, 0),
    COALESCE(${trackedSignalsTable.peakPrice}, 0),
    ${input.runnerPeakPrice}
  )`;
  const durableTrailingStop = sql<number>`(
    ${trackedSignalsTable.originalEntryPrice}
    * (1 + (
      (( ${durablePeak} - ${trackedSignalsTable.originalEntryPrice})
        / NULLIF(${trackedSignalsTable.originalEntryPrice}, 0) * 100
      ) - 30
    ) / 100)
  )`;
  const effectiveTrailingStop = sql<number>`GREATEST(
    CASE
      WHEN ${durablePeak} >= ${trackedSignalsTable.originalEntryPrice} * 1.3
        THEN ${durableTrailingStop}
      ELSE ${trackedSignalsTable.runnerTrailingStopLevel}
    END,
    ${trackedSignalsTable.runnerTrailingStopLevel}
  )`;
  const lifetimeTrailingActive = sql<boolean>`(
    ${durablePeak} >= ${trackedSignalsTable.originalEntryPrice} * 1.3
    AND ${effectiveTrailingStop} >= ${trackedSignalsTable.originalEntryPrice}
  )`;
  // A core-closed runner has an entry-anchored BE emergency stop. At lifetime
  // close, trailing takes priority; otherwise settle the runner at its BE.
  const effectiveRunnerExit = input.lifetimeClose
    ? sql<number>`CASE
        WHEN ${lifetimeTrailingActive} THEN GREATEST(${input.exitPrice}, ${effectiveTrailingStop})
        ELSE ${trackedSignalsTable.originalEntryPrice}
      END`
    : sql<number>`GREATEST(
        ${input.exitPrice},
        COALESCE(${effectiveTrailingStop}, ${input.exitPrice})
      )`;
  const effectiveRunnerPnl = sql<number>`(
    ${effectiveRunnerExit} -
    ${trackedSignalsTable.originalEntryPrice}
  ) / NULLIF(
    ${trackedSignalsTable.originalEntryPrice}, 0
  ) * 100`;
  const effectiveStatus = sql<
    "profit" | "stop_loss" | "expired" | "bu_stop"
  >`(CASE
    WHEN ${input.lifetimeClose === true} THEN CASE
      WHEN ${lifetimeTrailingActive} THEN 'profit'
      ELSE 'bu_stop'
    END
    WHEN ${effectiveRunnerPnl} >= 0 THEN 'profit'
    ELSE 'stop_loss'
  END)::tracked_status`;

  const claimed = await tx
    .update(trackedSignalsTable)
    .set({
      status: effectiveStatus,
      runnerState: "closed",
      runnerPeakPrice: durablePeak,
      runnerTrailingStopLevel: effectiveTrailingStop,
      runnerExitPrice: effectiveRunnerExit,
      runnerPnlPercent: effectiveRunnerPnl,
      runnerClosedAt: input.closedAt,
      runnerCloseEventKey: input.eventKey,
      exitPrice: effectiveRunnerExit,
      // Keep general tracker/statistics peak aligned with the durable runner
      // peak from the immutable original entry.
      peakPrice: durablePeak,
      // Canonical accounting is the runner's pure return from the immutable
      // original entry. Core/runner fields remain component telemetry only.
      pnlPercent: effectiveRunnerPnl,
      closedAt: input.closedAt,
      updatedAt: input.closedAt,
    })
    .where(
      sql`${trackedSignalsTable.id} = ${input.trackedSignalId}
        AND ${trackedSignalsTable.status} = 'in_run'
        AND ${trackedSignalsTable.policyVersion} = ${input.policyVersion}
        AND ${trackedSignalsTable.coreClosedAt} IS NOT NULL
        AND ${trackedSignalsTable.corePnlPercent} IS NOT NULL
        AND ${trackedSignalsTable.originalEntryPrice} IS NOT NULL
        AND ${trackedSignalsTable.originalEntryPrice} > 0
        AND ${trackedSignalsTable.runnerState} = 'open'`,
    )
    .returning({
      id: trackedSignalsTable.id,
      exitPrice: trackedSignalsTable.exitPrice,
      coreExitPrice: trackedSignalsTable.coreExitPrice,
      corePnlPercent: trackedSignalsTable.corePnlPercent,
      runnerExitPrice: trackedSignalsTable.runnerExitPrice,
      runnerPnlPercent: trackedSignalsTable.runnerPnlPercent,
      pnlPercent: trackedSignalsTable.pnlPercent,
      status: trackedSignalsTable.status,
      peakPrice: trackedSignalsTable.peakPrice,
      entryPrice: trackedSignalsTable.entryPrice,
      originalEntryPrice: trackedSignalsTable.originalEntryPrice,
    });

  return claimed[0] ?? null;
}
