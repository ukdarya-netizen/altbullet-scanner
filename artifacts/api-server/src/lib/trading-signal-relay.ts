import { randomUUID } from "node:crypto";
import { pool } from "@workspace/db";
import { ACTIVE_PATTERN_KEYS } from "./dead-patterns.js";
import { logger } from "./logger.js";
import {
  getBuStopMilestone,
  getBuStopProtectedProfitPct,
  hasNoProfitStopPromotion,
  getExitProfile,
  getMaxWatchDays,
  SINGLE_ENTRY_POLICY_VERSION,
  STOP_LOSS,
  PATTERN_MAX_STOP,
} from "./watcher-config.js";
import {
  IMPULSE_RUNNER_CORE_WEIGHT,
  IMPULSE_RUNNER_POLICY_VERSION,
  IMPULSE_RUNNER_TRAILING_ACTIVATION_PCT,
  IMPULSE_RUNNER_TRAILING_GAP_PCT,
} from "./impulse-runner-policy.js";

export const TRADING_SIGNAL_ENDPOINT =
  "https://bybit-trading-bot.replit.app/api/trading/signals";
export const TRADING_SIGNAL_TTL_MS = 10 * 60_000;
const RELAY_INTERVAL_MS = 15_000;
// Owner decision 2026-10-03: every active pattern is relayed.
export const RELAY_PATTERN_KEYS = [...ACTIVE_PATTERN_KEYS];
// The receiver's documented order contract requires an explicit quantity.
// This is the user's initial $10 isolated margin at 10x, not a loss limit.
const INITIAL_MARGIN_USD = 10;
const LEVERAGE = 10;
const EXIT_RULES_VERSION = "bullet-long-exits-v2";

export const RELAY_PATTERN_RULES = Object.fromEntries(
  RELAY_PATTERN_KEYS.map((key) => {
    const exit = getExitProfile(key);
    return [
      key,
      {
        priceMoveBasis: "unleveraged_percent_from_actual_entry_fill",
        rMultipleTargets: false,
        noFixedTakeProfit: true,
        partialProfitAdvice: {
          minFraction: 0.2,
          maxFraction: 0.25,
          execution: "advice_only_not_automated",
        },
        firstTargetPct: exit.firstTarget,
        firstTargetAction: "milestone_not_full_close",
        breakevenAtPct: getBuStopMilestone(key),
        breakevenStopGainPct: 0,
        breakevenIncludesFees: false,
        protectedProfitAtPct: hasNoProfitStopPromotion(key) ? 0 : 10,
        protectedProfitPct: hasNoProfitStopPromotion(key)
          ? 0
          : getBuStopProtectedProfitPct(key),
        trailingActivationPct: exit.trailingActivation,
        trailingGapPercentagePoints: exit.trailingGap,
        trailingGapBasis: "percentage_points_of_entry_pnl",
        trailingStopNeverDecreases: true,
        trailingExitAction: "close_remaining_position",
        maxWatchDays: getMaxWatchDays(key),
        expiryExitPrice: "observed_market_quote",
        ...(key === "impulse_buy"
          ? {
              runner: {
                policyVersion: IMPULSE_RUNNER_POLICY_VERSION,
                coreFraction: IMPULSE_RUNNER_CORE_WEIGHT,
                runnerFraction: 1 - IMPULSE_RUNNER_CORE_WEIGHT,
                coreExit: "standard_trailing_stop",
                afterCoreEmergencyStop: "original_entry_breakeven",
                trailingActivationPct: IMPULSE_RUNNER_TRAILING_ACTIVATION_PCT,
                trailingGapPercentagePoints: IMPULSE_RUNNER_TRAILING_GAP_PCT,
                trailingGapBasis: "percentage_points_of_entry_pnl",
                maxAgeHoursFromOriginalEntry: 120,
                expiryExitPrice: "observed_market_quote",
              },
            }
          : {}),
      },
    ];
  }),
);

function isBitcoinSymbol(symbol: string): boolean {
  return symbol === "BTC-USDT" || symbol === "BTCUSDT";
}

