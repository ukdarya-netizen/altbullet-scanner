export const IMPULSE_BUY_CURRENT_STATS_COHORT_STARTED_AT = new Date(
  "2026-09-11T14:50:31.000Z",
);

export type ImpulseBuyStatsRow = {
  sentimentKey: string | null | undefined;
  status: string | null | undefined;
  detectedAt?: Date | string | null | undefined;
};

export function isLegacyImpulseBuyStopLoss(row: ImpulseBuyStatsRow): boolean {
  if (row.sentimentKey !== "impulse_buy" || row.status !== "stop_loss") {
    return false;
  }
  if (row.detectedAt == null) return true;
  const detectedAt =
    row.detectedAt instanceof Date
      ? row.detectedAt
      : new Date(String(row.detectedAt));
  return (
    !Number.isFinite(detectedAt.getTime()) ||
    detectedAt < IMPULSE_BUY_CURRENT_STATS_COHORT_STARTED_AT
  );
}

export function isIncludedInCurrentPatternStats(
  row: ImpulseBuyStatsRow,
): boolean {
  return !isLegacyImpulseBuyStopLoss(row);
}
