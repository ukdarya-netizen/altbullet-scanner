/**
 * Observational candidate: after the position first reaches +10% from entry,
 * protect +5% of profit with a fixed entry-anchored virtual stop.
 *
 * This module is intentionally pure. The live watcher never reads these
 * values to make an exit decision.
 */
export const PROFIT_LOCK_ACTIVATION_PCT = 10 as const;
export const PROFIT_LOCKED_PNL_PCT = 5 as const;
export const PROFIT_LOCK_FOLLOW_UPS = [
  { eventType: "6h", elapsedMs: 6 * 60 * 60_000 },
  { eventType: "24h", elapsedMs: 24 * 60 * 60_000 },
  { eventType: "72h", elapsedMs: 72 * 60 * 60_000 },
] as const;
export const PROFIT_LOCK_EV_MIN_COMPLETED_HITS = 20;

export type ProfitLockEventType =
  | "activated"
  | "hit"
  | "6h"
  | "24h"
  | "72h"
  | "close";

export interface ProfitLockEvEvent {
  signalId: number;
  sentimentKey: string;
  eventType: string;
  observedAt: Date | string;
  currentPnlPct: number | null;
  peakPnlPct: number | null;
  actualPnlPct: number | null;
}

export interface ProfitLockEvGroup {
  sentimentKey: string;
  activated: number;
  closed: number;
  open: number;
  virtualHits: number;
  completedVirtualHits: number;
  closedWithoutHit: number;
  followUps6h: number;
  followUps24h: number;
  followUps72h: number;
  trajectoryCoveragePct: number | null;
  averageActualPnl: number | null;
  averageCandidatePnl: number | null;
  totalActualPnl: number;
  totalCandidatePnl: number;
  totalDeltaPp: number;
  averageDeltaPp: number | null;
  helped: number;
  hurt: number;
  unchanged: number;
  lostUpsideCount: number;
  totalLostUpsidePp: number;
  averageLostUpsidePp: number | null;
  minimumCompletedHits: number;
  sufficient: boolean;
  recommendation:
    | "insufficient_sample"
    | "candidate_improves"
    | "candidate_hurts"
    | "neutral";
}

export interface ProfitLockEvAnalysis {
  minimumCompletedHits: number;
  summary: ProfitLockEvGroup;
  byPattern: ProfitLockEvGroup[];
  definition: string;
}

export interface ProfitLockObservationState {
  activated: boolean;
  currentPnlPct: number;
  peakPrice: number;
  peakPnlPct: number;
  lockedStopPrice: number;
  virtualHit: boolean;
}

export function resolveDirectionAwareProfitLockLevel(
  entryPrice: number,
  lockedProfitPct: number,
  isShort: boolean,
): number {
  return isShort
    ? entryPrice * (1 - lockedProfitPct / 100)
    : entryPrice * (1 + lockedProfitPct / 100);
}

export function isProfitLockActivated(
  peakPnlPct: number,
  activationPct = PROFIT_LOCK_ACTIVATION_PCT,
): boolean {
  return Number.isFinite(peakPnlPct) && peakPnlPct >= activationPct;
}

export function isDirectionAwareProfitLockHit(
  currentPrice: number,
  lockedStopPrice: number,
  isShort: boolean,
): boolean {
  return isShort
    ? currentPrice >= lockedStopPrice
    : currentPrice <= lockedStopPrice;
}

/**
 * Derives a shadow-only lifecycle state. Once an activation row exists, its
 * direction-aware peak is the durable source of truth; this avoids inheriting
 * the legacy long-oriented tracked `peakPrice` for short positions.
 */
