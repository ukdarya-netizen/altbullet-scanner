export type DedicatedCancellationPattern =
  | "bullish_accumulation"
  | "balanced_grind"
  | "liquidation_cascade"
  | "impulse_buy"
  | "price_led_momentum"
  | "stealth_breakout"
  | "neon_support_bounce"
  | "whale_watch";

export type CancellationReasonKind = "stale" | "smart" | "max_age";

export interface CancellationPolicy {
  pattern: DedicatedCancellationPattern | "default";
  /** Whether this pattern may be closed by automatic cancellation paths. */
  automaticCancellationEnabled: boolean;
  staleGraceHours: number | null;
  smartGraceHours: number;
  smartCancelEnabled: boolean;
  maxAgeHours: number;
  smartPnlThreshold: number;
  smartOiHoldPct: number;
  requiresCompleteConfirmation: boolean;
}

const DEFAULT_POLICY: CancellationPolicy = {
  pattern: "default",
  automaticCancellationEnabled: true,
  // Disabled after the mature production cohort since 2026-08-19 showed
  // 72.7% of stale-cancelled positions recovered within the observed 72h,
  // and 54.5% moved at least +5% after cancellation.
  staleGraceHours: null,
  // Raised from 4h → 6h: data shows most smart cancels fire after 6h anyway;
  // the 2-hour extension lets short-term CVD dips self-correct without
  // increasing false-negative rate (only 1 of 80 historical smart cancels
  // occurred between 4h and 6h, and it continued downward).
  smartGraceHours: 6,
  smartCancelEnabled: true,
  maxAgeHours: 72,
  smartPnlThreshold: -2,
  // Lowered from 1.5 → 1.0: block cancel even when OI4h gained only 1% in
  // 4h — a modest but real accumulation signal.  With the 1.5 threshold,
  // positions with OI recovery in the 1.0–1.5 % range were incorrectly
  // cancelled; 72h data shows ~30 % of deep-bucket smart cancels recovered.
  smartOiHoldPct: 1.0,
  requiresCompleteConfirmation: false,
};

const DEDICATED_POLICIES: Record<
  DedicatedCancellationPattern,
  CancellationPolicy
> = {
  bullish_accumulation: {
    pattern: "bullish_accumulation",
    // BA is an early accumulation thesis. Keep it open until a normal trade
    // exit (stop-loss, BE/profit protection, trailing, or expiry), matching
    // the no-cancellation contract already used by Stealth and PLM.
    automaticCancellationEnabled: false,
    staleGraceHours: null,
    smartGraceHours: 0,
    smartCancelEnabled: false,
    maxAgeHours: 72,
    smartPnlThreshold: -3,
    smartOiHoldPct: 1,
    requiresCompleteConfirmation: true,
  },
  balanced_grind: {
    pattern: "balanced_grind",
    automaticCancellationEnabled: true,
    staleGraceHours: null,
    smartGraceHours: 24,
    smartCancelEnabled: true,
    maxAgeHours: 96,
    smartPnlThreshold: -3,
    smartOiHoldPct: 0.5,
    requiresCompleteConfirmation: true,
  },
  liquidation_cascade: {
    pattern: "liquidation_cascade",
    automaticCancellationEnabled: true,
    staleGraceHours: null,
    smartGraceHours: 24,
    // Pause CVD smart-cancellation: the recent mature cohort discarded more
    // +10% recoveries than it avoided confirmed stops. Keep max-age independent.
    smartCancelEnabled: false,
    maxAgeHours: 120,
    smartPnlThreshold: -4,
    smartOiHoldPct: 0,
    requiresCompleteConfirmation: true,
  },
  impulse_buy: {
    pattern: "impulse_buy",
    // Impulse Buy's historical cancellations do not support the generic
    // one-hour stale path. The newer dedicated forward cohort also showed that
    // CVD-only cancellation can remove later recoveries, so keep the six-hour
    // smart path but require complete entry CVD plus current CVD/OI evidence.
    automaticCancellationEnabled: true,
    staleGraceHours: null,
    smartGraceHours: 6,
    smartCancelEnabled: true,
    maxAgeHours: 72,
    smartPnlThreshold: -2,
    smartOiHoldPct: 1,
    requiresCompleteConfirmation: true,
  },
  price_led_momentum: {
    pattern: "price_led_momentum",
    // Spot-led momentum must not be closed by lifecycle checks based on
    // derivatives participation. Normal trading exits remain independent.
    automaticCancellationEnabled: false,
    staleGraceHours: null,
    smartGraceHours: 0,
    smartCancelEnabled: false,
    maxAgeHours: 72,
    smartPnlThreshold: -2,
    smartOiHoldPct: 1,
    requiresCompleteConfirmation: false,
  },
  stealth_breakout: {
    pattern: "stealth_breakout",
    // Technical experiment: keep each signal open until a normal trade exit
    // (stop-loss, profit target, BE or trailing) establishes its outcome.
    automaticCancellationEnabled: false,
    staleGraceHours: null,
    smartGraceHours: 0,
    smartCancelEnabled: false,
    maxAgeHours: 72,
    smartPnlThreshold: -2,
    smartOiHoldPct: 1,
    requiresCompleteConfirmation: false,
  },
  whale_watch: {
    pattern: "whale_watch",
    // Experimental pattern: no automatic cancellation. The position stays open
    // until a normal trade exit (stop-loss, profit target, BE or trailing).
    automaticCancellationEnabled: false,
    staleGraceHours: null,
    smartGraceHours: 0,
    smartCancelEnabled: false,
    maxAgeHours: 72,
    smartPnlThreshold: -2,
    smartOiHoldPct: 1,
    requiresCompleteConfirmation: false,
  },
  neon_support_bounce: {
    pattern: "neon_support_bounce",
    // Like Stealth, this is a frozen technical event rather than an OI thesis.
    // Keep it open until a normal position exit establishes the outcome.
    automaticCancellationEnabled: false,
    staleGraceHours: null,
    smartGraceHours: 0,
    smartCancelEnabled: false,
    maxAgeHours: 72,
    smartPnlThreshold: -2,
    smartOiHoldPct: 1,
    requiresCompleteConfirmation: false,
  },
};

