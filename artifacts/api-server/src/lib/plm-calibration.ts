import { PLM_MAX_PRICE_3H, PLM_MIN_SPOT_VOL_MULT } from "./scanner-patterns.js";

export const PLM_P24H_SHADOW_CAP = 18;
export const PLM_MIN_COMPLETED_OUTCOMES = 20;
export const PLM_MIN_COMPLETED_PER_TAKER_RANGE = 20;
export const PLM_FUT_TAKER_SHADOW_CLASSES = [
  "below_20",
  "at_or_above_20",
  "unavailable",
] as const;
export type PlmFutTakerShadowClass =
  (typeof PLM_FUT_TAKER_SHADOW_CLASSES)[number];
export const PLM_OI30M_SHADOW_CLASSES = [
  "below_2",
  "at_or_above_2",
  "unavailable",
] as const;
export type PlmOi30mShadowClass = (typeof PLM_OI30M_SHADOW_CLASSES)[number];

export type PlmCalibrationRow = {
  signalType: string | null;
  alphaScore: number | null;
  status: string;
  entryPrice?: number | null;
  peakPrice?: number | null;
  price24hAtFire: number | null;
  entryPrice3h: number | null;
  entryOi30m: number | null;
  entryOi1h?: number | null;
  entryOi4h?: number | null;
  entryPrice1h?: number | null;
  plmP24hCap18Pass: boolean | null;
  entryScoreBreakdown: string | null;
  entryGradeReason: string | null;
  plmFutTakerShadow?: string | null;
  plmOi30mShadow?: string | null;
  entryFutTakerNetBuy?: number | null;
  pnlPercent?: number | null;
  detectedAt?: Date | string | null;
  closedAt?: Date | string | null;
  entrySpotVolMult?: number | null;
};

const COMPLETED = new Set([
  "profit",
  "stop_loss",
  "bu_stop",
  "breakeven",
  "expired",
  "cancelled",
]);

const OPEN = new Set(["active", "in_run"]);

function summarizeTakerClass(
  rows: PlmCalibrationRow[],
  shadowClass: PlmFutTakerShadowClass,
) {
  const cohort = rows.filter((row) => row.plmFutTakerShadow === shadowClass);
  return summarizeTakerRows(cohort, shadowClass);
}

function summarizeOi30mClass(
  rows: PlmCalibrationRow[],
  shadowClass: PlmOi30mShadowClass,
) {
  return summarizeTakerRows(
    rows.filter((row) => row.plmOi30mShadow === shadowClass),
    shadowClass,
  );
}

function summarizeTakerRows(
  cohort: PlmCalibrationRow[],
  key: string,
  minimumCompletedOutcomes = PLM_MIN_COMPLETED_OUTCOMES,
) {
  const completed = cohort.filter((row) => COMPLETED.has(row.status));
  const rawPnlRows = completed.filter(
    (row) => row.pnlPercent != null && Number.isFinite(row.pnlPercent),
  );
  const netRawPnl = rawPnlRows.reduce((sum, row) => sum + row.pnlPercent!, 0);
  const countStatus = (status: string) =>
    completed.filter((row) => row.status === status).length;
  return {
    key,
    total: cohort.length,
    open: cohort.filter((row) => OPEN.has(row.status)).length,
    completed: completed.length,
    other: cohort.filter(
      (row) => !OPEN.has(row.status) && !COMPLETED.has(row.status),
    ).length,
    outcomes: {
      profit: countStatus("profit"),
      stopLoss: countStatus("stop_loss"),
      buStop: countStatus("bu_stop"),
      breakeven: countStatus("breakeven"),
      expired: countStatus("expired"),
      cancelled: countStatus("cancelled"),
    },
    rawPnlCount: rawPnlRows.length,
    netRawPnl,
    averageRawPnl: rawPnlRows.length > 0 ? netRawPnl / rawPnlRows.length : null,
    minimumCompletedOutcomes,
    sufficient: completed.length >= minimumCompletedOutcomes,
  };
}

function rate(numerator: number, denominator: number): number | null {
  return denominator > 0 ? (numerator / denominator) * 100 : null;
}

