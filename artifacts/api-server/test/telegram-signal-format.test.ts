import test from "node:test";
import assert from "node:assert/strict";
import {
  ACTIVATION_TEXT,
  buildSignalManagementLine,
  formatAlphaSignal,
  formatCompactAlphaSignal,
  resolvePrimarySignalPolicyContext,
  type AlphaResult,
} from "../src/lib/telegram.js";
import { buildTelegramPhotoDeliveryContent } from "../src/lib/telegram-photo-outbox-policy.js";
import {
  formatPrimarySignalTiming,
  withPrimarySignalTiming,
} from "../src/lib/telegram-signal-timing.js";

const baseSignal: AlphaResult = {
  symbol: "MNT-USDT",
  grade: "alpha",
  price: 0.4909,
  priceChange30m: 0,
  currentVolume: 0,
  avgVolume: 0,
  volumeMultiplier: 0,
  oiChangePercent: 0,
  openInterest: null,
  cmcRank: null,
  cmcSource: null,
  cmcAvailable: false,
  liquidationsUsd: null,
  liquidationsMultiple: null,
  coinglassAvailable: true,
  sentiment: "Liquidation Cascade",
  sentimentKey: "liquidation_cascade",
  traderAction: "LONG",
  alphaScore: 4,
  isContinuing: false,
  cumulativeOiChange: 0,
  tradingViewUrl: "https://www.tradingview.com/chart/?symbol=BINGX:MNTUSDT",
  bingxUrl: "https://bingx.com/en/perpetual/MNTUSDT/",
};

test("Telegram management line gives BTC its 1/2/1 stop ladder only", () => {
  const bitcoin = buildSignalManagementLine("liquidation_cascade", "BTC-USDT");
  assert.match(bitcoin, /Б\/У после \+1%/);
  assert.match(bitcoin, /трейлинг только с \+2%/);
  assert.match(bitcoin, /отступ от пика 1 п\.п\./);
  assert.match(
    bitcoin,
    /каждый новый \+1% пика подтягивает стоп на \+1 п\.п\./,
  );
  assert.doesNotMatch(bitcoin, /\+10%|20–25%/);

  const altcoin = buildSignalManagementLine("liquidation_cascade", "ETH-USDT");
  assert.match(altcoin, /при \+10% стоп в прибыль \+5%/);
  assert.match(altcoin, /трейлинг \+15%/);
});

test("subscriber welcome text distinguishes BTC from altcoin exit rules", () => {
  assert.match(ACTIVATION_TEXT, /BTC:.*\+1%.*\+2%.*1 п\.п\./);
  assert.match(
    ACTIVATION_TEXT,
    /Достигнутые уровни.*не подтверждение частичной сделки/,
  );
  assert.doesNotMatch(ACTIVATION_TEXT, /<b>\+15%<\/b>|<b>\+5-10%<\/b>/);
});

test("policy resolution fails closed when the authoritative tracker is absent", () => {
  assert.equal(resolvePrimarySignalPolicyContext(undefined), null);
  assert.equal(resolvePrimarySignalPolicyContext(null), null);
  assert.deepEqual(
    resolvePrimarySignalPolicyContext({
      entryPolicyVersion: null,
      splitLimitPrice: 0.466,
      policyVersion: null,
      entryPrice: 0.478,
      originalEntryPrice: 0.49,
      stopLossPct: 8,
      stopLossPrice: 0.45,
    }),
    {
      entryPolicyVersion: null,
      splitLimitPrice: 0.466,
      policyVersion: null,
      entryPrice: 0.478,
      originalEntryPrice: 0.49,
      stopLossPct: 8,
      stopLossPrice: 0.45,
    },
  );
});

