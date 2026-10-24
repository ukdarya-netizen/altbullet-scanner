import { isClosedTradeOutcome, normalizeClosedPnlPercent } from "./raw-pnl.js";

export type RelationMetric = {
  key: string;
  value: number | boolean | string | null;
  unit: string;
  provenance: string;
  provenanceCohort:
    | "fire_time"
    | "prescan_snapshot"
    | "reconstructed"
    | "unknown";
  observedAt?: string | null;
};

export type RelationTrade = {
  pattern: string;
  version: string;
  pnlPercent: number | null;
  terminal: boolean;
  metrics: RelationMetric[];
  supportDistancePct: number | null;
  resistanceDistancePct: number | null;
};

export type RelationGroup = {
  pattern: string;
  version: string;
  indicator: string;
  unit: string;
  bucket: string;
  provenanceCohort:
    | "fire_time"
    | "prescan_snapshot"
    | "reconstructed"
    | "unknown";
  supportProximityBand: string;
  resistanceProximityBand: string;
  eligibleCount: number;
  unknownCount: number;
  unknownEntryCount: number;
  unknownOutcomeCount: number;
  lowSample: boolean;
  averageRawPnlPercent: number | null;
  outcomesAtLeast10Pct: number;
};

export const RELATION_METRIC_BUCKETS: Record<
  string,
  { unit: string; ranges: Array<{ label: string; min: number; max: number }> }
> = {
  cvd15m: { unit: "boolean", ranges: [] },
  cvd30m: { unit: "boolean", ranges: [] },
  cvd1h: { unit: "boolean", ranges: [] },
  cvd4h: { unit: "boolean", ranges: [] },
  oi30m: {
    unit: "%",
    ranges: [
      { label: "<0%", min: -Infinity, max: 0 },
      { label: "0–2%", min: 0, max: 2 },
      { label: "2–5%", min: 2, max: 5 },
      { label: "5–10%", min: 5, max: 10 },
      { label: "≥10%", min: 10, max: Infinity },
    ],
  },
  oi1h: {
    unit: "%",
    ranges: [
      { label: "<0%", min: -Infinity, max: 0 },
      { label: "0–2%", min: 0, max: 2 },
      { label: "2–5%", min: 2, max: 5 },
      { label: "5–10%", min: 5, max: 10 },
      { label: "≥10%", min: 10, max: Infinity },
    ],
  },
  oi4h: {
    unit: "%",
    ranges: [
      { label: "<0%", min: -Infinity, max: 0 },
      { label: "0–2%", min: 0, max: 2 },
      { label: "2–5%", min: 2, max: 5 },
      { label: "5–10%", min: 5, max: 10 },
      { label: "≥10%", min: 10, max: Infinity },
    ],
  },
  oi24h: {
    unit: "%",
    ranges: [
      { label: "<0%", min: -Infinity, max: 0 },
      { label: "0–2%", min: 0, max: 2 },
      { label: "2–5%", min: 2, max: 5 },
      { label: "5–10%", min: 5, max: 10 },
      { label: "≥10%", min: 10, max: Infinity },
    ],
  },
  spotVolumeMultiple: {
    unit: "×",
    ranges: [
      { label: "<1×", min: -Infinity, max: 1 },
      { label: "1–2×", min: 1, max: 2 },
      { label: "2–3×", min: 2, max: 3 },
      { label: "≥3×", min: 3, max: Infinity },
    ],
  },
  futuresVolumeMultiple: {
    unit: "×",
    ranges: [
      { label: "<1×", min: -Infinity, max: 1 },
      { label: "1–2×", min: 1, max: 2 },
      { label: "2–3×", min: 2, max: 3 },
      { label: "≥3×", min: 3, max: Infinity },
    ],
  },
  volume24hToAverage: {
    unit: "×",
    ranges: [
      { label: "<1×", min: -Infinity, max: 1 },
      { label: "1–2×", min: 1, max: 2 },
      { label: "2–3×", min: 2, max: 3 },
      { label: "≥3×", min: 3, max: Infinity },
    ],
  },
  fundingRate: {
    unit: "raw decimal",
    ranges: [
      { label: "<0", min: -Infinity, max: 0 },
      { label: "0–0.01%", min: 0, max: 0.0001 },
      { label: "0.01–0.05%", min: 0.0001, max: 0.0005 },
      { label: "≥0.05%", min: 0.0005, max: Infinity },
    ],
  },
  rsi1h: {
    unit: "RSI points",
    ranges: [
      { label: "<30", min: -Infinity, max: 30 },
      { label: "30–50", min: 30, max: 50 },
      { label: "50–70", min: 50, max: 70 },
      { label: "≥70", min: 70, max: Infinity },
    ],
  },
  rsi5: {
    unit: "RSI points",
    ranges: [
      { label: "<30", min: -Infinity, max: 30 },
      { label: "30–50", min: 30, max: 50 },
      { label: "50–70", min: 50, max: 70 },
      { label: "≥70", min: 70, max: Infinity },
    ],
  },
  williamsR21: {
    unit: "Williams %R points",
    ranges: [
      { label: "≤−80", min: -Infinity, max: -80 },
      { label: "−80 to −50", min: -80, max: -50 },
      { label: "−50 to −20", min: -50, max: -20 },
      { label: ">−20", min: -20, max: Infinity },
    ],
  },
};

