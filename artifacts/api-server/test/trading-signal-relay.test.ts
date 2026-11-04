import assert from "node:assert/strict";
import test from "node:test";
import { pool } from "@workspace/db";
import {
  CAPTURE_CONFIRMED_SIGNALS_SQL,
  BTC_RELAY_PATTERN_RULES,
  RELAY_PATTERN_KEYS,
  RELAY_PATTERN_RULES,
  classifySignalReceipt,
  hasCompleteTradePlan,
} from "../src/lib/trading-signal-relay.js";
import { PATTERN_MAX_STOP } from "../src/lib/watcher-config.js";

test("trading relay accepts a queued receipt, not an awaiting-rules receipt", () => {
  assert.deepEqual(RELAY_PATTERN_KEYS, [
    "liquidation_cascade",
    "stealth_breakout",
    "neon_support_bounce",
    "impulse_buy",
  ]);
  assert.equal(RELAY_PATTERN_KEYS.includes("balanced_grind" as never), false);
  assert.ok(RELAY_PATTERN_RULES.neon_support_bounce);
  assert.ok(BTC_RELAY_PATTERN_RULES.neon_support_bounce);
  assert.equal(
    classifySignalReceipt(202, {
      accepted: true,
      duplicate: true,
      signal: { status: "pending" },
    }),
    "delivered",
  );
  assert.equal(
    classifySignalReceipt(202, {
      accepted: true,
      signal: { status: "awaiting_rules" },
    }),
    "retry",
  );
  assert.equal(classifySignalReceipt(202, { accepted: true }), "retry");
  assert.equal(classifySignalReceipt(307, null), "retry");
  assert.equal(classifySignalReceipt(401, null), "retry");
  assert.equal(classifySignalReceipt(422, null), "quarantined");
  assert.equal(classifySignalReceipt(409, null), "quarantined");
});

test("trading relay rejects incomplete or unprotected trade plans", () => {
  const plan = {
    sourceSignalId: "cab-signal-1",
    signalAt: new Date().toISOString(),
    patternId: "liquidation_cascade",
    symbol: "ETHUSDT",
    confirmationStatus: "confirmed",
    patternStatus: "approved",
    side: "buy",
    orderType: "market",
    reduceOnly: false,
    referencePrice: "100",
    limitPrice: "100",
    quantity: "1",
    stopLoss: "90",
    payload: {
      source: "CryptoAltBullet",
      rulesVersion: "bullet-long-exits-v2",
      marginMode: "isolated",
      initialMarginUsd: "10",
      leverage: 10,
      exitRules: RELAY_PATTERN_RULES.liquidation_cascade,
    },
  } as const;
  assert.equal(hasCompleteTradePlan(plan), true);
  assert.equal(
    hasCompleteTradePlan({
      ...plan,
      patternId: "neon_support_bounce",
      payload: {
        ...plan.payload,
        exitRules: RELAY_PATTERN_RULES.neon_support_bounce,
      },
    }),
    true,
  );
  assert.equal(
    hasCompleteTradePlan({ ...plan, patternId: "balanced_grind" }),
    false,
  );
  assert.equal(hasCompleteTradePlan({ ...plan, stopLoss: "110" }), false);
  assert.equal(hasCompleteTradePlan({ ...plan, quantity: "0" }), false);
  assert.equal(hasCompleteTradePlan({ ...plan, takeProfit: "110" }), false);
  assert.equal(
    hasCompleteTradePlan({
      ...plan,
      payload: { ...plan.payload, rulesVersion: "bullet-long-v1" },
    }),
    false,
  );
  assert.equal(hasCompleteTradePlan({ referencePrice: "100" }), false);
});

test("BTC relay carries its 1/2/1 protection ladder without a scalar take-profit", () => {
  const rules = BTC_RELAY_PATTERN_RULES.liquidation_cascade;
  assert.equal("runner" in BTC_RELAY_PATTERN_RULES.impulse_buy, false);
  const plan = {
    sourceSignalId: "cab-signal-1",
    signalAt: new Date().toISOString(),
    patternId: "liquidation_cascade",
    symbol: "BTCUSDT",
    confirmationStatus: "confirmed",
    patternStatus: "approved",
    side: "buy",
    orderType: "market",
    reduceOnly: false,
    referencePrice: "100",
    limitPrice: "100",
    quantity: "1",
    stopLoss: "99",
    payload: {
      source: "CryptoAltBullet",
      rulesVersion: "bullet-long-exits-v2",
      marginMode: "isolated",
      initialMarginUsd: "10",
      leverage: 10,
      exitRules: rules,
    },
  } as const;

  assert.equal(rules.firstTargetPct, 1);
  assert.equal(rules.firstTargetAction, "milestone_not_full_close");
  assert.equal(rules.breakevenAtPct, 1);
  assert.equal(rules.protectedProfitAtPct, 0);
  assert.equal(rules.protectedProfitPct, 0);
  assert.equal(rules.trailingActivationPct, 2);
  assert.equal(rules.trailingGapPercentagePoints, 1);
  assert.equal(rules.noFixedTakeProfit, true);
  assert.equal("takeProfit" in plan, false);
  assert.equal(hasCompleteTradePlan(plan), true);
  assert.equal(
    hasCompleteTradePlan({
      ...plan,
      payload: {
        ...plan.payload,
        exitRules: { ...rules, progressMilestoneIntervalPct: 2 },
      },
    }),
    false,
  );
  assert.match(CAPTURE_CONFIRMED_SIGNALS_SQL, /\$7::jsonb -> s\.sentiment_key/);

  assert.equal(
    RELAY_PATTERN_RULES.liquidation_cascade.trailingActivationPct,
    15,
  );
  assert.equal(
    RELAY_PATTERN_RULES.liquidation_cascade.trailingGapPercentagePoints,
    10,
  );
});

