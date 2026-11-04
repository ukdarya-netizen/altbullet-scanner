import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  evaluateStealthArmedSetup,
  type StealthArmedSnapshot,
} from "../src/lib/stealth-breakout-armed.js";
import { normalizeStealthTimestamp } from "../src/lib/stealth-breakout-armed-store.js";

const ms30 = 30 * 60 * 1000;
const candle = (time: number, close: number, open = close) => ({
  time,
  open,
  high: Math.max(open, close) * 1.01,
  low: Math.min(open, close) * 0.99,
  close,
  volume: 0,
});
const arm = (level = 1): StealthArmedSnapshot => ({
  structureKey: "horizontal:1:3",
  breakoutSource: "horizontal",
  breakoutLevel: level,
  touches: 3,
  armedAt: 0,
  armedAfterFourHourCandleTime: 0,
  expiresAt: 72 * 60 * 60 * 1000,
  technicalMode: "closed_30m",
  atr: level * 0.02,
});

test("Stealth closed-30m mode separates discovery and fire", () => {
  const first = evaluateStealthArmedSetup({
    arm: { ...arm(), armedAt: ms30 },
    breakoutCandles4h: [],
    refinementCandles: [candle(0, 1.01)],
    evaluatedAt: ms30,
  });
  assert.equal(first.status, "armed");
  assert.equal(first.reason, "awaiting_later_4h_cross");

  const discovered = evaluateStealthArmedSetup({
    arm: {
      ...arm(),
      armedAt: 0,
    },
    breakoutCandles4h: [],
    refinementCandles: [candle(0, 1.01)],
    evaluatedAt: ms30,
  });
  assert.equal(discovered.status, "armed");
  const second = evaluateStealthArmedSetup({
    arm: { ...arm(), ...discovered.closed30mState },
    breakoutCandles4h: [],
    refinementCandles: [candle(0, 1.01), candle(ms30, 1.01)],
    evaluatedAt: ms30 * 2,
  });
  assert.equal(second.status, "qualified");
  assert.equal(second.closed30mState?.lastCandleAt, ms30);
});

test("Stealth closed-30m mode bounds reclaim and rejects candle gaps", () => {
  const result = evaluateStealthArmedSetup({
    arm: {
      ...arm(),
      rawCrossObservedAt: ms30,
      rawCrossCandleAt: 0,
      rawCrossPrice: 1.01,
      lastCandleAt: 0,
      reclaimCount: 0,
    },
    breakoutCandles4h: [],
    refinementCandles: [candle(0, 1.01), candle(ms30 * 2, 1.02)],
    evaluatedAt: ms30 * 3,
  });
  assert.equal(result.status, "invalidated");
  assert.equal(result.reason, "candle_gap_after_raw_cross");
});

test("continuation shelf and quiet-zone arms share the Stealth mode", () => {
  for (const structureKey of ["quiet:1", "shelf:1"]) {
    const discovered = evaluateStealthArmedSetup({
      arm: { ...arm(), structureKey },
      breakoutCandles4h: [],
      refinementCandles: [candle(0, 1.01)],
      evaluatedAt: ms30,
    });
    const result = evaluateStealthArmedSetup({
      arm: { ...arm(), structureKey, ...discovered.closed30mState },
      breakoutCandles4h: [],
      refinementCandles: [candle(0, 1.01), candle(ms30, 1.01)],
      evaluatedAt: ms30 * 2,
    });
    assert.equal(result.status, "qualified", structureKey);
    assert.equal(result.closed30mState?.rawCrossCandleAt, 0);
  }
});

test("durable Stealth timestamps normalize Date, numeric, and ISO rows", () => {
  const instant = 1_700_000_000_000;
  assert.equal(normalizeStealthTimestamp(new Date(instant)), instant);
  assert.equal(normalizeStealthTimestamp(String(instant)), instant);
  assert.equal(
    normalizeStealthTimestamp(new Date(instant).toISOString()),
    instant,
  );
});

test("ATR scales Stealth chase allowance instead of using a fixed bound", () => {
  const discovered = evaluateStealthArmedSetup({
    arm: { ...arm(), atr: 0.1 },
    breakoutCandles4h: [],
    refinementCandles: [candle(0, 1.01)],
    evaluatedAt: ms30,
  });
  const wideAtr = evaluateStealthArmedSetup({
    arm: { ...arm(), atr: 0.1, ...discovered.closed30mState },
    breakoutCandles4h: [],
    refinementCandles: [candle(0, 1.01), candle(ms30, 1.015)],
    evaluatedAt: ms30 * 2,
  });
  assert.equal(wideAtr.status, "qualified");

  const narrowAtr = evaluateStealthArmedSetup({
    arm: { ...arm(), atr: 0.001, ...discovered.closed30mState },
    breakoutCandles4h: [],
    refinementCandles: [candle(0, 1.01), candle(ms30, 1.015)],
    evaluatedAt: ms30 * 2,
  });
  assert.equal(narrowAtr.status, "armed");
  assert.equal(narrowAtr.reason, "breakout_active_waiting_retest");
});

test("scanner admits shelf candidates and exempts only confirmed Stealth participation gates", () => {
  const scanner = readFileSync(
    new URL("../src/lib/scanner.ts", import.meta.url),
    "utf8",
  );
  assert.match(
    scanner,
    /const _sbShelfIsValid =\s*_sbContinuationShelf\.quietZone/,
  );
  assert.match(
    scanner,
    /const stealthConfirmed = res\.sentimentKey === "stealth_breakout"/,
  );
  assert.match(scanner, /spotVol24h === null && !stealthConfirmed/);
  assert.match(
    scanner,
    /res\.sentimentKey !== "neon_support_bounce"[\s\S]{0,100}!stealthConfirmed/,
  );
});

test("stale Stealth claim recovery matches terminal trackers in the claim window", () => {
  const store = readFileSync(
    new URL("../src/lib/stealth-breakout-armed-store.ts", import.meta.url),
    "utf8",
  );
  assert.match(store, /tracked\.sentiment_key = 'stealth_breakout'/);
  assert.match(store, /tracked\.detected_at >= setup\.fire_claimed_at/);
  assert.match(
    store,
    /tracked\.detected_at <=\s*setup\.fire_claimed_at \+\s*\(\$\{STEALTH_FIRE_CLAIM_TTL_MS\}/,
  );
  assert.doesNotMatch(store, /tracked\.status IN \('active', 'in_run'\)/);
});
