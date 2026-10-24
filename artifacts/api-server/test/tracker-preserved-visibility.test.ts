import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import {
  ACTIVE_PATTERN_KEYS,
  PRESERVED_DECOMMISSIONED_PATTERN_KEYS,
} from "../src/lib/dead-patterns.js";

const trackerRoute = readFileSync(
  resolve(process.cwd(), "src/routes/tracker.ts"),
  "utf8",
);
const signalHistoryPage = readFileSync(
  resolve(process.cwd(), "../alpha-scanner/src/pages/signal-history.tsx"),
  "utf8",
);

test("preserved retired patterns are visible only in open tracker views", () => {
  assert.deepEqual(PRESERVED_DECOMMISSIONED_PATTERN_KEYS, [
    "bullish_accumulation",
    "balanced_grind",
    "whale_watch",
    "price_led_momentum",
  ]);
  assert.equal(
    ACTIVE_PATTERN_KEYS.some((pattern) =>
      PRESERVED_DECOMMISSIONED_PATTERN_KEYS.includes(pattern as never),
    ),
    false,
  );

  assert.match(
    trackerRoute,
    /const OPEN_TRACKER_PATTERN_KEYS = \[\s*\.\.\.ACTIVE_PATTERN_KEYS,\s*\.\.\.PRESERVED_DECOMMISSIONED_PATTERN_KEYS,\s*\]/,
  );
  assert.equal(
    [
      ...trackerRoute.matchAll(
        /status === "open"\s*\?\s*inArray\(\s*trackedSignalsTable\.sentimentKey,\s*OPEN_TRACKER_PATTERN_KEYS\s*\)/g,
      ),
    ].length,
    2,
  );
  assert.match(
    trackerRoute,
    /const activeTrackedPatternCondition = \(\) =>\s*inArray\(trackedSignalsTable\.sentimentKey, ACTIVE_PATTERN_KEYS\)/,
  );
});

test("monthly archive aggregate and drilldown include preserved retired history", () => {
  assert.match(
    trackerRoute,
    /const ARCHIVE_PATTERN_KEYS_SQL = sql\.join\(\s*\[\s*\.\.\.ACTIVE_PATTERN_KEYS,\s*\.\.\.DEAD_PATTERN_KEYS,\s*\.\.\.PRESERVED_DECOMMISSIONED_PATTERN_KEYS,/,
  );
  assert.match(
    trackerRoute,
    /scope === "archive"\s*\?\s*inArray\(trackedSignalsTable\.sentimentKey, \[\s*\.\.\.ACTIVE_PATTERN_KEYS,\s*\.\.\.DEAD_PATTERN_KEYS,\s*\.\.\.PRESERVED_DECOMMISSIONED_PATTERN_KEYS,/,
  );
});

test("neutral administrative closes appear in history without joining PnL cohorts", () => {
  assert.match(
    trackerRoute,
    /const BALANCED_GRIND_DASHBOARD_CLOSE_REASON =\s*"balanced_grind_dashboard_neutral_close"/,
  );
  assert.match(
    trackerRoute,
    /const balancedGrindNeutralCloseCondition = and\(\s*eq\(trackedSignalsTable\.sentimentKey, "balanced_grind"\),\s*eq\(trackedSignalsTable\.status, "reclassified"\),\s*eq\(\s*trackedSignalsTable\.cancelReason,\s*BALANCED_GRIND_DASHBOARD_CLOSE_REASON\),/,
  );
  assert.match(trackerRoute, /"neutral_close"/);
  assert.match(
    trackerRoute,
    /status === "neutral_close" && \(metric \|\| pnlSign\)/,
  );

  const statusFilterStart = trackerRoute.indexOf(
    'if (status && status !== "all" && !metric)',
  );
  const closedStatusFilterEnd = trackerRoute.indexOf(
    '} else if (status === "neutral_close")',
    statusFilterStart,
  );
  assert.ok(statusFilterStart >= 0);
  assert.ok(closedStatusFilterEnd > statusFilterStart);
  assert.match(
    trackerRoute.slice(statusFilterStart, closedStatusFilterEnd),
    /else if \(status === "closed"\)[\s\S]*neutralCloseCondition/,
  );
  assert.match(
    trackerRoute,
    /const neutralCloseCondition = or\(\s*balancedGrindNeutralCloseCondition,\s*stealthResistanceNeutralCloseCondition/,
  );
  assert.match(
    trackerRoute,
    /const stealthResistanceNeutralCloseCondition = and\(\s*eq\(trackedSignalsTable\.sentimentKey, "stealth_breakout"\),\s*eq\(trackedSignalsTable\.status, "reclassified"\),/,
  );
  assert.match(
    trackerRoute,
    /sql<Date>`CASE WHEN \$\{neutralCloseCondition\}[\s\S]*THEN \$\{trackedSignalsTable\.detectedAt\}[\s\S]*ELSE \$\{trackedSignalsTable\.closedAt\} END`/,
  );

  const metricStatusesStart = trackerRoute.indexOf(
    "const metricStatuses: Record<string, string[]> =",
  );
  const metricStatusesEnd = trackerRoute.indexOf(
    "if (metric) {",
    metricStatusesStart,
  );
  const metricStatuses = trackerRoute.slice(
    metricStatusesStart,
    metricStatusesEnd,
  );
  assert.ok(metricStatusesStart >= 0);
  assert.ok(metricStatusesEnd > metricStatusesStart);
  assert.doesNotMatch(metricStatuses, /reclassified/);

  assert.match(
    signalHistoryPage,
    /status === "reclassified" &&[\s\S]*sentimentKey === "balanced_grind" &&[\s\S]*cancelReason === BG_NEUTRAL_CLOSE_REASON[\s\S]*sentimentKey === "stealth_breakout" &&[\s\S]*cancelReason === STEALTH_NEUTRAL_CLOSE_REASON[\s\S]*label: "Закрыто без PnL"/,
  );
  assert.match(
    signalHistoryPage,
    /\{ id: "neutral_close", label: "без PnL" \}/,
  );
  assert.match(
    signalHistoryPage,
    /s\.status === "reclassified" &&[\s\S]*s\.sentimentKey === "balanced_grind" &&[\s\S]*s\.cancelReason === BG_NEUTRAL_CLOSE_REASON[\s\S]*s\.sentimentKey === "stealth_breakout" &&[\s\S]*s\.cancelReason === STEALTH_NEUTRAL_CLOSE_REASON[\s\S]*"Перенесено в архив по дате обнаружения:[\s\S]*без исполнения выхода, цены закрытия и PnL/,
  );
});