export function resolveProfitLockObservationState(input: {
  entryPrice: number;
  currentPrice: number;
  isShort: boolean;
  trackedPeakPrice: number | null | undefined;
  activatedPeakPrice?: number | null;
}): ProfitLockObservationState {
  const currentPnlPct = input.isShort
    ? ((input.entryPrice - input.currentPrice) / input.entryPrice) * 100
    : ((input.currentPrice - input.entryPrice) / input.entryPrice) * 100;
  const peakPrice = input.isShort
    ? Math.min(
        input.activatedPeakPrice ?? input.trackedPeakPrice ?? input.entryPrice,
        input.currentPrice,
      )
    : Math.max(
        input.activatedPeakPrice ?? input.trackedPeakPrice ?? input.entryPrice,
        input.currentPrice,
      );
  const peakPnlPct = input.isShort
    ? ((input.entryPrice - peakPrice) / input.entryPrice) * 100
    : ((peakPrice - input.entryPrice) / input.entryPrice) * 100;
  const activated =
    input.activatedPeakPrice != null || isProfitLockActivated(peakPnlPct);
  const lockedStopPrice = resolveDirectionAwareProfitLockLevel(
    input.entryPrice,
    PROFIT_LOCKED_PNL_PCT,
    input.isShort,
  );

  return {
    activated,
    currentPnlPct,
    peakPrice,
    peakPnlPct,
    lockedStopPrice,
    virtualHit:
      activated &&
      isDirectionAwareProfitLockHit(
        input.currentPrice,
        lockedStopPrice,
        input.isShort,
      ),
  };
}

