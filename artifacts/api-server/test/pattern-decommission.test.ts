import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import {
  ACTIVE_PATTERN_KEYS,
  DEAD_PATTERN_KEYS,
  isPreservedDecommissionedPattern,
  PRESERVED_DECOMMISSIONED_PATTERN_KEYS,
  resolveExplicitOiWatchPattern,
} from "../src/lib/dead-patterns.js";

test("Bullish Accumulation is disabled without destructive cleanup", () => {
  assert.equal(
    ACTIVE_PATTERN_KEYS.includes("bullish_accumulation" as never),
    false,
  );
  assert.equal(
    DEAD_PATTERN_KEYS.includes("bullish_accumulation" as never),
    false,
  );
  assert.equal(isPreservedDecommissionedPattern("bullish_accumulation"), true);
});

test("Balanced Grind is retired while preserving history and open-position lifecycle", () => {
  assert.equal(ACTIVE_PATTERN_KEYS.includes("balanced_grind" as never), false);
  assert.equal(DEAD_PATTERN_KEYS.includes("balanced_grind" as never), false);
  assert.equal(isPreservedDecommissionedPattern("balanced_grind"), true);
});

test("retired Balanced Grind has no live scanner telemetry or outcome backfill", () => {
  assert.equal(ACTIVE_PATTERN_KEYS.includes("balanced_grind" as never), false);
  const scanner = readFileSync(
    resolve(process.cwd(), "src/lib/scanner.ts"),
    "utf8",
  );
  const watcher = readFileSync(
    resolve(process.cwd(), "src/lib/watcher.ts"),
    "utf8",
  );

  assert.match(
    scanner,
    /isPreservedDecommissionedPattern\(res\.sentimentKey\)/,
  );
  assert.doesNotMatch(scanner, /key:\s*"balanced_grind"/);
  assert.doesNotMatch(scanner, /recordBalancedGrindP24hHighRejection/);
  assert.doesNotMatch(scanner, /_pdb(?:Check|Pass|Reject)\("balanced_grind"/);
  assert.doesNotMatch(scanner, /_peBalGrind|_bg(?:Fr|ObRatio|Snf1h|Wi|Cvd)/);
  assert.doesNotMatch(watcher, /balanced_grind:p24h_gt_20/);
  assert.doesNotMatch(watcher, /notifyBalancedGrindP24hReviewReadiness/);
});

test("Whale Watch is a preserved decommissioned pattern, not active or dead", () => {
  assert.equal(ACTIVE_PATTERN_KEYS.includes("whale_watch" as never), false);
  assert.equal(DEAD_PATTERN_KEYS.includes("whale_watch" as never), false);
  assert.equal(
    PRESERVED_DECOMMISSIONED_PATTERN_KEYS.includes("whale_watch"),
    true,
  );
  for (const legacyKey of [
    "whale_futures",
    "whale_futures_early",
    "whale_watch_spot",
    "whale_alert",
  ]) {
    assert.equal(DEAD_PATTERN_KEYS.includes(legacyKey as never), true);
  }
});

test("Neon Support Bounce is an independent active pattern", () => {
  assert.equal(
    ACTIVE_PATTERN_KEYS.includes("neon_support_bounce" as never),
    true,
  );
  assert.equal(
    DEAD_PATTERN_KEYS.includes("neon_support_bounce" as never),
    false,
  );
});

test("payload-less OI Watch rows are not assumed to be Bullish Accumulation", () => {
  assert.equal(resolveExplicitOiWatchPattern(null, null), null);
  assert.equal(
    resolveExplicitOiWatchPattern(undefined, "balanced_grind"),
    "balanced_grind",
  );
  assert.equal(
    resolveExplicitOiWatchPattern("stealth_breakout", "bullish_accumulation"),
    "stealth_breakout",
  );
});
