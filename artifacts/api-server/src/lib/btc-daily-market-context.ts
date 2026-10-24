import { getDubaiDay } from "./btc-daily-performance.js";

const DAY_MS = 24 * 60 * 60 * 1000;

export type BtcDailyMarketPriceObservation = {
  observedAt: Date | string;
  price: number | null;
};

export type BtcDailyMarketDominanceObservation = {
  observedAt: Date | string;
  value: number;
  source: "coinglass" | "coingecko" | "signal_snapshot";
};

export type BtcDailyMarketContextPoint = {
  day: string;
  btcPrice: number | null;
  btcDominance: number | null;
  dominanceObservedAt: string | null;
  dominanceSource: "coinglass" | "coingecko" | "signal_snapshot" | null;
  btcChangePercent: number | null;
  dominanceChangePoints: number | null;
};

function validDate(value: Date | string): Date | null {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function validPrice(value: number | null): value is number {
  return value != null && Number.isFinite(value) && value > 0;
}

function validDominance(value: number): boolean {
  return Number.isFinite(value) && value > 0 && value <= 100;
}

function previousDay(day: string): string {
  return new Date(Date.parse(`${day}T12:00:00.000Z`) - DAY_MS)
    .toISOString()
    .slice(0, 10);
}

export function buildBtcDailyMarketContext(input: {
  days: readonly string[];
  now: Date;
  priceObservations: readonly BtcDailyMarketPriceObservation[];
  priceCandles: readonly { time: number; close: number | string }[];
  dominanceObservations: readonly BtcDailyMarketDominanceObservation[];
}): BtcDailyMarketContextPoint[] {
  if (input.days.length === 0) return [];

  const today = getDubaiDay(input.now);
  const firstDay = input.days[0]!;
  const previousFirstDay = previousDay(firstDay);
  const inPriceWindow = (day: string) =>
    day >= previousFirstDay && day <= today;
  const prices = new Map<string, { value: number; observedAt: number }>();

  for (const observation of input.priceObservations) {
    const at = validDate(observation.observedAt);
    if (!at || at > input.now || !validPrice(observation.price)) continue;
    const day = getDubaiDay(at);
    if (!inPriceWindow(day)) continue;
    const existing = prices.get(day);
    if (!existing || at.getTime() > existing.observedAt) {
      prices.set(day, { value: observation.price, observedAt: at.getTime() });
    }
  }

  // A complete daily candle is a fallback for missing snapshots, not a
  // replacement for an actual observed price on that Dubai day.
  for (const candle of input.priceCandles) {
    const closeAt = new Date(candle.time + DAY_MS);
    const value = Number(candle.close);
    if (
      !Number.isFinite(candle.time) ||
      closeAt > input.now ||
      !validPrice(value)
    ) {
      continue;
    }
    const day = getDubaiDay(closeAt);
    if (day >= today || !inPriceWindow(day) || prices.has(day)) continue;
    prices.set(day, { value, observedAt: closeAt.getTime() });
  }

  const dominanceByDay = new Map<
    string,
    {
      value: number;
      observedAt: number;
      source: BtcDailyMarketDominanceObservation["source"];
    }
  >();
  const sourcePriority = {
    signal_snapshot: 0,
    coingecko: 1,
    coinglass: 2,
  } as const;

  for (const observation of input.dominanceObservations) {
    const at = validDate(observation.observedAt);
    if (
      !at ||
      at > input.now ||
      !validDominance(observation.value) ||
      !["coinglass", "coingecko", "signal_snapshot"].includes(
        observation.source,
      )
    ) {
      continue;
    }
    const day = getDubaiDay(at);
    if (day < firstDay || day > today) continue;
    const existing = dominanceByDay.get(day);
    const betterSource =
      existing &&
      sourcePriority[observation.source] > sourcePriority[existing.source];
    const sameSourceAndLater =
      existing &&
      sourcePriority[observation.source] === sourcePriority[existing.source] &&
      at.getTime() > existing.observedAt;
    if (!existing || betterSource || sameSourceAndLater) {
      dominanceByDay.set(day, {
        value: observation.value,
        observedAt: at.getTime(),
        source: observation.source,
      });
    }
  }

  return input.days.map((day) => {
    const price = prices.get(day);
    const previousPrice = prices.get(previousDay(day));
    const dominance = dominanceByDay.get(day);
    const previousDominance = dominanceByDay.get(previousDay(day));
    return {
      day,
      btcPrice: price?.value ?? null,
      btcDominance: dominance?.value ?? null,
      dominanceObservedAt: dominance
        ? new Date(dominance.observedAt).toISOString()
        : null,
      dominanceSource: dominance?.source ?? null,
      btcChangePercent:
        price && previousPrice
          ? Number(
              (
                ((price.value - previousPrice.value) / previousPrice.value) *
                100
              ).toFixed(2),
            )
          : null,
      dominanceChangePoints:
        dominance && previousDominance
          ? Number((dominance.value - previousDominance.value).toFixed(2))
          : null,
    };
  });
}
