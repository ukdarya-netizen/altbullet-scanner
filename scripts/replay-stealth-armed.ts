import { writeFile } from "node:fs/promises";
import {
  confirmStealthFourHourBreakout,
  analyzeStealthStructure,
  normalizeClosedBreakoutCandles,
  refineStealthBreakoutEntry,
  type BreakoutCandle,
} from "../artifacts/api-server/src/lib/breakout-analysis.js";
import {
  buildStealthArmedSnapshot,
  evaluateStealthArmedSetup,
  type StealthArmedSnapshot,
} from "../artifacts/api-server/src/lib/stealth-breakout-armed.js";
import { getKlinesRange } from "../artifacts/api-server/src/lib/bingx.js";

type HistoryRow = {
  id: number;
  symbol: string;
  sentimentKey: string;
  status: string;
  detectedAt: string;
  pnlPercent: number | null;
  peakPct: number | null;
};

type VariantEntry = {
  entryAt: string;
  entryPrice: number;
  peak48hPct: number | null;
  drawdown48hPct: number | null;
  hit10BeforeStop: boolean | null;
  stopBefore10: boolean | null;
};

type VariantResult = {
  direct: VariantEntry | null;
  retest: VariantEntry | null;
  hybrid: VariantEntry | null;
};

const apiBase = process.argv
  .find((argument) => argument.startsWith("--api-base="))
  ?.slice("--api-base=".length);
const outputPath =
  process.argv
    .find((argument) => argument.startsWith("--output="))
    ?.slice("--output=".length) ??
  "artifacts/api-server/stealth-armed-replay.json";
if (!apiBase)
  throw new Error("--api-base=https://production.example is required");

const response = await fetch(
  `${apiBase}/api/tracker/signal-history?limit=200&pattern=stealth_breakout`,
);
if (!response.ok) throw new Error(`history request failed: ${response.status}`);
const payload = (await response.json()) as
  | HistoryRow[]
  | { signals?: HistoryRow[]; data?: HistoryRow[] };
const rows = (
  Array.isArray(payload) ? payload : (payload.signals ?? payload.data ?? [])
).filter((row) => row.sentimentKey === "stealth_breakout");

const candle = (row: {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}): BreakoutCandle => ({
  time: Number(row.time),
  open: Number(row.open),
  high: Number(row.high),
  low: Number(row.low),
  close: Number(row.close),
  volume: Number(row.volume),
});
const closeAt = (row: BreakoutCandle, intervalMs: number) =>
  row.time + intervalMs;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
function buildVariantEntry(
  entryAt: number,
  entryPrice: number,
  candles: BreakoutCandle[],
): VariantEntry {
  const forward = candles.filter((item) => {
    const at = closeAt(item, HOUR / 2);
    return at > entryAt && at <= entryAt + 48 * HOUR;
  });
  if (entryPrice <= 0 || forward.length === 0) {
    return {
      entryAt: new Date(entryAt).toISOString(),
      entryPrice,
      peak48hPct: null,
      drawdown48hPct: null,
      hit10BeforeStop: null,
      stopBefore10: null,
    };
  }
  let firstTargetAt: number | null = null;
  let firstStopAt: number | null = null;
  for (const item of forward) {
    const at = closeAt(item, HOUR / 2);
    if (firstTargetAt === null && item.high >= entryPrice * 1.1)
      firstTargetAt = at;
    if (firstStopAt === null && item.low <= entryPrice * 0.9) firstStopAt = at;
  }
  return {
    entryAt: new Date(entryAt).toISOString(),
    entryPrice,
    peak48hPct:
      ((Math.max(...forward.map((item) => item.high)) - entryPrice) /
        entryPrice) *
      100,
    drawdown48hPct:
      ((Math.min(...forward.map((item) => item.low)) - entryPrice) /
        entryPrice) *
      100,
    hit10BeforeStop:
      firstTargetAt === null
        ? false
        : firstStopAt === null || firstTargetAt < firstStopAt,
    stopBefore10:
      firstStopAt === null
        ? false
        : firstTargetAt === null || firstStopAt < firstTargetAt,
  };
}
const matches: Array<
  HistoryRow & {
    armedPass: boolean;
    armedCrossAt: string | null;
    variants: VariantResult;
  }
> = [];

