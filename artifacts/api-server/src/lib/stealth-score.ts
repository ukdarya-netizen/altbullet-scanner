// Stealth Range score (prepared 2026-10-21, NOT wired into the fire path).
// Fitted on 274 resolved Range signals (worker = +8% before -8% within 72h).
// Held-out AUC over 5 random folds: 0.65-0.70 (current score: 0.50).
// Points per quintile group = worker-share deviation from the mean; the sum is
// scaled linearly to 1..10. A missing metric adds 0 points.
// Caveats: nested slice, right-censored recent signals, rangeWidth/body only
// available for ~207 rows (decisions after 2026-10-10).

type Fit = { edges: number[]; points: number[] };

export const STEALTH_SCORE_FIT = {
  confirmDistPct: {
    edges: [0.24, 0.53, 1.051, 2.036],
    points: [-0.34, -0.49, 0.17, 0.32, 0.34],
  },
  oneHourVolumeRatio: {
    edges: [0.958, 0.988, 1.042, 1.444],
    points: [-0.31, -0.3, -0.49, 0.31, 0.4],
  },
  rangeWidthPct: {
    edges: [3.21, 4.37, 5.5, 7.46],
    points: [-0.81, -0.51, -0.14, 0.08, 0.77],
  },
  gateBodyPct: {
    edges: [0.785, 1.318, 1.94, 3.223],
    points: [-0.81, -0.41, -0.14, 0.08, 0.67],
  },
  futVolMult: {
    edges: [0.039, 0.059, 0.138, 0.905],
    points: [-0.4, -0.01, -0.1, 0.22, 0.37],
  },
  spotVolMult: {
    edges: [0.809, 1, 1.522, 2.548],
    points: [-0.45, -0.16, -0.18, 0.26, -0.19],
  },
  atrPct1h: {
    edges: [1.049, 1.29, 1.568, 2.112],
    points: [-0.84, 0.15, 0.07, -0.01, 0.32],
  },
  p24h: {
    edges: [1.208, 2.262, 3.517, 5.616],
    points: [-0.1, -0.42, -0.4, 0.43, 0.26],
  },
  oi4h: {
    edges: [0.467, 1.809, 3.292, 5.731],
    points: [-0.38, 0.01, 0.03, 0.01, 0.11],
  },
  cvd4h: { edges: [0, 0, 1, 1], points: [-0.3, 0, 0.1, 0, 0] },
} as const satisfies Record<string, Fit>;

export const STEALTH_SCORE_RAW_MIN = -4.8;
export const STEALTH_SCORE_RAW_MAX = 3.17;

export type StealthScoreInput = Partial<
  Record<keyof typeof STEALTH_SCORE_FIT, number | null | undefined>
>;

export function stealthScoreRaw(input: StealthScoreInput): number {
  let sum = 0;
  for (const key of Object.keys(STEALTH_SCORE_FIT) as Array<
    keyof typeof STEALTH_SCORE_FIT
  >) {
    const value = input[key];
    if (value == null || !Number.isFinite(value)) continue;
    const fit: Fit = STEALTH_SCORE_FIT[key];
    let group = 0;
    for (const edge of fit.edges) if (value > edge) group++;
    sum += fit.points[group] ?? 0;
  }
  return sum;
}

export function calcStealthScore(input: StealthScoreInput): number {
  const raw = stealthScoreRaw(input);
  const scaled =
    1 +
    (9 * (raw - STEALTH_SCORE_RAW_MIN)) /
      (STEALTH_SCORE_RAW_MAX - STEALTH_SCORE_RAW_MIN);
  return Math.min(10, Math.max(1, Math.round(scaled)));
}
