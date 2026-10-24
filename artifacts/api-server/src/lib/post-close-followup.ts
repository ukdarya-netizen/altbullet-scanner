const HOUR_MS = 60 * 60 * 1000;

export const POST_CLOSE_FOLLOWUP_MAX_HOUR = 72;
export const POST_CLOSE_FOLLOWUP_FINAL_SAMPLE_GRACE_HOURS = 24;
export const POST_CLOSE_TERMINAL_STATUSES = [
  "profit",
  "stop_loss",
  "cancelled",
  "breakeven",
  "bu_stop",
  "expired",
] as const;

export type PostCloseTerminalStatus =
  (typeof POST_CLOSE_TERMINAL_STATUSES)[number];

export interface PostCloseFollowupSignal {
  id: number;
  symbol: string;
  status: string;
  closedAt: Date | null;
  exitPrice: number | null;
  isShort: boolean;
}

export interface PostCloseFollowupSnapshot {
  trackedSignalId: number;
  symbol: string;
  status: PostCloseTerminalStatus;
  closedAt: Date;
  exitPrice: number;
  isShort: boolean;
  hourAfterClose: number;
  observedAt: Date;
  price: number;
  movePct: number;
}

export function isPostCloseTerminalStatus(
  status: string,
): status is PostCloseTerminalStatus {
  return (POST_CLOSE_TERMINAL_STATUSES as readonly string[]).includes(status);
}

export function getPostCloseFollowupHour(
  closedAt: Date,
  observedAt: Date,
): number | null {
  const elapsedMs = observedAt.getTime() - closedAt.getTime();
  if (elapsedMs < HOUR_MS) return null;
  return Math.min(
    POST_CLOSE_FOLLOWUP_MAX_HOUR,
    Math.floor(elapsedMs / HOUR_MS),
  );
}

export function isPostCloseFollowupObservationEligible(
  closedAt: Date,
  observedAt: Date,
): boolean {
  const elapsedHours = (observedAt.getTime() - closedAt.getTime()) / HOUR_MS;
  return (
    elapsedHours >= 1 &&
    elapsedHours <=
      POST_CLOSE_FOLLOWUP_MAX_HOUR +
        POST_CLOSE_FOLLOWUP_FINAL_SAMPLE_GRACE_HOURS
  );
}

export function calculatePostCloseMovePct(
  exitPrice: number,
  currentPrice: number,
  isShort: boolean,
): number | null {
  if (
    !Number.isFinite(exitPrice) ||
    !Number.isFinite(currentPrice) ||
    exitPrice <= 0 ||
    currentPrice <= 0
  ) {
    return null;
  }
  const move = isShort
    ? ((exitPrice - currentPrice) / exitPrice) * 100
    : ((currentPrice - exitPrice) / exitPrice) * 100;
  return Number(move.toFixed(4));
}

export function buildPostCloseFollowupSnapshot(
  signal: PostCloseFollowupSignal,
  currentPrice: number,
  observedAt: Date,
): PostCloseFollowupSnapshot | null {
  if (
    !isPostCloseTerminalStatus(signal.status) ||
    !signal.closedAt ||
    signal.exitPrice == null ||
    !isPostCloseFollowupObservationEligible(signal.closedAt, observedAt)
  ) {
    return null;
  }
  const hourAfterClose = getPostCloseFollowupHour(signal.closedAt, observedAt);
  const movePct = calculatePostCloseMovePct(
    signal.exitPrice,
    currentPrice,
    signal.isShort,
  );
  if (hourAfterClose == null || movePct == null) return null;

  return {
    trackedSignalId: signal.id,
    symbol: signal.symbol,
    status: signal.status,
    closedAt: signal.closedAt,
    exitPrice: signal.exitPrice,
    isShort: signal.isShort,
    hourAfterClose,
    observedAt,
    price: currentPrice,
    movePct,
  };
}
