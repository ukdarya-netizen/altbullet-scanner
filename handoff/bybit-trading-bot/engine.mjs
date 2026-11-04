const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const APPROVED_PATTERNS = new Set([
  "liquidation_cascade",
  "price_led_momentum",
  "impulse_buy",
  "neon_support_bounce",
]);

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function finitePositive(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw new TypeError(`${name} must be a positive finite number`);
  }
  return number;
}

function asMillis(value, name) {
  const millis = value instanceof Date ? value.getTime() : typeof value === "number" ? value : Date.parse(value);
  if (!Number.isFinite(millis)) {
    throw new TypeError(`${name} must be a valid date, ISO timestamp, or epoch millisecond`);
  }
  return millis;
}

function isBitcoin(symbol) {
  return symbol === "BTCUSDT" || symbol === "BTC-USDT";
}

function isImpulseAlt(position) {
  return position.patternId === "impulse_buy" && !isBitcoin(position.symbol);
}

function priceAtGain(entryPrice, gainPct) {
  return entryPrice * (1 + gainPct / 100);
}

function quoteGainPct(entryPrice, price) {
  return ((price - entryPrice) / entryPrice) * 100;
}

function copyPosition(position) {
  return {
    ...position,
    rules: { ...position.rules },
    milestones: { ...position.milestones },
  };
}

function validateRules(patternId, symbol, rules) {
  if (!APPROVED_PATTERNS.has(patternId)) {
    throw new TypeError(`Unsupported approved pattern: ${patternId}`);
  }
  if (!isObject(rules)) throw new TypeError("signal.payload.exitRules is required");
  if (
    rules.noFixedTakeProfit !== true ||
    rules.rMultipleTargets !== false ||
    rules.firstTargetAction !== "milestone_not_full_close" ||
    rules.priceMoveBasis !== "unleveraged_percent_from_actual_entry_fill" ||
    rules.trailingGapBasis !== "percentage_points_of_entry_pnl" ||
    rules.trailingStopNeverDecreases !== true ||
    rules.trailingExitAction !== "close_remaining_position" ||
    rules.expiryExitPrice !== "observed_market_quote" ||
    rules.partialProfitAdvice?.execution !== "advice_only_not_automated"
  ) {
    throw new TypeError("Unsupported exit-rule semantics");
  }

  const btc = isBitcoin(symbol);
  const positiveFields = [
    "firstTargetPct",
    "breakevenAtPct",
    "trailingActivationPct",
    "trailingGapPercentagePoints",
    "maxWatchDays",
  ];
  for (const field of positiveFields) finitePositive(rules[field], `exitRules.${field}`);
  if (
    typeof rules.protectedProfitAtPct !== "number" ||
    !Number.isFinite(rules.protectedProfitAtPct) ||
    typeof rules.protectedProfitPct !== "number" ||
    !Number.isFinite(rules.protectedProfitPct) ||
    typeof rules.breakevenStopGainPct !== "number" ||
    !Number.isFinite(rules.breakevenStopGainPct)
  ) {
    throw new TypeError("Exit rules contain invalid stop thresholds");
  }

  if (btc) {
    if (
      rules.breakevenAtPct !== 1 ||
      rules.protectedProfitAtPct !== 0 ||
      rules.protectedProfitPct !== 0 ||
      rules.trailingActivationPct !== 2 ||
      rules.trailingGapPercentagePoints !== 1 ||
      rules.progressMilestoneIntervalPct !== 1 ||
      Object.hasOwn(rules, "runner")
    ) {
      throw new TypeError("Unsupported BTC exit ladder");
    }
  } else if (
    rules.firstTargetPct !== 10 ||
    rules.breakevenAtPct !== 5 ||
    rules.protectedProfitAtPct !== 10 ||
    rules.protectedProfitPct !== 5 ||
    rules.trailingActivationPct !== 15 ||
    rules.trailingGapPercentagePoints !== 10
  ) {
    throw new TypeError("Unsupported non-BTC exit ladder");
  }

  if (patternId === "impulse_buy" && !btc) {
    const runner = rules.runner;
    if (
      !isObject(runner) ||
      runner.policyVersion !== "impulse_runner_v1" ||
      runner.coreExit !== "standard_trailing_stop" ||
      !Number.isFinite(runner.coreFraction) ||
      Math.abs(runner.coreFraction - 0.8) >= 1e-8 ||
      !Number.isFinite(runner.runnerFraction) ||
      Math.abs(runner.runnerFraction - 0.2) >= 1e-8 ||
      runner.afterCoreEmergencyStop !== "original_entry_breakeven" ||
      runner.trailingActivationPct !== 30 ||
      runner.trailingGapPercentagePoints !== 30 ||
      runner.trailingGapBasis !== "percentage_points_of_entry_pnl" ||
      runner.maxAgeHoursFromOriginalEntry !== 120 ||
      runner.expiryExitPrice !== "observed_market_quote"
    ) {
      throw new TypeError("Unsupported Impulse Buy runner policy");
    }
  } else if (Object.hasOwn(rules, "runner")) {
    throw new TypeError("Runner rules are only supported for non-BTC Impulse Buy");
  }
}

