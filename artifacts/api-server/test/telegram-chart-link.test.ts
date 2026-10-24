import test from "node:test";
import assert from "node:assert/strict";
import {
  appendTradingViewLinks,
  tradingViewUrl,
  withoutTradingViewLinks,
} from "../src/lib/telegram-chart-link.js";

test("adds a BingX TradingView link for ticker hashtags", () => {
  const result = appendTradingViewLinks("🚀 <b>#BTC</b> сигнал");

  assert.match(
    result,
    /https:\/\/www\.tradingview\.com\/chart\/\?symbol=BINGX:BTCUSDT\.P/,
  );
  assert.equal((result.match(/tradingview\.com\/chart/g) ?? []).length, 1);
});

test("does not duplicate an existing link and adds missing symbols", () => {
  const existing = tradingViewUrl("BTC");
  const result = appendTradingViewLinks(
    `#BTC #ETH <a href="${existing}">TradingView</a>`,
  );

  assert.equal((result.match(/BINGX:BTCUSDT\.P/g) ?? []).length, 1);
  assert.equal((result.match(/BINGX:ETHUSDT\.P/g) ?? []).length, 1);
});

test("recognizes pair notation and leaves generic messages unchanged", () => {
  assert.match(
    appendTradingViewLinks("Сигнал по SOL-USDT"),
    /BINGX:SOLUSDT\.P/,
  );
  assert.equal(
    appendTradingViewLinks("Подписка активирована"),
    "Подписка активирована",
  );
});

test("one-letter futures tickers retain market links in primary alerts", () => {
  for (const symbol of ["G-USDT", "S-USDT"]) {
    const chart = `https://www.tradingview.com/chart/?symbol=BINGX:${symbol[0]}USDT.P`;
    assert.equal(tradingViewUrl(symbol), chart);
    const fromPair = appendTradingViewLinks(`Сигнал по ${symbol}`);
    const fromTag = appendTradingViewLinks(`#${symbol[0]}`);
    assert.ok(fromPair.includes(chart));
    assert.ok(fromTag.includes(chart));
  }
  assert.equal(appendTradingViewLinks("#1"), "#1");
});

test("keeps the chart link within the requested Telegram limit", () => {
  const result = appendTradingViewLinks(`#BTC ${"x".repeat(3_990)}`, 4_000);

  assert.ok(result.length <= 4_000);
  assert.match(result, /BINGX:BTCUSDT\.P/);
});

test("suppresses chart links only for explicitly marked reports", () => {
  const report = withoutTradingViewLinks("📊 REPORT\n#BTC #ETH");
  const result = appendTradingViewLinks(report);

  assert.equal(result, "📊 REPORT\n#BTC #ETH");
  assert.match(appendTradingViewLinks("#BTC"), /BINGX:BTCUSDT\.P/);
});