export const ABNEON_RELATION_MAX_READY_SNAPSHOTS = 1_000;

export function classifyRelationProvenance(
  source: string | null | undefined,
): RelationMetric["provenanceCohort"] {
  if (!source) return "unknown";
  if (/^reconstructed(?:_|$)/i.test(source)) return "reconstructed";
  if (source === "prescan_snapshot") return "prescan_snapshot";
  if (
    source === "signal_fire" ||
    /^bingx_(15m|30m|1h|4h)_closed$/.test(source) ||
    source.startsWith("signals entry-time field:") ||
    source.startsWith("tracked decision-time snapshot field:")
  )
    return "fire_time";
  return "unknown";
}

export function relationOutcomePnl(input: {
  status: string | null | undefined;
  cancelReason?: string | null;
  exitPrice: number | string | null | undefined;
  pnlPercent: number | string | null | undefined;
  sentimentKey?: string | null;
}): number | null {
  if (!isClosedTradeOutcome(input)) return null;
  return normalizeClosedPnlPercent(
    input.status,
    input.pnlPercent,
    input.sentimentKey,
  );
}

export function bucketRelationMetric(
  key: string,
  value: number | boolean | string | null,
): string {
  if (value == null || (typeof value === "number" && !Number.isFinite(value)))
    return "unknown";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") return value.trim() || "unknown";
  if (key === "williamsR21" || key === "williamsR21Ema13") {
    if (value <= -80) return "≤−80";
    if (value < -50) return "−80 to −50";
    if (value < -20) return "−50 to −20";
    return ">−20";
  }
  const definition = RELATION_METRIC_BUCKETS[key];
  const range = definition?.ranges.find(
    ({ min, max }) => value >= min && value < max,
  );
  if (range) return range.label;
  if (value < 0) return "<0";
  if (value < 1) return "0–1";
  if (value < 5) return "1–5";
  if (value < 10) return "5–10";
  return "≥10";
}

export function bucketProximity(distancePct: number | null): string {
  if (distancePct == null || !Number.isFinite(distancePct) || distancePct < 0)
    return "unknown";
  if (distancePct <= 1) return "0–1%";
  if (distancePct <= 3) return ">1–3%";
  if (distancePct <= 5) return ">3–5%";
  return ">5%";
}

function emptyGroup(
  trade: RelationTrade,
  metric: RelationMetric,
  bucket: string,
): RelationGroup {
  return {
    pattern: trade.pattern,
    version: trade.version,
    indicator: metric.key,
    unit: metric.unit,
    bucket,
    provenanceCohort: metric.provenanceCohort,
    supportProximityBand: bucketProximity(trade.supportDistancePct),
    resistanceProximityBand: bucketProximity(trade.resistanceDistancePct),
    eligibleCount: 0,
    unknownCount: 0,
    unknownEntryCount: 0,
    unknownOutcomeCount: 0,
    lowSample: true,
    averageRawPnlPercent: null,
    outcomesAtLeast10Pct: 0,
  };
}

