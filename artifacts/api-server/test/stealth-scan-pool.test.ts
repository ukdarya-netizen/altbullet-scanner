import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  buildStealthScanPool,
  buildStealthScanWorklist,
  findSupplementalSymbols,
  getCircularPageWindow,
  selectStealthRangeScanCandidates,
  shouldEvaluateNeonSupportShadow,
  shouldContinueAfterStealthEvaluation,
  evaluateRangeLifecycleOnce,
  shouldSkipForNegativeShortOiWithout24h,
  canDeliverQualifiedRangeArm,
} from "../src/lib/stealth-scan-pool.js";

const ticker = (symbol: string) => ({ symbol }) as any;

test("Stealth pool unions and deduplicates normal, Prescan, and OI Watch symbols", () => {
  const result = buildStealthScanPool({
    normalTickers: [ticker("A-USDT"), ticker("B-USDT"), ticker("A-USDT")],
    tickerBySymbol: new Map([
      ["A-USDT", ticker("A-USDT")],
      ["B-USDT", ticker("B-USDT")],
      ["C-USDT", ticker("C-USDT")],
      ["D-USDT", ticker("D-USDT")],
    ]),
    prescanSymbols: ["C-USDT", "A-USDT"],
    oiWatchSymbols: ["C-USDT", "D-USDT", "MISSING-USDT"],
  });
  assert.deepEqual(
    result.tickers.map((item) => item.symbol),
    ["A-USDT", "B-USDT", "C-USDT", "D-USDT"],
  );
  assert.deepEqual([...result.supplementalSymbols], ["C-USDT", "D-USDT"]);
});

test("normal pool remains normal and unavailable supplemental tickers are skipped", () => {
  const result = buildStealthScanPool({
    normalTickers: [ticker("A-USDT")],
    tickerBySymbol: new Map([["A-USDT", ticker("A-USDT")]]),
    prescanSymbols: ["MISSING-USDT"],
    oiWatchSymbols: [],
  });
  assert.deepEqual(
    result.tickers.map((item) => item.symbol),
    ["A-USDT"],
  );
  assert.equal(result.supplementalSymbols.size, 0);
});

test("symbols injected after the normal snapshot remain Stealth-only", () => {
  const normalSnapshot = [ticker("NORMAL-USDT")];
  const result = buildStealthScanPool({
    normalTickers: normalSnapshot,
    tickerBySymbol: new Map([
      ["NORMAL-USDT", ticker("NORMAL-USDT")],
      ["PRESCAN-USDT", ticker("PRESCAN-USDT")],
      ["OI-WATCH-USDT", ticker("OI-WATCH-USDT")],
    ]),
    prescanSymbols: ["PRESCAN-USDT"],
    oiWatchSymbols: ["OI-WATCH-USDT"],
  });

  assert.deepEqual(
    [...result.supplementalSymbols],
    ["PRESCAN-USDT", "OI-WATCH-USDT"],
  );
});

test("persisted Range arms join the pool without changing the normal universe", () => {
  const normal = [ticker("NORMAL-USDT")];
  const pool = buildStealthScanPool({
    normalTickers: normal,
    tickerBySymbol: new Map([
      ["NORMAL-USDT", ticker("NORMAL-USDT")],
      ["ARM-USDT", ticker("ARM-USDT")],
      ["PRESCAN-USDT", ticker("PRESCAN-USDT")],
    ]),
    rangeArmSymbols: ["ARM-USDT"],
    prescanSymbols: ["PRESCAN-USDT"],
    oiWatchSymbols: [],
  });
  assert.deepEqual(
    pool.tickers.map((item) => item.symbol),
    ["NORMAL-USDT", "ARM-USDT", "PRESCAN-USDT"],
  );
  assert.deepEqual([...pool.supplementalSymbols], ["ARM-USDT", "PRESCAN-USDT"]);
  assert.deepEqual(
    normal.map((item) => item.symbol),
    ["NORMAL-USDT"],
  );
});