/**
 * Create the persisted position snapshot after an entry fill is confirmed.
 * `price` must be the actual fill, not Bullet's reference price.
 */
export function initialPosition(signal, { price, quantity, at, mode }) {
  if (!isObject(signal)) throw new TypeError("signal must be an object");
  const entryPrice = finitePositive(price, "price");
  const totalQuantity = finitePositive(quantity, "quantity");
  const entryAtMs = asMillis(at, "at");
  if (mode !== "paper" && mode !== "live") {
    throw new TypeError('mode must be "paper" or "live"');
  }

  const rules = signal.payload?.exitRules;
  validateRules(signal.patternId, signal.symbol, rules);
  const initialStop = finitePositive(signal.stopLoss, "signal.stopLoss");
  if (initialStop >= entryPrice) {
    throw new TypeError("signal.stopLoss must be below the actual entry fill");
  }

  const splitRunner = signal.patternId === "impulse_buy" && !isBitcoin(signal.symbol);
  const coreQuantity = splitRunner
    ? Number((totalQuantity * rules.runner.coreFraction).toPrecision(14))
    : totalQuantity;
  const runnerQuantity = splitRunner ? totalQuantity - coreQuantity : 0;
  const entryAt = new Date(entryAtMs).toISOString();

  return {
    sourceSignalId: signal.sourceSignalId,
    symbol: signal.symbol,
    patternId: signal.patternId,
    signalAt: signal.signalAt,
    entryAt,
    entryPrice,
    quantity: totalQuantity,
    remainingQty: totalQuantity,
    coreQty: coreQuantity,
    runnerQty: runnerQuantity,
    stopPrice: initialStop,
    runnerStopPrice: null,
    peakPct: Math.max(0, quoteGainPct(entryPrice, entryPrice)),
    runnerPeakPct: 0,
    coreOpen: true,
    runnerOpen: false,
    status: "open",
    mode,
    rules: { ...rules },
    milestones: {
      breakevenReached: false,
      firstTargetReached: false,
    },
  };
}

function closeAll(next, quantity, actions, reason, price) {
  actions.push({
    type: "close_all",
    quantity,
    price,
    reason,
  });
  next.remainingQty = 0;
  next.coreOpen = false;
  next.runnerOpen = false;
  next.status = "closed";
}

function handleCoreStop(next, actions, price) {
  if (!isImpulseAlt(next) || !next.runnerOpen) {
    closeAll(next, next.remainingQty, actions, "protective_stop", price);
    return;
  }

  closeAll(next, next.remainingQty, actions, "runner_stop", price);
}

/**
 * Compute a proposed state transition for one observed market quote.
 *
 * This is deliberately side-effect-free. The caller must execute every
 * returned action successfully before persisting `next`; on exchange failure,
 * keep the original snapshot and reconcile the actual exchange position first.
 * The caller must also use `price` as the observed market quote for stop/expiry
 * closes rather than treating the stop threshold as a guaranteed fill price.
 */