export const BTC_RELAY_PATTERN_RULES = Object.fromEntries(
  RELAY_PATTERN_KEYS.map((key) => {
    const exit = getExitProfile(key, "BTC-USDT");
    const baseRules = { ...RELAY_PATTERN_RULES[key] };
    // BTC has one stop ladder; the altcoin impulse runner must not replace it.
    delete baseRules.runner;
    return [
      key,
      {
        ...baseRules,
        firstTargetPct: exit.firstTarget,
        breakevenAtPct: getBuStopMilestone(key, "BTC-USDT"),
        // BTC protection is the +1% BE followed by the +2% peak-minus-1pp
        // trail; the generic +10% => +5% floor is intentionally disabled.
        protectedProfitAtPct: 0,
        protectedProfitPct: 0,
        trailingActivationPct: exit.trailingActivation,
        trailingGapPercentagePoints: exit.trailingGap,
        progressMilestoneIntervalPct: 1,
      },
    ];
  }),
) as Record<
  string,
  (typeof RELAY_PATTERN_RULES)[string] & {
    progressMilestoneIntervalPct: number;
  }
>;

export type TradingSignalPayload = {
  sourceSignalId: string;
  confirmationStatus: "confirmed";
  patternId: (typeof RELAY_PATTERN_KEYS)[number];
  patternStatus: "approved";
  symbol: string;
  signalAt: string;
  referencePrice: string;
  side: "buy";
  orderType: "market";
  quantity: string;
  limitPrice: string;
  stopLoss: string;
  stopLossPct: string | null;
  reduceOnly: false;
  payload: {
    source: "CryptoAltBullet";
    rulesVersion: typeof EXIT_RULES_VERSION;
    marginMode: "isolated";
    initialMarginUsd: string;
    leverage: number;
    exitRules: (typeof RELAY_PATTERN_RULES)[string];
  };
};

export function classifySignalReceipt(
  status: number,
  body: unknown,
): "delivered" | "quarantined" | "retry" {
  if (status === 202) {
    if (
      body &&
      typeof body === "object" &&
      "accepted" in body &&
      body.accepted === true &&
      "signal" in body &&
      body.signal &&
      typeof body.signal === "object" &&
      "status" in body.signal &&
      body.signal.status === "pending"
    ) {
      return "delivered";
    }
    return "retry";
  }
  if ([400, 409, 422].includes(status)) return "quarantined";
  return "retry";
}

function isAwaitingRulesReceipt(body: unknown): boolean {
  return (
    body !== null &&
    typeof body === "object" &&
    "signal" in body &&
    body.signal !== null &&
    typeof body.signal === "object" &&
    "status" in body.signal &&
    body.signal.status === "awaiting_rules"
  );
}

/** Publish owns schema creation; startup only checks availability and seeds
 * the single activation time (never reset on restart). */
export async function ensureTradingSignalRelaySchema(): Promise<void> {
  await pool.query(
    "SELECT source_signal_id FROM trading_signal_deliveries LIMIT 0",
  );
  await pool.query(`
    INSERT INTO trading_signal_relay_settings (singleton)
    VALUES (true) ON CONFLICT (singleton) DO NOTHING
  `);
}

