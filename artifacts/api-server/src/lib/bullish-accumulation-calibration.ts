/**
 * Pure calibration helpers for bullish_accumulation.
 *
 * A rejected candidate is observed once per symbol in a 12-hour window. This
 * is enough to evaluate the gate without treating repeated scanner passes as
 * independent opportunities.
 */

export const BA_REJECT_TELEMETRY_WINDOW_MS = 12 * 60 * 60 * 1000;
/** Canonical Bullish Accumulation overheat ceiling shared by scanner and OI Watch. */
export const BULLISH_ACCUMULATION_MAX_P24H = 5;
export const BULLISH_ACCUMULATION_FRESH_OI30M_MIN = 3.5;
export const BULLISH_ACCUMULATION_FRESH_OI30M_MAX = 5;
/**
 * The former 5% hard cap was inferred from one historical entry. The restored
 * 5–10% band has its own route so its outcomes cannot be hidden inside fresh.
 */
export const BULLISH_ACCUMULATION_EXTENDED_OI30M_MIN = 5;
export const BULLISH_ACCUMULATION_EXTENDED_OI30M_MAX = 10;
export const BULLISH_ACCUMULATION_TRANSITION_OI30M_MIN = 2.5;
export const BULLISH_ACCUMULATION_TRANSITION_OI30M_MAX = 3.5;
export const BULLISH_ACCUMULATION_SLOW_OI30M_MAX = 2.5;
export const BULLISH_ACCUMULATION_SLOW_OI1H_MIN = 2;
export const BULLISH_ACCUMULATION_SLOW_OI1H_MAX = 6;
export const BULLISH_ACCUMULATION_SLOW_OI4H_MIN = 2.5;
export const BULLISH_ACCUMULATION_DEFAULT_OI_WATCH_PRICE_CONFIRM_PCT = 2;
export const BULLISH_ACCUMULATION_SLOW_OI_WATCH_PRICE_CONFIRM_PCT = 0;
export const BULLISH_ACCUMULATION_MIN_COMPLETED_OUTCOMES = 20;
export const BULLISH_ACCUMULATION_MIN_COMPLETED_PER_PATH = 5;
export const BULLISH_ACCUMULATION_ENTRY_CONTRACT_VERSION = "ba-oi-contract-v3";

export type BullishAccumulationOiPath =
  | "fresh_oi30m"
  | "extended_oi30m"
  | "transition_oi30m"
  | "slow_multitf";

export type BullishAccumulationOiDecision =
  | { allowed: true; path: BullishAccumulationOiPath; reason: null }
  | {
      allowed: false;
      path: null;
      reason: "oi_too_low" | "oi30m_too_hot" | "slow_oi1h_too_hot";
    };

export type BullishAccumulationCalibrationRow = {
  status: string;
  pnlPercent: number | null;
  entrySource: string | null;
};

const BULLISH_ACCUMULATION_FINAL_STATUSES = new Set([
  "profit",
  "stop_loss",
  "bu_stop",
  "breakeven",
  "expired",
  "cancelled",
]);

/**
 * The four BA entry theses are deliberately disjoint:
 * - fresh_oi30m catches a new 30m impulse;
 * - extended_oi30m restores the previously blocked 5–10% band as its own
 *   measurable cohort;
 * - transition_oi30m restores the previously hard-blocked 2.5–3.5% band as
 *   its own measurable cohort;
 * - slow_multitf catches quiet higher-TF accumulation while 30m stays cool.
 *
 * The former >5% ceiling rested on one historical entry and therefore was not
 * representative enough for a hard gate. The temporary 10% ceiling limits
 * obvious overheat while v2 gathers route-specific forward outcomes.
 */