export function getCancellationPolicy(
  sentimentKey: string | null | undefined,
): CancellationPolicy {
  if (
    sentimentKey &&
    Object.hasOwn(DEDICATED_POLICIES, sentimentKey) &&
    sentimentKey in DEDICATED_POLICIES
  ) {
    return DEDICATED_POLICIES[sentimentKey as DedicatedCancellationPattern];
  }
  return DEFAULT_POLICY;
}

export function isDedicatedCancellationPattern(
  policy: CancellationPolicy,
): policy is CancellationPolicy & {
  pattern: DedicatedCancellationPattern;
} {
  return policy.pattern !== "default";
}

export function isAutomaticCancellationEnabled(
  policy: CancellationPolicy,
): boolean {
  return policy.automaticCancellationEnabled;
}

export function canStartStaleEvaluation(
  policy: CancellationPolicy,
  ageHours: number,
): boolean {
  return (
    isAutomaticCancellationEnabled(policy) &&
    policy.staleGraceHours !== null &&
    ageHours >= policy.staleGraceHours
  );
}

export interface StaleEvaluationPlan {
  runNormalStale: boolean;
  evaluateMaxAge: boolean;
}

/**
 * Normal stale and max-age are separate paths. In particular, LC skips normal
 * stale entirely but must still reach its own 120-hour max-age decision.
 */
export function getStaleEvaluationPlan(
  policy: CancellationPolicy,
  ageHours: number,
): StaleEvaluationPlan {
  if (!isAutomaticCancellationEnabled(policy)) {
    return {
      runNormalStale: false,
      evaluateMaxAge: false,
    };
  }
  return {
    runNormalStale: canStartStaleEvaluation(policy, ageHours),
    evaluateMaxAge: ageHours >= policy.maxAgeHours,
  };
}

export interface CancellationConfirmation {
  entryCvd1h: boolean | null;
  entryCvd4h: boolean | null;
  currentCvd30m: boolean | null;
  currentCvd1h: boolean | null;
  oi30m: number | null;
  oi4h: number | null;
  oiAvailable: boolean;
}

/**
 * Generic smart-cancel keeps the historical rule: it only blocks when both
 * entry CVD snapshots are absent. Dedicated policies require both snapshots.
 */
export function hasEntryCvdForSmartCancellation(
  policy: CancellationPolicy,
  entryCvd1h: boolean | null,
  entryCvd4h: boolean | null,
): boolean {
  return policy.requiresCompleteConfirmation
    ? entryCvd1h !== null && entryCvd4h !== null
    : entryCvd1h !== null || entryCvd4h !== null;
}

/**
 * Dedicated policies are deliberately fail-closed. A missing CVD/OI field is
 * insufficient evidence to end a slower accumulation/cascade position.
 */
export function hasCompleteCancellationConfirmation(
  policy: CancellationPolicy,
  confirmation: CancellationConfirmation,
): boolean {
  if (!policy.requiresCompleteConfirmation) return true;
  return (
    confirmation.entryCvd1h !== null &&
    confirmation.entryCvd4h !== null &&
    confirmation.currentCvd30m !== null &&
    confirmation.currentCvd1h !== null &&
    confirmation.oiAvailable &&
    confirmation.oi30m !== null &&
    confirmation.oi4h !== null
  );
}

/**
 * Impulse Buy's stricter evidence requirement belongs to its six-hour smart
 * cancellation only. Its 72-hour max-age path keeps the existing independent
 * OI30m + spot-CVD outflow gate instead of inheriting every smart-cancel field.
 */
export function shouldRequireCompleteCancellationConfirmation(
  policy: CancellationPolicy,
  ageHours: number,
): boolean {
  return (
    policy.requiresCompleteConfirmation &&
    !(policy.pattern === "impulse_buy" && ageHours >= policy.maxAgeHours)
  );
}

export function cancelReasonFor(
  kind: CancellationReasonKind,
  policy: CancellationPolicy,
): string {
  switch (kind) {
    case "stale":
      return "stale_oi_vol";
    case "smart":
      return policy.pattern === "impulse_buy"
        ? "impulse_smart_cancel_cvd"
        : "smart_cancel_cvd";
    case "max_age":
      return policy.pattern === "impulse_buy"
        ? `impulse_max_age_${policy.maxAgeHours}h`
        : `max_age_${policy.maxAgeHours}h`;
  }
}

export function calculatePrice72hAfterExitPct(
  exitPrice: number,
  priceAfter72h: number,
  isShort: boolean,
): number | null {
  if (
    !Number.isFinite(exitPrice) ||
    !Number.isFinite(priceAfter72h) ||
    exitPrice <= 0 ||
    priceAfter72h <= 0
  ) {
    return null;
  }
  const pnl = isShort
    ? ((exitPrice - priceAfter72h) / exitPrice) * 100
    : ((priceAfter72h - exitPrice) / exitPrice) * 100;
  return Number(pnl.toFixed(4));
}
