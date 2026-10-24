export const IMPULSE_RUNNER_POLICY_VERSION = "impulse_runner_v1" as const;
export const IMPULSE_RUNNER_NEW_ENTRY_POLICY_VERSION =
  "single_entry_v1" as const;
export const IMPULSE_RUNNER_CORE_WEIGHT = 0.8;
export const IMPULSE_RUNNER_RUNNER_WEIGHT = 0.2;
export const IMPULSE_RUNNER_EMERGENCY_STOP_PCT = 0;
export const IMPULSE_RUNNER_NEW_EMERGENCY_STOP_PCT = 0;
export const IMPULSE_RUNNER_TRAILING_ACTIVATION_PCT = 30;
export const IMPULSE_RUNNER_TRAILING_GAP_PCT = 30;
export const IMPULSE_RUNNER_ACCOUNTING_CORRECTION_VERSION =
  "canonical_accounting_v1" as const;
export const BR_RUNNER_CORRECTION_KEY = "br-1688-runner-close-v2";

export function impulseRunnerAccountingCorrectionEventKey(
  trackedSignalId: number,
): string {
  return `position:${trackedSignalId}:${IMPULSE_RUNNER_POLICY_VERSION}:runner_close_correction:${IMPULSE_RUNNER_ACCOUNTING_CORRECTION_VERSION}`;
}

// One-time production recovery for the BR runner whose durable peak reached
// +174.10% while an older worker advanced only to the +10% milestone. These
// are immutable notification intents only; they never affect trading state.
export const BR_MISSED_MILESTONES = [
  15, 20, 25, 30, 35, 40, 45, 50, 55, 60, 65, 70, 75, 80, 85, 90, 95, 100, 105,
  110, 115, 120, 125, 130, 135, 140, 145, 150, 155, 160, 165,
] as const;

export function brMilestoneEventKey(milestone: number): string {
  return `milestone:v3:1688:milestone:${milestone}`;
}

export function brMilestoneReconstructedPrice(milestone: number): number {
  return 0.2532 * (1 + milestone / 100);
}
const BR_MILESTONE_RECOVERY_IDENTITY = {
  trackedSignalId: 1688,
  signalId: 6012,
  symbol: "BR-USDT",
  detectedAtMs: Date.parse("2026-09-16T09:35:49.907Z"),
} as const;

export type ImpulseRunnerState = "open" | "closed";

export function isBrMilestoneRecoveryIdentity(input: {
  id: number;
  signalId: number | null;
  symbol: string;
  detectedAt: Date;
  status: string;
  policyVersion: string | null;
  coreClosedAt: Date | null;
  runnerState: string | null;
}): boolean {
  return (
    input.id === BR_MILESTONE_RECOVERY_IDENTITY.trackedSignalId &&
    input.signalId === BR_MILESTONE_RECOVERY_IDENTITY.signalId &&
    input.symbol === BR_MILESTONE_RECOVERY_IDENTITY.symbol &&
    input.detectedAt.getTime() ===
      BR_MILESTONE_RECOVERY_IDENTITY.detectedAtMs &&
    input.status === "in_run" &&
    input.policyVersion === IMPULSE_RUNNER_POLICY_VERSION &&
    input.coreClosedAt !== null &&
    input.runnerState === "open"
  );
}

export function isBrMilestoneRecoveryTarget(input: {
  id: number;
  signalId: number | null;
  symbol: string;
  detectedAt: Date;
  policyVersion: string | null;
}): boolean {
  return (
    input.id === BR_MILESTONE_RECOVERY_IDENTITY.trackedSignalId &&
    input.signalId === BR_MILESTONE_RECOVERY_IDENTITY.signalId &&
    input.symbol === BR_MILESTONE_RECOVERY_IDENTITY.symbol &&
    input.detectedAt.getTime() ===
      BR_MILESTONE_RECOVERY_IDENTITY.detectedAtMs &&
    input.policyVersion === IMPULSE_RUNNER_POLICY_VERSION
  );
}

export type HistoricalRunnerCandle = {
  time: number;
  low: number;
};

