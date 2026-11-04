export type PositionHealthState = "hold" | "exit" | "follow" | "neutral";

export type PositionHealthMetrics = {
  oiPct: number | null;
  turnover: number | null;
  cvdBadCount: number;
};

export type PositionHealthClassification = {
  state: PositionHealthState;
  oiGood: boolean;
  volGood: boolean;
  oiBad: boolean;
  volBad: boolean;
  cvdBad: boolean;
};

export type HealthPriceShadow = {
  state: PositionHealthState;
  reason:
    | "confirmed"
    | "not_confirmed"
    | "missing_price"
    | "missing_reference"
    | "reference_before_entry"
    | "no_health_state";
  price1hPct: number | null;
  price4hPct: number | null;
  reference1hAt: Date | null;
  reference4hAt: Date | null;
};

/**
 * An observation-only hypothesis. References must be closed before the check,
 * close to the requested lookback, and never reconstructed from future prices.
 * Thresholds are fixed before the forward cohort begins; do not tune on it.
 */
export function classifyPriceConfirmedHealth(input: {
  state: PositionHealthState;
  price: number;
  at: Date;
  positionOpenedAt: Date;
  candles: ReadonlyArray<{ time: number; close: string }>;
}): HealthPriceShadow {
  const empty = {
    state: "neutral" as const,
    price1hPct: null,
    price4hPct: null,
    reference1hAt: null,
    reference4hAt: null,
  };
  if (input.state === "neutral") {
    return { ...empty, reason: "no_health_state" };
  }
  if (!Number.isFinite(input.price) || input.price <= 0) {
    return { ...empty, reason: "missing_price" };
  }
  const now = input.at.getTime();
  const intervalMs = 30 * 60_000;
  function reference(hours: number) {
    const target = now - hours * 60 * 60_000;
    const candle = input.candles
      .filter((c) => {
        const closeAt = c.time + intervalMs;
        return (
          closeAt <= target &&
          closeAt >= target - intervalMs - 5 * 60_000 &&
          Number.isFinite(Number(c.close)) &&
          Number(c.close) > 0
        );
      })
      .sort((a, b) => b.time - a.time)[0];
    return candle
      ? { price: Number(candle.close), at: new Date(candle.time + intervalMs) }
      : null;
  }
  const ref1h = reference(1);
  const ref4h = reference(4);
  if (!ref1h || !ref4h) {
    return {
      ...empty,
      reason: "missing_reference",
      reference1hAt: ref1h?.at ?? null,
      reference4hAt: ref4h?.at ?? null,
    };
  }
  if (
    ref1h.at.getTime() < input.positionOpenedAt.getTime() ||
    ref4h.at.getTime() < input.positionOpenedAt.getTime()
  ) {
    return {
      ...empty,
      reason: "reference_before_entry",
      reference1hAt: ref1h.at,
      reference4hAt: ref4h.at,
    };
  }
  const price1hPct = (input.price / ref1h.price - 1) * 100;
  const price4hPct = (input.price / ref4h.price - 1) * 100;
  const confirmed =
    input.state === "hold"
      ? price1hPct >= 0.5 && price4hPct >= 0.5
      : input.state === "follow"
        ? price1hPct <= -0.5 && price4hPct <= 0
        : price1hPct <= -1 && price4hPct <= -1;
  return {
    state: confirmed ? input.state : "neutral",
    reason: confirmed ? "confirmed" : "not_confirmed",
    price1hPct,
    price4hPct,
    reference1hAt: ref1h.at,
    reference4hAt: ref4h.at,
  };
}

const HOLD_DOWNGRADE_PATTERNS = new Set([
  "bullish_accumulation",
  "impulse_buy",
  "liquidation_cascade",
  "price_led_momentum",
]);

const ORDINARY_HEALTH_COOLDOWN_MS = 12 * 60 * 60_000;
const ORDINARY_HEALTH_LIMIT = 2;

export type HealthNotificationDecision = {
  shouldSend: boolean;
  nextPendingState: PositionHealthState | null;
  nextPendingCount: number;
  nextSentTypes: PositionHealthState[];
  nextOrdinarySentCount: number;
  nextLastOrdinaryAt: Date | null;
  reason:
    | "neutral"
    | "awaiting_confirmation"
    | "already_sent"
    | "ordinary_limit"
    | "ordinary_cooldown"
    | "send";
};

/**
 * Classifies the presentation-only accompaniment state for an open position.
 * Missing metrics never count as negative evidence.
 */
