// Liquidation Cascade score fitted on 3 389 completed decisions (fired, missed,
// rejected) with the worker label "+8% before -8% within 72h" (15m candles).
// Held-out AUC over 5 random folds: 0.62-0.64 on fired+missed, 0.64-0.67 on
// fired (the previous score scored 0.43). Metrics were kept only when AUC was
// >=0.55 or <=0.45 with the same direction on all decisions and fired+missed.
// Points per quintile group are the worker-share deviation from the mean;
// the sum is scaled linearly to 1..10. A missing metric adds 0 points.
// BingX-only metrics (order book ratio) are deliberately absent.

type Fit = { edges: number[]; points: number[] };

export const LC_SCORE_FIT = {
  liq4h: {
    edges: [73288.805, 107586.21, 179905.72, 432457],
    points: [-0.08, 0.03, -0.22, -0.11, -0.38],
  },
  liqRatio: {
    edges: [0.394, 0.524, 0.649, 0.841],
    points: [-0.07, 0.18, 0.38, 0.22, 0.52],
  },
  p24h: {
    edges: [-5.7, -1.64, -0.03, 0.09],
    points: [0.48, 0.26, -0.13, -0.54, 0.05],
  },
  volMcap: {
    edges: [0.24, 0.69, 1.62, 6.76],
    points: [-0.77, -0.25, 0.04, 0.05, 0.15],
  },
  spotTaker: {
    edges: [3.475, 10.935, 25.813, 42.99],
    points: [-0.11, 0.34, 0.13, 0.1, 0.48],
  },
  whale: {
    edges: [-24.365, 32.12, 74.965, 142.505],
    points: [-0.28, 0.08, 0.21, 0.44, 0.39],
  },
} as const satisfies Record<string, Fit>;

export const LC_SCORE_RAW_MIN = -1.69;
export const LC_SCORE_RAW_MAX = 1.78;

export type LcScoreInput = {
  /** Long liquidations over 4h at detection, USD. */
  liq4h: number | null | undefined;
  /** Long liquidations 1h / 24h at detection. */
  liqRatio: number | null | undefined;
  /** 24h price change in percent. */
  p24h: number | null | undefined;
  /** Spot 24h volume / market cap, percent. */
  volMcap: number | null | undefined;
  /** Aggregated spot taker net buy, percent. */
  spotTaker: number | null | undefined;
  /** Whale index. */
  whale: number | null | undefined;
};

function groupPoints(value: number | null | undefined, fit: Fit): number {
  if (value == null || !Number.isFinite(value)) return 0;
  let group = 0;
  for (const edge of fit.edges) if (value > edge) group++;
  return fit.points[group] ?? 0;
}

export function lcScoreRaw(input: LcScoreInput): number {
  return (
    groupPoints(input.liq4h, LC_SCORE_FIT.liq4h) +
    groupPoints(input.liqRatio, LC_SCORE_FIT.liqRatio) +
    groupPoints(input.p24h, LC_SCORE_FIT.p24h) +
    groupPoints(input.volMcap, LC_SCORE_FIT.volMcap) +
    groupPoints(input.spotTaker, LC_SCORE_FIT.spotTaker) +
    groupPoints(input.whale, LC_SCORE_FIT.whale)
  );
}

/** Score 1..10; rises with the historical worker share. */
export function calcLcScore(input: LcScoreInput): number {
  const raw = lcScoreRaw(input);
  const scaled =
    1 + (9 * (raw - LC_SCORE_RAW_MIN)) / (LC_SCORE_RAW_MAX - LC_SCORE_RAW_MIN);
  return Math.min(10, Math.max(1, Math.round(scaled)));
}