/**
 * Returns the first closed candle which crossed an already armed stop.
 * The current candle is deliberately excluded: it is not a durable observation
 * until the exchange has closed it.
 */
export function findHistoricalRunnerTrailingStopHit(
  candles: readonly HistoricalRunnerCandle[],
  armedAt: Date | null | undefined,
  nowMs: number,
  stopPrice: number | null | undefined,
): HistoricalRunnerCandle | null {
  if (
    !armedAt ||
    !Number.isFinite(nowMs) ||
    stopPrice == null ||
    !Number.isFinite(stopPrice)
  ) {
    return null;
  }
  const currentCandleStart = nowMs - (nowMs % 60_000);
  return (
    [...candles]
      .sort((left, right) => left.time - right.time)
      .find(
        (candle) =>
          Number.isFinite(candle.time) &&
          candle.time >= armedAt.getTime() &&
          candle.time < currentCandleStart &&
          Number.isFinite(candle.low) &&
          candle.low <= stopPrice,
      ) ?? null
  );
}

export function nextSequentialMilestone(
  milestones: readonly number[],
  lastMilestone: number | null,
  currentPnl: number,
  ceiling: number,
): number | null {
  const last = lastMilestone ?? 0;
  return (
    milestones.find(
      (milestone) =>
        milestone > last && milestone <= currentPnl && milestone <= ceiling,
    ) ?? null
  );
}

export function selectImpulseRunnerPolicy(input: {
  sentimentKey: string | null | undefined;
  isShort?: boolean | null;
}): typeof IMPULSE_RUNNER_POLICY_VERSION | null {
  return input.sentimentKey === "impulse_buy" && input.isShort !== true
    ? IMPULSE_RUNNER_POLICY_VERSION
    : null;
}

export function isImpulseRunnerPolicy(
  policyVersion: string | null | undefined,
): policyVersion is typeof IMPULSE_RUNNER_POLICY_VERSION {
  return policyVersion === IMPULSE_RUNNER_POLICY_VERSION;
}

export const IMPULSE_RUNNER_MAX_AGE_MS = 5 * 24 * 60 * 60_000;

export function isImpulseRunnerFiveDaysOld(
  originalOpenedAt: Date,
  observedAt: Date,
): boolean {
  return (
    observedAt.getTime() - originalOpenedAt.getTime() >=
    IMPULSE_RUNNER_MAX_AGE_MS
  );
}

export function resolveImpulseRunnerEmergencyStopPct(
  persistedStopLossPct: number | null | undefined,
  entryPolicyVersion?: string | null,
): number {
  const emergencyStop =
    entryPolicyVersion === IMPULSE_RUNNER_NEW_ENTRY_POLICY_VERSION
      ? IMPULSE_RUNNER_NEW_EMERGENCY_STOP_PCT
      : IMPULSE_RUNNER_EMERGENCY_STOP_PCT;
  return persistedStopLossPct != null &&
    Number.isFinite(persistedStopLossPct) &&
    persistedStopLossPct > 0
    ? Math.min(emergencyStop, persistedStopLossPct)
    : emergencyStop;
}

export function resolveImpulseRunnerEmergencyStopPrice(
  entryPrice: number,
  persistedStopLossPct: number | null | undefined,
  entryPolicyVersion?: string | null,
): number {
  return (
    entryPrice *
    (1 -
      resolveImpulseRunnerEmergencyStopPct(
        persistedStopLossPct,
        entryPolicyVersion,
      ) /
        100)
  );
}

export function resolveImpulseRunnerTrailingStopPrice(input: {
  entryPrice: number;
  peakPrice: number;
  persistedTrailingStopLevel?: number | null;
}): number | null {
  if (
    !Number.isFinite(input.entryPrice) ||
    input.entryPrice <= 0 ||
    !Number.isFinite(input.peakPrice) ||
    input.peakPrice <= 0
  ) {
    return null;
  }
  const peakPnl =
    ((input.peakPrice - input.entryPrice) / input.entryPrice) * 100;
  if (peakPnl < IMPULSE_RUNNER_TRAILING_ACTIVATION_PCT) return null;
  const calculated =
    input.entryPrice * (1 + (peakPnl - IMPULSE_RUNNER_TRAILING_GAP_PCT) / 100);
  return Math.max(calculated, input.persistedTrailingStopLevel ?? 0);
}

