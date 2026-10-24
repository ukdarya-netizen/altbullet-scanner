export const LC_OB_HYPOTHESIS_VERSION = 1;
export const LC_OB_FIFTEEN_MINUTES = 15 * 60_000;
export const LC_OB_DAY_MS = 24 * 60 * 60_000;
export const LC_OB_MAX_FOLLOWUP_MS = 48 * 60 * 60_000;

export type ObProximity =
  | "inside_or_within_1pct"
  | "between_1_2pct"
  | "beyond_2pct"
  | "no_zone"
  | "unavailable";

export type NumericCandle = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
};

export type ObHypothesisForEvaluation = {
  version: number;
  status: string;
  zone?: { high: number; low: number } | null;
};

export type ObZoneCandidate = {
  high: number;
  low: number;
  timeframe: "1h" | "4h";
  createdAt: number;
  detectedAt: number;
};

export type FrozenObResult = {
  status: "available" | "no_zone" | "unavailable";
  zone: ObZoneCandidate | null;
  distancePct: number | null;
  insideZone: boolean;
  proximity: ObProximity;
};

export type ObCohortInput = {
  proximity?: unknown;
  detectedAt: number;
  trackerFinalStatus: string | null;
  trackerFinalPnl: number | string | null;
  originalEntryComparison?: Record<string, unknown> | null;
};

export type ObCohortSummary = {
  total: number;
  known: number;
  open: number;
  unknown: number;
  pending: number;
  realizedPnlUnknown: number;
  finalizedWithPnl: number;
  realizedAtOrBelow8: number;
  realizedAbove8: number;
  realizedAbove10: number;
  exactStopLossCount: number;
  medianTimeToPlus8Minutes: number | null;
  medianTimeToPlus10Minutes: number | null;
};

export function classifyMissedStrongWinner(
  decision: string,
  followupOutcome: string | null | undefined,
  followupStatus: string | null | undefined,
  trackerFinalStatus: string | null,
  trackerFinalPnl: number | string | null,
): "missed" | "pending" | "not_missed" {
  const trackerOpen =
    trackerFinalStatus === null ||
    ["active", "in_run"].includes(trackerFinalStatus);
  const pnl = trackerFinalPnl == null ? NaN : Number(trackerFinalPnl);
  const realizedKnown = !trackerOpen && Number.isFinite(pnl);
  const realizedStrong = realizedKnown && pnl > 10;
  const isNoTarget = decision === "no_target";
  const waitNoTouch =
    decision === "wait" &&
    (followupOutcome === "no_touch" ||
      followupOutcome === "expired" ||
      followupStatus === "expired");
  if (isNoTarget || waitNoTouch) {
    if (realizedStrong) return "missed";
    return realizedKnown ? "not_missed" : "pending";
  }
  if (
    decision === "wait" &&
    ["pending", "touched", "unknown"].includes(String(followupOutcome))
  ) {
    return "pending";
  }
  return "not_missed";
}

export type ObFollowupResult = {
  followup: Record<string, unknown>;
  originalEntryComparison: Record<string, unknown>;
};

function reachedAbove(price: number, threshold: number): boolean {
  return price >= threshold - Math.abs(threshold) * 1e-12;
}

function reachedBelow(price: number, threshold: number): boolean {
  return price <= threshold + Math.abs(threshold) * 1e-12;
}

export function classifyObProximity(
  distancePct: number | null,
  insideZone = false,
): ObProximity {
  if (insideZone) return "inside_or_within_1pct";
  if (distancePct === null || !Number.isFinite(distancePct))
    return "unavailable";
  if (distancePct <= 1) return "inside_or_within_1pct";
  if (distancePct <= 2) return "between_1_2pct";
  return "beyond_2pct";
}

export function obPolicyDecision(
  distancePct: number | null,
  thresholdPct: 1 | 2,
  hasZone: boolean,
  insideZone = false,
): "enter_now" | "wait" | "no_target" {
  if (!hasZone || distancePct === null || !Number.isFinite(distancePct))
    return "no_target";
  if (insideZone || distancePct <= thresholdPct) return "enter_now";
  if (distancePct <= 10) return "wait";
  return "no_target";
}