function rawPnlSummary(rows: PlmCalibrationRow[]) {
  const measured = rows.filter(
    (row) => row.pnlPercent != null && Number.isFinite(row.pnlPercent),
  );
  const net = measured.reduce((sum, row) => sum + row.pnlPercent!, 0);
  return {
    count: measured.length,
    net,
    average: measured.length > 0 ? net / measured.length : null,
  };
}

function peakPnl(row: PlmCalibrationRow): number | null {
  if (
    row.entryPrice == null ||
    row.peakPrice == null ||
    !Number.isFinite(row.entryPrice) ||
    !Number.isFinite(row.peakPrice) ||
    row.entryPrice <= 0
  ) {
    return null;
  }
  return ((row.peakPrice - row.entryPrice) / row.entryPrice) * 100;
}

const LIVE_PLM = {
  p24hMin: 5,
  p24hMax: 15,
  p3hMin: 1.5,
  p3hMax: PLM_MAX_PRICE_3H,
  spotVolMin: PLM_MIN_SPOT_VOL_MULT,
  missingSpotVol: "reject" as const,
};

function summarizeLiveRows(rows: PlmCalibrationRow[]) {
  const measured = rows.filter(
    (row) => row.pnlPercent != null && Number.isFinite(row.pnlPercent),
  );
  const net = measured.reduce((sum, row) => sum + row.pnlPercent!, 0);
  const outcomes = Object.fromEntries(
    ["profit", "stop_loss", "bu_stop", "breakeven", "expired", "cancelled"].map(
      (status) => [status, rows.filter((row) => row.status === status).length],
    ),
  );
  return {
    total: rows.length,
    terminal: rows.filter((row) => COMPLETED.has(row.status)).length,
    outcomes,
    pnlCount: measured.length,
    netPnl: net,
    averagePnl: measured.length > 0 ? net / measured.length : null,
  };
}

function chronologicalHalfSummary(rows: PlmCalibrationRow[]) {
  const ordered = [...rows].sort(
    (a, b) =>
      new Date(a.detectedAt ?? 0).getTime() -
      new Date(b.detectedAt ?? 0).getTime(),
  );
  const midpoint = Math.ceil(ordered.length / 2);
  return [ordered.slice(0, midpoint), ordered.slice(midpoint)].map((half) => ({
    retained: half.length,
    terminal: half.filter((row) => COMPLETED.has(row.status)).length,
    stops: half.filter((row) => row.status === "stop_loss").length,
    averagePnl: summarizeLiveRows(half).averagePnl,
  }));
}

function deriveOverlap(
  rows: PlmCalibrationRow[],
  analysisCutoff: number | null,
) {
  const events: Array<[number, number]> = [];
  const validRows = rows
    .map((row) => ({
      row,
      start: row.detectedAt ? new Date(row.detectedAt).getTime() : NaN,
      close: row.closedAt ? new Date(row.closedAt).getTime() : NaN,
    }))
    .filter(
      (value) =>
        analysisCutoff != null &&
        Number.isFinite(value.start) &&
        value.start <= analysisCutoff &&
        (value.row.closedAt == null || Number.isFinite(value.close)),
    );
  const measuredSignals = validRows.length;
  const openAtCutoff = validRows.filter(
    ({ row, start }) =>
      row.closedAt == null &&
      start < (analysisCutoff ?? Number.NEGATIVE_INFINITY),
  ).length;
  for (const row of rows) {
    const start = row.detectedAt ? new Date(row.detectedAt).getTime() : NaN;
    const close = row.closedAt ? new Date(row.closedAt).getTime() : NaN;
    if (
      analysisCutoff != null &&
      Number.isFinite(start) &&
      start <= analysisCutoff
    ) {
      if (row.closedAt != null && !Number.isFinite(close)) continue;
      const end =
        row.closedAt == null ? analysisCutoff : Math.min(close, analysisCutoff);
      if (end >= start) events.push([start, 1], [end, -1]);
    }
  }
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let active = 0;
  let max = 0;
  let weighted = 0;
  let previous: number | null = null;
  for (const [at, delta] of events) {
    if (previous !== null && at > previous)
      weighted += active * (at - previous);
    active += delta;
    max = Math.max(max, active);
    previous = at;
  }
  const span =
    events.length > 1 ? events[events.length - 1]![0] - events[0]![0] : 0;
  return {
    measuredSignals,
    openAtCutoff,
    maxConcurrent: events.length > 0 ? max : 0,
    averageConcurrent: span > 0 ? weighted / span : 0,
  };
}

