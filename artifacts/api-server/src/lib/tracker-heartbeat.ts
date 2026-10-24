/**
 * In-memory freshness of open positions: the last time the FastCycle tracker
 * evaluated a position against a live price. tracked_signals.updated_at only
 * changes on events, so it cannot show that a quiet position is still watched.
 */
const checkedAt = new Map<number, number>();

export function markTrackerChecked(
  signalIds: Iterable<number>,
  at = Date.now(),
) {
  for (const id of signalIds) checkedAt.set(id, at);
}

export function getTrackerCheckedAt(signalId: number): number | null {
  return checkedAt.get(signalId) ?? null;
}

/** Latest of the persisted event time and the tracker heartbeat (open only). */
export function effectiveSourceUpdatedAt(
  updatedAt: Date | null,
  signalId: number,
  isOpen: boolean,
): Date | null {
  if (!isOpen) return updatedAt;
  const hb = checkedAt.get(signalId);
  if (hb === undefined) return updatedAt;
  return !updatedAt || hb > updatedAt.getTime() ? new Date(hb) : updatedAt;
}
