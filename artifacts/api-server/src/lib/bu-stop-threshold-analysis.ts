/**
 * Pure analysis for deciding whether a pattern's BE milestone should remain
 * at 5% or move higher.
 *
 * Snapshots are direction-aware movement from the actual protected BE.
 * exit/entry price. A trajectory is eligible only when it has at least 60
 * distinct hourly observations in hours 1..72 and an exact hour-72 sample.
 */

export const BU_STOP_THRESHOLD_CANDIDATES = [5, 8, 10] as const;
export const BU_STOP_ANALYSIS_MIN_SAMPLES = 60;

export interface BuStopThresholdSample {
  hourAfterClose: number;
  movePct: number;
}

export interface BuStopThresholdTrajectory {
  id: number;
  symbol: string;
  pattern?: string | null;
  closedAt: string | Date | null;
  samples: BuStopThresholdSample[];
}

export interface BuStopThresholdTrade {
  id: number;
  symbol: string;
  sampleCount: number;
  maxMoveFromEntryPct: number;
  minMoveFromEntryPct: number;
  moveAt72hFromEntryPct: number;
  samples: BuStopThresholdSample[];
}

export interface BuStopThresholdScenario {
  thresholdPct: number;
  sampleSize: number;
  continuationCount: number;
  continuationRatePct: number | null;
  maxMovementAfterBuPct: number | null;
  averagePeakFromEntryPct: number | null;
  medianPeakFromEntryPct: number | null;
  averageMovementAt72hPct: number | null;
  medianMovementAt72hPct: number | null;
  notReachedThresholdCount: number;
  protectionLostCount: number;
  trades: BuStopThresholdTrade[];
}

export interface BuStopThresholdAnalysis {
  requiredSampleSize: number;
  minimumHour72Samples: number;
  qualified: boolean;
  qualificationMessage: string;
  sampleSize: number;
  thresholds: BuStopThresholdScenario[];
  recommendation: "keep_5_until_cohort" | "keep_5" | "move_to_8" | "move_to_10";
  recommendationMessage: string;
}

export interface BuStopThresholdPatternAnalysis {
  pattern: string;
  analysis: BuStopThresholdAnalysis;
}

function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? round((sorted[middle - 1] + sorted[middle]) / 2)
    : round(sorted[middle]);
}

function average(values: number[]): number | null {
  return values.length > 0
    ? round(values.reduce((sum, value) => sum + value, 0) / values.length)
    : null;
}

function normalizeTrajectory(
  trajectory: BuStopThresholdTrajectory,
): BuStopThresholdTrade | null {
  const byHour = new Map<number, number>();
  for (const sample of trajectory.samples) {
    if (
      Number.isInteger(sample.hourAfterClose) &&
      sample.hourAfterClose >= 1 &&
      sample.hourAfterClose <= 72 &&
      Number.isFinite(sample.movePct)
    ) {
      byHour.set(sample.hourAfterClose, sample.movePct);
    }
  }
  if (byHour.size < BU_STOP_ANALYSIS_MIN_SAMPLES || !byHour.has(72)) {
    return null;
  }

  const moves = [...byHour.values()];
  const samples = [...byHour.entries()]
    .sort(([hourA], [hourB]) => hourA - hourB)
    .map(([hourAfterClose, movePct]) => ({ hourAfterClose, movePct }));
  return {
    id: trajectory.id,
    symbol: trajectory.symbol,
    sampleCount: byHour.size,
    maxMoveFromEntryPct: round(Math.max(...moves)),
    minMoveFromEntryPct: round(Math.min(...moves)),
    moveAt72hFromEntryPct: round(byHour.get(72)!),
    samples,
  };
}

function lostProtectionBeforeThreshold(
  trade: BuStopThresholdTrade,
  thresholdPct: number,
): boolean {
  if (thresholdPct === 5) return false;
  const firstThresholdIndex = trade.samples.findIndex(
    (sample) => sample.movePct >= thresholdPct,
  );
  const samplesBeforeThreshold =
    firstThresholdIndex === -1
      ? trade.samples
      : trade.samples.slice(0, firstThresholdIndex);
  return samplesBeforeThreshold.some((sample) => sample.movePct < 0);
}

/**
 * Build the three threshold counterfactuals from complete post-BE.
 * trajectories. "Continuation" means the trajectory exceeded that
 * threshold after the protected BE level. For +8/+10, protection is
 * considered lost if the market moved below the actual BE level before
 * its first observation at or above the higher threshold.
 */
