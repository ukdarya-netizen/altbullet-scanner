import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

/** One row per scanner cycle: CoinGlass governor load and phase coverage. */
export async function ensureCoinglassCycleMetricsSchema(): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS coinglass_cycle_metrics (
      id bigserial PRIMARY KEY,
      recorded_at timestamptz NOT NULL DEFAULT now(),
      cycle_started_at timestamptz,
      duration_ms integer,
      by_endpoint jsonb NOT NULL DEFAULT '{}'::jsonb,
      by_endpoint_peak_per_min jsonb NOT NULL DEFAULT '{}'::jsonb,
      total_requests integer,
      total_peak_per_min integer,
      http_429 integer,
      oi_breaker_trips integer,
      governor jsonb NOT NULL DEFAULT '{}'::jsonb,
      phases jsonb NOT NULL DEFAULT '{}'::jsonb
    )
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS coinglass_cycle_metrics_recorded_idx
      ON coinglass_cycle_metrics (recorded_at)
  `);
}

export interface CoinglassCycleMetricsInput {
  cycleStartedAt: Date;
  durationMs: number;
  governor: {
    byEndpoint?: Record<string, number>;
    byEndpointPeakPerMin?: Record<string, number>;
    totalPeakPerMin?: number;
    rateLimited?: number;
  } & Record<string, unknown>;
  oiBreakerTrips: number;
  phases: Record<string, unknown>;
}

export async function recordCoinglassCycleMetrics(
  input: CoinglassCycleMetricsInput,
): Promise<void> {
  const byEndpoint = input.governor.byEndpoint ?? {};
  const total = Object.values(byEndpoint).reduce((a, b) => a + b, 0);
  await db.execute(sql`
    INSERT INTO coinglass_cycle_metrics
      (cycle_started_at, duration_ms, by_endpoint, by_endpoint_peak_per_min,
       total_requests, total_peak_per_min, http_429, oi_breaker_trips,
       governor, phases)
    VALUES (${input.cycleStartedAt.toISOString()}, ${Math.round(input.durationMs)},
            ${JSON.stringify(byEndpoint)}::jsonb,
            ${JSON.stringify(input.governor.byEndpointPeakPerMin ?? {})}::jsonb,
            ${total}, ${input.governor.totalPeakPerMin ?? 0},
            ${input.governor.rateLimited ?? 0}, ${input.oiBreakerTrips},
            ${JSON.stringify(input.governor)}::jsonb,
            ${JSON.stringify(input.phases)}::jsonb)
  `);
}