export function classifyBullishAccumulationOiPath(input: {
  oi30m: number | null | undefined;
  oi1h: number | null | undefined;
  oi4h: number | null | undefined;
}): BullishAccumulationOiDecision {
  const oi30m =
    typeof input.oi30m === "number" && Number.isFinite(input.oi30m)
      ? input.oi30m
      : null;
  const oi1h =
    typeof input.oi1h === "number" && Number.isFinite(input.oi1h)
      ? input.oi1h
      : null;
  const hasSlowConfirmation =
    (oi1h !== null && oi1h >= BULLISH_ACCUMULATION_SLOW_OI1H_MIN) ||
    (typeof input.oi4h === "number" &&
      Number.isFinite(input.oi4h) &&
      input.oi4h >= BULLISH_ACCUMULATION_SLOW_OI4H_MIN);

  if (
    oi30m !== null &&
    oi30m >= BULLISH_ACCUMULATION_FRESH_OI30M_MIN &&
    oi30m <= BULLISH_ACCUMULATION_FRESH_OI30M_MAX
  ) {
    return { allowed: true, path: "fresh_oi30m", reason: null };
  }

  if (
    oi30m !== null &&
    oi30m > BULLISH_ACCUMULATION_EXTENDED_OI30M_MIN &&
    oi30m <= BULLISH_ACCUMULATION_EXTENDED_OI30M_MAX
  ) {
    return { allowed: true, path: "extended_oi30m", reason: null };
  }

  if (
    oi30m !== null &&
    oi30m > BULLISH_ACCUMULATION_TRANSITION_OI30M_MIN &&
    oi30m < BULLISH_ACCUMULATION_TRANSITION_OI30M_MAX
  ) {
    return { allowed: true, path: "transition_oi30m", reason: null };
  }

  if (
    (oi30m === null || oi30m <= BULLISH_ACCUMULATION_SLOW_OI30M_MAX) &&
    hasSlowConfirmation
  ) {
    if (oi1h !== null && oi1h > BULLISH_ACCUMULATION_SLOW_OI1H_MAX) {
      return { allowed: false, path: null, reason: "slow_oi1h_too_hot" };
    }
    return { allowed: true, path: "slow_multitf", reason: null };
  }

  if (oi30m !== null && oi30m > BULLISH_ACCUMULATION_EXTENDED_OI30M_MAX) {
    return { allowed: false, path: null, reason: "oi30m_too_hot" };
  }
  return { allowed: false, path: null, reason: "oi_too_low" };
}

/**
 * Slow accumulation is already confirmed by higher-timeframe OI, so waiting
 * for an extra +2% price move turns an early-entry thesis into a late entry.
 * The zero threshold still prevents firing while price is below its watch
 * origin. Faster OI routes retain the existing +2% confirmation.
 */
export function getBullishAccumulationOiWatchMinPriceMove(
  oiPath: BullishAccumulationOiPath | null | undefined,
): number {
  return oiPath === "slow_multitf"
    ? BULLISH_ACCUMULATION_SLOW_OI_WATCH_PRICE_CONFIRM_PCT
    : BULLISH_ACCUMULATION_DEFAULT_OI_WATCH_PRICE_CONFIRM_PCT;
}

/**
 * A BA entry is valid only when its 24h price move is known and is not above
 * the calibrated overheat ceiling. OI Watch must use this exact predicate
 * before it can create a tracked signal.
 */
export function isBullishAccumulationP24hAllowed(
  price24h: number | null | undefined,
): boolean {
  return (
    typeof price24h === "number" &&
    Number.isFinite(price24h) &&
    price24h <= BULLISH_ACCUMULATION_MAX_P24H
  );
}

/**
 * OI Watch Path B has legacy rows without a pattern key that ultimately create
 * BA tracked signals; Path A only represents BA when the stored payload says so.
 */
export function isBullishAccumulationOiWatchFireAllowed(
  path: "path_a" | "path_b",
  sentimentKey: string | null | undefined,
  price24h: number | null | undefined,
  oi?: {
    oi30m: number | null | undefined;
    oi1h: number | null | undefined;
    oi4h: number | null | undefined;
  },
): boolean {
  return getBullishAccumulationOiWatchFireDecision(
    path,
    sentimentKey,
    price24h,
    oi,
  ).allowed;
}

export function getBullishAccumulationOiWatchFireDecision(
  path: "path_a" | "path_b",
  sentimentKey: string | null | undefined,
  price24h: number | null | undefined,
  oi?: {
    oi30m: number | null | undefined;
    oi1h: number | null | undefined;
    oi4h: number | null | undefined;
  },
):
  | { allowed: true; reason: null; oiPath: BullishAccumulationOiPath | null }
  | { allowed: false; defer: boolean; reason: string; oiPath: null } {
  const isBullishAccumulation =
    sentimentKey === "bullish_accumulation" ||
    (path === "path_b" && sentimentKey === null);

  if (!isBullishAccumulation) {
    return { allowed: true, reason: null, oiPath: null };
  }
  if (!isBullishAccumulationP24hAllowed(price24h)) {
    return {
      allowed: false,
      defer: false,
      reason: "ba_p24h_too_high_5pct",
      oiPath: null,
    };
  }
  if (!oi) return { allowed: true, reason: null, oiPath: null };

  const oiDecision = classifyBullishAccumulationOiPath(oi);
  if (oiDecision.allowed) {
    return { allowed: true, reason: null, oiPath: oiDecision.path };
  }
  if (oiDecision.reason === "oi_too_low" && oi.oi4h == null) {
    return {
      allowed: false,
      defer: true,
      reason: "ba_oi_data_incomplete",
      oiPath: null,
    };
  }
  return {
    allowed: false,
    defer: false,
    reason: `ba_${oiDecision.reason}`,
    oiPath: null,
  };
}