export const CAPTURE_CONFIRMED_SIGNALS_SQL = `
    INSERT INTO trading_signal_deliveries
      (source_signal_id, signal_at, payload)
    SELECT s.id, s.detected_at AT TIME ZONE 'UTC',
      jsonb_build_object(
        'sourceSignalId', 'cab-signal-' || s.id::text,
        'confirmationStatus', 'confirmed',
        'patternId', s.sentiment_key,
        'patternStatus', 'approved',
        'symbol', replace(upper(s.symbol), '-', ''),
        'signalAt', to_char(s.detected_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'referencePrice', t.entry_price::numeric::text,
        'side', 'buy',
        'orderType', 'market',
        'quantity', trunc(($4::numeric * $5::numeric) / t.entry_price::numeric, 8)::text,
        'limitPrice', t.entry_price::numeric::text,
        'stopLoss', trim_scale(round(stop_plan.price, 12))::text,
        'stopLossPct', trim_scale(stop_plan.pct)::text,
        'reduceOnly', false,
        'payload', jsonb_build_object(
          'source', 'CryptoAltBullet',
          'rulesVersion', '${EXIT_RULES_VERSION}',
          'marginMode', 'isolated',
          'initialMarginUsd', $4::numeric::text,
          'leverage', $5::integer,
         'exitRules', CASE
           WHEN replace(upper(s.symbol), '-', '') = 'BTCUSDT'
             THEN $7::jsonb -> s.sentiment_key
           ELSE $3::jsonb -> s.sentiment_key
         END
        )
      )
    FROM signals s
    JOIN tracked_signals t
      ON t.signal_id = s.id AND t.sentiment_key = s.sentiment_key
    CROSS JOIN trading_signal_relay_settings cfg
    CROSS JOIN LATERAL (
      SELECT CASE
        -- The stop is an exact entry-relative percentage (LC/IB 8%, others
        -- 10%). Derive the price from that percentage on the same numeric
        -- reference price sent in the payload, not from a float4 column.
        WHEN t.stop_loss_pct IS NOT NULL AND t.stop_loss_pct > 0
          THEN t.entry_price::numeric * (1 - t.stop_loss_pct::numeric / 100)
        WHEN t.stop_loss_price IS NULL
          AND t.stop_source = 'standard'
          THEN t.entry_price::numeric
            * (1 - COALESCE(($8::jsonb ->> s.sentiment_key)::numeric, $6::numeric) / 100)
        ELSE t.stop_loss_price::numeric
      END AS price,
      CASE
        WHEN t.stop_loss_pct IS NOT NULL AND t.stop_loss_pct > 0
          THEN t.stop_loss_pct::numeric
        WHEN t.stop_loss_price IS NULL AND t.stop_source = 'standard'
          THEN COALESCE(($8::jsonb ->> s.sentiment_key)::numeric, $6::numeric)
        ELSE NULL
      END AS pct
    ) stop_plan
    WHERE cfg.singleton = true
      AND s.detected_at >= cfg.activated_at AT TIME ZONE 'UTC'
      AND s.detected_at >= (now() AT TIME ZONE 'UTC') - interval '10 minutes'
      AND s.detected_at <= now() AT TIME ZONE 'UTC'
      AND ($2::integer IS NULL OR s.id = $2::integer)
      AND s.sentiment_key = ANY($1::text[])
      AND t.status IN ('active', 'in_run')
      AND t.is_short = false
      AND t.entry_price > 0
      AND t.entry_policy_version = '${SINGLE_ENTRY_POLICY_VERSION}'
      AND stop_plan.price > 0
      AND stop_plan.price < t.entry_price
      AND ($3::jsonb -> s.sentiment_key) IS NOT NULL
      AND trunc(($4::numeric * $5::numeric) / t.entry_price::numeric, 8) > 0
    ON CONFLICT (source_signal_id) DO NOTHING
    RETURNING source_signal_id
  `;

async function captureConfirmedSignals(): Promise<number> {
  // Reconcile a missed confirmation capture after a transient DB failure.
  // The payload is frozen at capture, including the original signal timestamp.
  const result = await pool.query(CAPTURE_CONFIRMED_SIGNALS_SQL, [
    RELAY_PATTERN_KEYS,
    null,
    JSON.stringify(RELAY_PATTERN_RULES),
    INITIAL_MARGIN_USD,
    LEVERAGE,
    STOP_LOSS,
    JSON.stringify(BTC_RELAY_PATTERN_RULES),
    JSON.stringify(PATTERN_MAX_STOP),
  ]);
  return result.rowCount ?? 0;
}

/** Called immediately after the tracker insert on every confirmed fire path. */
export async function captureTradingSignalAtConfirmation(
  signalId: number,
): Promise<void> {
  if (process.env.NODE_ENV !== "production") return;
  const result = await pool.query(CAPTURE_CONFIRMED_SIGNALS_SQL, [
    RELAY_PATTERN_KEYS,
    signalId,
    JSON.stringify(RELAY_PATTERN_RULES),
    INITIAL_MARGIN_USD,
    LEVERAGE,
    STOP_LOSS,
    JSON.stringify(BTC_RELAY_PATTERN_RULES),
    JSON.stringify(PATTERN_MAX_STOP),
  ]);
  if (result.rowCount) {
    logger.info({ signalId }, "Confirmed signal frozen for trading relay");
  }
}

type ClaimedSignal = {
  source_signal_id: number;
  payload: TradingSignalPayload;
  claim_token: string;
};

