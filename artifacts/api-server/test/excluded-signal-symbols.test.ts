import assert from "node:assert/strict";
import test from "node:test";
import {
  EXCLUDED_SIGNAL_SYMBOLS,
  isSignalSymbolExcluded,
  normalizeSignalSymbol,
} from "../src/lib/excluded-signal-symbols.js";
import { isClosedTradeOutcome } from "../src/lib/raw-pnl.js";

test("BTC (own bot since 2026-11-13), ETH, BNB, SOL, DOGE, ETC and BCH are excluded from new trading signals", () => {
  assert.deepEqual(EXCLUDED_SIGNAL_SYMBOLS, [
    "BTC-USDT",
    "ETH-USDT",
    "BNB-USDT",
    "SOL-USDT",
    "DOGE-USDT",
    "ETC-USDT",
    "BCH-USDT",
    "NCSKECHO2USD-USDT",
  ]);
  assert.equal(isSignalSymbolExcluded("ethusdt"), true);
  assert.equal(isSignalSymbolExcluded("BNB-USDT"), true);
  assert.equal(isSignalSymbolExcluded("SOL-USDT"), true);
  assert.equal(isSignalSymbolExcluded("dogeusdt"), true);
  assert.equal(isSignalSymbolExcluded("etcusdt"), true);
  assert.equal(isSignalSymbolExcluded("BCH-USDT"), true);
  assert.equal(isSignalSymbolExcluded("BTC-USDT"), true);
  assert.equal(isSignalSymbolExcluded("btcusdt"), true);
});

test("signal symbols are normalized without broad ticker matching", () => {
  assert.equal(isSignalSymbolExcluded("BTCDOM-USDT"), false);
  assert.equal(normalizeSignalSymbol(" solusdt "), "SOL-USDT");
  assert.equal(isSignalSymbolExcluded("ETH2-USDT"), false);
  assert.equal(isSignalSymbolExcluded("1000BNB-USDT"), false);
  assert.equal(isSignalSymbolExcluded("SOL2-USDT"), false);
  assert.equal(isSignalSymbolExcluded("1000DOGE-USDT"), false);
  assert.equal(isSignalSymbolExcluded("1000ETC-USDT"), false);
  assert.equal(isSignalSymbolExcluded("BCH2-USDT"), false);
});

test("neutral exclusion is not counted as a closed trade outcome", () => {
  assert.equal(
    isClosedTradeOutcome({
      status: "reclassified",
      pnlPercent: null,
      exitPrice: null,
      cancelReason: "symbol_excluded_by_policy",
    }),
    false,
  );
});