export function obPolicyDecisionWithAvailability(
  distancePct: number | null,
  thresholdPct: 1 | 2,
  hasZone: boolean,
  bothTimeframesAvailable: boolean,
  insideZone = false,
): "enter_now" | "wait" | "no_target" | "unavailable" {
  if (!bothTimeframesAvailable && !hasZone) return "unavailable";
  const decision = obPolicyDecision(
    distancePct,
    thresholdPct,
    hasZone,
    insideZone,
  );
  return !bothTimeframesAvailable && decision !== "enter_now"
    ? "unavailable"
    : decision;
}

export function resolveFrozenOb(
  entry: number,
  candidate: ObZoneCandidate | undefined,
  bothTimeframesAvailable: boolean,
): FrozenObResult {
  if (!candidate) {
    return {
      status: bothTimeframesAvailable ? "no_zone" : "unavailable",
      zone: null,
      distancePct: null,
      insideZone: false,
      proximity: bothTimeframesAvailable ? "no_zone" : "unavailable",
    };
  }
  const insideZone = candidate.low <= entry && candidate.high >= entry;
  const distancePct = ((entry - candidate.high) / entry) * 100;
  const confidentlyNear = insideZone || distancePct <= 2;
  if (!bothTimeframesAvailable && !confidentlyNear) {
    return {
      status: "unavailable",
      zone: null,
      distancePct: null,
      insideZone: false,
      proximity: "unavailable",
    };
  }
  return {
    status: "available",
    zone: candidate,
    distancePct,
    insideZone,
    proximity:
      bothTimeframesAvailable || insideZone || distancePct <= 1
        ? classifyObProximity(distancePct, insideZone)
        : "unavailable",
  };
}

export function summarizeObCohorts(
  rows: ObCohortInput[],
): Record<ObProximity, ObCohortSummary> {
  const keys: ObProximity[] = [
    "inside_or_within_1pct",
    "between_1_2pct",
    "beyond_2pct",
    "no_zone",
    "unavailable",
  ];
  const cohorts = Object.fromEntries(
    keys.map((key) => [
      key,
      {
        total: 0,
        known: 0,
        open: 0,
        unknown: 0,
        pending: 0,
        realizedPnlUnknown: 0,
        finalizedWithPnl: 0,
        realizedAtOrBelow8: 0,
        realizedAbove8: 0,
        realizedAbove10: 0,
        exactStopLossCount: 0,
        plus8Times: [] as number[],
        plus10Times: [] as number[],
      },
    ]),
  ) as Record<
    ObProximity,
    Omit<
      ObCohortSummary,
      "medianTimeToPlus8Minutes" | "medianTimeToPlus10Minutes"
    > & { plus8Times: number[]; plus10Times: number[] }
  >;
  for (const row of rows) {
    const key = keys.includes(row.proximity as ObProximity)
      ? (row.proximity as ObProximity)
      : "unavailable";
    const cohort = cohorts[key];
    cohort.total += 1;
    const comparison = row.originalEntryComparison;
    if (comparison?.status === "completed") {
      cohort.known += 1;
      for (const [statusKey, timeKey, times] of [
        ["firstPlus8Status", "firstPlus8At", cohort.plus8Times],
        ["firstPlus10Status", "firstPlus10At", cohort.plus10Times],
      ] as const) {
        const rawTime = comparison[timeKey];
        const time = rawTime == null ? NaN : Number(rawTime);
        if (
          comparison[statusKey] === "hit" &&
          Number.isFinite(time) &&
          time >= row.detectedAt
        ) {
          times.push((time - row.detectedAt) / 60_000);
        }
      }
    } else if (comparison?.status === "pending") {
      cohort.pending += 1;
    } else {
      cohort.unknown += 1;
    }

    const finalStatus = row.trackerFinalStatus;
    const open =
      finalStatus === null || ["active", "in_run"].includes(finalStatus);
    if (open) cohort.open += 1;
    if (finalStatus === "stop_loss") cohort.exactStopLossCount += 1;
    if (open) continue;

    const pnl = row.trackerFinalPnl == null ? NaN : Number(row.trackerFinalPnl);
    if (!Number.isFinite(pnl)) {
      cohort.realizedPnlUnknown += 1;
      continue;
    }
    cohort.finalizedWithPnl += 1;
    if (pnl <= 8) cohort.realizedAtOrBelow8 += 1;
    if (pnl > 8) cohort.realizedAbove8 += 1;
    if (pnl > 10) cohort.realizedAbove10 += 1;
  }

  const median = (values: number[]) => {
    if (!values.length) return null;
    const sorted = [...values].sort((left, right) => left - right);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2
      ? sorted[middle]!
      : (sorted[middle - 1]! + sorted[middle]!) / 2;
  };
  return Object.fromEntries(
    keys.map((key) => {
      const { plus8Times, plus10Times, ...cohort } = cohorts[key];
      return [
        key,
        {
          ...cohort,
          medianTimeToPlus8Minutes: median(plus8Times),
          medianTimeToPlus10Minutes: median(plus10Times),
        },
      ];
    }),
  ) as Record<ObProximity, ObCohortSummary>;
}