function evaluateLivePolicy(rows: PlmCalibrationRow[]) {
  const evaluated = rows.filter(
    (row) =>
      row.price24hAtFire != null &&
      row.entryPrice3h != null &&
      row.entrySpotVolMult != null &&
      Number.isFinite(row.price24hAtFire) &&
      Number.isFinite(row.entryPrice3h) &&
      Number.isFinite(row.entrySpotVolMult),
  );
  const retained = evaluated.filter(
    (row) =>
      row.price24hAtFire! >= LIVE_PLM.p24hMin &&
      row.price24hAtFire! <= LIVE_PLM.p24hMax &&
      row.entryPrice3h! >= LIVE_PLM.p3hMin &&
      row.entryPrice3h! <= LIVE_PLM.p3hMax &&
      row.entrySpotVolMult! >= LIVE_PLM.spotVolMin,
  );
  const excluded = evaluated.filter((row) => !retained.includes(row));
  const validDetectedAt = evaluated
    .map((row) => (row.detectedAt ? new Date(row.detectedAt).getTime() : NaN))
    .filter((value) => Number.isFinite(value));
  const analysisCutoff =
    validDetectedAt.length > 0 ? Math.max(...validDetectedAt) : null;
  return {
    evaluatedTotal: evaluated.length,
    evaluatedTerminal: evaluated.filter((row) => COMPLETED.has(row.status))
      .length,
    retained: summarizeLiveRows(retained),
    excluded: summarizeLiveRows(excluded),
    chronologicalHalves: chronologicalHalfSummary(retained),
    analysisCutoff:
      analysisCutoff == null ? null : new Date(analysisCutoff).toISOString(),
    methodology:
      "Derived from valid detectedAt/closedAt intervals as half-open [detectedAt, min(closedAt, analysisCutoff)); open rows end at analysisCutoff. Malformed dates are excluded from measured intervals. Tied timestamps process closes before opens; zero-duration intervals contribute no elapsed overlap.",
    comparableBaseline: deriveOverlap(evaluated, analysisCutoff),
    retainedLoad: deriveOverlap(retained, analysisCutoff),
  };
}

type PlmCandidateDefinition = {
  key:
    | "p24h_above_18"
    | "fut_taker_at_or_above_20"
    | "oi30m_below_0"
    | "oi1h_below_0"
    | "oi4h_below_0"
    | "price1h_below_0";
  label: string;
  value: (row: PlmCalibrationRow) => number | null;
  excludes: (row: PlmCalibrationRow) => boolean;
};

const CANDIDATES: PlmCandidateDefinition[] = [
  {
    key: "p24h_above_18",
    label: "p24h >18%",
    value: (row) =>
      row.plmP24hCap18Pass != null ? (row.price24hAtFire ?? 18) : null,
    excludes: (row) =>
      row.plmP24hCap18Pass === false ||
      (row.plmP24hCap18Pass == null &&
        row.price24hAtFire != null &&
        row.price24hAtFire > PLM_P24H_SHADOW_CAP),
  },
  {
    key: "fut_taker_at_or_above_20",
    label: "Futures Taker ≥20%",
    value: (row) =>
      row.plmFutTakerShadow === "unavailable" || row.plmFutTakerShadow == null
        ? null
        : (row.entryFutTakerNetBuy ?? 20),
    excludes: (row) => row.plmFutTakerShadow === "at_or_above_20",
  },
  {
    key: "oi30m_below_0",
    label: "OI30m <0%",
    value: (row) => row.entryOi30m,
    excludes: (row) => row.entryOi30m != null && row.entryOi30m < 0,
  },
  {
    key: "oi1h_below_0",
    label: "OI1h <0%",
    value: (row) => row.entryOi1h ?? null,
    excludes: (row) => row.entryOi1h != null && row.entryOi1h < 0,
  },
  {
    key: "oi4h_below_0",
    label: "OI4h <0%",
    value: (row) => row.entryOi4h ?? null,
    excludes: (row) => row.entryOi4h != null && row.entryOi4h < 0,
  },
  {
    key: "price1h_below_0",
    label: "price1h <0%",
    value: (row) => row.entryPrice1h ?? null,
    excludes: (row) => row.entryPrice1h != null && row.entryPrice1h < 0,
  },
];