test(
  "trading relay freezes only new, linked, approved signals once",
  { skip: process.env.RUN_TRADING_RELAY_INTEGRATION_TESTS !== "true" },
  async () => {
    if (!process.env.TEST_DATABASE_URL) {
      throw new Error("TEST_DATABASE_URL is required");
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`
        CREATE TEMP TABLE trading_signal_relay_settings (
          singleton boolean PRIMARY KEY, activated_at timestamptz NOT NULL
        ) ON COMMIT DROP;
        CREATE TEMP TABLE signals (
          id integer PRIMARY KEY, symbol text NOT NULL, detected_at timestamp NOT NULL,
          sentiment_key text, telegram_alert_queued boolean NOT NULL
        ) ON COMMIT DROP;
        CREATE TEMP TABLE tracked_signals (
          signal_id integer, sentiment_key text, entry_price real NOT NULL,
          status text NOT NULL, is_short boolean NOT NULL,
          entry_policy_version text NOT NULL DEFAULT 'single_entry_v1',
          stop_loss_price real,
          stop_source text,
          stop_loss_pct real
        ) ON COMMIT DROP;
        CREATE TEMP TABLE trading_signal_deliveries (
          source_signal_id integer PRIMARY KEY, signal_at timestamptz NOT NULL,
          payload jsonb NOT NULL
        ) ON COMMIT DROP
      `);
      await client.query(`
        INSERT INTO trading_signal_relay_settings
        VALUES (true, now() - interval '2 minutes');
        INSERT INTO signals VALUES
          (1, 'BTC-USDT', now() AT TIME ZONE 'UTC' - interval '20 seconds', 'liquidation_cascade', true),
          (2, 'ETH-USDT', now() AT TIME ZONE 'UTC' - interval '20 seconds', 'whale_watch', true),
          (3, 'SOL-USDT', now() AT TIME ZONE 'UTC' - interval '20 seconds', 'balanced_grind', false),
          (4, 'ADA-USDT', now() AT TIME ZONE 'UTC' - interval '20 seconds', 'impulse_buy', true),
          (5, 'DOGE-USDT', now() AT TIME ZONE 'UTC' - interval '20 minutes', 'price_led_momentum', true),
          (6, 'XRP-USDT', now() AT TIME ZONE 'UTC' - interval '20 seconds', 'impulse_buy', true),
          (7, 'AVAX-USDT', now() AT TIME ZONE 'UTC' - interval '20 seconds', 'stealth_breakout', true),
          (8, 'BNB-USDT', now() AT TIME ZONE 'UTC' - interval '20 seconds', 'bullish_accumulation', true),
          (9, 'DOT-USDT', now() AT TIME ZONE 'UTC' - interval '20 seconds', 'price_led_momentum', true),
          (10, 'LINK-USDT', now() AT TIME ZONE 'UTC' - interval '20 seconds', 'balanced_grind', true),
          (11, 'NEON-USDT', now() AT TIME ZONE 'UTC' - interval '20 seconds', 'neon_support_bounce', true);
        INSERT INTO tracked_signals
          (signal_id, sentiment_key, entry_price, status, is_short, stop_loss_price, stop_source, stop_loss_pct)
        VALUES
          (1, 'liquidation_cascade', 65000, 'active', false, 59800, 'pattern', 8),
          (2, 'whale_watch', 4200, 'active', false, 4000, 'pattern', 5),
          (3, 'balanced_grind', 180, 'active', false, null, 'standard', null),
          (4, 'impulse_buy', 3.4, 'cancelled', false, 3.1, 'pattern', 8),
          (5, 'price_led_momentum', 0.1, 'active', false, 0.09, 'pattern', 10),
          (6, 'impulse_buy', 2.2, 'in_run', false, 2.024, 'pattern', 8),
          (7, 'stealth_breakout', 22, 'active', false, 20, 'pattern', 10),
          (8, 'bullish_accumulation', 600, 'active', false, 550, 'pattern', 10),
          (9, 'price_led_momentum', 8, 'active', false, null, 'standard', null),
          (10, 'balanced_grind', 20, 'active', false, null, 'liq_heatmap', null),
          (11, 'neon_support_bounce', 10, 'active', false, null, 'standard', null)
      `);
      const args = [
        RELAY_PATTERN_KEYS,
        null,
        JSON.stringify(RELAY_PATTERN_RULES),
        10,
        10,
        10,
        JSON.stringify(BTC_RELAY_PATTERN_RULES),
        JSON.stringify(PATTERN_MAX_STOP),
      ];
      const immediate = await client.query(CAPTURE_CONFIRMED_SIGNALS_SQL, [
        ...args.slice(0, 1),
        6,
        ...args.slice(2),
      ]);
      assert.deepEqual(
        immediate.rows.map((row) => row.source_signal_id),
        [6],
      );
      const first = await client.query(CAPTURE_CONFIRMED_SIGNALS_SQL, args);
      assert.deepEqual(
        first.rows.map((row) => row.source_signal_id).sort((a, b) => a - b),
        [1, 9, 11],
      );
      const frozen = await client.query(`
        SELECT payload FROM trading_signal_deliveries
        WHERE source_signal_id = 1
      `);
      const payload = frozen.rows[0].payload;
      assert.equal(payload.sourceSignalId, "cab-signal-1");
      assert.equal(payload.confirmationStatus, "confirmed");
      assert.equal(payload.patternId, "liquidation_cascade");
      assert.equal(payload.patternStatus, "approved");
      assert.equal(payload.symbol, "BTCUSDT");
      assert.equal(payload.referencePrice, "65000");
      assert.equal(payload.side, "buy");
      assert.equal(payload.orderType, "market");
      assert.equal(payload.quantity, "0.00153846");
      assert.equal(payload.limitPrice, "65000");
      assert.equal(payload.stopLoss, "59800");
      assert.equal(Number(payload.stopLossPct), 8);
      assert.equal("takeProfit" in payload, false);
      assert.equal(payload.reduceOnly, false);
      assert.equal(payload.payload.exitRules.breakevenAtPct, 1);
      assert.equal(payload.payload.exitRules.firstTargetPct, 1);
      assert.equal(payload.payload.exitRules.protectedProfitAtPct, 0);
      assert.equal(payload.payload.exitRules.protectedProfitPct, 0);
      assert.equal(payload.payload.exitRules.trailingActivationPct, 2);
      assert.equal(payload.payload.exitRules.trailingGapPercentagePoints, 1);
      assert.equal(payload.payload.exitRules.progressMilestoneIntervalPct, 1);
      assert.equal(payload.payload.exitRules.noFixedTakeProfit, true);
      assert.equal(payload.payload.exitRules.rMultipleTargets, false);
      assert.equal(
        payload.payload.exitRules.partialProfitAdvice.execution,
        "advice_only_not_automated",
      );
      assert.equal(payload.payload.marginMode, "isolated");
      assert.equal(hasCompleteTradePlan(payload), true);
      assert.match(frozen.rows[0].payload.signalAt, /Z$/);
      const standardStops = await client.query(`
        SELECT source_signal_id, payload FROM trading_signal_deliveries
        WHERE source_signal_id IN (9, 11) ORDER BY source_signal_id
      `);
      assert.deepEqual(
        standardStops.rows.map(({ source_signal_id, payload }) => [
          source_signal_id,
          Number(payload.stopLoss),
          hasCompleteTradePlan(payload),
        ]),
        [
          [9, 7.2, true],
          [11, 9, true],
        ],
      );
      const impulse = await client.query(`
        SELECT payload FROM trading_signal_deliveries
        WHERE source_signal_id = 6
      `);
      assert.equal(impulse.rows[0].payload.side, "buy");
      assert.ok(
        Math.abs(Number(impulse.rows[0].payload.stopLoss) - 2.024) < 1e-9,
      );
      assert.equal("takeProfit" in impulse.rows[0].payload, false);
      assert.equal(
        impulse.rows[0].payload.payload.exitRules.runner.policyVersion,
        "impulse_runner_v1",
      );
      assert.equal(
        impulse.rows[0].payload.payload.exitRules.runner.coreExit,
        "standard_trailing_stop",
      );
      assert.equal(
        impulse.rows[0].payload.payload.exitRules.runner.coreFraction,
        0.8,
      );
      assert.ok(
        Math.abs(
          impulse.rows[0].payload.payload.exitRules.runner.runnerFraction - 0.2,
        ) < 1e-12,
      );
      assert.equal(
        impulse.rows[0].payload.payload.exitRules.runner.afterCoreEmergencyStop,
        "original_entry_breakeven",
      );
      assert.equal(
        impulse.rows[0].payload.payload.exitRules.runner
          .maxAgeHoursFromOriginalEntry,
        120,
      );
      assert.equal(hasCompleteTradePlan(impulse.rows[0].payload), true);
      const excluded = await client.query(
        "SELECT count(*)::int AS n FROM trading_signal_deliveries WHERE source_signal_id IN (2, 5, 7, 8, 10)",
      );
      assert.equal(excluded.rows[0].n, 0);
      const repeat = await client.query(CAPTURE_CONFIRMED_SIGNALS_SQL, args);
      assert.equal(repeat.rowCount, 0);
      const duplicateImmediate = await client.query(
        CAPTURE_CONFIRMED_SIGNALS_SQL,
        [...args.slice(0, 1), 6, ...args.slice(2)],
      );
      assert.equal(duplicateImmediate.rowCount, 0);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  },
);