export function hasCompleteObCoverage(
  candles: NumericCandle[],
  start: number,
  end: number,
): boolean {
  if (end <= start) return false;
  const firstExpected =
    Math.ceil(start / LC_OB_FIFTEEN_MINUTES) * LC_OB_FIFTEEN_MINUTES;
  const lastExpected =
    Math.floor((end - LC_OB_FIFTEEN_MINUTES) / LC_OB_FIFTEEN_MINUTES) *
    LC_OB_FIFTEEN_MINUTES;
  if (lastExpected < firstExpected) return false;
  const times = new Set(candles.map((candle) => candle.time));
  for (
    let time = firstExpected;
    time <= lastExpected;
    time += LC_OB_FIFTEEN_MINUTES
  ) {
    if (!times.has(time)) return false;
  }
  return true;
}

function thresholdResult(
  candles: NumericCandle[],
  coverageStart: number,
  deadline: number,
  now: number,
  value: number,
  direction: "up" | "down",
  stopValue: number | null,
  overallCoverageComplete: boolean,
  forceUnknownAt: number,
): {
  at: number | null;
  status: "hit" | "stopped" | "not_hit" | "pending" | "unknown";
} {
  const scoped = candles.filter(
    (candle) =>
      candle.time >= coverageStart &&
      candle.time + LC_OB_FIFTEEN_MINUTES <= deadline,
  );
  const event = scoped.find(
    (candle) =>
      (direction === "up"
        ? reachedAbove(candle.high, value)
        : reachedBelow(candle.low, value)) ||
      (stopValue !== null &&
        (direction === "up"
          ? reachedBelow(candle.low, stopValue)
          : reachedAbove(candle.high, stopValue))),
  );
  if (event) {
    if (
      !hasCompleteObCoverage(
        candles,
        coverageStart,
        event.time + LC_OB_FIFTEEN_MINUTES,
      )
    ) {
      return { at: null, status: "unknown" };
    }
    const targetHit =
      direction === "up"
        ? reachedAbove(event.high, value)
        : reachedBelow(event.low, value);
    const stopHit =
      stopValue !== null &&
      (direction === "up"
        ? reachedBelow(event.low, stopValue)
        : reachedAbove(event.high, stopValue));
    if (stopHit) return { at: null, status: "stopped" };
    if (targetHit)
      return {
        at: event.time + LC_OB_FIFTEEN_MINUTES,
        status: "hit",
      };
  }
  if (overallCoverageComplete) return { at: null, status: "not_hit" };
  return {
    at: null,
    status: now >= forceUnknownAt ? "unknown" : "pending",
  };
}

