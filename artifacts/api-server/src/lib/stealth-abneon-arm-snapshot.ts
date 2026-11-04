/**
 * Immutable, observational ABNeon evidence for a newly-created Stealth arm.
 *
 * This module deliberately does not expose a live gate.  It compares the
 * resistance used by the normal quiet-zone detector with the event-time
 * AltBullet nearest resistance and returns evidence that can be persisted
 * alongside the arm.  It must never be used to select a level or eligibility.
 */
import {
  ALT_BULLET_INDICATOR_VERSION,
  analyzeAltBulletIndicator,
  type AltBulletIndicatorReading,
  type AltBulletVerdict,
} from "./altbullet-indicator.js";
import type { BreakoutCandle } from "./breakout-analysis.js";

const ONE_HOUR_MS = 60 * 60_000;
const FOUR_HOURS_MS = 4 * ONE_HOUR_MS;
const LEVEL_AGREEMENT_MAX_DISTANCE_PCT = 1.5;

export type StealthAbneonClassification = "agreement" | "neutral" | "conflict";
export type StealthAbneonCoverage = "complete" | "missing";

export type StealthAbneonArmSnapshot = {
  indicatorVersion: string;
  capturedAt: number;
  status: AltBulletIndicatorReading["status"];
  verdict: AltBulletVerdict | null;
  nearestResistance: number | null;
  frozenStealthLevel: number | null;
  levelDistancePct: number | null;
  classification: StealthAbneonClassification;
  coverage: StealthAbneonCoverage;
  reason: string;
  checks: AltBulletIndicatorReading["checks"];
  context: AltBulletIndicatorReading["context"];
};

function finitePositive(value: unknown): number | null {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

function candlesClosedBy(
  candles: readonly BreakoutCandle[],
  timeframeMs: number,
  capturedAt: number,
): BreakoutCandle[] {
  return candles
    .filter((candle) => candle.time + timeframeMs <= capturedAt)
    .sort((left, right) => left.time - right.time);
}

export function classifyStealthAbneonLevels(input: {
  frozenStealthLevel: number;
  nearestResistance: number;
}): {
  classification: StealthAbneonClassification;
  levelDistancePct: number;
  reason: string;
} {
  const levelDistancePct =
    (Math.abs(input.nearestResistance - input.frozenStealthLevel) /
      input.frozenStealthLevel) *
    100;
  const classification: StealthAbneonClassification =
    levelDistancePct <= LEVEL_AGREEMENT_MAX_DISTANCE_PCT
      ? "agreement"
      : input.nearestResistance < input.frozenStealthLevel
        ? "conflict"
        : "neutral";
  return {
    classification,
    levelDistancePct,
    reason:
      classification === "agreement"
        ? "same_resistance_zone"
        : classification === "conflict"
          ? "abneon_detected_lower_ceiling"
          : "abneon_detected_higher_resistance",
  };
}

/**
 * Capture only candles that had closed at the arm evaluation timestamp.
 * AltBullet is used here as an observation port; its verdict is not a gate.
 */
export function buildStealthAbneonArmSnapshot(input: {
  frozenStealthLevel: number | null;
  candles4h: readonly BreakoutCandle[];
  candles1h: readonly BreakoutCandle[];
  capturedAt: number;
}): StealthAbneonArmSnapshot {
  const reading = analyzeAltBulletIndicator({
    candles4h: candlesClosedBy(
      input.candles4h,
      FOUR_HOURS_MS,
      input.capturedAt,
    ),
    candles1h: candlesClosedBy(input.candles1h, ONE_HOUR_MS, input.capturedAt),
    requestedAt: new Date(input.capturedAt),
  });
  const resistance = finitePositive(reading.context.nearestResistance);
  const frozenLevel = finitePositive(input.frozenStealthLevel);

  if (reading.status !== "ready" || resistance === null) {
    return {
      indicatorVersion: ALT_BULLET_INDICATOR_VERSION,
      capturedAt: input.capturedAt,
      status: reading.status,
      verdict: reading.verdict,
      nearestResistance: resistance,
      frozenStealthLevel: input.frozenStealthLevel,
      levelDistancePct: null,
      classification: "neutral",
      coverage: "missing",
      reason:
        reading.status !== "ready"
          ? reading.error || "abneon_snapshot_unavailable"
          : "abneon_resistance_unavailable",
      checks: reading.checks,
      context: reading.context,
    };
  }

  if (frozenLevel === null) {
    return {
      indicatorVersion: ALT_BULLET_INDICATOR_VERSION,
      capturedAt: input.capturedAt,
      status: reading.status,
      verdict: reading.verdict,
      nearestResistance: resistance,
      frozenStealthLevel: null,
      levelDistancePct: null,
      classification: "neutral",
      coverage: "complete",
      reason: "stealth_level_unavailable",
      checks: reading.checks,
      context: reading.context,
    };
  }

  const comparison = classifyStealthAbneonLevels({
    frozenStealthLevel: frozenLevel,
    nearestResistance: resistance,
  });
  return {
    indicatorVersion: ALT_BULLET_INDICATOR_VERSION,
    capturedAt: input.capturedAt,
    status: reading.status,
    verdict: reading.verdict,
    nearestResistance: resistance,
    frozenStealthLevel: frozenLevel,
    levelDistancePct: comparison.levelDistancePct,
    classification: comparison.classification,
    coverage: "complete",
    reason: comparison.reason,
    checks: reading.checks,
    context: reading.context,
  };
}

export function buildStealthAbneonArmSnapshotSafely(
  input: Parameters<typeof buildStealthAbneonArmSnapshot>[0],
  build: typeof buildStealthAbneonArmSnapshot = buildStealthAbneonArmSnapshot,
): StealthAbneonArmSnapshot {
  try {
    return build(input);
  } catch (error) {
    return {
      indicatorVersion: ALT_BULLET_INDICATOR_VERSION,
      capturedAt: input.capturedAt,
      status: "unavailable",
      verdict: null,
      nearestResistance: null,
      frozenStealthLevel: input.frozenStealthLevel,
      levelDistancePct: null,
      classification: "neutral",
      coverage: "missing",
      reason: `snapshot_error:${error instanceof Error ? error.message : "unknown"}`,
      checks: null,
      context: {},
    };
  }
}