export function hasCompleteTradePlan(
  input: unknown,
): input is TradingSignalPayload {
  if (input === null || typeof input !== "object") return false;
  const payload = input as Partial<TradingSignalPayload>;
  if (
    !payload ||
    typeof payload.sourceSignalId !== "string" ||
    !/^cab-signal-\d+$/.test(payload.sourceSignalId) ||
    typeof payload.signalAt !== "string" ||
    !Number.isFinite(Date.parse(payload.signalAt)) ||
    typeof payload.symbol !== "string" ||
    !/^[A-Z0-9]+USDT$/.test(payload.symbol) ||
    (payload.patternId !== undefined &&
      !RELAY_PATTERN_KEYS.includes(payload.patternId)) ||
    payload.patternId === undefined ||
    payload.side !== "buy" ||
    payload.orderType !== "market" ||
    payload.reduceOnly !== false ||
    payload.patternStatus !== "approved" ||
    payload.confirmationStatus !== "confirmed" ||
    !payload.payload?.exitRules ||
    payload.payload.rulesVersion !== EXIT_RULES_VERSION ||
    payload.payload.source !== "CryptoAltBullet" ||
    payload.payload.marginMode !== "isolated" ||
    payload.payload.initialMarginUsd !== String(INITIAL_MARGIN_USD) ||
    payload.payload.leverage !== LEVERAGE
  ) {
    return false;
  }
  const entry = Number(payload.limitPrice);
  const reference = Number(payload.referencePrice);
  const quantity = Number(payload.quantity);
  const stop = Number(payload.stopLoss);
  const rules = payload.payload.exitRules as Record<string, unknown>;
  const isBitcoin = isBitcoinSymbol(payload.symbol);
  // Stealth Breakout has no +10% → +5% profit stop (owner decision 2026-10-08).
  const noProfitStop = isBitcoin || hasNoProfitStopPromotion(payload.patternId);
  const bitcoinProtectionValid =
    !isBitcoin ||
    (Number(rules.firstTargetPct) === 1 &&
      Number(rules.breakevenAtPct) === 1 &&
      Number(rules.protectedProfitAtPct) === 0 &&
      Number(rules.protectedProfitPct) === 0 &&
      Number(rules.trailingActivationPct) === 2 &&
      Number(rules.trailingGapPercentagePoints) === 1 &&
      Number(rules.progressMilestoneIntervalPct) === 1);
  return (
    !("takeProfit" in payload) &&
    Number.isFinite(entry) &&
    entry > 0 &&
    Number.isFinite(reference) &&
    reference === entry &&
    Number.isFinite(quantity) &&
    quantity > 0 &&
    Number.isFinite(stop) &&
    stop > 0 &&
    stop < entry &&
    rules.noFixedTakeProfit === true &&
    rules.rMultipleTargets === false &&
    rules.firstTargetAction === "milestone_not_full_close" &&
    rules.priceMoveBasis === "unleveraged_percent_from_actual_entry_fill" &&
    rules.trailingGapBasis === "percentage_points_of_entry_pnl" &&
    rules.trailingExitAction === "close_remaining_position" &&
    Number(rules.breakevenAtPct) > 0 &&
    (noProfitStop
      ? Number(rules.protectedProfitAtPct) === 0 &&
        Number(rules.protectedProfitPct) === 0
      : Number(rules.protectedProfitAtPct) > Number(rules.breakevenAtPct) &&
        Number(rules.protectedProfitPct) > 0) &&
    Number(rules.trailingActivationPct) > Number(rules.protectedProfitAtPct) &&
    Number(rules.trailingGapPercentagePoints) > 0 &&
    bitcoinProtectionValid &&
    Number(rules.maxWatchDays) > 0
  );
}

async function claimNextSignal(): Promise<ClaimedSignal | null> {
  const claimToken = randomUUID();
  const result = await pool.query<ClaimedSignal>(
    `
    UPDATE trading_signal_deliveries d
    SET status = 'processing', claim_token = $1,
        claim_until = now() + interval '30 seconds',
        attempts = attempts + 1
    WHERE d.source_signal_id = (
      SELECT source_signal_id FROM trading_signal_deliveries
      WHERE (status = 'pending' AND next_attempt_at <= now())
         OR (status = 'processing' AND claim_until < now())
      ORDER BY signal_at ASC
      LIMIT 1 FOR UPDATE SKIP LOCKED
    )
    RETURNING d.source_signal_id, d.payload, d.claim_token
    `,
    [claimToken],
  );
  return result.rows[0] ?? null;
}