export function classifyPositionHealth(
  metrics: PositionHealthMetrics,
): PositionHealthClassification {
  const oiGood = metrics.oiPct !== null && metrics.oiPct > 3;
  const volGood = metrics.turnover !== null && metrics.turnover >= 0.1;
  const oiBad = metrics.oiPct !== null && metrics.oiPct < -3;
  const volBad = metrics.turnover !== null && metrics.turnover < 0.08;
  const cvdBad = metrics.cvdBadCount >= 2;
  const negativeCategories = [oiBad, volBad, cvdBad].filter(Boolean).length;
  const exit = negativeCategories >= 2;

  // СЛЕДИ requires two independent, material weakening categories. Tiny
  // negative OI readings and a single red 15m CVD candle are normal noise.
  const weakeningCategories = [
    metrics.oiPct !== null && metrics.oiPct <= -1,
    metrics.turnover !== null && metrics.turnover < 0.08,
    metrics.cvdBadCount >= 2,
  ].filter(Boolean).length;
  const follow = weakeningCategories >= 2;
  const hold = !exit && (oiGood || volGood);

  return {
    state: exit ? "exit" : hold ? "hold" : follow ? "follow" : "neutral",
    oiGood,
    volGood,
    oiBad,
    volBad,
    cvdBad,
  };
}

/**
 * Applies presentation-only pattern calibration after the metric classifier.
 * Unconfirmed HOLD advice is suppressed rather than relabelled as FOLLOW:
 * the latter must retain its own weakening-evidence meaning.
 */
export function calibratePositionHealthMessage(
  state: PositionHealthState,
  sentimentKey: string | null,
): PositionHealthState {
  if (
    state === "hold" &&
    sentimentKey !== null &&
    HOLD_DOWNGRADE_PATTERNS.has(sentimentKey)
  ) {
    return "neutral";
  }
  return state;
}

/**
 * Persistent anti-spam policy for user-facing position-health messages.
 * Every non-neutral state needs two consecutive evaluations. Ordinary
 * HOLD/FOLLOW messages are capped and cooled down; EXIT bypasses only those
 * ordinary limits, never the confirmation or same-type deduplication.
 */
export function decideHealthNotification(input: {
  state: PositionHealthState;
  pendingState: string | null;
  pendingCount: number;
  sentTypes: string[];
  ordinarySentCount: number;
  lastOrdinaryAt: Date | null;
  now: Date;
}): HealthNotificationDecision {
  const sentTypes = input.sentTypes.filter(
    (value): value is PositionHealthState =>
      value === "hold" || value === "follow" || value === "exit",
  );

  if (input.state === "neutral") {
    return {
      shouldSend: false,
      nextPendingState: null,
      nextPendingCount: 0,
      nextSentTypes: sentTypes,
      nextOrdinarySentCount: input.ordinarySentCount,
      nextLastOrdinaryAt: input.lastOrdinaryAt,
      reason: "neutral",
    };
  }

  const nextPendingCount =
    input.pendingState === input.state ? input.pendingCount + 1 : 1;
  if (nextPendingCount < 2) {
    return {
      shouldSend: false,
      nextPendingState: input.state,
      nextPendingCount,
      nextSentTypes: sentTypes,
      nextOrdinarySentCount: input.ordinarySentCount,
      nextLastOrdinaryAt: input.lastOrdinaryAt,
      reason: "awaiting_confirmation",
    };
  }

  if (sentTypes.includes(input.state)) {
    return {
      shouldSend: false,
      nextPendingState: null,
      nextPendingCount: 0,
      nextSentTypes: sentTypes,
      nextOrdinarySentCount: input.ordinarySentCount,
      nextLastOrdinaryAt: input.lastOrdinaryAt,
      reason: "already_sent",
    };
  }

  const ordinary = input.state === "hold" || input.state === "follow";
  if (ordinary && input.ordinarySentCount >= ORDINARY_HEALTH_LIMIT) {
    return {
      shouldSend: false,
      nextPendingState: null,
      nextPendingCount: 0,
      nextSentTypes: sentTypes,
      nextOrdinarySentCount: input.ordinarySentCount,
      nextLastOrdinaryAt: input.lastOrdinaryAt,
      reason: "ordinary_limit",
    };
  }
  if (
    ordinary &&
    input.lastOrdinaryAt !== null &&
    input.now.getTime() - input.lastOrdinaryAt.getTime() <
      ORDINARY_HEALTH_COOLDOWN_MS
  ) {
    return {
      shouldSend: false,
      nextPendingState: input.state,
      nextPendingCount,
      nextSentTypes: sentTypes,
      nextOrdinarySentCount: input.ordinarySentCount,
      nextLastOrdinaryAt: input.lastOrdinaryAt,
      reason: "ordinary_cooldown",
    };
  }

  return {
    shouldSend: true,
    nextPendingState: null,
    nextPendingCount: 0,
    nextSentTypes: [...sentTypes, input.state],
    nextOrdinarySentCount: input.ordinarySentCount + (ordinary ? 1 : 0),
    nextLastOrdinaryAt: ordinary ? input.now : input.lastOrdinaryAt,
    reason: "send",
  };
}