/** Descriptive only: groups immutable entry readings against closed outcomes. */
export function aggregateIndicatorRelations(
  trades: readonly RelationTrade[],
): RelationGroup[] {
  type Accumulator = RelationGroup & { pnlSum: number };
  const groups = new Map<string, Accumulator>();
  for (const trade of trades) {
    for (const metric of trade.metrics) {
      const bucket = bucketRelationMetric(metric.key, metric.value);
      const result = emptyGroup(trade, metric, bucket);
      const key = [
        result.pattern,
        result.version,
        metric.key,
        bucket,
        result.provenanceCohort,
        result.supportProximityBand,
        result.resistanceProximityBand,
      ].join("|");
      let group = groups.get(key);
      if (!group) {
        group = { ...result, pnlSum: 0 };
        groups.set(key, group);
      }
      if (bucket === "unknown") group.unknownEntryCount += 1;
      if (trade.pnlPercent == null) {
        group.unknownOutcomeCount += 1;
      } else {
        group.eligibleCount += 1;
        group.pnlSum += trade.pnlPercent;
        if (trade.pnlPercent >= 10) group.outcomesAtLeast10Pct += 1;
      }
      group.unknownCount = group.unknownEntryCount + group.unknownOutcomeCount;
    }
  }
  return [...groups.values()].map(({ pnlSum, ...group }) => ({
    ...group,
    lowSample: group.eligibleCount < 10,
    averageRawPnlPercent:
      group.eligibleCount > 0 ? pnlSum / group.eligibleCount : null,
  }));
}

export type TargetAuditInput = {
  version: string;
  pattern: string;
  variant: string;
  eligible: boolean;
  pnlPercent: number | null;
  targetPct: number | null;
  requestedAt: Date | string | null;
  capturedAt: Date | string | null;
  hitAt: Date | string | null;
  closedAt: Date | string | null;
};

/** Historical shadow audit; no unobserved non-hit is classified as a miss. */
export function aggregateTargetAudit(rows: readonly TargetAuditInput[]) {
  type Group = {
    version: string;
    pattern: string;
    variant: string;
    eligibleClosed: number;
    measuredClosed: number;
    unknownOutcome: number;
    confirmedHits: number;
    unknownTouch: number;
    actualStrong: number;
    confirmedStrongClipped: number;
    actualRawPnlSum: number;
    confirmedHitActualPnlSum: number;
    confirmedHitTargetPnlSum: number;
  };
  const groups = new Map<string, Group>();
  for (const row of rows) {
    if (!row.eligible || !row.closedAt) continue;
    const key = [row.version, row.pattern, row.variant].join("|");
    let group = groups.get(key);
    if (!group) {
      group = {
        version: row.version,
        pattern: row.pattern,
        variant: row.variant,
        eligibleClosed: 0,
        measuredClosed: 0,
        unknownOutcome: 0,
        confirmedHits: 0,
        unknownTouch: 0,
        actualStrong: 0,
        confirmedStrongClipped: 0,
        actualRawPnlSum: 0,
        confirmedHitActualPnlSum: 0,
        confirmedHitTargetPnlSum: 0,
      };
      groups.set(key, group);
    }
    group.eligibleClosed++;
    if (row.pnlPercent == null || !Number.isFinite(row.pnlPercent)) {
      group.unknownOutcome++;
      continue;
    }
    group.measuredClosed++;
    group.actualRawPnlSum += row.pnlPercent;
    if (row.pnlPercent >= 10) group.actualStrong++;
    const requested =
      row.requestedAt == null ? null : new Date(row.requestedAt).getTime();
    const captured =
      row.capturedAt == null ? null : new Date(row.capturedAt).getTime();
    const closed = new Date(row.closedAt).getTime();
    const hit = row.hitAt == null ? null : new Date(row.hitAt).getTime();
    const confirmed =
      row.targetPct != null &&
      Number.isFinite(row.targetPct) &&
      row.targetPct > 0 &&
      requested != null &&
      Number.isFinite(requested) &&
      captured != null &&
      Number.isFinite(captured) &&
      hit != null &&
      Number.isFinite(hit) &&
      Number.isFinite(closed) &&
      requested <= captured &&
      captured <= hit &&
      hit < closed;
    if (!confirmed) {
      group.unknownTouch++;
      continue;
    }
    group.confirmedHits++;
    group.confirmedHitActualPnlSum += row.pnlPercent;
    group.confirmedHitTargetPnlSum += row.targetPct!;
    if (row.pnlPercent >= 10 && row.targetPct! < 10)
      group.confirmedStrongClipped++;
  }
  return [...groups.values()].map((group) => ({
    ...group,
    sufficient: group.measuredClosed >= 20,
    actualAverageRawPnl: group.measuredClosed
      ? group.actualRawPnlSum / group.measuredClosed
      : null,
    confirmedHitDeltaPp: group.confirmedHits
      ? (group.confirmedHitTargetPnlSum - group.confirmedHitActualPnlSum) /
        group.confirmedHits
      : null,
  }));
}
