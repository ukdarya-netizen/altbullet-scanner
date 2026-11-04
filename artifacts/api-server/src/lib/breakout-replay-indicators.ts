import type { BreakoutCandle } from "./breakout-analysis.js";
import { analyzeAltBulletIndicator } from "./altbullet-indicator.js";
import { detectAutoRangePine } from "./auto-range-pine.js";

const HOUR = 60 * 60_000;
export const REPLAY_INDICATOR_4H_BARS = 900;
export const REPLAY_INDICATOR_1H_BARS = 800;

function prefixAt(
  candles: readonly BreakoutCandle[],
  interval: number,
  at: number,
  count: number,
): BreakoutCandle[] {
  return candles.filter((candle) => candle.time + interval <= at).slice(-count);
}

function historyProblem(
  candles: readonly BreakoutCandle[],
  interval: number,
  minimum: number,
  at: number,
  label: string,
): string | null {
  if (candles.length < minimum)
    return `Недостаточно закрытых ${label}-свечей на дату события: ${candles.length}/${minimum}`;
  if (at - (candles.at(-1)!.time + interval) >= interval)
    return `${label}-свечи устарели на дату события`;
  if (
    candles.some(
      (candle, index) =>
        !Number.isFinite(candle.close) ||
        candle.close <= 0 ||
        (index > 0 && candle.time - candles[index - 1]!.time !== interval),
    )
  )
    return `Неполная история закрытых ${label}-свечей`;
  return null;
}

function contextNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function buildBreakoutReplayIndicators(input: {
  eventAt: number;
  candles4h: readonly BreakoutCandle[];
  candles1h: readonly BreakoutCandle[];
  error4h?: boolean;
  error1h?: boolean;
}) {
  const { eventAt } = input;
  const candles4h = prefixAt(
    input.candles4h,
    4 * HOUR,
    eventAt,
    REPLAY_INDICATOR_4H_BARS,
  );
  const candles1h = prefixAt(
    input.candles1h,
    HOUR,
    eventAt,
    REPLAY_INDICATOR_1H_BARS,
  );
  const problem4h = input.error4h
    ? "Не удалось загрузить исторические 4H-свечи BingX"
    : historyProblem(
        candles4h,
        4 * HOUR,
        REPLAY_INDICATOR_4H_BARS,
        eventAt,
        "4H",
      );
  const problem1h = input.error1h
    ? "Не удалось загрузить исторические 1H-свечи BingX"
    : historyProblem(candles1h, HOUR, 760, eventAt, "1H");
  const unknownRange = {
    status: "unknown" as const,
    reason: problem4h ?? "История 4H недоступна",
    activeConfirmedRange: null,
    latestUpsideBreakout: null,
  };
  const rangeDetector = problem4h
    ? unknownRange
    : detectAutoRangePine(candles4h);
  const reading =
    !problem4h && !problem1h
      ? analyzeAltBulletIndicator({
          candles4h,
          candles1h,
          requestedAt: new Date(eventAt),
        })
      : null;
  const ready = reading?.status === "ready";
  const context = ready ? reading.context : null;
  const lastClosed4hAt = candles4h.length
    ? new Date(candles4h.at(-1)!.time + 4 * HOUR).toISOString()
    : null;
  const lastClosed1hAt = candles1h.length
    ? new Date(candles1h.at(-1)!.time + HOUR).toISOString()
    : null;
  return {
    asOf: new Date(eventAt).toISOString(),
    abNeon: {
      status: ready ? ("ready" as const) : ("unknown" as const),
      reason: problem4h ?? problem1h ?? reading?.error ?? "",
      source: "BingX Futures" as const,
      lastClosed4hAt,
      lastClosed1hAt,
      support: ready ? contextNumber(context?.nearestSupport) : null,
      resistance: ready ? contextNumber(context?.nearestResistance) : null,
      range4hState: ready
        ? String(context?.range4hState ?? "unknown")
        : "unknown",
      range4hUpper: ready ? contextNumber(context?.range4hUpper) : null,
      range4hLower: ready ? contextNumber(context?.range4hLower) : null,
      range1hState: ready
        ? String(context?.range1hState ?? "unknown")
        : "unknown",
      range1hUpper: ready ? contextNumber(context?.range1hUpper) : null,
      range1hLower: ready ? contextNumber(context?.range1hLower) : null,
    },
    rangeDetector: {
      ...rangeDetector,
      source: "BingX Futures" as const,
      historyCandles: candles4h.length,
    },
    candles4h: candles4h.slice(-80),
  };
}
