/**
 * archetypeClient.ts
 *
 * Лёгкий клиент к archetype-detector FastAPI сервису.
 * Fail-open: при таймауте / ошибке / недоступности сервиса возвращает null.
 * Таймаут 2.5 с — не блокирует основной поток trackSignal.
 */
import { logger } from "./logger.js";

const ARCHETYPE_URL = `http://localhost:${process.env.ARCHETYPE_PORT ?? "8000"}/classify`;

export interface ArchetypeInput {
  oi_30m?: number | null;
  oi_prev_30m?: number | null;
  oi_1h?: number | null;
  oi_prev_1h?: number | null;
  oi_4h?: number | null;
  vol_mult?: number | null;
  spot_vol_mult?: number | null;
  price_1h?: number | null;
  price_3h?: number | null;
  price_4h?: number | null;
  price_24h?: number | null;
  cvd_1h?: boolean | null;
  cvd_1h_ratio?: number | null;
  cvd_30m?: boolean | null;
  funding?: number | null;
  net_buy_pct?: number | null;
  spot_net_pct?: number | null;
}

export interface ArchetypeResult {
  archetype: string;
  confidence_score: number | null;
  risk_recommendation: string | null;
  reason: string | null;
}

export async function fetchArchetype(
  symbol: string,
  metrics: ArchetypeInput,
): Promise<ArchetypeResult | null> {
  try {
    const body: Record<string, unknown> = {
      symbol,
      snapshot_time: new Date().toISOString(),
    };
    for (const [k, v] of Object.entries(metrics)) {
      if (v != null) body[k] = v;
    }
    const res = await fetch(ARCHETYPE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(2_500),
    });
    if (!res.ok) {
      logger.debug(
        { symbol, status: res.status },
        "archetype: non-200 (fail-open)",
      );
      return null;
    }
    const json = (await res.json()) as Partial<ArchetypeResult>;
    return {
      archetype: json.archetype ?? "no_signal",
      confidence_score: json.confidence_score ?? null,
      risk_recommendation: json.risk_recommendation ?? null,
      reason: json.reason ?? null,
    };
  } catch (err) {
    if (err instanceof Error && err.name !== "TimeoutError") {
      logger.debug(
        { symbol, err: err.message },
        "archetype: classify error (fail-open)",
      );
    }
    return null;
  }
}