function summarizeCandidate(
  completed: PlmCalibrationRow[],
  candidate: PlmCandidateDefinition,
) {
  const evaluated = completed.filter((row) => candidate.value(row) != null);
  const excluded = evaluated.filter(candidate.excludes);
  const retained = evaluated.filter((row) => !candidate.excludes(row));
  const excludedPeaks = excluded
    .map(peakPnl)
    .filter((value): value is number => value != null);
  const baselinePnl = rawPnlSummary(evaluated);
  const excludedPnl = rawPnlSummary(excluded);
  const retainedPnl = rawPnlSummary(retained);
  const profitsLost = excluded.filter((row) => row.status === "profit").length;
  const hit10Lost = excludedPeaks.filter((value) => value >= 10).length;
  const hit20Lost = excludedPeaks.filter((value) => value >= 20).length;
  const stopsRemoved = excluded.filter(
    (row) => row.status === "stop_loss",
  ).length;
  const sufficient = evaluated.length >= PLM_MIN_COMPLETED_OUTCOMES;
  const completeRawPnlCoverage = baselinePnl.count === evaluated.length;
  const completePeakCoverage = excludedPeaks.length === excluded.length;
  const noStrongDealsLost =
    profitsLost === 0 && hit10Lost === 0 && hit20Lost === 0;
  const improvesAverageRawPnl =
    baselinePnl.average != null &&
    retainedPnl.average != null &&
    retainedPnl.average > baselinePnl.average;
  const qualifiesForLiveChange =
    sufficient &&
    completeRawPnlCoverage &&
    completePeakCoverage &&
    stopsRemoved > 0 &&
    noStrongDealsLost &&
    improvesAverageRawPnl;

  return {
    key: candidate.key,
    label: candidate.label,
    evaluatedCompleted: evaluated.length,
    unavailableCompleted: completed.length - evaluated.length,
    excludedCompleted: excluded.length,
    retainedCompleted: retained.length,
    stopsRemoved,
    profitsLost,
    hit10Lost,
    hit20Lost,
    peakCoverage: {
      measured: excludedPeaks.length,
      excluded: excluded.length,
    },
    rawPnl: {
      baseline: baselinePnl,
      excluded: excludedPnl,
      retained: retainedPnl,
    },
    criteria: {
      minimumCompletedOutcomes: PLM_MIN_COMPLETED_OUTCOMES,
      sufficient,
      completeRawPnlCoverage,
      completePeakCoverage,
      removesStopLoss: stopsRemoved > 0,
      noStrongDealsLost,
      improvesAverageRawPnl,
      qualifiesForLiveChange,
    },
    liveGateChanged: false,
  };
}