function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function toTimestamp(value: Date | string): number | null {
  const timestamp = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

type SignalProfitLockLifecycle = {
  signalId: number;
  sentimentKey: string;
  activatedAt: number | null;
  hitAt: number | null;
  actualPnl: number | null;
  closedAt: number | null;
  followUps: Set<ProfitLockEventType>;
};

function summarizeProfitLockGroup(
  sentimentKey: string,
  lifecycles: SignalProfitLockLifecycle[],
): ProfitLockEvGroup {
  const closed = lifecycles.filter(
    (lifecycle) =>
      lifecycle.closedAt != null &&
      lifecycle.actualPnl != null &&
      Number.isFinite(lifecycle.actualPnl),
  );
  const isCompletedHit = (lifecycle: SignalProfitLockLifecycle) =>
    lifecycle.hitAt != null &&
    lifecycle.closedAt != null &&
    lifecycle.hitAt <= lifecycle.closedAt;
  const hit = lifecycles.filter((lifecycle) => lifecycle.hitAt != null);
  const completedHit = closed.filter(isCompletedHit);
  const actualPnls = closed.map((lifecycle) => lifecycle.actualPnl!);
  const candidatePnls = closed.map((lifecycle) =>
    isCompletedHit(lifecycle) ? PROFIT_LOCKED_PNL_PCT : lifecycle.actualPnl!,
  );
  const deltas = candidatePnls.map(
    (candidatePnl, index) => candidatePnl - actualPnls[index],
  );
  const lostUpsides = completedHit
    .map((lifecycle) => lifecycle.actualPnl! - PROFIT_LOCKED_PNL_PCT)
    .filter((delta) => delta > 0);
  const totalActualPnl = actualPnls.reduce((sum, value) => sum + value, 0);
  const totalCandidatePnl = candidatePnls.reduce(
    (sum, value) => sum + value,
    0,
  );
  const totalDeltaPp = totalCandidatePnl - totalActualPnl;
  const completedVirtualHits = completedHit.length;
  const sufficient = completedVirtualHits >= PROFIT_LOCK_EV_MIN_COMPLETED_HITS;
  const recommendation: ProfitLockEvGroup["recommendation"] = !sufficient
    ? "insufficient_sample"
    : totalDeltaPp > 0.05
      ? "candidate_improves"
      : totalDeltaPp < -0.05
        ? "candidate_hurts"
        : "neutral";

  return {
    sentimentKey,
    activated: lifecycles.length,
    closed: closed.length,
    open: lifecycles.length - closed.length,
    virtualHits: hit.length,
    completedVirtualHits,
    closedWithoutHit: closed.length - completedVirtualHits,
    followUps6h: hit.filter((lifecycle) => lifecycle.followUps.has("6h"))
      .length,
    followUps24h: hit.filter((lifecycle) => lifecycle.followUps.has("24h"))
      .length,
    followUps72h: hit.filter((lifecycle) => lifecycle.followUps.has("72h"))
      .length,
    trajectoryCoveragePct:
      completedVirtualHits > 0
        ? round(
            (completedHit.filter((lifecycle) => lifecycle.followUps.has("72h"))
              .length /
              completedVirtualHits) *
              100,
            1,
          )
        : null,
    averageActualPnl:
      closed.length > 0 ? round(totalActualPnl / closed.length) : null,
    averageCandidatePnl:
      closed.length > 0 ? round(totalCandidatePnl / closed.length) : null,
    totalActualPnl: round(totalActualPnl),
    totalCandidatePnl: round(totalCandidatePnl),
    totalDeltaPp: round(totalDeltaPp),
    averageDeltaPp:
      closed.length > 0 ? round(totalDeltaPp / closed.length) : null,
    helped: deltas.filter((delta) => delta > 0.05).length,
    hurt: deltas.filter((delta) => delta < -0.05).length,
    unchanged: deltas.filter((delta) => Math.abs(delta) <= 0.05).length,
    lostUpsideCount: lostUpsides.length,
    totalLostUpsidePp: round(
      lostUpsides.reduce((sum, value) => sum + value, 0),
    ),
    averageLostUpsidePp:
      lostUpsides.length > 0
        ? round(
            lostUpsides.reduce((sum, value) => sum + value, 0) /
              lostUpsides.length,
          )
        : null,
    minimumCompletedHits: PROFIT_LOCK_EV_MIN_COMPLETED_HITS,
    sufficient,
    recommendation,
  };
}

/**
 * Counterfactual for every observed +10% activation. If the fixed +5% level
 * was hit before the real close, candidate PnL is +5%; otherwise it preserves
 * the actual close. The active-pattern allowlist prevents legacy history from
 * leaking into user-facing recommendations.
 */
export function buildProfitLockEvAnalysis(
  events: readonly ProfitLockEvEvent[],
  activePatternKeys: readonly string[],
): ProfitLockEvAnalysis {
  const activePatterns = new Set(activePatternKeys);
  const lifecycles = new Map<number, SignalProfitLockLifecycle>();

  for (const event of events) {
    if (!activePatterns.has(event.sentimentKey)) continue;
    const timestamp = toTimestamp(event.observedAt);
    if (timestamp == null) continue;
    const existing = lifecycles.get(event.signalId) ?? {
      signalId: event.signalId,
      sentimentKey: event.sentimentKey,
      activatedAt: null,
      hitAt: null,
      actualPnl: null,
      closedAt: null,
      followUps: new Set<ProfitLockEventType>(),
    };
    if (event.eventType === "activated") {
      existing.activatedAt =
        existing.activatedAt == null
          ? timestamp
          : Math.min(existing.activatedAt, timestamp);
    } else if (event.eventType === "hit") {
      existing.hitAt =
        existing.hitAt == null
          ? timestamp
          : Math.min(existing.hitAt, timestamp);
    } else if (event.eventType === "close") {
      existing.closedAt =
        existing.closedAt == null
          ? timestamp
          : Math.min(existing.closedAt, timestamp);
      existing.actualPnl =
        event.actualPnlPct != null && Number.isFinite(event.actualPnlPct)
          ? event.actualPnlPct
          : null;
    } else if (
      event.eventType === "6h" ||
      event.eventType === "24h" ||
      event.eventType === "72h"
    ) {
      existing.followUps.add(event.eventType);
    }
    lifecycles.set(event.signalId, existing);
  }

  const activated = [...lifecycles.values()].filter(
    (lifecycle) =>
      lifecycle.activatedAt != null &&
      (lifecycle.hitAt == null || lifecycle.hitAt >= lifecycle.activatedAt) &&
      (lifecycle.closedAt == null ||
        lifecycle.closedAt >= lifecycle.activatedAt),
  );
  const byPattern = activePatternKeys.map((sentimentKey) =>
    summarizeProfitLockGroup(
      sentimentKey,
      activated.filter((lifecycle) => lifecycle.sentimentKey === sentimentKey),
    ),
  );

  return {
    minimumCompletedHits: PROFIT_LOCK_EV_MIN_COMPLETED_HITS,
    summary: summarizeProfitLockGroup("all", activated),
    byPattern,
    definition:
      "Counterfactual включает все позиции после наблюдаемой активации +10%. Если виртуальный уровень +5% был задет до фактического закрытия, сценарий фиксирует +5%; иначе сохраняется фактический PnL. 72h coverage описывает полноту дальнейшей траектории и не используется для восстановления порядка пропущенных тиков. Вывод доступен только после 20 завершённых виртуальных срабатываний и не меняет live-выходы.",
  };
}
