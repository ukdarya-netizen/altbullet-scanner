import assert from "node:assert/strict";
import test from "node:test";
import {
  IMPULSE_BUY_TELEGRAM_NAME,
  NEON_SUPPORT_BOUNCE_TELEGRAM_NAME,
  PRICE_LED_MOMENTUM_TELEGRAM_NAME,
  STEALTH_BREAKOUT_TELEGRAM_NAME,
} from "../src/lib/telegram-pattern-text.js";
import {
  getPatternLabel,
  getPatternTgLabel,
} from "../src/lib/pattern-labels.js";
import { buildCanonicalSignalFirePrice } from "../src/lib/scanner-patterns.js";

test("names Stealth Breakout without an experiment marker", () => {
  assert.equal(
    STEALTH_BREAKOUT_TELEGRAM_NAME,
    "🔵 Stealth Breakout — Пробой тихой зоны",
  );
});

test("treats Price Led Momentum as a finalized pattern", () => {
  assert.equal(
    PRICE_LED_MOMENTUM_TELEGRAM_NAME,
    "💫 Цена лидирует — spot momentum (SNF+CVD), OI/WI только для наблюдения",
  );
  assert.equal(
    getPatternTgLabel("price_led_momentum"),
    "💫 Цена лидирует · Spot Momentum",
  );
});

test("treats Neon Support Bounce as a full pattern with its standalone name", () => {
  assert.equal(
    NEON_SUPPORT_BOUNCE_TELEGRAM_NAME,
    "🩷 Neon Support — Отскок от поддержки",
  );
  assert.equal(
    getPatternTgLabel("neon_support_bounce"),
    "🩷 Neon Support — Отскок от поддержки",
  );
  assert.equal(
    getPatternLabel("neon_support_bounce"),
    "🩷 Neon Support — Отскок от поддержки #neon_support_bounce",
  );
});

test("treats Impulse Buy as a finalized pattern", () => {
  assert.equal(
    IMPULSE_BUY_TELEGRAM_NAME,
    "⚡ Импульсная покупка — закрытый 30m импульс с подтверждённым объёмом",
  );
});

test("uses a blue label for Stealth Breakout", () => {
  assert.equal(
    getPatternTgLabel("stealth_breakout"),
    "🔵 Stealth Breakout — Пробой тихой зоны",
  );
});

test("preserves the Balanced Grind label for historical trades", () => {
  assert.equal(
    getPatternTgLabel("balanced_grind"),
    "🟡 Умеренный широкий рост · Balanced Grind",
  );
});

test("uses the finalized Impulse Buy shared label", () => {
  assert.equal(
    getPatternTgLabel("impulse_buy"),
    "⚡ Импульсная покупка · Impulse Buy",
  );
});

test("uses the final sampled price for persistence, Telegram, and PnL entry", () => {
  const result = buildCanonicalSignalFirePrice({
    entryPrice: 0.03325,
    signalToPersist: {
      symbol: "BTR-USDT",
      price: 0.03124,
    },
    telegramSignal: {
      symbol: "BTR-USDT",
      price: 0.03305,
    },
  });

  assert.equal(result.entryPrice, 0.03325);
  assert.equal(result.signalToPersist.price, 0.03325);
  assert.equal(result.telegramSignal.price, 0.03325);
});

test("rejects an invalid final sampled price instead of creating mismatched records", () => {
  assert.throws(
    () =>
      buildCanonicalSignalFirePrice({
        entryPrice: 0,
        signalToPersist: { symbol: "FF-USDT", price: 0.08875 },
        telegramSignal: { symbol: "FF-USDT", price: 0.09105 },
      }),
    /positive finite number/,
  );
});