test("Range scan selection prioritizes active arms, skips missing tickers, caps, and rotates fairly", () => {
  const symbols = ["ARM-A", "ARM-B", "ARM-C", "SUP-A", "SUP-B", "SUP-C"];
  const tickers = new Map(symbols.map((symbol) => [symbol, ticker(symbol)]));
  const first = selectStealthRangeScanCandidates({
    activeRangeSymbols: [
      "NORMAL-ARM",
      "ARM-A",
      "MISSING",
      "ARM-B",
      "ARM-C",
      "ARM-A",
    ],
    supplementalSymbols: ["SUP-A", "SUP-B", "SUP-C"],
    tickerBySymbol: tickers,
    normalSymbols: ["NORMAL-ARM"],
    reviewedWatchSymbols: ["SUP-C"],
    persistedDeliverySymbols: ["SUP-B"],
    rangeLimit: 2,
    supplementalLimit: 3,
  });
  assert.deepEqual(
    first.tickers.map((item) => item.symbol),
    ["ARM-A", "ARM-B", "SUP-A", "SUP-B", "SUP-C"],
  );
  assert.deepEqual([...first.selectedRangeSymbols], ["ARM-A", "ARM-B"]);
  assert.deepEqual([...first.rangeOnlySymbols], ["ARM-A", "ARM-B", "SUP-A"]);
  const scanWorklist = buildStealthScanWorklist({
    normalTickers: [ticker("NORMAL")],
    persistedDeliveryTickers: [ticker("SUP-B")],
    reviewedWatchTickers: [
      ticker("REVIEWED"),
      ticker("SUP-C"),
      ticker("ARM-A"),
    ],
    selectedSupplementalTickers: first.tickers,
  });
  assert.deepEqual(
    scanWorklist.map((item) => item.symbol),
    ["NORMAL", "SUP-B", "REVIEWED", "SUP-C", "ARM-A", "ARM-B", "SUP-A"],
  );

  const second = selectStealthRangeScanCandidates({
    activeRangeSymbols: ["ARM-A", "MISSING", "ARM-B", "ARM-C", "ARM-A"],
    supplementalSymbols: ["SUP-A", "SUP-B", "SUP-C"],
    tickerBySymbol: tickers,
    normalSymbols: [],
    rangeCursor: first.nextRangeCursor,
    supplementalCursor: 1,
    rangeLimit: 2,
    supplementalLimit: 1,
  });
  assert.deepEqual(
    second.tickers.map((item) => item.symbol),
    ["ARM-C", "ARM-A", "SUP-B"],
  );
  assert.equal(second.tickers.length, 3);
});

test("empty and all-missing candidate sets select no ticker", () => {
  const empty = selectStealthRangeScanCandidates({
    activeRangeSymbols: [],
    supplementalSymbols: [],
    tickerBySymbol: new Map(),
    normalSymbols: [],
  });
  assert.deepEqual(empty.tickers, []);
  assert.deepEqual([...empty.rangeOnlySymbols], []);

  const missing = selectStealthRangeScanCandidates({
    activeRangeSymbols: ["MISSING-ARM"],
    supplementalSymbols: ["MISSING-SUPPLEMENTAL"],
    tickerBySymbol: new Map(),
    normalSymbols: [],
  });
  assert.deepEqual(missing.tickers, []);
  assert.deepEqual([...missing.rangeOnlySymbols], []);
});

test("normal arms are removed before the active-arm cap is applied", () => {
  const normalSymbols = Array.from(
    { length: 10 },
    (_, index) => `NORMAL-${index}`,
  );
  const armSymbols = Array.from({ length: 50 }, (_, index) => `ARM-${index}`);
  const allSymbols = [...normalSymbols, ...armSymbols];
  const result = selectStealthRangeScanCandidates({
    activeRangeSymbols: allSymbols,
    supplementalSymbols: [],
    tickerBySymbol: new Map(
      allSymbols.map((symbol) => [symbol, ticker(symbol)]),
    ),
    normalSymbols,
    rangeLimit: 50,
  });
  assert.equal(result.selectedRangeSymbols.size, 50);
  assert.deepEqual([...result.selectedRangeSymbols], armSymbols);
});

