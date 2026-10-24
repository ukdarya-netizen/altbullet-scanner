export type ReentryHorizon = "4h" | "8h" | "24h";

const HORIZONS: Record<ReentryHorizon, number> = {
  "4h": 4 * 3_600_000,
  "8h": 8 * 3_600_000,
  "24h": 24 * 3_600_000,
};

/** Each slot has a bounded observation window; outside it the slot is missed. */
export function classifyReentryHorizon(
  candidateAtMs: number,
  nowMs: number,
  horizon: ReentryHorizon,
): "before" | "valid" | "missed" {
  const age = nowMs - candidateAtMs;
  const start = HORIZONS[horizon];
  const end =
    horizon === "4h"
      ? HORIZONS["8h"]
      : horizon === "8h"
        ? HORIZONS["24h"]
        : 48 * 3_600_000;
  if (age < start) return "before";
  if (age < end) return "valid";
  return "missed";
}

export function reentryShadowAggregate(
  rows: Array<{
    outcome4hPct: number | null;
    outcome8hPct: number | null;
    outcome24hPct: number | null;
  }>,
) {
  const values = (key: keyof (typeof rows)[number]) =>
    rows.map((r) => r[key]).filter((v): v is number => typeof v === "number");
  const avg = (v: number[]) =>
    v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
  const v4 = values("outcome4hPct"),
    v8 = values("outcome8hPct"),
    v24 = values("outcome24hPct");
  return {
    eventCount: rows.length,
    observed4h: v4.length,
    observed8h: v8.length,
    observed24h: v24.length,
    avg4h: avg(v4),
    avg8h: avg(v8),
    avg24h: avg(v24),
  };
}