/**
 * Marks BA signals created after the shared OI Watch p24h gate went live.
 * Older bypasses used legacy trigger-TF entry sources, so production reporting
 * can keep them out of the clean cohort.
 */
export function getBullishAccumulationEntrySource(
  origin: "scan" | "oi_watch/path_a" | "oi_watch/path_b",
  oiPath: BullishAccumulationOiPath,
): string {
  return `${origin}/${BULLISH_ACCUMULATION_ENTRY_CONTRACT_VERSION}/${oiPath}`;
}

export function getBullishAccumulationOiWatchEntrySource(
  path: "path_a" | "path_b",
  oiPath: BullishAccumulationOiPath,
): string {
  return getBullishAccumulationEntrySource(`oi_watch/${path}`, oiPath);
}

export function getBullishAccumulationOiPathFromEntrySource(
  entrySource: string | null | undefined,
): BullishAccumulationOiPath | null {
  if (!entrySource) return null;
  const match = entrySource.match(
    new RegExp(
      `^(?:scan|oi_watch/path_[ab])/${BULLISH_ACCUMULATION_ENTRY_CONTRACT_VERSION}/(fresh_oi30m|extended_oi30m|transition_oi30m|slow_multitf)$`,
    ),
  );
  return (match?.[1] as BullishAccumulationOiPath | undefined) ?? null;
}

function summarizeBullishAccumulationPath(
  rows: BullishAccumulationCalibrationRow[],
) {
  const completed = rows.filter((row) =>
    BULLISH_ACCUMULATION_FINAL_STATUSES.has(row.status),
  );
  const finitePnl = completed.map((row) =>
    row.status === "bu_stop" || row.status === "breakeven"
      ? 0
      : typeof row.pnlPercent === "number" && Number.isFinite(row.pnlPercent)
        ? row.pnlPercent
        : null,
  );
  const measuredPnl = finitePnl.filter(
    (value): value is number => value !== null,
  );
  const outcomes = {
    profit: completed.filter((row) => row.status === "profit").length,
    stopLoss: completed.filter((row) => row.status === "stop_loss").length,
    buStop: completed.filter((row) => row.status === "bu_stop").length,
    breakeven: completed.filter((row) => row.status === "breakeven").length,
    expired: completed.filter((row) => row.status === "expired").length,
    cancelled: completed.filter((row) => row.status === "cancelled").length,
  };

  return {
    totalSignals: rows.length,
    openSignals: rows.length - completed.length,
    completedSignals: completed.length,
    representative:
      completed.length >= BULLISH_ACCUMULATION_MIN_COMPLETED_PER_PATH,
    outcomes,
    rates: {
      profit:
        completed.length > 0
          ? (outcomes.profit / completed.length) * 100
          : null,
      stopLoss:
        completed.length > 0
          ? (outcomes.stopLoss / completed.length) * 100
          : null,
      cancelled:
        completed.length > 0
          ? (outcomes.cancelled / completed.length) * 100
          : null,
    },
    pnl: {
      measuredSignals: measuredPnl.length,
      netPercent:
        measuredPnl.length > 0
          ? measuredPnl.reduce((sum, value) => sum + value, 0)
          : null,
      averagePercent:
        measuredPnl.length > 0
          ? measuredPnl.reduce((sum, value) => sum + value, 0) /
            measuredPnl.length
          : null,
    },
  };
}