export function resolveImpulseRunnerExitDecision(input: {
  entryPrice: number;
  currentPrice: number;
  peakPrice: number;
  persistedStopLossPct?: number | null;
  persistedTrailingStopLevel?: number | null;
  entryPolicyVersion?: string | null;
}): {
  hit: boolean;
  exitPrice: number | null;
  reason: "emergency_stop" | "trailing_stop" | null;
} {
  const emergencyStop = resolveImpulseRunnerEmergencyStopPrice(
    input.entryPrice,
    input.persistedStopLossPct,
    input.entryPolicyVersion,
  );
  const trailingStop = resolveImpulseRunnerTrailingStopPrice({
    entryPrice: input.entryPrice,
    peakPrice: input.peakPrice,
    persistedTrailingStopLevel: input.persistedTrailingStopLevel,
  });
  if (trailingStop != null && input.currentPrice <= trailingStop) {
    return {
      hit: true,
      exitPrice: trailingStop,
      reason: "trailing_stop",
    };
  }
  if (input.currentPrice <= emergencyStop) {
    return {
      hit: true,
      exitPrice: emergencyStop,
      reason: "emergency_stop",
    };
  }
  return { hit: false, exitPrice: null, reason: null };
}

export function impulseRunnerFinalStatus(
  _corePnlPercent: number,
  runnerPnlPercent: number,
): "profit" | "stop_loss" {
  return runnerPnlPercent >= 0 ? "profit" : "stop_loss";
}

export function impulseRunnerPnlPercent(
  originalEntryPrice: number,
  exitPrice: number,
): number {
  return originalEntryPrice > 0
    ? ((exitPrice - originalEntryPrice) / originalEntryPrice) * 100
    : 0;
}

export function resolveImpulseRunnerCanonicalAccounting(input: {
  originalEntryPrice: number | null | undefined;
  runnerExitPrice: number | null | undefined;
  peakPrice: number | null | undefined;
  runnerPeakPrice: number | null | undefined;
  persistedTrailingStopLevel?: number | null | undefined;
}): {
  runnerExitPrice: number;
  trailingStopLevel: number | null;
  pnlPercent: number;
  status: "profit" | "stop_loss";
  peakPrice: number;
} | null {
  const entry = Number(input.originalEntryPrice);
  const exit = Number(input.runnerExitPrice);
  if (
    !Number.isFinite(entry) ||
    entry <= 0 ||
    !Number.isFinite(exit) ||
    exit <= 0
  ) {
    return null;
  }
  const peak = Math.max(
    Number(input.peakPrice) > 0 ? Number(input.peakPrice) : 0,
    Number(input.runnerPeakPrice) > 0 ? Number(input.runnerPeakPrice) : 0,
    exit,
  );
  const persistedStop = Number(input.persistedTrailingStopLevel);
  if (
    Number.isFinite(persistedStop) &&
    persistedStop > 0 &&
    persistedStop > peak
  ) {
    return null;
  }
  const trailingStopLevel = resolveImpulseRunnerTrailingStopPrice({
    entryPrice: entry,
    peakPrice: peak,
    persistedTrailingStopLevel:
      Number.isFinite(persistedStop) && persistedStop > 0
        ? persistedStop
        : null,
  });
  const correctedExit = Math.max(exit, trailingStopLevel ?? exit);
  const pnlPercent = impulseRunnerPnlPercent(entry, correctedExit);
  return {
    runnerExitPrice: correctedExit,
    trailingStopLevel,
    pnlPercent,
    status: pnlPercent >= 0 ? "profit" : "stop_loss",
    peakPrice: peak,
  };
}

export function isImpulseRunnerCoreClosed(input: {
  policyVersion: string | null | undefined;
  coreClosedAt: Date | null | undefined;
  runnerState: string | null | undefined;
}): boolean {
  return (
    isImpulseRunnerPolicy(input.policyVersion) &&
    input.coreClosedAt != null &&
    input.runnerState === "open"
  );
}
