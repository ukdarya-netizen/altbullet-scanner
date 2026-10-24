import assert from "node:assert/strict";
import test from "node:test";
import type { TrackedSignal } from "@workspace/db";
import {
  fmtPositionProtectionLine,
  fmtSplitFillMarketContext,
  formatOpenPositionLines,
  hasEarnedBuProtection,
  msgAccumVolumeBuilding,
  msgBUStop,
  msgExpired,
  msgFirstTarget,
  msgLateSignal,
  msgMilestone,
  msgPartialTakeProfit,
  msgReEntry,
  msgStopLoss,
  msgTrailingActivated,
  msgTrailingStopHit,
  patternTag,
} from "../src/lib/watcher-formatters.js";
import {
  buildPositionCard,
  type PositionEnrichment,
} from "../src/lib/position-batch-update.js";
import {
  ACCUM_SCOUT_TELEGRAM_ENABLED,
  HEALTH_ADVICE_TELEGRAM_ENABLED,
  resolveBuStopProtection,
} from "../src/lib/watcher-config.js";

function position(overrides: Partial<TrackedSignal> = {}): TrackedSignal {
  return {
    id: 1,
    symbol: "TEST-USDT",
    sentimentKey: "price_led_momentum",
    sentiment: "price_led_momentum",
    status: "active",
    isShort: false,
    entryPrice: 1,
    peakPrice: 1.1,
    stopLossPrice: 0.92,
    stopLossPct: 8,
    trailingStopLevel: null,
    lastMilestone: null,
    detectedAt: new Date("2026-08-25T00:00:00.000Z"),
    ...overrides,
  } as TrackedSignal;
}