async function finishSignal(
  claim: ClaimedSignal,
  outcome: "delivered" | "quarantined" | "retry" | "expired",
  status: number | null,
  error: string | null,
): Promise<void> {
  const result = await pool.query(
    `
    UPDATE trading_signal_deliveries
    SET status = CASE WHEN $3 = 'retry' THEN 'pending' ELSE $3 END,
        next_attempt_at = CASE
          WHEN $3 = 'retry' THEN now() + interval '30 seconds'
          ELSE next_attempt_at END,
        delivered_at = CASE WHEN $3 = 'delivered' THEN now() ELSE delivered_at END,
        claim_token = NULL, claim_until = NULL,
        last_http_status = $4, last_error = $5
    WHERE source_signal_id = $1 AND status = 'processing' AND claim_token = $2
    `,
    [claim.source_signal_id, claim.claim_token, outcome, status, error],
  );
  if (result.rowCount !== 1) {
    logger.warn(
      { sourceSignalId: claim.source_signal_id },
      "Trading signal relay claim changed before acknowledgement",
    );
  }
}

async function sendClaimedSignal(claim: ClaimedSignal, token: string) {
  if (!hasCompleteTradePlan(claim.payload)) {
    await finishSignal(claim, "quarantined", null, "incomplete_trade_plan");
    return;
  }
  const signalTime = Date.parse(claim.payload.signalAt);
  if (
    !Number.isFinite(signalTime) ||
    Date.now() - signalTime > TRADING_SIGNAL_TTL_MS ||
    signalTime > Date.now() + 30_000
  ) {
    await finishSignal(claim, "expired", null, "signal_too_old_or_invalid");
    return;
  }
  try {
    // Do not open an external position after the source has already closed
    // or reclassified this exact tracker-linked signal.
    const open = await pool.query(
      `SELECT 1 FROM tracked_signals
       WHERE signal_id = $1 AND status IN ('active', 'in_run')
         AND is_short = false LIMIT 1`,
      [claim.source_signal_id],
    );
    if (!open.rowCount) {
      await finishSignal(claim, "expired", null, "position_no_longer_open");
      return;
    }
    const response = await fetch(TRADING_SIGNAL_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-trading-token": token,
      },
      body: JSON.stringify(claim.payload),
      redirect: "manual",
      signal: AbortSignal.timeout(8_000),
    });
    const body =
      response.status === 202 ? await response.json().catch(() => null) : null;
    const outcome = classifySignalReceipt(response.status, body);
    await finishSignal(
      claim,
      outcome,
      response.status,
      outcome === "delivered"
        ? null
        : response.status === 202 && isAwaitingRulesReceipt(body)
          ? "receiver_awaiting_rules"
          : `receiver_http_${response.status}`,
    );
    if (outcome !== "delivered") {
      logger.warn(
        {
          sourceSignalId: claim.source_signal_id,
          status: response.status,
          outcome,
        },
        "Trading signal receiver did not accept signal",
      );
    } else {
      logger.info(
        { sourceSignalId: claim.source_signal_id },
        "Trading signal accepted by receiver",
      );
    }
  } catch (error) {
    await finishSignal(
      claim,
      "retry",
      null,
      error instanceof Error ? error.name : "network_error",
    );
    logger.warn(
      { sourceSignalId: claim.source_signal_id, err: error },
      "Trading signal relay request failed",
    );
  }
}

let running = false;
async function relayTick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const captured = await captureConfirmedSignals();
    if (captured > 0) {
      logger.info({ captured }, "Confirmed trading signals captured for relay");
    }
    const token = process.env.TRADING_INGEST_TOKEN;
    if (!token) return;
    // Keep each tick bounded: do not compete with scanner or watcher.
    for (let i = 0; i < 5; i++) {
      const claim = await claimNextSignal();
      if (!claim) break;
      await sendClaimedSignal(claim, token);
    }
  } catch (error) {
    logger.error({ err: error }, "Trading signal relay cycle failed");
  } finally {
    running = false;
  }
}

export function startTradingSignalRelay(): void {
  if (process.env.NODE_ENV !== "production") return;
  setTimeout(() => void relayTick(), 30_000);
  setInterval(() => void relayTick(), RELAY_INTERVAL_MS);
  logger.info(
    {
      receiver: TRADING_SIGNAL_ENDPOINT,
      hasToken: !!process.env.TRADING_INGEST_TOKEN,
    },
    "Trading signal relay scheduled",
  );
}
