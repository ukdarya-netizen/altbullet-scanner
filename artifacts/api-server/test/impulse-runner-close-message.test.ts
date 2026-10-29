import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { TrackedSignal } from "@workspace/db";
import {
  fmtImpulseRunnerCoreCloseLine,
  fmtImpulseRunnerFinalLine,
  fmtImpulseRunnerPolicyLine,
  msgImpulseRunnerAccountingCorrection,
  msgImpulseRunnerFinalClose,
} from "../src/lib/watcher-formatters.js";

test("runner Telegram policy states breakeven starts after core close", () => {
  const policy = fmtImpulseRunnerPolicyLine({
    sentimentKey: "impulse_buy",
    policyVersion: "impulse_runner_v1",
    entryPolicyVersion: "single_entry_v1",
  });
  const coreClose = fmtImpulseRunnerCoreCloseLine({
    coreExitPrice: 120,
    corePnlPercent: 20,
  });

  assert.match(policy, /После закрытия core: аварийный стоп runner в Б\/У/);
  assert.match(policy, /от исходного входа/);
  assert.match(coreClose, /аварийный стоп — Б\/У от исходного входа/);
  assert.doesNotMatch(policy, /−(?:8|10)%|-{1}(?:8|10)%/);
});

test("runner close caption shows component results without a weighted result line", () => {
  const line = fmtImpulseRunnerFinalLine({
    coreExitPrice: 0.000917,
    corePnlPercent: 5.99,
    runnerExitPrice: 0.001162,
    runnerPnlPercent: 34.35,
  });

  assert.doesNotMatch(line, /Weighted result/i);
  assert.match(line, /Core .+\+5\.99%/);
  assert.match(line, /Runner .+\+34\.35%/);
});

test("runner close main PNL uses the original runner entry and runner-only result", () => {
  const tracked = {
    symbol: "PTB-USDT",
    entryPrice: 0.0009,
    originalEntryPrice: 0.000865,
    detectedAt: new Date(),
    policyVersion: "impulse_runner_v1",
    entryPolicyVersion: "single_entry_v1",
    sentimentKey: "impulse_buy",
    signalType: "multi",
    isShort: false,
    entrySpotNetBuy1h: null,
    entrySpotNetBuy4h: null,
    entrySpotNetBuy24h: null,
  } as unknown as TrackedSignal;

  const message = msgImpulseRunnerFinalClose(
    tracked,
    0.001162,
    0.000917,
    5.99,
    34.35,
    "profit",
  );

  assert.match(message, /\$0\.000865 → \$0\.001162 \(\+34\.35%\)/);
  assert.doesNotMatch(message, /\+11\.66%/);
  assert.doesNotMatch(message, /Weighted result/i);
});

test("historical runner expiry captions retain their recorded PNL", () => {
  const tracked = {
    symbol: "EXAMPLE-USDT",
    entryPrice: 100,
    originalEntryPrice: 100,
    detectedAt: new Date("2026-09-17T14:25:36Z"),
    policyVersion: "impulse_runner_v1",
    sentimentKey: "impulse_buy",
    signalType: "multi",
    isShort: false,
  } as unknown as TrackedSignal;

  for (const [price, pnl] of [
    [125, "+25.00%"],
    [90, "-10.00%"],
  ] as const) {
    const message = msgImpulseRunnerFinalClose(
      tracked,
      price,
      120,
      20,
      price === 125 ? 25 : -10,
      "expired",
      null,
      "age_expired",
    );
    assert.match(message, /IMPULSE RUNNER EXPIRED/);
    assert.ok(message.includes(pnl));
    assert.match(message, /фактическим PNL/);
    assert.doesNotMatch(message, /RUNNER BREAKEVEN/);
  }
});

test("five-day runner BE close shows the runner peak and achieved target", () => {
  const tracked = {
    symbol: "EXAMPLE-USDT",
    entryPrice: 100,
    originalEntryPrice: 100,
    peakPrice: 120,
    runnerPeakPrice: 120,
    lastMilestone: 10,
    detectedAt: new Date("2026-09-17T14:25:36Z"),
    policyVersion: "impulse_runner_v1",
    sentimentKey: "impulse_buy",
    signalType: "multi",
    isShort: false,
  } as unknown as TrackedSignal;
  const message = msgImpulseRunnerFinalClose(
    tracked,
    100,
    120,
    20,
    0,
    "bu_stop",
    null,
    "age_expired",
  );
  assert.match(message, /IMPULSE RUNNER BE STOP/);
  assert.match(message, /Пик позиции: \+20\.00%/);
  assert.match(message, /Пройденный уровень: \+10%/);
  assert.match(message, /защищённому Б\/У/);
});