test("bounded arm pages rotate beyond the oldest 500 rows without permanent starvation", () => {
  const totalCount = 501;
  let cursor = 0;
  const visited = new Set<number>();
  for (let cycle = 0; cycle < 11; cycle++) {
    const page = getCircularPageWindow(totalCount, cursor, 50);
    for (let index = 0; index < page.firstPageLimit; index++) {
      visited.add(page.offset + index);
    }
    for (let index = 0; index < page.wrappedPageLimit; index++) {
      visited.add(index);
    }
    cursor = page.nextCursor;
  }
  assert.equal(visited.size, totalCount);
  assert.deepEqual(getCircularPageWindow(0, 0, 50), {
    offset: 0,
    firstPageLimit: 0,
    wrappedPageLimit: 0,
    nextCursor: 0,
  });
});

test("scanner wires persisted arms and selected supplementals into the guarded worklist", () => {
  const source = readFileSync("src/lib/scanner.ts", "utf8");
  assert.match(
    source,
    /listActiveAutoRange4hArms\(\s*1000,\s*autoRangeScanCursor,?\s*\[/,
  );
  assert.match(
    source,
    /selectStealthRangeScanCandidates\(\{[\s\S]*?normalSymbols:\s*normalScanSymbols/,
  );
  assert.match(
    source,
    /rangeOnlyLoopSymbols\s*=\s*rangeScanSelection\.rangeOnlySymbols/,
  );
  assert.match(
    source,
    /selectedSupplementalTickers:\s*rangeScanSelection\.tickers/,
  );
  assert.match(
    source,
    /allowCreate:\s*isLiveStealthBreakoutSource\("auto_range_4h"\)\s*&&\s*candidate\.identity\s*!==\s*null/,
  );
  assert.match(
    source,
    /isRangeOnlySupplemental\s*\?\s*null\s*:\s*\(persistedNeonSupportEvents\.get\(symbol\)/,
  );
  assert.match(
    source,
    /const result = await evaluateRangeLifecycleOnce\(\{\s*selected:\s*isRangeLifecycleCandidate/,
  );
  assert.ok(
    source.indexOf("const _sbRangeArmedEarlyByVenue = new Map<") <
      source.indexOf("shouldSkipForNegativeShortOiWithout24h({"),
  );
  assert.match(source, /"Bounded Stealth Range scan selection"/);
});

test("active supplemental arms run before ordinary work without expanding its universe", () => {
  const worklist = buildStealthScanWorklist({
    normalTickers: [ticker("NORMAL")],
    persistedDeliveryTickers: [ticker("DELIVERY")],
    reviewedWatchTickers: [],
    selectedSupplementalTickers: [
      ticker("ARM"),
      ticker("SUP"),
      ticker("NORMAL"),
    ],
    prioritySymbols: new Set(["ARM"]),
  });
  assert.deepEqual(
    worklist.map((item) => item.symbol),
    ["ARM", "NORMAL", "DELIVERY", "SUP"],
  );
});

test("Range-only supplemental work continues only for Range Breakout and Impulse Buy", () => {
  assert.equal(
    shouldContinueAfterStealthEvaluation({
      supplemental: true,
      rangeOnly: true,
      detectedPattern: "stealth_breakout",
    }),
    true,
  );
  assert.equal(
    shouldContinueAfterStealthEvaluation({
      supplemental: true,
      rangeOnly: true,
      detectedPattern: "impulse_buy",
    }),
    true,
  );
  for (const otherPattern of [
    "neon_support_bounce",
    "whale_watch",
    "balanced_grind",
  ]) {
    assert.equal(
      shouldContinueAfterStealthEvaluation({
        supplemental: true,
        rangeOnly: true,
        detectedPattern: otherPattern,
      }),
      false,
    );
  }
  assert.equal(
    shouldEvaluateNeonSupportShadow({
      inStealthUniverse: true,
      rangeOnly: true,
    }),
    false,
  );
});

test("reviewed neutral observations stay in the Stealth-only pool after leaving active trades", () => {
  const reviewedWatchSymbols = ["APEX-USDT", "MEW-USDT"];
  const result = buildStealthScanPool({
    normalTickers: [ticker("NORMAL-USDT")],
    tickerBySymbol: new Map([
      ["NORMAL-USDT", ticker("NORMAL-USDT")],
      ["APEX-USDT", ticker("APEX-USDT")],
      ["MEW-USDT", ticker("MEW-USDT")],
    ]),
    prescanSymbols: reviewedWatchSymbols,
    oiWatchSymbols: [],
  });
  assert.deepEqual([...result.supplementalSymbols], reviewedWatchSymbols);
  assert.deepEqual(
    result.tickers.map((item) => item.symbol),
    ["NORMAL-USDT", ...reviewedWatchSymbols],
  );
});

test("post-snapshot injections stay supplemental when OI Watch lookup fails", () => {
  const normalSnapshot = [ticker("NORMAL-USDT")];
  const currentPool = [
    ...normalSnapshot,
    ticker("QUIET-PRESCAN-USDT"),
    ticker("LAYER8-OI-WATCH-USDT"),
  ];

  assert.deepEqual(
    [...findSupplementalSymbols(normalSnapshot, currentPool)],
    ["QUIET-PRESCAN-USDT", "LAYER8-OI-WATCH-USDT"],
  );
});

test("supplemental symbols continue only for live technical patterns", () => {
  assert.equal(
    shouldContinueAfterStealthEvaluation({
      supplemental: true,
      detectedPattern: null,
    }),
    false,
  );
  assert.equal(
    shouldContinueAfterStealthEvaluation({
      supplemental: true,
      detectedPattern: "balanced_grind",
    }),
    false,
  );
  assert.equal(
    shouldContinueAfterStealthEvaluation({
      supplemental: true,
      detectedPattern: "stealth_breakout",
    }),
    true,
  );
  assert.equal(
    shouldContinueAfterStealthEvaluation({
      supplemental: true,
      detectedPattern: "neon_support_bounce",
    }),
    true,
  );
  for (const unrelatedPattern of [
    "balanced_grind",
    "whale_watch",
    "price_led_momentum",
    "impulse_buy",
  ]) {
    assert.equal(
      shouldContinueAfterStealthEvaluation({
        supplemental: true,
        detectedPattern: unrelatedPattern,
      }),
      false,
    );
  }
  assert.equal(
    shouldContinueAfterStealthEvaluation({
      supplemental: false,
      detectedPattern: null,
    }),
    false,
  );
});

test("selected stored Range arms advance once before a negative short-OI fire gate", async () => {
  const storedArmResult = {
    status: "qualified",
    arm: { levelSource: "auto_range_4h", breakoutLevel: 100 },
  };
  let evaluations = 0;
  const evaluate = async () => {
    evaluations++;
    return storedArmResult;
  };
  const early = await evaluateRangeLifecycleOnce({
    selected: true,
    priorResult: null,
    evaluate,
  });
  const reused = await evaluateRangeLifecycleOnce({
    selected: true,
    priorResult: early,
    evaluate,
  });

  assert.strictEqual(early, storedArmResult);
  assert.strictEqual(reused, storedArmResult);
  assert.equal(evaluations, 1);

  const oiGateRejects = shouldSkipForNegativeShortOiWithout24h({
    coinglassAvailable: true,
    oi24h: null,
    oi30m: -3,
    oi1h: -4,
  });
  assert.equal(oiGateRejects, true);
  assert.equal(canDeliverQualifiedRangeArm(reused!, !oiGateRejects), false);
});

test("Neon shadow evaluation is enabled for every symbol in the Stealth universe", () => {
  assert.equal(
    shouldEvaluateNeonSupportShadow({ inStealthUniverse: true }),
    true,
  );
  assert.equal(
    shouldEvaluateNeonSupportShadow({ inStealthUniverse: false }),
    false,
  );
});