for (const row of rows) {
  const eventAt = Date.parse(row.detectedAt);
  const from = eventAt - 14 * DAY;
  const to = eventAt + 60 * HOUR;
  const [raw4h, raw30m] = await Promise.all([
    getKlinesRange(row.symbol, "4h", from, to),
    getKlinesRange(row.symbol, "30m", from, to),
  ]);
  const fourHour = raw4h.map(candle);
  const thirtyMinute = raw30m.map(candle);
  let arm: StealthArmedSnapshot | null = null;
  const consumed = new Set<string>();
  let matchedCrossAt: number | null = null;
  const replayFrom = eventAt - 72 * HOUR;

  for (
    let evaluatedAt = Math.ceil(replayFrom / (4 * HOUR)) * (4 * HOUR);
    evaluatedAt <= eventAt + 4 * HOUR;
    evaluatedAt += 4 * HOUR
  ) {
    const closed4h = fourHour.filter(
      (item) => closeAt(item, 4 * HOUR) <= evaluatedAt,
    );
    const closed30m = thirtyMinute.filter(
      (item) => closeAt(item, HOUR / 2) <= evaluatedAt,
    );
    if (!arm) {
      const structure = analyzeStealthStructure(closed4h);
      const latest4h = closed4h[closed4h.length - 1];
      if (latest4h) {
        const candidate = buildStealthArmedSnapshot({
          structure,
          latestClosedFourHourCandleTime: latest4h.time,
          confirmationCandles: closed4h,
          armedAt: evaluatedAt,
        });
        if (candidate && !consumed.has(candidate.structureKey)) arm = candidate;
      }
      continue;
    }
    const decision = evaluateStealthArmedSetup({
      arm,
      breakoutCandles4h: closed4h,
      refinementCandles: closed30m,
      evaluatedAt,
    });
    if (decision.status === "armed") continue;
    consumed.add(arm.structureKey);
    if (
      decision.status === "qualified" &&
      Math.abs(decision.firstCrossAt - eventAt) <= 90 * 60 * 1000
    ) {
      matchedCrossAt = decision.firstCrossAt;
      break;
    }
    arm = null;
  }

  // Legacy counterfactuals freeze the level at the historical first cross.
  // They are offline comparisons only and never bypass the live ARMED gate.
  const legacy4h = fourHour.filter(
    (item) => closeAt(item, 4 * HOUR) <= eventAt,
  );
  const legacy30m = thirtyMinute.filter(
    (item) => closeAt(item, HOUR / 2) <= eventAt,
  );
  const legacyStructure = analyzeStealthStructure(legacy4h);
  const legacyBreakoutPair = legacy4h.slice(-2);
  const legacyConfirmation = confirmStealthFourHourBreakout(
    legacyStructure,
    legacyBreakoutPair,
    eventAt,
  );
  const legacyRefinement = refineStealthBreakoutEntry(
    legacyStructure,
    legacy30m,
  );
  const directQualified =
    legacyStructure.quietZone &&
    legacyConfirmation.status === "fresh_breakout" &&
    legacyRefinement.status === "near_level";
  const directCandle = legacy30m[legacy30m.length - 1] ?? null;
  const direct =
    directQualified && directCandle
      ? buildVariantEntry(eventAt, directCandle.close, thirtyMinute)
      : null;
  const level = legacyStructure.breakoutLevel;
  const tolerance = legacyConfirmation.breakoutTolerance ?? 0;
  let retestCandle: BreakoutCandle | null = null;
  if (directQualified && level !== null && legacyConfirmation.lifecycle) {
    const breakoutCandle =
      legacyBreakoutPair[legacyConfirmation.lifecycle.breakoutIndex] ?? null;
    const breakoutAt = breakoutCandle
      ? closeAt(breakoutCandle, 4 * HOUR)
      : eventAt;
    retestCandle =
      thirtyMinute.find((item) => {
        const itemClose = closeAt(item, HOUR / 2);
        return (
          itemClose > breakoutAt &&
          itemClose <= breakoutAt + 12 * HOUR &&
          item.low <= level + tolerance &&
          item.close >= level
        );
      }) ?? null;
  }
  const retest = retestCandle
    ? buildVariantEntry(
        closeAt(retestCandle, HOUR / 2),
        retestCandle.close,
        thirtyMinute,
      )
    : null;
  // Experimental split only: strong first crosses enter directly; weaker
  // crosses require a held retest. Thresholds are reported, not enabled.
  const strongDirect =
    directQualified &&
    (legacyConfirmation.distanceFromLevelPct ?? 0) >= 0.75 &&
    (legacyConfirmation.closeStrength ?? 0) >= 0.6;
  matches.push({
    ...row,
    armedPass: matchedCrossAt !== null,
    armedCrossAt:
      matchedCrossAt === null ? null : new Date(matchedCrossAt).toISOString(),
    variants: {
      direct,
      retest,
      hybrid: strongDirect ? direct : retest,
    },
  });
  process.stdout.write(".");
}

const terminal = new Set([
  "profit",
  "bu_stop",
  "stop_loss",
  "cancelled",
  "breakeven",
]);
const summary: Record<string, { total: number; passed: number }> = {};
for (const row of matches) {
  const bucket = summary[row.status] ?? { total: 0, passed: 0 };
  bucket.total += 1;
  if (row.armedPass) bucket.passed += 1;
  summary[row.status] = bucket;
}
const variants = Object.fromEntries(
  (["armed", "direct", "retest", "hybrid"] as const).map((variant) => {
    const passed = (row: (typeof matches)[number]) =>
      variant === "armed" ? row.armedPass : row.variants[variant] !== null;
    const byStatus: Record<string, { total: number; passed: number }> = {};
    for (const row of matches) {
      const bucket = byStatus[row.status] ?? { total: 0, passed: 0 };
      bucket.total += 1;
      if (passed(row)) bucket.passed += 1;
      byStatus[row.status] = bucket;
    }
    return [
      variant,
      {
        total: matches.filter(passed).length,
        closedTotal: matches.filter(
          (row) => passed(row) && terminal.has(row.status),
        ).length,
        actual48h: {
          hit10BeforeStop: matches.filter(
            (row) =>
              variant !== "armed" &&
              row.variants[variant]?.hit10BeforeStop === true,
          ).length,
          stopBefore10: matches.filter(
            (row) =>
              variant !== "armed" &&
              row.variants[variant]?.stopBefore10 === true,
          ).length,
        },
        byStatus,
      },
    ];
  }),
);
const report = {
  generatedAt: new Date().toISOString(),
  source: apiBase,
  total: matches.length,
  passed: matches.filter((row) => row.armedPass).length,
  closedTotal: matches.filter((row) => terminal.has(row.status)).length,
  closedPassed: matches.filter(
    (row) => terminal.has(row.status) && row.armedPass,
  ).length,
  byStatus: summary,
  variants,
  rows: matches,
};
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(`\n${JSON.stringify({ ...report, rows: undefined }, null, 2)}`);
