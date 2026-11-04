import { GetBtcAnalysisResponse } from "@workspace/api-zod";

export type BtcCrossHistory = ReturnType<
  typeof GetBtcAnalysisResponse.parse
>["crossHistory"];
type BtcCrossHistoryDay = BtcCrossHistory["days"][number];

export type CrossObservationDay = {
  day: string;
  btcPrice: number | null;
  btcDominance: number | null;
  dominanceObservedAt: Date | null;
  dominanceSource: "coinglass" | "coingecko" | null;
};

export function formatPgDate(value: string | Date): string {
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) {
      throw new Error("Invalid database date value");
    }
    return value.toISOString().slice(0, 10);
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    throw new Error("Invalid database date value");
  }
  return parsed.toISOString().slice(0, 10);
}

export type CrossEventCandidate = {
  day: string;
  direction: "btc_outperformed" | "dominance_outperformed";
  btcPrice: number;
  btcDominance: number;
};

function stablePercent(value: number, anchor: number): number {
  return ((value - anchor) / anchor) * 100;
}

export function buildBtcCrossHistory(
  observations: readonly CrossObservationDay[],
  anchor: { day: string; btcPrice: number; btcDominance: number } | null,
): BtcCrossHistory {
  const days: BtcCrossHistoryDay[] = observations.map((point) => {
    const validPrice =
      point.btcPrice != null && Number.isFinite(point.btcPrice);
    const validDominance =
      point.btcDominance != null && Number.isFinite(point.btcDominance);
    return {
      day: point.day,
      btcPrice: point.btcPrice,
      btcDominance: point.btcDominance,
      btcChangePercent:
        validPrice && anchor
          ? stablePercent(point.btcPrice!, anchor.btcPrice)
          : null,
      dominanceChangePercent:
        validDominance && anchor
          ? stablePercent(point.btcDominance!, anchor.btcDominance)
          : null,
      dominanceObservedAt: point.dominanceObservedAt,
      dominanceSource: point.dominanceSource,
    };
  });
  return { anchor, days };
}

function previousCalendarDay(day: string): string {
  return new Date(Date.parse(`${day}T00:00:00.000Z`) - 86_400_000)
    .toISOString()
    .slice(0, 10);
}

export function findCrossingEvents(
  history: BtcCrossHistory,
  afterDay: string | null,
): CrossEventCandidate[] {
  if (!history.anchor) return [];
  const candidates: CrossEventCandidate[] = [];
  for (let index = 1; index < history.days.length; index += 1) {
    const previous = history.days[index - 1]!;
    const current = history.days[index]!;
    if (
      (afterDay != null && current.day <= afterDay) ||
      previous.day !== previousCalendarDay(current.day) ||
      current.btcPrice == null ||
      current.btcDominance == null ||
      previous.btcChangePercent == null ||
      previous.dominanceChangePercent == null ||
      current.btcChangePercent == null ||
      current.dominanceChangePercent == null
    ) {
      continue;
    }
    const previousDifference =
      previous.btcChangePercent - previous.dominanceChangePercent;
    const currentDifference =
      current.btcChangePercent - current.dominanceChangePercent;
    // Strict opposite signs avoid fabricating an alert at the shared baseline.
    if (
      !(
        (previousDifference > 0 && currentDifference < 0) ||
        (previousDifference < 0 && currentDifference > 0)
      )
    ) {
      continue;
    }
    candidates.push({
      day: current.day,
      direction:
        currentDifference > 0 ? "btc_outperformed" : "dominance_outperformed",
      btcPrice: current.btcPrice,
      btcDominance: current.btcDominance,
    });
  }
  return candidates;
}