export function evaluatePosition(position, { price, at }) {
  if (!isObject(position) || position.status !== "open") {
    throw new TypeError("position must be an open position snapshot");
  }
  const quote = finitePositive(price, "price");
  const now = asMillis(at, "at");
  const entry = finitePositive(position.entryPrice, "position.entryPrice");
  const next = copyPosition(position);
  const actions = [];
  const gainPct = quoteGainPct(entry, quote);
  const ageMs = now - asMillis(position.entryAt, "position.entryAt");
  if (ageMs < 0) throw new TypeError("at cannot be earlier than the position entry time");

  const impulseAlt = isImpulseAlt(position);

  // Stops already installed on the exchange are checked first. Do not update
  // the peak on a quote which has already crossed existing protection.
  if (position.coreOpen && quote <= position.stopPrice) {
    if (impulseAlt) {
      const coreQty = Math.min(position.coreQty, position.remainingQty);
      actions.push({
        type: "close_core",
        quantity: coreQty,
        price: quote,
        reason: "core_protective_stop",
      });
      next.remainingQty = Number((next.remainingQty - coreQty).toPrecision(14));
      next.coreOpen = false;
      next.runnerOpen = true;
      next.runnerStopPrice = entry;
      next.runnerPeakPct = Math.max(next.runnerPeakPct, next.peakPct, gainPct, 0);

      // If the observed quote is already below the runner's post-core
      // break-even protection, close that remainder at the observed quote too.
      if (quote <= entry) {
        closeAll(next, next.remainingQty, actions, "runner_breakeven_emergency_stop", quote);
      } else {
        actions.push({
          type: "raise_stop",
          quantity: next.remainingQty,
          stopPrice: entry,
          reason: "runner_breakeven_emergency_stop",
        });
      }
    } else {
      handleCoreStop(next, actions, quote);
    }
    return { next, actions };
  }

  if (position.runnerOpen && quote <= position.runnerStopPrice) {
    closeAll(next, position.remainingQty, actions, "runner_stop", quote);
    return { next, actions };
  }

  const runnerOnly = impulseAlt && !position.coreOpen && position.runnerOpen;
  const lifetimeMs = runnerOnly
    ? position.rules.runner.maxAgeHoursFromOriginalEntry * HOUR_MS
    : position.rules.maxWatchDays * DAY_MS;
  if (ageMs >= lifetimeMs) {
    if (impulseAlt && position.coreOpen) {
      // The ordinary four-day window belongs to the 80% core. The runner
      // retains its separate 120-hour clock measured from original entry.
      const coreQty = Math.min(position.coreQty, position.remainingQty);
      actions.push({
        type: "close_core",
        quantity: coreQty,
        price: quote,
        reason: "core_max_watch_expiry",
      });
      next.remainingQty = Number((next.remainingQty - coreQty).toPrecision(14));
      next.coreOpen = false;
      next.runnerOpen = true;
      next.runnerStopPrice = entry;
      next.runnerPeakPct = Math.max(next.runnerPeakPct, next.peakPct, gainPct, 0);
      if (quote <= entry) {
        closeAll(next, next.remainingQty, actions, "runner_breakeven_emergency_stop", quote);
      } else {
        actions.push({
          type: "raise_stop",
          quantity: next.remainingQty,
          stopPrice: entry,
          reason: "runner_breakeven_emergency_stop",
        });
      }
      return { next, actions };
    }
    closeAll(
      next,
      position.remainingQty,
      actions,
      runnerOnly ? "runner_max_age_expiry" : "max_watch_expiry",
      quote,
    );
    return { next, actions };
  }

  next.peakPct = Math.max(position.peakPct, gainPct, 0);
  if (position.runnerOpen) {
    next.runnerPeakPct = Math.max(position.runnerPeakPct, gainPct, 0);
  }
  next.milestones.breakevenReached =
    position.milestones.breakevenReached || next.peakPct >= position.rules.breakevenAtPct;
  next.milestones.firstTargetReached =
    position.milestones.firstTargetReached || next.peakPct >= position.rules.firstTargetPct;

  if (position.coreOpen) {
    const rules = position.rules;
    let protectedGain = null;
    if (next.peakPct >= rules.breakevenAtPct) {
      protectedGain = rules.breakevenStopGainPct;
    }
    if (rules.protectedProfitAtPct > 0 && next.peakPct >= rules.protectedProfitAtPct) {
      protectedGain = Math.max(protectedGain ?? -Infinity, rules.protectedProfitPct);
    }
    if (next.peakPct >= rules.trailingActivationPct) {
      protectedGain = Math.max(
        protectedGain ?? -Infinity,
        next.peakPct - rules.trailingGapPercentagePoints,
      );
    }
    if (protectedGain !== null) {
      const candidate = priceAtGain(entry, protectedGain);
      if (candidate > position.stopPrice) {
        next.stopPrice = candidate;
        actions.push({
          type: "raise_stop",
          quantity: position.coreOpen ? position.coreQty : position.remainingQty,
          stopPrice: candidate,
          reason: next.peakPct >= rules.trailingActivationPct
            ? "percentage_point_trailing_stop"
            : rules.protectedProfitAtPct > 0 &&
                next.peakPct >= rules.protectedProfitAtPct
              ? "protected_profit_floor"
              : "breakeven_stop",
        });
      }
    }
  }

  if (position.runnerOpen) {
    const runnerRules = position.rules.runner;
    let runnerGain = 0;
    if (next.runnerPeakPct >= runnerRules.trailingActivationPct) {
      runnerGain = Math.max(
        0,
        next.runnerPeakPct - runnerRules.trailingGapPercentagePoints,
      );
    }
    const candidate = priceAtGain(entry, runnerGain);
    if (candidate > position.runnerStopPrice) {
      next.runnerStopPrice = candidate;
      actions.push({
        type: "raise_stop",
        quantity: position.remainingQty,
        stopPrice: candidate,
        reason: next.runnerPeakPct >= runnerRules.trailingActivationPct
          ? "runner_percentage_point_trailing_stop"
          : "runner_breakeven_emergency_stop",
      });
    }
  }

  return { next, actions };
}