test("PTB accounting correction explicitly replaces the stale Telegram result", () => {
  const tracked = {
    symbol: "PTB-USDT",
    entryPrice: 0.0008647,
    originalEntryPrice: 0.0008647,
    detectedAt: new Date("2026-09-20T16:34:55.198Z"),
    policyVersion: "impulse_runner_v1",
    entryPolicyVersion: "single_entry_v1",
    sentimentKey: "impulse_buy",
    signalType: "multi",
    isShort: false,
    entrySpotNetBuy1h: null,
    entrySpotNetBuy4h: null,
    entrySpotNetBuy24h: null,
  } as unknown as TrackedSignal;

  const message = msgImpulseRunnerAccountingCorrection(
    tracked,
    0.00116169,
    0.00091653,
    5.9939885,
    34.346012,
    11.664393,
    "profit",
  );

  assert.match(message, /ИСПРАВЛЕНИЕ ИТОГА IMPULSE RUNNER/);
  assert.match(message, /Предыдущий итог: \+11\.66%/);
  assert.match(message, /Правильный итог: <b>\+34\.35%<\/b>/);
  assert.match(message, /\$0\.000865 → \$0\.001162 \(\+34\.35%\)/);
});

test("every runner final close uses the dedicated Runner image", () => {
  const watcherSource = readFileSync(
    new URL("../src/lib/watcher.ts", import.meta.url),
    "utf8",
  );
  const finalClose = watcherSource.match(
    /async function closeImpulseRunnerFinalPosition\([\s\S]*?\n}\n\n\/\*\*/,
  )?.[0];

  assert.ok(finalClose);
  assert.match(finalClose, /\(\) =>\s*IMPULSE_RUNNER_CLOSED_IMG/);
  assert.doesNotMatch(finalClose, /BREAKEVEN_STOP_IMG/);
  assert.doesNotMatch(finalClose, /POSITION_EXIT_IMG/);
  assert.doesNotMatch(finalClose, /POSITION_UPDATE_IMG/);
  assert.match(finalClose, /persistedRunnerPnl = persisted\.runnerPnlPercent/);
});

test("BTC and milestones above 200% use the target-hit image; Runner close keeps its own", () => {
  const watcherSource = readFileSync(
    new URL("../src/lib/watcher.ts", import.meta.url),
    "utf8",
  );
  const imageSelector = watcherSource.match(
    /function milestoneImageFor\([\s\S]*?\n}\n/,
  )?.[0];

  assert.ok(imageSelector);
  assert.match(imageSelector, /tracked\.symbol === "BTC-USDT"/);
  assert.match(imageSelector, /tracked\.symbol === "BTCUSDT"/);
  assert.match(imageSelector, /milestone > 200/);
  assert.match(imageSelector, /return TARGET_HIT_IMG/);
  assert.match(
    imageSelector,
    /return MILESTONE_IMAGES\[milestone\] \?\? fallback/,
  );
  assert.match(watcherSource, /200: MILESTONE200_IMG/);
  assert.match(
    watcherSource,
    /milestoneImageFor\(tracked, milestone\)\s*\?\?\s*POSITION_UPDATE_IMG/,
  );
  assert.match(
    watcherSource,
    /milestoneImageFor\(tracked, firstTargetTransition\.imageMilestone\)\s*\?\?\s*FIRST_TARGET_IMG/,
  );
  assert.match(
    watcherSource,
    /kind === "late_target"[\s\S]*?image \?\? POSITION_UPDATE_IMG/,
  );
  assert.match(
    watcherSource,
    /kind === "trailing"[\s\S]*?milestone === 15 \|\| isBitcoinTrackedSignal\(tracked\)/,
  );
});

test("BTC catch-up runs before higher active and trailing transitions", () => {
  const watcherSource = readFileSync(
    new URL("../src/lib/watcher.ts", import.meta.url),
    "utf8",
  );

  const activeCatchUp = watcherSource.indexOf("const btcProgressMilestone =");
  const activeEight = watcherSource.indexOf(
    "// Active milestone +8%",
    activeCatchUp,
  );
  const activeFirstTarget = watcherSource.indexOf(
    "// Active → in_run transition",
    activeCatchUp,
  );
  const inRunSection = watcherSource.indexOf(
    "// in_run: trailing stop and milestones",
  );
  const inRunCatchUp = watcherSource.indexOf(
    "const btcReachedMilestone =",
    inRunSection,
  );
  const trailingTransition = watcherSource.indexOf(
    "if (trailingJustActivated)",
    inRunSection,
  );
  const partialBlock = watcherSource.match(
    /\/\/ Milestone \(5%[\s\S]*?\/\/ Active milestone \+8%/,
  )?.[0];

  assert.ok(activeCatchUp > 0 && activeCatchUp < activeEight);
  assert.ok(activeCatchUp < activeFirstTarget);
  assert.ok(inRunCatchUp > inRunSection && inRunCatchUp < trailingTransition);
  assert.ok(partialBlock);
  assert.match(
    partialBlock,
    /if \(isBitcoinTrackedSignal\(tracked\) \|\| !delivered\) continue/,
  );
});

test("historical BTC stop losses are excluded from peak repair", () => {
  const watcherSource = readFileSync(
    new URL("../src/lib/watcher.ts", import.meta.url),
    "utf8",
  );
  const repair = watcherSource.match(
    /async function repairMisclassifiedBuStopsFromPeak\(\)[\s\S]*?\n}\n/,
  )?.[0];

  assert.ok(repair);
  assert.match(repair, /if \(isBitcoinTrackedSignal\(tracked\)\) continue/);
});