test("keeps Neon Support's hashtag without an experiment marker in lifecycle messages", () => {
  assert.equal(patternTag("neon_support_bounce"), "#neon_support_bounce");
  assert.equal(patternTag("price_led_momentum"), "#price_led_momentum");

  const lifecycle = msgStopLoss(
    position({ sentimentKey: "neon_support_bounce" }),
    0.9,
    -10,
  );
  assert.match(lifecycle, /#neon_support_bounce #stop_loss/);
  assert.doesNotMatch(lifecycle, /эксперимент/gi);
});

const noEnrichment: PositionEnrichment = {
  obRatio: null,
  obBidsUsd: null,
  obAsksUsd: null,
  whaleIndex: null,
  snfNetPct1h: null,
  snfNetPct4h: null,
  longMaxPain: null,
  shortMaxPain: null,
};

test("keeps non-actionable scheduled position updates out of Telegram", () => {
  assert.equal(HEALTH_ADVICE_TELEGRAM_ENABLED, false);
  assert.equal(ACCUM_SCOUT_TELEGRAM_ENABLED, false);
});

test("shows ordinary stop state before the BE target", () => {
  const beforeTarget = position();

  assert.equal(hasEarnedBuProtection(beforeTarget), false);
  assert.equal(fmtPositionProtectionLine(beforeTarget), "");

  const batch = buildPositionCard(
    beforeTarget,
    new Map([["TEST-USDT", 0.97]]),
    noEnrichment,
  );
  assert.doesNotMatch(batch, /ещё не достигнут/);
  assert.match(batch, /Stop: \$0\.9200/);
  assert.match(
    batch,
    /🏷 <b>💫 Цена лидирует · Spot Momentum<\/b> · \[(?:Spot|Multi|BingX)\]/,
  );
  assert.doesNotMatch(batch, /\[💫 Цена лидирует/);
});

test("shows earned BE and hides the obsolete initial stop", () => {
  const protectedPosition = position({ lastMilestone: 5 });

  assert.equal(hasEarnedBuProtection(protectedPosition), true);
  assert.match(
    fmtPositionProtectionLine(protectedPosition),
    /Тейк \+5% достигнут · 🛡 BE STOP → \$1\.0000/,
  );

  const batch = buildPositionCard(
    protectedPosition,
    new Map([["TEST-USDT", 1.03]]),
    noEnrichment,
  );
  assert.match(batch, /BE STOP → \$1\.0000/);
  assert.doesNotMatch(batch, /Stop: \$0\.9200/);

  const report = formatOpenPositionLines(
    [protectedPosition],
    new Map([["TEST-USDT", 1.03]]),
  ).join("\n");
  assert.match(report, /BE STOP → \$1\.0000/);
});

test("BTC earns breakeven protection at +1% and says so in follow-ups", () => {
  const btc = position({
    symbol: "BTC-USDT",
    lastMilestone: 1,
    peakPrice: 1.01,
  });

  assert.equal(hasEarnedBuProtection(btc), true);
  assert.deepEqual(
    resolveBuStopProtection({
      sentimentKey: btc.sentimentKey,
      symbol: btc.symbol,
      lastMilestone: btc.lastMilestone,
      persistedPeakPnlPercent: 1,
    }),
    {
      earned: true,
      milestone: 1,
      protectedProfitPct: 0,
    },
  );
  assert.match(
    fmtPositionProtectionLine(btc),
    /Б\/У активирован при \+1%.*стоп в точке входа \$1\.0000/,
  );
  assert.match(
    msgPartialTakeProfit(btc, 1.01, 1),
    /BTC: достигнут уровень Б\/У \+1%.*частичное исполнение не подтверждено/,
  );
});

test("BTC accompaniment shows a 1% initial stop before breakeven is earned", () => {
  const btc = position({
    symbol: "BTC-USDT",
    entryPrice: 100_000,
    peakPrice: 100_500,
    stopLossPrice: 92_000,
    stopLossPct: 8,
    lastMilestone: null,
  });

  const batch = buildPositionCard(
    btc,
    new Map([["BTC-USDT", 100_500]]),
    noEnrichment,
  );

  assert.match(batch, /Stop Loss BTC: \$99000\.000 \(−1\.0%\)/);
  assert.doesNotMatch(batch, /\$92,000/);
  assert.match(
    fmtPositionProtectionLine(btc),
    /Б\/У ещё не заработан: нужен пик \+1%/,
  );
  assert.doesNotMatch(fmtPositionProtectionLine(btc), /Тейк/);
});

test("BTC first target is BE only; +2% starts a 1pp trail that ratchets each 1%", () => {
  const btcAtBreakeven = position({
    symbol: "BTC-USDT",
    entryPrice: 100_000,
    peakPrice: 101_000,
    lastMilestone: 1,
  });
  const firstTarget = msgFirstTarget(btcAtBreakeven, 101_000);
  assert.match(firstTarget, /BTC: Б\/У после \+1%/);
  assert.doesNotMatch(firstTarget, /TARGET HIT|Фиксируй/);
  assert.match(firstTarget, /трейлинг включится только при \+2%/);
  assert.doesNotMatch(firstTarget, /Фиксируй 20-25%/);
  assert.doesNotMatch(firstTarget, /частичного исполнения подтверждено/);

  const btcAtTwo = position({
    symbol: "BTC-USDT",
    entryPrice: 100_000,
    peakPrice: 102_000,
    lastMilestone: 2,
    trailingStopLevel: 101_000,
  });
  const activation = msgTrailingActivated(btcAtTwo, 102_000, 101_000);
  assert.match(activation, /BTC: ТРЕЙЛИНГ С \+2%/);
  assert.match(activation, /BTC-трейлинг активирован при \+2%/);
  assert.match(activation, /защита \+1\.00%/);
  assert.match(activation, /от пика на 1 п\.п\./);

  const btcAtThree = position({
    symbol: "BTCUSDT",
    entryPrice: 100_000,
    peakPrice: 103_000,
    lastMilestone: 3,
    trailingStopLevel: 102_000,
  });
  const nextRung = msgMilestone(btcAtThree, 3, 103_000, 102_000);
  assert.match(nextRung, /BTC: уровень \+3%/);
  assert.match(nextRung, /Пик BTC достиг \+3%/);
  assert.match(nextRung, /защищает \+2\.00% от входа/);
  assert.match(nextRung, /частичное исполнение не подтверждено/);
  assert.match(
    fmtPositionProtectionLine(btcAtThree),
    /трейлинг: пик PnL −1 п\.п\..*защита \+2\.00%/,
  );
  const closeByTrail = msgTrailingStopHit(btcAtThree, 102_000, 3, 2);
  assert.match(closeByTrail, /BTC: стоп по трейлингу/);
  assert.match(closeByTrail, /\+2\.00%/);
  assert.doesNotMatch(closeByTrail, /TARGET HIT|частичная продажа совершена/);
  assert.doesNotMatch(
    fmtPositionProtectionLine(btcAtThree),
    /PROFIT STOP \+5%/,
  );
});

test("can omit ticker tags from report position rows", () => {
  const signal = position();
  const report = formatOpenPositionLines(
    [signal],
    new Map([["TEST-USDT", 1.03]]),
    false,
  ).join("\n");

  assert.doesNotMatch(report, /#TEST/);
  assert.doesNotMatch(report, /tradingview/i);
  assert.match(
    formatOpenPositionLines([signal], new Map([["TEST-USDT", 1.03]])).join(
      "\n",
    ),
    /#TEST/,
  );
});

test("keeps Bullish Accumulation unprotected until its +10% milestone", () => {
  const interimBa = position({
    sentimentKey: "bullish_accumulation",
    lastMilestone: 8,
  });

  assert.equal(hasEarnedBuProtection(interimBa), false);
  assert.match(
    fmtPositionProtectionLine(interimBa),
    /^🎯 Промежуточная цель \+8% достигнута$/,
  );
});

test("Impulse Buy presents +5% before +10% and promotes BE to +5% profit protection", () => {
  const beforeFive = position({
    sentimentKey: "impulse_buy",
    lastMilestone: null,
    detectedAt: new Date("2026-09-02T00:00:00.000Z"),
  });
  assert.equal(hasEarnedBuProtection(beforeFive), false);
  assert.equal(fmtPositionProtectionLine(beforeFive), "");
  assert.doesNotMatch(
    fmtPositionProtectionLine(beforeFive),
    /Тейк \+10% ещё не достигнут/,
  );

  const beforeTarget = position({
    sentimentKey: "impulse_buy",
    lastMilestone: 5,
    detectedAt: new Date("2026-09-02T00:00:00.000Z"),
  });
  assert.equal(hasEarnedBuProtection(beforeTarget), true);
  assert.match(
    fmtPositionProtectionLine(beforeTarget),
    /Тейк \+5% достигнут · 🛡 BE STOP → \$1\.0000 · при \+10% стоп в прибыль \+5%/,
  );

  const protectedPosition = position({
    sentimentKey: "impulse_buy",
    lastMilestone: 10,
    detectedAt: new Date("2026-09-02T00:00:00.000Z"),
  });
  assert.equal(hasEarnedBuProtection(protectedPosition), true);
  assert.match(
    fmtPositionProtectionLine(protectedPosition),
    /Тейк \+10% достигнут · 🛡 PROFIT STOP \+5% → \$1\.0500/,
  );

  const closed = msgBUStop(
    position({
      sentimentKey: "impulse_buy",
      status: "bu_stop",
      lastMilestone: 10,
      detectedAt: new Date("2026-09-02T00:00:00.000Z"),
    }),
    1.05,
    5,
  );
  assert.match(closed, /POSITION CLOSED — TEST/);
  assert.match(closed, /<b>🔵 PROFIT STOP \+5%<\/b>/);
  assert.match(closed, /\$1\.0000 → \$1\.0500 \(\+5\.00%\)/);
});

test("Impulse Buy keeps ordinary BE at +5 before its +10 promotion", () => {
  const legacyProtected = position({
    sentimentKey: "impulse_buy",
    entryPrice: 0.4607,
    peakPrice: 0.4942,
    lastMilestone: 5,
  });

  assert.equal(hasEarnedBuProtection(legacyProtected), true);
  assert.match(
    fmtPositionProtectionLine(legacyProtected),
    /Тейк \+5% достигнут · 🛡 BE STOP → \$0\.460700/,
  );
  assert.doesNotMatch(
    fmtPositionProtectionLine(legacyProtected),
    /PROFIT STOP \+5%/,
  );

  const closed = msgBUStop(
    {
      ...legacyProtected,
      status: "bu_stop",
    },
    0.4607,
    0,
  );
  assert.match(closed, /POSITION CLOSED — TEST/);
  assert.match(closed, /<b>🔵 BE STOP<\/b>/);
  assert.match(closed, /\$0\.460700 → \$0\.460700 \(\+0\.00%\)/);
  assert.match(closed, /Пик позиции: \+7\.27%/);
  assert.match(closed, /Тейк: \+5% достигнут/);
  assert.doesNotMatch(closed, /PROFIT STOP \+5%/);
});

test("formats the same BE fact across milestone, accumulation, re-entry and late-signal updates", () => {
  const signal = position({ lastMilestone: 5 });
  const texts = [
    msgPartialTakeProfit(signal, 1.06, 6),
    msgFirstTarget(signal, 1.1),
    msgTrailingActivated(signal, 1.15, 1.06),
    msgAccumVolumeBuilding(signal, 1.03, 3, 2, null),
    msgReEntry(signal, 1.03, 3, null),
    msgLateSignal(signal, 1.2, 20),
  ];

  assert.match(texts[0]!, /Тейк \+5% достигнут/);
  assert.match(texts[1]!, /Тейк \+10% достигнут.*PROFIT STOP \+5%/s);
  assert.match(
    texts[2]!,
    /Тейк \+10% достигнут.*PROFIT STOP \+5% пройден, трейлинг: \$1\.0600/s,
  );
  assert.match(texts[3]!, /Тейк \+5% достигнут/);
  assert.match(texts[4]!, /Тейк \+5% достигнут/);
  assert.match(texts[5]!, /Тейк \+10% достигнут.*PROFIT STOP \+5%/s);
  assert.match(texts[2]!, /трейлинг: \$1\.0600/);
  assert.match(texts[2]!, /защищает \+6\.00%/);
  assert.match(
    texts[2]!,
    /\$1\.0000 → \$1\.1500 \(\+15\.00%\).*Достигнут уровень активации трейлинга/s,
  );
});

test("moonshot milestones show only the current trailing stop", () => {
  const text = msgMilestone(position({ lastMilestone: 15 }), 20, 1.2, 1.1);

  assert.match(text, /🛡 Трейлинг-стоп: \$1\.1000 \(\+10\.00% от входа\)/);
  assert.doesNotMatch(text, /Тейк \+10% достигнут/);
  assert.doesNotMatch(text, /PROFIT STOP \+5% пройден/);
  assert.doesNotMatch(text, /Держим до срабатывания стопа/);
});

test("formats only fresh split-fill metrics that are available", () => {
  assert.deepEqual(
    fmtSplitFillMarketContext({
      oi30m: -0.5,
      spotCvdStrength1h: 0.032,
      spotCvd1h: true,
      obRatio: 1.45,
    }),
    ["📊 OI Δ 30m: -0.50% · Spot CVD 1h: +3.20% 🟢", "📚 Стакан: OB 1.45x ⚪"],
  );
  assert.deepEqual(
    fmtSplitFillMarketContext({
      oi30m: null,
      spotCvdStrength1h: null,
      spotCvd1h: null,
      obRatio: null,
    }),
    [],
  );
});

test("uses the same milestone rule for short positions and terminal BE", () => {
  const shortProtected = position({
    isShort: true,
    lastMilestone: 5,
    entryPrice: 2,
  });
  assert.match(
    fmtPositionProtectionLine(shortProtected),
    /BE STOP → \$2\.0000/,
  );

  const closedAtBu = position({
    status: "bu_stop",
    lastMilestone: 5,
    entryPrice: 2,
  });
  assert.match(
    fmtPositionProtectionLine(closedAtBu),
    /BE STOP сработал на \$2\.0000/,
  );
});

test("includes position peak in EXPIRED and achieved take in BE STOP", () => {
  const expired = msgExpired(position(), 1, 0);
  assert.match(expired, /Максимальный пик позиции: \+10\.00%/);
  assert.match(expired, /POSITION CLOSED — TEST/);
  assert.match(expired, /<b>⏳ EXPIRED<\/b>/);

  const protectedBuStop = msgBUStop(
    position({ status: "bu_stop", lastMilestone: 5 }),
    1,
    0,
  );
  assert.match(protectedBuStop, /Пик позиции: \+10\.00% \(\$1\.1000\)/);
  assert.match(protectedBuStop, /Тейк: \+5% достигнут/);
  assert.match(protectedBuStop, /POSITION CLOSED — TEST/);
  assert.match(protectedBuStop, /<b>🔵 BE STOP<\/b>/);
});

test("Bullish Accumulation uses the canonical lifecycle blocks", () => {
  const plm = position({ sentimentKey: "price_led_momentum" });
  const accumulation = position({ sentimentKey: "bullish_accumulation" });
  const shape = (message: string) =>
    message.split("\n").map((line, index, lines) => {
      if (index >= lines.length - 2)
        return index === lines.length - 2 ? "PATTERN" : "TAGS";
      if (line === "") return "BLANK";
      if (line.startsWith("🟣📊 <b>POSITION UPDATE")) return "UPDATE HEADER";
      if (line.startsWith("🏁 <b>POSITION CLOSED")) return "CLOSE HEADER";
      if (line.startsWith("<b>")) return "EVENT";
      if (line.startsWith("$")) return "PRICE";
      return "CONTEXT";
    });

  assert.deepEqual(
    shape(msgAccumVolumeBuilding(accumulation, 1.03, 3, 2, null)),
    shape(msgAccumVolumeBuilding(plm, 1.03, 3, 2, null)),
  );
  assert.deepEqual(
    shape(msgExpired(accumulation, 1, 0)),
    shape(msgExpired(plm, 1, 0)),
  );
});
