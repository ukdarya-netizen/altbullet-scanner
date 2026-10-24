import { timingSafeEqual } from "node:crypto";

const PATTERNS = new Set([
  "liquidation_cascade",
  "price_led_momentum",
  "impulse_buy",
  "neon_support_bounce",
]);
const TEN_MINUTES = 10 * 60_000;

function response(status, code, field) {
  return {
    status,
    body: { accepted: false, error: { code, field } },
  };
}

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function positiveString(value) {
  return (
    typeof value === "string" &&
    value.trim() !== "" &&
    Number.isFinite(Number(value)) &&
    Number(value) > 0
  );
}

function approx(value, expected) {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    Math.abs(value - expected) < 1e-8
  );
}

function sameSecret(actual, expected) {
  if (typeof actual !== "string" || typeof expected !== "string" || !expected) {
    return false;
  }
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Validate the exact Crypto Alt Bullet v2 ingress contract.
 * No exchange order is placed by this function.
 */
export function validateBulletSignal(s, now = Date.now()) {
  if (!object(s)) return response(400, "invalid_payload", "body");
  if (
    typeof s.sourceSignalId !== "string" ||
    !/^cab-signal-[1-9]\d*$/.test(s.sourceSignalId)
  ) {
    return response(400, "invalid_signal_id", "sourceSignalId");
  }
  if (s.confirmationStatus !== "confirmed" || s.patternStatus !== "approved") {
    return response(422, "unconfirmed_signal", "confirmationStatus");
  }
  if (!PATTERNS.has(s.patternId)) {
    return response(422, "pattern_not_approved", "patternId");
  }
  if (
    typeof s.signalAt !== "string" ||
    !/Z$/.test(s.signalAt) ||
    !Number.isFinite(Date.parse(s.signalAt))
  ) {
    return response(400, "invalid_timestamp", "signalAt");
  }
  const age = now - Date.parse(s.signalAt);
  if (age > TEN_MINUTES || age < -30_000) {
    return response(422, "expired_or_future_signal", "signalAt");
  }
  if (typeof s.symbol !== "string" || !/^[A-Z0-9]+USDT$/.test(s.symbol)) {
    return response(400, "invalid_symbol", "symbol");
  }
  if (
    s.side !== "buy" ||
    s.orderType !== "market" ||
    s.reduceOnly !== false ||
    Object.hasOwn(s, "takeProfit")
  ) {
    return response(422, "unsupported_order", "orderType");
  }
  for (const name of ["referencePrice", "limitPrice", "quantity", "stopLoss"]) {
    if (!positiveString(s[name])) return response(400, "invalid_number", name);
  }
  if (
    Number(s.referencePrice) !== Number(s.limitPrice) ||
    Number(s.stopLoss) >= Number(s.referencePrice)
  ) {
    return response(422, "invalid_entry_or_stop", "stopLoss");
  }
  const p = s.payload;
  if (
    !object(p) ||
    p.source !== "CryptoAltBullet" ||
    p.rulesVersion !== "bullet-long-exits-v2" ||
    p.marginMode !== "isolated" ||
    p.initialMarginUsd !== "10" ||
    p.leverage !== 10
  ) {
    return response(422, "unsupported_plan", "payload");
  }
  const r = p.exitRules;
  if (
    !object(r) ||
    r.priceMoveBasis !== "unleveraged_percent_from_actual_entry_fill" ||
    r.noFixedTakeProfit !== true ||
    r.rMultipleTargets !== false ||
    r.firstTargetAction !== "milestone_not_full_close" ||
    r.breakevenStopGainPct !== 0 ||
    r.breakevenIncludesFees !== false ||
    r.trailingGapBasis !== "percentage_points_of_entry_pnl" ||
    r.trailingStopNeverDecreases !== true ||
    r.trailingExitAction !== "close_remaining_position" ||
    r.expiryExitPrice !== "observed_market_quote" ||
    r.maxWatchDays !== 4 ||
    !object(r.partialProfitAdvice) ||
    r.partialProfitAdvice.execution !== "advice_only_not_automated" ||
    !approx(r.partialProfitAdvice.minFraction, 0.2) ||
    !approx(r.partialProfitAdvice.maxFraction, 0.25)
  ) {
    return response(422, "unsupported_exit_rules", "payload.exitRules");
  }
  const btc = s.symbol === "BTCUSDT";
  const ladderValid = btc
    ? r.firstTargetPct === 1 &&
      r.breakevenAtPct === 1 &&
      r.protectedProfitAtPct === 0 &&
      r.protectedProfitPct === 0 &&
      r.trailingActivationPct === 2 &&
      r.trailingGapPercentagePoints === 1 &&
      r.progressMilestoneIntervalPct === 1 &&
      !Object.hasOwn(r, "runner")
    : r.firstTargetPct === 10 &&
      r.breakevenAtPct === 5 &&
      r.protectedProfitAtPct === 10 &&
      r.protectedProfitPct === 5 &&
      r.trailingActivationPct === 15 &&
      r.trailingGapPercentagePoints === 10;
  if (!ladderValid) {
    return response(422, "unsupported_exit_ladder", "payload.exitRules");
  }
  if (!btc && s.patternId === "impulse_buy") {
    const runner = r.runner;
    if (
      !object(runner) ||
      runner.policyVersion !== "impulse_runner_v1" ||
      runner.coreExit !== "standard_trailing_stop" ||
      !approx(runner.coreFraction, 0.8) ||
      !approx(runner.runnerFraction, 0.2) ||
      runner.afterCoreEmergencyStop !== "original_entry_breakeven" ||
      runner.trailingActivationPct !== 30 ||
      runner.trailingGapPercentagePoints !== 30 ||
      runner.trailingGapBasis !== "percentage_points_of_entry_pnl" ||
      runner.maxAgeHoursFromOriginalEntry !== 120 ||
      runner.expiryExitPrice !== "observed_market_quote"
    ) {
      return response(422, "unsupported_runner", "payload.exitRules.runner");
    }
  } else if (Object.hasOwn(r, "runner")) {
    return response(422, "unexpected_runner", "payload.exitRules.runner");
  }
  return { status: 200, body: { accepted: true } };
}

/**
 * Framework-independent endpoint logic. `supportsPlan` must prove that the
 * existing worker implements the supplied exits; `enqueue` must durably,
 * atomically deduplicate sourceSignalId. Neither callback may place an order
 * during HTTP receipt. Missing callbacks fail closed.
 */
export async function ingestBulletSignal(
  { token, body },
  { expectedToken, supportsPlan, enqueue, now = Date.now } = {},
) {
  if (!sameSecret(token, expectedToken)) {
    return response(401, "unauthorized", "x-trading-token");
  }
  const valid = validateBulletSignal(body, now());
  if (valid.status !== 200) return valid;
  if (typeof supportsPlan !== "function" || typeof enqueue !== "function") {
    return response(503, "receiver_not_configured", "worker");
  }
  try {
    if ((await supportsPlan(body)) !== true) {
      return response(
        422,
        "executor_does_not_support_plan",
        "payload.exitRules",
      );
    }
    const saved = await enqueue(body);
    if (!object(saved) || saved.status !== "pending") {
      return response(503, "durable_queue_not_confirmed", "worker");
    }
    return {
      status: 202,
      body: {
        accepted: true,
        signal: { status: "pending", sourceSignalId: body.sourceSignalId },
      },
    };
  } catch {
    return response(503, "receiver_unavailable", "worker");
  }
}

/** Express adapter: register after express.json({ limit: "32kb" }). */
export function expressBulletHandler(options) {
  return async (req, res) => {
    const result = await ingestBulletSignal(
      { token: req.get("x-trading-token"), body: req.body },
      options,
    );
    res.status(result.status).json(result.body);
  };
}