export function buildBullishAccumulationCalibrationReport(
  rows: BullishAccumulationCalibrationRow[],
) {
  const canonical = rows
    .map((row) => ({
      row,
      path: getBullishAccumulationOiPathFromEntrySource(row.entrySource),
    }))
    .filter(
      (
        item,
      ): item is {
        row: BullishAccumulationCalibrationRow;
        path: BullishAccumulationOiPath;
      } => item.path !== null,
    );
  const freshRows = canonical
    .filter((item) => item.path === "fresh_oi30m")
    .map((item) => item.row);
  const extendedRows = canonical
    .filter((item) => item.path === "extended_oi30m")
    .map((item) => item.row);
  const transitionRows = canonical
    .filter((item) => item.path === "transition_oi30m")
    .map((item) => item.row);
  const slowRows = canonical
    .filter((item) => item.path === "slow_multitf")
    .map((item) => item.row);
  const paths = {
    freshOi30m: summarizeBullishAccumulationPath(freshRows),
    extendedOi30m: summarizeBullishAccumulationPath(extendedRows),
    transitionOi30m: summarizeBullishAccumulationPath(transitionRows),
    slowMultitf: summarizeBullishAccumulationPath(slowRows),
  };
  const completedSignals =
    paths.freshOi30m.completedSignals +
    paths.extendedOi30m.completedSignals +
    paths.transitionOi30m.completedSignals +
    paths.slowMultitf.completedSignals;
  const sufficient =
    completedSignals >= BULLISH_ACCUMULATION_MIN_COMPLETED_OUTCOMES &&
    paths.freshOi30m.representative &&
    paths.extendedOi30m.representative &&
    paths.transitionOi30m.representative &&
    paths.slowMultitf.representative;

  return {
    observationOnly: true,
    contract: {
      version: BULLISH_ACCUMULATION_ENTRY_CONTRACT_VERSION,
      legacySignalsExcluded: rows.length - canonical.length,
    },
    sample: {
      canonicalSignals: canonical.length,
      completedSignals,
      minimumCompletedSignals: BULLISH_ACCUMULATION_MIN_COMPLETED_OUTCOMES,
      minimumCompletedPerPath: BULLISH_ACCUMULATION_MIN_COMPLETED_PER_PATH,
      bothPathsRepresentative:
        paths.freshOi30m.representative && paths.slowMultitf.representative,
      allPathsRepresentative:
        paths.freshOi30m.representative &&
        paths.extendedOi30m.representative &&
        paths.transitionOi30m.representative &&
        paths.slowMultitf.representative,
      sufficient,
    },
    thresholds: {
      freshOi30m: {
        min: BULLISH_ACCUMULATION_FRESH_OI30M_MIN,
        max: BULLISH_ACCUMULATION_FRESH_OI30M_MAX,
      },
      extendedOi30m: {
        minExclusive: BULLISH_ACCUMULATION_EXTENDED_OI30M_MIN,
        max: BULLISH_ACCUMULATION_EXTENDED_OI30M_MAX,
      },
      transitionOi30m: {
        min: BULLISH_ACCUMULATION_TRANSITION_OI30M_MIN,
        maxExclusive: BULLISH_ACCUMULATION_TRANSITION_OI30M_MAX,
      },
      slowMultitf: {
        maxOi30m: BULLISH_ACCUMULATION_SLOW_OI30M_MAX,
        minOi1h: BULLISH_ACCUMULATION_SLOW_OI1H_MIN,
        minOi4h: BULLISH_ACCUMULATION_SLOW_OI4H_MIN,
      },
      liveGateChanged: false,
    },
    paths,
    recommendation: sufficient
      ? {
          code: "review_ready_no_automatic_change",
          title: "Выборка готова к решению",
          detail:
            "Все четыре пути представлены и суммарно накоплено не меньше 20 завершённых сигналов. Порог не меняется автоматически: любая корректировка должна быть приложена отдельным replay её влияния.",
          thresholdChangeRecommended: false,
          replayRequiredForAnyChange: true,
        }
      : {
          code: "insufficient_canonical_cohort",
          title: "Сохраняем текущие пороги и продолжаем сбор",
          detail:
            "Решение о корректировке заблокировано до 20 завершённых post-contract сигналов суммарно и минимум 5 завершённых сигналов в каждом OI-пути.",
          thresholdChangeRecommended: false,
          replayRequiredForAnyChange: true,
        },
    definition:
      "В отчёт входят только BA-сигналы с versioned entry_source канонического двухпутевого контракта. Legacy-история исключена. Net PnL — сумма фактических raw PnL завершённых сигналов; BE и breakeven считаются как 0%.",
  };
}

export function getBullishAccumulationP24hTelemetrySource(
  symbol: string,
  observedAt: Date,
): string {
  const window = Math.floor(
    observedAt.getTime() / BA_REJECT_TELEMETRY_WINDOW_MS,
  );
  return `bullish_accumulation:p24h_gt_5:${symbol}:${window}`;
}
