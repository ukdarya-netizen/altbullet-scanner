import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const source = readFileSync(resolve(process.cwd(), "src/index.ts"), "utf8");
const correction = source.match(
  /async function reclassifyReviewedOpenStealthBreakouts[\s\S]*?\n}\n/,
)?.[0];

test("reviewed CHR and TAIKO crosses use exact neutral-observation identities", () => {
  assert.ok(correction);
  assert.match(correction, /\(1660, 5870, 2157, 'CHR-USDT'\)/);
  assert.match(correction, /\(1644, 5772, 2102, 'TAIKO-USDT'\)/);
  assert.match(correction, /\(1910, 10452, 3662, 'APEX-USDT'\)/);
  assert.match(correction, /\(1909, 10363, 3628, 'MEW-USDT'\)/);
  assert.match(correction, /t\.id = x\.tracked_id/);
  assert.match(correction, /t\.signal_id = x\.signal_id/);
  assert.match(correction, /a\.id = x\.arm_id/);
  assert.match(correction, /a\.fired_signal_id = x\.signal_id/);
  assert.match(correction, /status = 'reclassified'/);
  assert.match(correction, /cancel_reason = 'false_breakout_reclassified'/);
  assert.match(correction, /exit_price = NULL/);
  assert.match(correction, /pnl_percent = NULL/);
  assert.match(correction, /closed_at = NULL/);
  assert.match(correction, /UPDATE milestone_notification_deliveries/);
  assert.match(correction, /UPDATE telegram_photo_deliveries/);
  assert.match(correction, /process\.env\.NODE_ENV !== "production"/);
  assert.doesNotMatch(correction, /DELETE FROM/);
  assert.doesNotMatch(correction, /sendTelegram|sendMessage|broadcast/);
});

test("reviewed APEX and MEW remain scan candidates only until a newer confirmed Stealth signal", () => {
  const scanner = readFileSync(
    resolve(process.cwd(), "src/lib/scanner.ts"),
    "utf8",
  );
  assert.match(scanner, /\(1910, 10452, 'APEX-USDT'\)/);
  assert.match(scanner, /\(1909, 10363, 'MEW-USDT'\)/);
  assert.match(scanner, /newer\.id > t\.id/);
  assert.match(scanner, /newer\.status <> 'reclassified'/);
  assert.match(
    scanner,
    /prescanSymbols: \[\.\.\.prescanTracker\.keys\(\), \.\.\.reviewedWatchSymbols\]/,
  );
  assert.match(
    scanner,
    /buildStealthScanWorklist\(\{[\s\S]*?reviewedWatchTickers,/,
  );
});

test("the exact correction runs during production startup and excludes other open Stealth signals", () => {
  assert.match(source, /await reclassifyReviewedOpenStealthBreakouts\(\)/);
  for (const symbol of [
    "AGLD-USDT",
    "MASK-USDT",
    "SOMI-USDT",
    "ANIME-USDT",
    "ROSE-USDT",
  ]) {
    assert.doesNotMatch(correction!, new RegExp(symbol));
  }
});