test("primary alert formatter keeps fresh and legacy entry wording distinct", () => {
  const fresh = formatCompactAlphaSignal({
    ...baseSignal,
    sentimentKey: "impulse_buy",
  });
  assert.match(fresh, /Вход:<\/b> \$/);
  assert.doesNotMatch(fresh, /лимиткой|лимит на добавление/);
  assert.doesNotMatch(fresh, /80%.*20%/);
  assert.match(fresh, /<b>Стоп:<\/b>.*−8\.0%/);

  const legacy = formatCompactAlphaSignal(
    {
      ...baseSignal,
      sentimentKey: "impulse_buy",
    },
    { entryPolicyVersion: null, splitLimitPrice: 0.466355 },
  );
  assert.match(legacy, /50% рынок/);
  assert.match(legacy, /лимит/);
  assert.match(legacy, /−5%/);
  assert.doesNotMatch(legacy, /80%.*20%/);
});

test("primary alert uses detected time in Dubai, not delivery time", () => {
  const detectedAt = new Date("2026-09-24T22:57:00Z");
  assert.equal(
    formatPrimarySignalTiming(detectedAt, new Date("2026-09-24T22:59:00Z")),
    "🕒 <b>Обнаружен:</b> 25/09/2026 02:57 (Dubai)",
  );
  assert.match(
    formatPrimarySignalTiming(detectedAt, new Date("2026-09-24T23:08:00Z")),
    /25\/09\/2026 02:57 \(Dubai\) · ⚠️ <b>Доставка с задержкой 11 мин<\/b>/,
  );
  assert.doesNotMatch(
    formatPrimarySignalTiming(detectedAt, new Date("2026-09-24T23:01:59Z")),
    /задержкой/,
  );
});

test("BTC Impulse Buy primary alert shows detection time and only single-position rules", () => {
  const signal: AlphaResult = {
    ...baseSignal,
    symbol: "BTC-USDT",
    sentimentKey: "impulse_buy",
    price: 100_000,
  };
  const policy = {
    entryPolicyVersion: "single_entry_v1",
    policyVersion: null,
    stopLossPrice: 99_000,
    stopLossPct: 1,
  };
  for (const render of [formatAlphaSignal, formatCompactAlphaSignal]) {
    const text = withPrimarySignalTiming(
      render(signal, policy),
      new Date("2026-09-24T22:57:00Z"),
      new Date("2026-09-24T23:08:00Z"),
    );
    assert.match(text, /25\/09\/2026 02:57 \(Dubai\)/);
    assert.match(text, /Доставка с задержкой 11 мин/);
    assert.match(text, /Б\/У после \+1%/);
    assert.match(text, /трейлинг только с \+2%/);
    assert.doesNotMatch(text, /runner|раннер|\bcore\b|ядро/i);
  }
});