function buildTakerRangeComparison(
  from20To30: ReturnType<typeof summarizeTakerRows>,
  above30: ReturnType<typeof summarizeTakerRows>,
) {
  const sufficient =
    from20To30.sufficient &&
    above30.sufficient &&
    from20To30.rawPnlCount === from20To30.completed &&
    above30.rawPnlCount === above30.completed;
  const stopRate20To30 = rate(
    from20To30.outcomes.stopLoss,
    from20To30.completed,
  );
  const stopRateAbove30 = rate(above30.outcomes.stopLoss, above30.completed);
  const averageRawPnlDelta =
    from20To30.averageRawPnl != null && above30.averageRawPnl != null
      ? above30.averageRawPnl - from20To30.averageRawPnl
      : null;
  const stopRateDelta =
    stopRate20To30 != null && stopRateAbove30 != null
      ? stopRateAbove30 - stopRate20To30
      : null;

  if (!sufficient) {
    return {
      action: "insufficient_sample" as const,
      sufficient: false,
      averageRawPnlDelta,
      stopRateDelta,
      detail: `Для честного сравнения каждому диапазону нужны ${PLM_MIN_COMPLETED_PER_TAKER_RANGE} завершённых исходов с raw PnL. Сейчас 20–30%: ${from20To30.completed}, >30%: ${above30.completed}.`,
      liveGateChanged: false,
    };
  }

  if (
    averageRawPnlDelta != null &&
    stopRateDelta != null &&
    averageRawPnlDelta < 0 &&
    stopRateDelta > 0
  ) {
    return {
      action: "above_30_worse" as const,
      sufficient: true,
      averageRawPnlDelta,
      stopRateDelta,
      detail:
        "Диапазон >30% одновременно хуже по среднему raw PnL и доле stop-loss, чем 20–30%. Это отдельное наблюдение; scanner автоматически не меняется.",
      liveGateChanged: false,
    };
  }

  if (
    averageRawPnlDelta != null &&
    stopRateDelta != null &&
    averageRawPnlDelta > 0 &&
    stopRateDelta < 0
  ) {
    return {
      action: "from_20_to_30_worse" as const,
      sufficient: true,
      averageRawPnlDelta,
      stopRateDelta,
      detail:
        "Диапазон 20–30% одновременно хуже по среднему raw PnL и доле stop-loss, чем >30%. Это отдельное наблюдение; scanner автоматически не меняется.",
      liveGateChanged: false,
    };
  }

  return {
    action: "no_clear_difference" as const,
    sufficient: true,
    averageRawPnlDelta,
    stopRateDelta,
    detail:
      "Raw PnL и доля stop-loss не ухудшаются в одном направлении; оснований предпочесть один перегретый диапазон нет.",
    liveGateChanged: false,
  };
}

function buildTakerDecision(
  below20: ReturnType<typeof summarizeTakerRows>,
  atOrAbove20: ReturnType<typeof summarizeTakerRows>,
) {
  const measurableCompleted = below20.completed + atOrAbove20.completed;
  const sufficient = measurableCompleted >= PLM_MIN_COMPLETED_OUTCOMES;
  const coolStopRate = rate(below20.outcomes.stopLoss, below20.completed);
  const overheatedStopRate = rate(
    atOrAbove20.outcomes.stopLoss,
    atOrAbove20.completed,
  );
  const pnlWorse =
    below20.averageRawPnl != null &&
    atOrAbove20.averageRawPnl != null &&
    atOrAbove20.averageRawPnl < below20.averageRawPnl;
  const stopsWorse =
    coolStopRate != null &&
    overheatedStopRate != null &&
    overheatedStopRate > coolStopRate;
  const strongOverheatedOutcomes =
    atOrAbove20.outcomes.profit +
    atOrAbove20.outcomes.buStop +
    atOrAbove20.outcomes.breakeven;

  if (!sufficient) {
    return {
      action: "observation_only" as const,
      title: "Оставить только наблюдение",
      detail: `В измеримых immutable-когортах завершено ${measurableCompleted}/${PLM_MIN_COMPLETED_OUTCOMES}. До минимальной forward-выборки live-gate менять нельзя.`,
      measurableCompleted,
      minimumCompletedOutcomes: PLM_MIN_COMPLETED_OUTCOMES,
      sufficient: false,
      liveGateChanged: false,
    };
  }

  if (
    atOrAbove20.completed >= PLM_MIN_COMPLETED_OUTCOMES &&
    pnlWorse &&
    stopsWorse &&
    strongOverheatedOutcomes === 0
  ) {
    return {
      action: "live_veto" as const,
      title: "Ввести live-veto для Futures Taker ≥20%",
      detail:
        "Перегретая когорта сама набрала 20 завершённых исходов, имеет худший raw PnL и более высокую долю stop-loss без сильных завершений. Gate должен оформляться отдельным изменением без пересчёта legacy NULL.",
      measurableCompleted,
      minimumCompletedOutcomes: PLM_MIN_COMPLETED_OUTCOMES,
      sufficient: true,
      liveGateChanged: false,
    };
  }

  if (pnlWorse && stopsWorse) {
    return {
      action: "limited_experiment" as const,
      title: "Провести ограниченный эксперимент",
      detail:
        strongOverheatedOutcomes > 0
          ? `Направление риска подтверждается, но ≥20% уже дало ${strongOverheatedOutcomes} сильных завершений. Полный veto может удалить хорошие сделки; нужен отдельный ограниченный live-эксперимент.`
          : "Направление риска подтверждается, но сама перегретая когорта ещё не набрала 20 завершённых исходов. Для полного veto доказательств недостаточно.",
      measurableCompleted,
      minimumCompletedOutcomes: PLM_MIN_COMPLETED_OUTCOMES,
      sufficient: true,
      liveGateChanged: false,
    };
  }

  return {
    action: "observation_only" as const,
    title: "Оставить только наблюдение",
    detail:
      "Forward-данные не подтверждают одновременно ухудшение raw PnL и рост доли stop-loss в когорте ≥20%. Live-veto не обоснован.",
    measurableCompleted,
    minimumCompletedOutcomes: PLM_MIN_COMPLETED_OUTCOMES,
    sufficient: true,
    liveGateChanged: false,
  };
}