export function evaluateObFollowup(
  candles: NumericCandle[],
  detectedAt: number,
  entry: number,
  hypothesis: ObHypothesisForEvaluation | undefined,
  now: number,
): ObFollowupResult {
  const postSignalStart =
    Math.floor(detectedAt / LC_OB_FIFTEEN_MINUTES) * LC_OB_FIFTEEN_MINUTES +
    LC_OB_FIFTEEN_MINUTES;
  const originalDeadline = detectedAt + LC_OB_DAY_MS;
  const finalDeadline = detectedAt + LC_OB_MAX_FOLLOWUP_MS;
  const originalCoverageComplete =
    now >= originalDeadline &&
    hasCompleteObCoverage(candles, postSignalStart, originalDeadline);
  const originalWindow = candles.filter(
    (candle) =>
      candle.time >= postSignalStart &&
      candle.time + LC_OB_FIFTEEN_MINUTES <= originalDeadline,
  );
  const originalPlus8 = thresholdResult(
    originalWindow,
    postSignalStart,
    originalDeadline,
    now,
    entry * 1.08,
    "up",
    entry * 0.9,
    originalCoverageComplete,
    finalDeadline,
  );
  const originalPlus10 = thresholdResult(
    originalWindow,
    postSignalStart,
    originalDeadline,
    now,
    entry * 1.1,
    "up",
    entry * 0.9,
    originalCoverageComplete,
    finalDeadline,
  );
  const originalMinus10 = thresholdResult(
    originalWindow,
    postSignalStart,
    originalDeadline,
    now,
    entry * 0.9,
    "down",
    null,
    originalCoverageComplete,
    finalDeadline,
  );
  const originalEntryComparison = {
    status: originalCoverageComplete
      ? "completed"
      : now >= finalDeadline
        ? "unknown"
        : "pending",
    firstPlus8At: originalPlus8.at,
    firstPlus8Status: originalPlus8.status,
    firstPlus10At: originalPlus10.at,
    firstPlus10Status: originalPlus10.status,
    firstMinus10At: originalMinus10.at,
    firstMinus10Status: originalMinus10.status,
    peakPct24h:
      originalCoverageComplete && originalWindow.length
        ? (Math.max(...originalWindow.map((candle) => candle.high)) / entry -
            1) *
          100
        : null,
    coverageEnd: Math.min(now, originalDeadline),
  };

  if (!hypothesis || hypothesis.version !== LC_OB_HYPOTHESIS_VERSION) {
    return {
      followup: { status: "unknown", outcome: "unknown" },
      originalEntryComparison,
    };
  }
  const zone = hypothesis.zone;
  if (hypothesis.status !== "available" || !zone) {
    return {
      followup: {
        status: hypothesis.status === "no_zone" ? "no_zone" : "unavailable",
        outcome: "unknown",
      },
      originalEntryComparison,
    };
  }

  const firstTouchCandle = candles.find(
    (candle) =>
      candle.time >= postSignalStart &&
      candle.time + LC_OB_FIFTEEN_MINUTES <= originalDeadline &&
      candle.low <= zone.high,
  );
  if (firstTouchCandle) {
    const touchAt = firstTouchCandle.time + LC_OB_FIFTEEN_MINUTES;
    if (!hasCompleteObCoverage(candles, postSignalStart, touchAt)) {
      return {
        followup: {
          status: "unknown",
          outcome: "unknown",
          touchAt: null,
          candidateTouchAt: touchAt,
          invalidatedAt: null,
          invalidationStatus: "unknown",
          targetPrice: zone.high,
          zoneLow: zone.low,
          fillPrice: zone.high,
          coverageComplete: false,
          reason: "history_gap_before_first_touch",
        },
        originalEntryComparison,
      };
    }
    const fillDeadline = touchAt + LC_OB_DAY_MS;
    const outcomeCoverageComplete =
      now >= fillDeadline &&
      hasCompleteObCoverage(candles, touchAt, fillDeadline);
    const outcomeUnknown = now >= fillDeadline && !outcomeCoverageComplete;
    const postTouch = candles.filter(
      (candle) =>
        candle.time > firstTouchCandle.time &&
        candle.time + LC_OB_FIFTEEN_MINUTES <= fillDeadline,
    );
    const stopCandle = postTouch.find((candle) =>
      reachedBelow(candle.low, zone.high * 0.9),
    );
    const plus8Candle = postTouch.find((candle) =>
      reachedAbove(candle.high, zone.high * 1.08),
    );
    const plus10Candle = postTouch.find((candle) =>
      reachedAbove(candle.high, zone.high * 1.1),
    );
    const exitResult = (targetCandle: NumericCandle | undefined) => {
      const firstEvent =
        !targetCandle || (stopCandle && stopCandle.time <= targetCandle.time)
          ? stopCandle
          : targetCandle;
      if (!firstEvent) {
        return {
          at: null,
          status: outcomeCoverageComplete
            ? "not_hit"
            : now >= finalDeadline
              ? "unknown"
              : "pending",
        };
      }
      if (
        !hasCompleteObCoverage(
          candles,
          touchAt,
          firstEvent.time + LC_OB_FIFTEEN_MINUTES,
        )
      ) {
        return { at: null, status: "unknown" };
      }
      if (firstEvent === stopCandle) return { at: null, status: "stopped" };
      return {
        at: firstEvent.time + LC_OB_FIFTEEN_MINUTES,
        status: "hit",
      };
    };
    const invalidationCandle = candles.find(
      (candle) =>
        candle.time > firstTouchCandle.time &&
        candle.time + LC_OB_FIFTEEN_MINUTES <= fillDeadline &&
        candle.close < zone.low - Math.abs(zone.low) * 1e-12,
    );
    const invalidationKnown =
      invalidationCandle !== undefined &&
      hasCompleteObCoverage(
        candles,
        touchAt,
        invalidationCandle.time + LC_OB_FIFTEEN_MINUTES,
      );
    const invalidationStatus = invalidationKnown
      ? "invalidated"
      : outcomeCoverageComplete
        ? "not_invalidated"
        : now >= finalDeadline
          ? "unknown"
          : "pending";
    const plus8Result = exitResult(plus8Candle);
    const plus10Result = exitResult(plus10Candle);
    const stopKnown =
      stopCandle !== undefined &&
      hasCompleteObCoverage(
        candles,
        touchAt,
        stopCandle.time + LC_OB_FIFTEEN_MINUTES,
      );
    const stopStatus = stopKnown
      ? "hit"
      : outcomeCoverageComplete
        ? "not_hit"
        : now >= finalDeadline
          ? "unknown"
          : "pending";
    const resultStatus = outcomeCoverageComplete
      ? "completed"
      : outcomeUnknown
        ? "unknown"
        : "touched";
    return {
      followup: {
        status: resultStatus,
        outcome: resultStatus,
        touchAt,
        invalidatedAt: invalidationKnown
          ? invalidationCandle!.time + LC_OB_FIFTEEN_MINUTES
          : null,
        invalidationStatus,
        targetPrice: zone.high,
        zoneLow: zone.low,
        fillPrice: zone.high,
        firstPlus8At: plus8Result.at,
        firstPlus8Status: plus8Result.status,
        firstPlus10At: plus10Result.at,
        firstPlus10Status: plus10Result.status,
        firstMinus10At: stopKnown
          ? stopCandle!.time + LC_OB_FIFTEEN_MINUTES
          : null,
        firstMinus10Status: stopStatus,
        coverageComplete: outcomeCoverageComplete,
        fillWindowDeadline: fillDeadline,
      },
      originalEntryComparison,
    };
  }

  const noTouchComplete =
    now >= originalDeadline &&
    hasCompleteObCoverage(candles, postSignalStart, originalDeadline);
  const noTouchUnknown = now >= originalDeadline && !noTouchComplete;
  return {
    followup: {
      status: noTouchComplete
        ? "completed"
        : noTouchUnknown
          ? "unknown"
          : "pending",
      outcome: noTouchComplete
        ? "no_touch"
        : noTouchUnknown
          ? "unknown"
          : "pending",
      touchAt: null,
      invalidatedAt: null,
      invalidationStatus: noTouchComplete ? "not_applicable" : "pending",
      targetPrice: zone.high,
      zoneLow: zone.low,
      firstPlus8At: null,
      firstPlus8Status: noTouchComplete ? "not_applicable" : "pending",
      firstPlus10At: null,
      firstPlus10Status: noTouchComplete ? "not_applicable" : "pending",
      firstMinus10At: null,
      coverageComplete: noTouchComplete,
    },
    originalEntryComparison,
  };
}

export function isObHypothesisTerminal(
  hypothesis: Record<string, unknown> | undefined,
  detectedAt: number,
  now: number,
): boolean {
  if (!hypothesis || hypothesis.version !== LC_OB_HYPOTHESIS_VERSION)
    return true;
  const comparison = hypothesis.originalEntryComparison as
    | Record<string, unknown>
    | undefined;
  const followup = hypothesis.followup as Record<string, unknown> | undefined;
  const comparisonTerminal =
    comparison?.status === "completed" ||
    (comparison?.status === "unknown" &&
      now >= detectedAt + LC_OB_MAX_FOLLOWUP_MS);
  const followupTerminal =
    hypothesis.status === "no_zone" ||
    hypothesis.status === "unavailable" ||
    followup?.status === "completed" ||
    (followup?.status === "unknown" &&
      now >= detectedAt + LC_OB_MAX_FOLLOWUP_MS);
  return comparisonTerminal && followupTerminal;
}