test("queued primary caption gains timing and updates delay without losing trading details", () => {
  const detectedAt = new Date("2026-09-24T22:57:00Z");
  const header = "🪙 <b>MNT</b>";
  const legacy = `${header}\n${formatCompactAlphaSignal(baseSignal)}`;
  const queued = withPrimarySignalTiming(
    legacy,
    detectedAt,
    new Date("2026-09-24T22:58:00Z"),
    1_000,
  );
  const delivered = withPrimarySignalTiming(
    queued,
    detectedAt,
    new Date("2026-09-24T23:18:00Z"),
    1_000,
  );
  const content = buildTelegramPhotoDeliveryContent(delivered);
  assert.equal(content.caption, delivered);
  assert.equal(content.continuationTexts.length, 0);
  assert.equal(delivered.match(/Обнаружен:/g)?.length, 1);
  assert.match(delivered, /Доставка с задержкой 21 мин/);
  assert.match(delivered, /<b>Вход:<\/b>/);
  assert.match(delivered, /<b>Стоп:<\/b>/);
  assert.match(delivered, /href="https:\/\/www\.tradingview\.com/);
  assert.match(delivered, /href="https:\/\/bingx\.com/);
  assert.match(delivered, /href="https:\/\/www\.coinglass\.com/);
  assert.equal(
    withPrimarySignalTiming(
      legacy,
      detectedAt,
      new Date("2026-09-24T23:18:00Z"),
    ),
    delivered,
  );
});

test("Stealth alerts label known level sources without changing the pattern name", () => {
  for (const render of [formatAlphaSignal, formatCompactAlphaSignal]) {
    const range = render({
      ...baseSignal,
      sentiment: "Stealth Breakout",
      sentimentKey: "stealth_breakout",
      stealthLevelSource: "auto_range_4h",
    });
    assert.match(range, /Range Breakout/);
    assert.doesNotMatch(range, /sentiment_key|bullish|bearish/i);

    for (const source of ["stealth_legacy", "continuation_shelf"] as const) {
      const resistance = render({
        ...baseSignal,
        sentiment: "Stealth Breakout",
        sentimentKey: "stealth_breakout",
        stealthLevelSource: source,
      });
      assert.match(resistance, /Resistance Breakout/);
    }

    const unknown = render({
      ...baseSignal,
      sentiment: "Stealth Breakout",
      sentimentKey: "stealth_breakout",
    });
    assert.doesNotMatch(unknown, /Range Breakout|Resistance Breakout/);
  }
});

test("compact Telegram metrics mark buying, selling, and neutral states", () => {
  const strong = formatCompactAlphaSignal({
    ...baseSignal,
    tokenWhaleIndex: 12,
    obImbalance: { bidAskRatio: 1.8 } as AlphaResult["obImbalance"],
    snf1h: 4,
    fundingRate: 0.03,
  });
  assert.match(strong, /WI \+12\.0🟢/);
  assert.match(strong, /OB 1\.80x🟢/);
  assert.match(strong, /SNF \+4\.0%\/1ч🟢/);
  assert.match(strong, /FR \+0\.030%🔴/);

  const weak = formatCompactAlphaSignal({
    ...baseSignal,
    tokenWhaleIndex: -11,
    obImbalance: { bidAskRatio: 0.6 } as AlphaResult["obImbalance"],
    snf1h: -4,
    fundingRate: -0.02,
  });
  assert.match(weak, /WI -11\.0🔴/);
  assert.match(weak, /OB 0\.60x🔴/);
  assert.match(weak, /SNF -4\.0%\/1ч🔴/);
  assert.match(weak, /FR -0\.020%🟢/);

  const neutral = formatCompactAlphaSignal({
    ...baseSignal,
    tokenWhaleIndex: 0,
    obImbalance: { bidAskRatio: 1 } as AlphaResult["obImbalance"],
    snf1h: 0,
    fundingRate: 0,
  });
  assert.match(neutral, /WI \+0\.0⚪/);
  assert.match(neutral, /OB 1\.00x⚪/);
  assert.match(neutral, /SNF \+0\.0%\/1ч⚪/);
  assert.match(neutral, /FR \+0\.000%⚪/);
});

test("legacy reconciled formatter uses persisted stop and does not infer runner", () => {
  const plm = formatCompactAlphaSignal(
    { ...baseSignal, sentimentKey: "price_led_momentum" },
    {
      entryPolicyVersion: null,
      entryPrice: 0.478,
      originalEntryPrice: 0.49,
      splitLimitPrice: 0.4655,
      stopLossPct: 8,
      stopLossPrice: 0.4504,
      policyVersion: null,
    },
  );
  assert.match(plm, /−8\.0%/);
  assert.match(plm, /средняя/);

  const legacyImpulse = formatCompactAlphaSignal(
    { ...baseSignal, sentimentKey: "impulse_buy" },
    {
      entryPolicyVersion: null,
      entryPrice: 0.478,
      originalEntryPrice: 0.49,
      splitLimitPrice: 0.4655,
      stopLossPct: 10,
      stopLossPrice: 0.4302,
      policyVersion: null,
    },
  );
  assert.doesNotMatch(legacyImpulse, /Exit policy/);
});

test("escapes comparison signs in the score breakdown for Telegram HTML", () => {
  const text = formatAlphaSignal({
    ...baseSignal,
    signalId: 4886,
    scoreBreakdown: "liq1h $60k ⚠️ мало (<$60k, ист. −2 скор)",
  });

  assert.match(text, /&lt;\$60k/);
  assert.doesNotMatch(text, /мало \(<\$60k/);
  assert.doesNotMatch(text, /#4886|#\d+\b/);
});

test("does not mark a live Impulse Buy alert as an experiment", () => {
  const text = formatAlphaSignal({
    ...baseSignal,
    sentiment: "Impulse Buy",
    sentimentKey: "impulse_buy",
    traderAction: "LONG",
  });

  assert.match(text, /⚡ Импульсная покупка/);
  assert.doesNotMatch(text, /эксперимент/gi);
});

test("does not mark a live Price Led Momentum alert as an experiment", () => {
  const text = formatAlphaSignal({
    ...baseSignal,
    sentiment: "Price Led Momentum",
    sentimentKey: "price_led_momentum",
    traderAction: "LONG",
  });
  const compactText = formatCompactAlphaSignal({
    ...baseSignal,
    sentiment: "Price Led Momentum",
    sentimentKey: "price_led_momentum",
    traderAction: "LONG",
  });

  assert.match(text, /💫 Цена лидирует/);
  assert.doesNotMatch(text, /эксперимент/gi);
  assert.doesNotMatch(compactText, /эксперимент/gi);
});

test("preserves the historical Balanced Grind label without an experiment tag", () => {
  const text = formatAlphaSignal({
    ...baseSignal,
    sentiment: "Balanced Grind",
    sentimentKey: "balanced_grind",
  });

  assert.match(text, /🟡 Умеренный широкий рост/);
  assert.doesNotMatch(text, /эксперимент/gi);
});

test("shows Neon Support Bounce without an experiment marker and keeps its hashtag", () => {
  const text = formatAlphaSignal({
    ...baseSignal,
    sentiment: "Neon Support Bounce",
    sentimentKey: "neon_support_bounce",
  });

  assert.match(
    text,
    /🏷 <b>Паттерн:<\/b> 🩷 Neon Support — Отскок от поддержки/,
  );
  assert.doesNotMatch(text, /эксперимент/gi);
  assert.match(text, /#neon_support_bounce/);
});

test("hides Impulse diagnostics without adding an experiment marker", () => {
  const signal: AlphaResult = {
    ...baseSignal,
    sentiment: "Impulse Buy",
    sentimentKey: "impulse_buy",
    scoreBreakdown:
      "OI 30m+5.5%/1h+5.5%/4h-0.0% · Vol ×1.0 · CVD 1h+4h ✅ · Taker 50% · Impulse 3/3 [✓bullish_impulse,✓confirmed_volume,✓strong_close]",
  };
  const text = formatCompactAlphaSignal(signal);
  const fullText = formatAlphaSignal(signal);

  assert.doesNotMatch(text, /Импульсная покупка|Impulse Buy/);
  assert.doesNotMatch(text, /Impulse 3\/3|bullish_impulse|confirmed_volume/);
  assert.doesNotMatch(text, /эксперимент/gi);
  assert.doesNotMatch(
    fullText,
    /Impulse 3\/3|bullish_impulse|confirmed_volume/,
  );
  assert.doesNotMatch(fullText, /эксперимент/gi);
});

test("uses the same primary-signal block structure for every pattern", () => {
  const shape = (text: string) =>
    text
      .split("\n")
      .map((line) => {
        if (line.startsWith("🏷 <b>")) return "PATTERN";
        if (line.startsWith("🎯 <b>")) return "SCORE";
        if (line.startsWith("📥 <b>Вход:")) return "ENTRY";
        if (line.startsWith("🛑 <b>Стоп:")) return "STOP";
        if (line.startsWith("🛡 <b>Сопровождение:")) return "MANAGEMENT";
        if (line.startsWith("🔗 ")) return "LINKS";
        if (line.startsWith("#")) return "TAGS";
        return "OPTIONAL";
      })
      .filter((segment) => segment !== "OPTIONAL");

  assert.deepEqual(
    shape(
      formatCompactAlphaSignal({
        ...baseSignal,
        sentiment: "Bullish Accumulation",
        sentimentKey: "bullish_accumulation",
      }),
    ),
    shape(
      formatCompactAlphaSignal({
        ...baseSignal,
        sentiment: "Price-led Momentum",
        sentimentKey: "price_led_momentum",
      }),
    ),
  );
});

test("keeps a fully enriched primary signal and all chart links in one photo caption", () => {
  const signal: AlphaResult = {
    ...baseSignal,
    signalId: 123456,
    alphaScore: 10,
    scoreBreakdown:
      "liq1h $800k + OI 30m + volume + CVD + spot momentum + order-book confirmation",
    sentimentKey: "impulse_buy",
    liqStopPrice: 0.4516,
    liqStopPct: 8,
    liqTakes: [
      { price: 0.54, pctFromEntry: 10, liqUsd: 800_000 },
      { price: 0.565, pctFromEntry: 15, liqUsd: 600_000 },
      { price: 0.59, pctFromEntry: 20, liqUsd: 400_000 },
    ],
    upcomingUnlock: { daysUntil: 2, pctSupply: 12.4 },
    freshMoverRisk: { cycles: 2, price24h: 18.7 },
    isExhaustedSqueeze: true,
    globalOiChange: 68.2,
    fundingRate: 0.18,
    isScalpOnly: true,
    klineSlippage: 5.4,
    isRepeatSignal: true,
    isContinuing: true,
    cumulativeOiChange: 22.1,
    tokenWhaleIndex: 14.2,
    entryOb: {
      bidAskRatio: 1.82,
      bidVolumeUsd: 2_000_000,
      askVolumeUsd: 1_100_000,
      largestBidWallUsd: 900_000,
      largestBidWallPrice: 0.48,
      largestBidWallPct: 45,
      bidWallCount: 3,
      bias: "bull",
      scoreBonus: 1,
    },
    snf1h: 5.4,
    snf4h: 8.1,
    snf24h: 12.2,
  };

  const body = formatCompactAlphaSignal(signal);
  const header = "🪙 <b>MNT</b>\n";
  const content = buildTelegramPhotoDeliveryContent(header + body);
  const delayed = withPrimarySignalTiming(
    header + body,
    new Date("2026-09-24T22:57:00Z"),
    new Date("2026-09-24T23:18:00Z"),
    1_000,
  );
  const delayedContent = buildTelegramPhotoDeliveryContent(delayed);
  assert.equal(delayedContent.caption, delayed);
  assert.equal(delayedContent.continuationTexts.length, 0);
  assert.match(delayed, /Доставка с задержкой 21 мин/);
  for (const link of [
    "https://www.tradingview.com",
    "https://bingx.com",
    "https://www.coinglass.com",
  ]) {
    assert.ok(delayed.includes(link), `${link} remains in delayed caption`);
  }

  assert.equal(content.caption, header + body);
  assert.doesNotMatch(body, /#\d+\b/);
  assert.doesNotMatch(content.caption, /[▬─]{3,}/);
  assert.doesNotMatch(content.caption, /🏷/);
  assert.equal(content.continuationTexts.length, 0);
  assert.match(content.caption, /href="https:\/\/www\.tradingview\.com/);
  assert.match(content.caption, /href="https:\/\/bingx\.com/);
  assert.match(
    content.caption,
    /href="https:\/\/www\.coinglass\.com\/tv\/MNT"/,
  );
  assert.match(content.caption, /<b>Вход:<\/b>/);
  assert.match(content.caption, /<b>Стоп:<\/b>/);
  assert.doesNotMatch(content.caption, /<b>Цели:<\/b>/);
  assert.match(
    content.caption,
    /<b>Сопровождение:<\/b> БУ с \+5% · при \+10% стоп в прибыль \+5% · цель \+10%: вручную зафиксируй 20–25% \(не автоисполнение\) · трейлинг \+15%/,
  );

  const rangeBody = formatCompactAlphaSignal({
    ...signal,
    sentimentKey: "stealth_breakout",
    stealthLevelSource: "auto_range_4h",
  });
  const rangeContent = buildTelegramPhotoDeliveryContent(header + rangeBody);
  assert.equal(rangeContent.caption, header + rangeBody);
  assert.equal(rangeContent.continuationTexts.length, 0);
  assert.match(rangeContent.caption, /Range Breakout/);
  assert.match(rangeContent.caption, /<b>Вход:<\/b>/);
  assert.match(rangeContent.caption, /<b>Стоп:<\/b>/);
  assert.match(rangeContent.caption, /href="https:\/\/www\.tradingview\.com/);
  assert.match(rangeContent.caption, /href="https:\/\/bingx\.com/);
  assert.match(rangeContent.caption, /href="https:\/\/www\.coinglass\.com/);
});

test("uses the pattern-specific BE, first target, and trailing levels", () => {
  const text = formatCompactAlphaSignal({
    ...baseSignal,
    sentimentKey: "bullish_accumulation",
    liqTakes: [
      { price: 0.54, pctFromEntry: 10, liqUsd: 800_000 },
      { price: 0.565, pctFromEntry: 15, liqUsd: 600_000 },
    ],
  });

  assert.doesNotMatch(text, /Цели:/);
  assert.doesNotMatch(text, /\$0\.540/);
  assert.match(
    text,
    /Сопровождение:<\/b> БУ с \+10% · при \+10% стоп в прибыль \+5% · цель \+10%: вручную зафиксируй 20–25% \(не автоисполнение\) · трейлинг \+15%/,
  );
});

test("single-entry replay prefers persisted stop over conflicting live liq stop", () => {
  const replaySignal = {
    ...baseSignal,
    sentimentKey: "price_led_momentum",
    liqStopPct: 10,
    liqStopPrice: 0.44181,
  };
  const persistedPolicy = {
    entryPolicyVersion: "single_entry_v1",
    stopLossPct: 8,
    stopLossPrice: 0.451628,
  };

  for (const render of [formatAlphaSignal, formatCompactAlphaSignal]) {
    const text = render(replaySignal, persistedPolicy);
    assert.match(text, /0\.451628/);
    assert.match(text, /−8\.0%/);
    assert.doesNotMatch(text, /0\.441810/);
    assert.doesNotMatch(text, /−10\.0%/);
  }
});

test("primary instructions stay truthful for every live/reference pattern", () => {
  const patterns = [
    ["stealth_breakout", 10, 5, 15, 10],
    ["neon_support_bounce", 10, 5, 15, 10],
    ["balanced_grind", 10, 5, 15, 10],
    ["price_led_momentum", 10, 5, 15, 10],
    ["bullish_accumulation", 10, 10, 15, 10],
    ["liquidation_cascade", 10, 5, 15, 10],
    ["whale_watch", 10, 5, 12, 7],
    ["impulse_buy", 8, 5, 15, 10],
  ] as const;

  for (const [sentimentKey, stop, be, trailing, gap] of patterns) {
    for (const render of [formatAlphaSignal, formatCompactAlphaSignal]) {
      const text = render({
        ...baseSignal,
        sentimentKey,
        sentiment: sentimentKey,
      });
      assert.match(text, new RegExp(`−${stop}(?:\\.0)?%\\)`));
      assert.match(
        text,
        new RegExp(
          `цель \\+${sentimentKey === "whale_watch" ? 8 : 10}%: вручную зафиксируй 20–25% \\(не автоисполнение\\)`,
        ),
      );
      assert.match(text, new RegExp(`БУ с \\+${be}%`));
      assert.match(text, /при \+10% стоп в прибыль \+5%/);
      assert.match(
        text,
        new RegExp(`трейлинг \\+${trailing}%`),
      );
    }
  }
});

test("legacy full and compact instructions preserve the recorded split policy", () => {
  for (const sentimentKey of ["price_led_momentum", "impulse_buy"]) {
    for (const render of [formatAlphaSignal, formatCompactAlphaSignal]) {
      const text = render(
        { ...baseSignal, sentimentKey, sentiment: sentimentKey },
        {
          entryPolicyVersion: null,
          entryPrice: 0.478,
          originalEntryPrice: 0.49,
          splitLimitPrice: 0.4655,
          stopLossPct: sentimentKey === "impulse_buy" ? 10 : 8,
          stopLossPrice: 0.4302,
          policyVersion: sentimentKey === "impulse_buy" ? null : null,
        },
      );
      assert.match(text, /50%.*лимит/);
      assert.match(text, /−5%/);
    }
  }
});