function groupCount(
  values: Array<string | null>,
): Array<{ key: string; count: number }> {
  const counts = new Map<string, number>();
  for (const value of values) {
    const key = value?.trim() || "unknown";
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}

export function buildPlmCalibrationReport(rows: PlmCalibrationRow[]) {
  const allCompleted = rows.filter((row) => COMPLETED.has(row.status));
  const completed = allCompleted.filter(
    (row) =>
      row.entryPrice3h != null &&
      row.plmP24hCap18Pass != null &&
      row.entryScoreBreakdown != null &&
      row.entryGradeReason != null,
  );
  const withP3h = rows.filter((row) => row.entryPrice3h != null);
  const capEvaluated = completed.filter(
    (row) => row.plmP24hCap18Pass != null || row.price24hAtFire != null,
  );
  const excludedByCap = capEvaluated.filter(
    (row) =>
      row.plmP24hCap18Pass === false ||
      (row.plmP24hCap18Pass == null &&
        row.price24hAtFire != null &&
        row.price24hAtFire > PLM_P24H_SHADOW_CAP),
  );
  const superAlpha = completed.filter(
    (row) => row.signalType === "super_alpha",
  );
  const alpha = completed.filter((row) => row.signalType === "alpha");
  const negativeOi = completed.filter(
    (row) => row.entryOi30m != null && row.entryOi30m < 0,
  );
  const candidateFilters = CANDIDATES.map((candidate) =>
    summarizeCandidate(completed, candidate),
  );
  const qualifyingCandidates = candidateFilters.filter(
    (candidate) => candidate.criteria.qualifiesForLiveChange,
  );
  const takerCohorts = PLM_FUT_TAKER_SHADOW_CLASSES.map((key) =>
    summarizeTakerClass(rows, key),
  );
  const oi30mCohorts = PLM_OI30M_SHADOW_CLASSES.map((key) =>
    summarizeOi30mClass(rows, key),
  );
  const oi30mBelow2 = oi30mCohorts.find((cohort) => cohort.key === "below_2")!;
  const oi30mAtOrAbove2 = oi30mCohorts.find(
    (cohort) => cohort.key === "at_or_above_2",
  )!;
  const oi30mAverageRawPnlDelta =
    oi30mAtOrAbove2.averageRawPnl != null && oi30mBelow2.averageRawPnl != null
      ? oi30mAtOrAbove2.averageRawPnl - oi30mBelow2.averageRawPnl
      : null;
  const oi30mStopRateDelta =
    rate(oi30mAtOrAbove2.outcomes.stopLoss, oi30mAtOrAbove2.completed) !=
      null && rate(oi30mBelow2.outcomes.stopLoss, oi30mBelow2.completed) != null
      ? rate(oi30mAtOrAbove2.outcomes.stopLoss, oi30mAtOrAbove2.completed)! -
        rate(oi30mBelow2.outcomes.stopLoss, oi30mBelow2.completed)!
      : null;
  const oi30mComparatorAvailable = oi30mBelow2.completed > 0;
  const oi30mCompleteRawPnlCoverage =
    oi30mAtOrAbove2.rawPnlCount === oi30mAtOrAbove2.completed &&
    oi30mBelow2.rawPnlCount === oi30mBelow2.completed;
  const oi30mComparisonSufficient =
    oi30mAtOrAbove2.sufficient &&
    oi30mComparatorAvailable &&
    oi30mCompleteRawPnlCoverage;
  const below20 = takerCohorts.find((cohort) => cohort.key === "below_20")!;
  const atOrAbove20 = takerCohorts.find(
    (cohort) => cohort.key === "at_or_above_20",
  )!;
  const numericOverheatedRows = rows.filter(
    (row) =>
      row.plmFutTakerShadow === "at_or_above_20" &&
      row.entryFutTakerNetBuy != null &&
      Number.isFinite(row.entryFutTakerNetBuy),
  );
  const takerRanges = [
    summarizeTakerRows(
      numericOverheatedRows.filter(
        (row) =>
          row.entryFutTakerNetBuy! >= 20 && row.entryFutTakerNetBuy! <= 30,
      ),
      "from_20_to_30",
      PLM_MIN_COMPLETED_PER_TAKER_RANGE,
    ),
    summarizeTakerRows(
      numericOverheatedRows.filter((row) => row.entryFutTakerNetBuy! > 30),
      "above_30",
      PLM_MIN_COMPLETED_PER_TAKER_RANGE,
    ),
  ];
  const takerRangeComparison = buildTakerRangeComparison(
    takerRanges[0]!,
    takerRanges[1]!,
  );

  const summarizeGrade = (gradeRows: PlmCalibrationRow[]) => ({
    completed: gradeRows.length,
    profits: gradeRows.filter((row) => row.status === "profit").length,
    stops: gradeRows.filter((row) => row.status === "stop_loss").length,
    negativeOi30m: gradeRows.filter(
      (row) => row.entryOi30m != null && row.entryOi30m < 0,
    ).length,
  });

  return {
    observationOnly: true,
    livePolicy: {
      active: true,
      thresholds: LIVE_PLM,
    },
    liveEvaluation: evaluateLivePolicy(rows),
    sample: {
      totalSignals: rows.length,
      allHistoryCompletedOutcomes: allCompleted.length,
      completedOutcomes: completed.length,
      minimumCompletedOutcomes: PLM_MIN_COMPLETED_OUTCOMES,
      sufficient: completed.length >= PLM_MIN_COMPLETED_OUTCOMES,
      p3hCaptured: withP3h.length,
      p3hCoverageRate:
        rows.length > 0 ? (withP3h.length / rows.length) * 100 : null,
      capEvaluated: capEvaluated.length,
    },
    shadow: {
      threshold: {
        p24hCap: PLM_P24H_SHADOW_CAP,
        p3hMax: PLM_MAX_PRICE_3H,
        liveGateChanged: false,
      },
      capCost: {
        excludedCompleted: excludedByCap.length,
        stopsRemoved: excludedByCap.filter((row) => row.status === "stop_loss")
          .length,
        profitsLost: excludedByCap.filter((row) => row.status === "profit")
          .length,
        protectedExitsLost: excludedByCap.filter(
          (row) => row.status === "bu_stop" || row.status === "breakeven",
        ).length,
      },
      candidateFilters,
      decision: {
        action:
          completed.length < PLM_MIN_COMPLETED_OUTCOMES
            ? ("observation_only" as const)
            : qualifyingCandidates.length === 0
              ? ("keep_current_live_thresholds" as const)
              : ("candidate_requires_separate_live_change" as const),
        liveGateChanged: false,
        qualifyingCandidateKeys: qualifyingCandidates.map(
          (candidate) => candidate.key,
        ),
        criteria:
          "Кандидат допустим к отдельному live-изменению только после 20 завершённых immutable-сигналов, если он убирает stop-loss, не теряет ни profit, ни hit10/hit20 и повышает средний raw PnL сохранённой когорты.",
        detail:
          completed.length < PLM_MIN_COMPLETED_OUTCOMES
            ? `Завершено ${completed.length}/${PLM_MIN_COMPLETED_OUTCOMES} immutable PLM-сигналов. Все кандидаты остаются observation-only.`
            : qualifyingCandidates.length === 0
              ? "Ни один кандидат не выполнил все заранее зафиксированные критерии. Live-пороги остаются без изменений."
              : `Критерии выполнили: ${qualifyingCandidates
                  .map((candidate) => candidate.label)
                  .join(
                    ", ",
                  )}. Автоматически scanner не меняется: live-gate оформляется отдельным проверяемым изменением.`,
      },
      grades: {
        alpha: summarizeGrade(alpha),
        superAlpha: summarizeGrade(superAlpha),
        superAlphaReasons: groupCount(
          superAlpha.map((row) => row.entryGradeReason),
        ),
        superAlphaScoreBreakdowns: groupCount(
          superAlpha.map((row) => row.entryScoreBreakdown),
        ).slice(0, 8),
      },
      negativeOi30mRisk: {
        observedCompleted: negativeOi.length,
        stops: negativeOi.filter((row) => row.status === "stop_loss").length,
        profits: negativeOi.filter((row) => row.status === "profit").length,
        isGate: false,
      },
      futTakerShadow: {
        liveGateChanged: false,
        thresholdPct: 20,
        captured: rows.filter((row) => row.plmFutTakerShadow != null).length,
        coverageRate:
          rows.length > 0
            ? (rows.filter((row) => row.plmFutTakerShadow != null).length /
                rows.length) *
              100
            : null,
        cohorts: takerCohorts,
        ranges: {
          numericCaptured: numericOverheatedRows.length,
          minimumCompletedPerRange: PLM_MIN_COMPLETED_PER_TAKER_RANGE,
          sufficientForComparison: takerRanges.every(
            (range) => range.sufficient,
          ),
          cohorts: takerRanges,
          comparison: takerRangeComparison,
          note: "20–30% и >30% считаются только по сохранённому entry_fut_taker_net_buy внутри immutable-класса ≥20%; legacy NULL не пересчитывается.",
        },
        recommendation: buildTakerDecision(below20, atOrAbove20),
      },
      oi30mShadow: {
        liveGateChanged: false,
        thresholdPct: 2,
        captured: rows.filter((row) => row.plmOi30mShadow != null).length,
        coverageRate:
          rows.length > 0
            ? (rows.filter((row) => row.plmOi30mShadow != null).length /
                rows.length) *
              100
            : null,
        cohorts: oi30mCohorts,
        comparison: {
          sufficient: oi30mComparisonSufficient,
          highOiCohortSufficient: oi30mAtOrAbove2.sufficient,
          comparatorAvailable: oi30mComparatorAvailable,
          completeRawPnlCoverage: oi30mCompleteRawPnlCoverage,
          minimumHighOiCompleted: PLM_MIN_COMPLETED_OUTCOMES,
          averageRawPnlDelta: oi30mAverageRawPnlDelta,
          stopRateDelta: oi30mStopRateDelta,
          action: !oi30mComparisonSufficient
            ? ("observation_only_insufficient_comparison" as const)
            : oi30mAverageRawPnlDelta != null &&
                oi30mAverageRawPnlDelta < 0 &&
                oi30mStopRateDelta != null &&
                oi30mStopRateDelta > 0
              ? ("risk_confirmed_requires_separate_live_change" as const)
              : ("keep_current_live_thresholds" as const),
          liveGateChanged: false,
        },
        note: "Классы OI30m фиксируются только при fire. Сравнение с <2% становится достаточным после 20 завершённых сигналов в когорте ≥2%; legacy NULL и позднее enrichment не пересчитываются.",
      },
    },
    definition:
      "PLM Lab — отчёт по live-политике PLM: p24h 5–15%, p3h 1.5–4.0% и decision-time Spot Volume ≥1.1x; существующие SNF/CVD gates не меняются. Для p24h 18%, Futures Taker 20%, immutable OI30m 2%, отрицательных OI30m/OI1h/OI4h и price1h сохраняются независимые shadow-аналитики. Legacy NULL не пересчитывается.",
  };
}