export function analyzeBuStopThresholds(
  trajectories: BuStopThresholdTrajectory[],
): BuStopThresholdAnalysis {
  const qualifiedTrades = trajectories
    .map(normalizeTrajectory)
    .filter((trade): trade is BuStopThresholdTrade => trade !== null);

  const thresholds = BU_STOP_THRESHOLD_CANDIDATES.map((thresholdPct) => {
    const continuationTrades = qualifiedTrades.filter(
      (trade) => trade.maxMoveFromEntryPct > thresholdPct,
    );
    const peakMoves = qualifiedTrades.map((trade) => trade.maxMoveFromEntryPct);
    const hour72Moves = qualifiedTrades.map(
      (trade) => trade.moveAt72hFromEntryPct,
    );
    const notReachedThresholdCount = qualifiedTrades.filter(
      (trade) => trade.maxMoveFromEntryPct < thresholdPct,
    ).length;

    return {
      thresholdPct,
      sampleSize: qualifiedTrades.length,
      continuationCount: continuationTrades.length,
      continuationRatePct:
        qualifiedTrades.length > 0
          ? round((continuationTrades.length / qualifiedTrades.length) * 100)
          : null,
      maxMovementAfterBuPct:
        peakMoves.length > 0 ? round(Math.max(...peakMoves)) : null,
      averagePeakFromEntryPct: average(peakMoves),
      medianPeakFromEntryPct: median(peakMoves),
      averageMovementAt72hPct: average(hour72Moves),
      medianMovementAt72hPct: median(hour72Moves),
      notReachedThresholdCount,
      // At +5 the protection was actually activated, so this counterfactual
      // is zero by definition. For higher milestones, preserve event order:
      // a later recovery above the threshold cannot undo an earlier loss.
      protectionLostCount: qualifiedTrades.filter((trade) =>
        lostProtectionBeforeThreshold(trade, thresholdPct),
      ).length,
      trades: qualifiedTrades,
    };
  });

  const sampleSize = qualifiedTrades.length;
  const qualified = sampleSize >= 10;
  if (!qualified) {
    return {
      requiredSampleSize: 10,
      minimumHour72Samples: BU_STOP_ANALYSIS_MIN_SAMPLES,
      qualified: false,
      qualificationMessage: `Недостаточно данных: ${sampleSize} зрелых BE с ≥${BU_STOP_ANALYSIS_MIN_SAMPLES} наблюдениями и hour-72; нужно ещё ${Math.max(0, 10 - sampleSize)}.`,
      sampleSize,
      thresholds,
      recommendation: "keep_5_until_cohort",
      recommendationMessage:
        "Оставить BE на +5% до формирования требуемой выборки; менять порог по неполному cohort нельзя.",
    };
  }

  const at8 = thresholds[1];
  const at10 = thresholds[2];
  const recommendation = (
    at10.protectionLostCount === 0 && (at10.continuationRatePct ?? 0) >= 50
      ? "move_to_10"
      : at8.protectionLostCount === 0 && (at8.continuationRatePct ?? 0) >= 50
        ? "move_to_8"
        : "keep_5"
  ) as BuStopThresholdAnalysis["recommendation"];

  const recommendationMessage =
    recommendation === "move_to_8"
      ? "Перейти на +8%: продолжения остаются частыми, а в cohort нет сделок, потерявших защиту."
      : recommendation === "move_to_10"
        ? "Перейти на +10%: +10% сохраняет приемлемую долю продолжений без потери защиты."
        : `Оставить +5%: при n=${sampleSize} более высокий порог либо заметно теряет защиту, либо не даёт достаточной доли продолжений.`;

  return {
    requiredSampleSize: 10,
    minimumHour72Samples: BU_STOP_ANALYSIS_MIN_SAMPLES,
    qualified: true,
    qualificationMessage: `Квалифицировано ${sampleSize} зрелых BE с полными 72-часовыми траекториями.`,
    sampleSize,
    thresholds,
    recommendation,
    recommendationMessage,
  };
}

export function analyzeBuStopThresholdsByPattern(
  trajectories: BuStopThresholdTrajectory[],
): BuStopThresholdPatternAnalysis[] {
  const grouped = new Map<string, BuStopThresholdTrajectory[]>();
  for (const trajectory of trajectories) {
    const pattern = trajectory.pattern?.trim();
    if (!pattern) continue;
    const rows = grouped.get(pattern) ?? [];
    rows.push(trajectory);
    grouped.set(pattern, rows);
  }

  return [...grouped.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([pattern, rows]) => ({
      pattern,
      analysis: analyzeBuStopThresholds(rows),
    }));
}
