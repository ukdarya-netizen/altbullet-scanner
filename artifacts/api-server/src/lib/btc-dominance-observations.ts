import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import type { BitcoinDominanceSummary } from "./coinglass_btc_dominance.js";

export type DominanceObservation = {
  observedAt: string;
  value: number;
  source: "coinglass" | "coingecko";
};

const DAY_MS = 86_400_000;

// Preserve the provider's observation time, never the time of our HTTP request.
export function observationsFromSummary(
  summary: BitcoinDominanceSummary,
  now = new Date(),
): DominanceObservation[] {
  const seen = new Set<string>();
  return summary.history.flatMap((point) => {
    const time = Date.parse(point.timestamp);
    const value = point.dominance;
    if (
      !Number.isFinite(time) ||
      time > now.getTime() ||
      time < now.getTime() - 32 * DAY_MS ||
      !Number.isFinite(value) ||
      value <= 0 ||
      value > 100
    )
      return [];
    const observedAt = new Date(time).toISOString();
    const key = `${summary.source}:${observedAt}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ observedAt, value, source: summary.source }];
  });
}

export async function ensureBtcDominanceObservationsSchema(): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext('btc_dominance_observations_schema'))`,
    );
    await tx.execute(sql`
      CREATE TABLE IF NOT EXISTS btc_dominance_observations (
        source text NOT NULL CHECK (source IN ('coinglass', 'coingecko')),
        observed_at timestamptz NOT NULL,
        dominance double precision NOT NULL CHECK (dominance > 0 AND dominance <= 100),
        saved_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (source, observed_at)
      )
    `);
    await tx.execute(sql`
      CREATE INDEX IF NOT EXISTS btc_dominance_observations_time_idx
      ON btc_dominance_observations (observed_at DESC)
    `);
  });
}

export async function saveBtcDominanceObservations(
  summary: BitcoinDominanceSummary,
): Promise<void> {
  const points = observationsFromSummary(summary);
  if (!points.length) return;
  await db.execute(sql`
    INSERT INTO btc_dominance_observations (source, observed_at, dominance)
    VALUES ${sql.join(
      points.map(
        (point) =>
          sql`(${point.source}, ${point.observedAt}::timestamptz, ${point.value})`,
      ),
      sql`, `,
    )}
    ON CONFLICT (source, observed_at) DO NOTHING
  `);
}

export async function loadBtcDominanceObservations(
  now = new Date(),
): Promise<DominanceObservation[]> {
  // One extra UTC day covers the Dubai-calendar boundary of the 30-day window.
  const since = new Date(now.getTime() - 31 * DAY_MS);
  const result = await db.execute(sql`
    SELECT source, observed_at, dominance
    FROM btc_dominance_observations
    WHERE observed_at >= ${since} AND observed_at <= ${now}
    ORDER BY observed_at ASC
  `);
  return (result.rows as Record<string, unknown>[]).map((row) => ({
    source: String(row.source) as DominanceObservation["source"],
    observedAt: new Date(row.observed_at as Date | string).toISOString(),
    value: Number(row.dominance),
  }));
}
