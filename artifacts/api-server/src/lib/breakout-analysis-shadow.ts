import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { getKlines } from "./bingx.js";
import {
  analyzeBreakout,
  normalizeClosedBreakoutCandles,
  type BreakoutCandle,
  type BreakoutEvidence,
} from "./breakout-analysis.js";
import { dbWriteBestEffort } from "./dbWriteFast.js";
import { getCached, setCached } from "./routeCache.js";
import { getScannerCandidates } from "./scanner.js";

const BREAKOUT_TIMEFRAME = "30m";
const BREAKOUT_KLINE_LIMIT = 160;
const BREAKOUT_LIST_LIMIT = 24;
const BREAKOUT_CONCURRENCY = 3;

export type BreakoutCandidateSource = "prescan" | "oi_watch" | "cycle";

interface BreakoutCandidateInput {
  symbol: string;
  source: BreakoutCandidateSource;
  price: number | null;
  price24h: number | null;
  cycleCount: number | null;
  layers: string[];
  priority: number;
}

export interface BreakoutShadowCandidate {
  symbol: string;
  source: BreakoutCandidateSource;
  price: number | null;
  price24h: number | null;
  cycleCount: number | null;
  layers: string[];
  evidence: ReturnType<typeof compactEvidence>;
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Drizzle expands a JavaScript array embedded in a raw `sql` template into a
 * parenthesized parameter list. That is not a PostgreSQL `text[]`, and an
 * empty array becomes the invalid SQL expression `()`. Pass a correctly
 * escaped array literal and cast it at the insertion site instead.
 */
function toPostgresTextArrayLiteral(values: readonly string[]): string {
  return `{${values
    .map(
      (value) => `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`,
    )
    .join(",")}}`;
}

function toBreakoutCandidates(
  data: Awaited<ReturnType<typeof getScannerCandidates>>,
): BreakoutCandidateInput[] {
  const bySymbol = new Map<string, BreakoutCandidateInput>();
  const add = (candidate: BreakoutCandidateInput) => {
    if (!/^[A-Z0-9-]{3,50}$/.test(candidate.symbol)) return;
    const existing = bySymbol.get(candidate.symbol);
    if (!existing || candidate.priority > existing.priority) {
      bySymbol.set(candidate.symbol, candidate);
    }
  };

  for (const item of data.prescan) {
    add({
      symbol: item.symbol,
      source: "prescan",
      price: finiteOrNull(item.lastPrice),
      price24h: finiteOrNull(item.lastPrice24h),
      cycleCount: item.cycleCount,
      layers: item.layers,
      priority: 3_000 - Math.min(999, item.bestRank),
    });
  }
  for (const item of data.oiWatch) {
    add({
      symbol: item.symbol,
      source: "oi_watch",
      price: finiteOrNull(item.currentPrice ?? item.priceAtEntry),
      price24h: finiteOrNull(item.price24hChange),
      cycleCount: null,
      layers: item.sentimentKey ? [item.sentimentKey] : [],
      priority: 2_000 + Math.min(999, Math.round(item.oiChange * 10)),
    });
  }
  for (const item of data.cycleCandidates) {
    add({
      symbol: item.symbol,
      source: "cycle",
      price: finiteOrNull(item.price),
      price24h: finiteOrNull(item.price24h),
      cycleCount: null,
      layers: item.layers,
      priority: 1_000 + Math.min(999, Math.round(item.score * 10)),
    });
  }

  return Array.from(bySymbol.values())
    .sort((left, right) => right.priority - left.priority)
    .slice(0, BREAKOUT_LIST_LIMIT);
}

async function getBreakoutCandles(symbol: string): Promise<BreakoutCandle[]> {
  const cacheKey = `scanner:breakout-candles:${symbol}:${BREAKOUT_TIMEFRAME}`;
  const cached = getCached<BreakoutCandle[]>(cacheKey);
  if (cached) return cached;
  const candles = normalizeClosedBreakoutCandles(
    await getKlines(symbol, BREAKOUT_TIMEFRAME, BREAKOUT_KLINE_LIMIT),
  );
  setCached(cacheKey, candles, 60_000);
  return candles;
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T) => Promise<R>,
): Promise<R[]> {
  const iterator = items[Symbol.iterator]();
  const results: R[] = [];
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      for (let next = iterator.next(); !next.done; next = iterator.next()) {
        results.push(await mapper(next.value));
      }
    }),
  );
  return results;
}

function compactEvidence(evidence: BreakoutEvidence) {
  return {
    status: evidence.status,
    kind: evidence.kind,
    breakoutSource: evidence.breakoutSource,
    timeframe: evidence.timeframe,
    score: evidence.score,
    quietZone: evidence.quietZone,
    breakoutLevel: evidence.breakoutLevel,
    distanceFromLevelPct: evidence.distanceFromLevelPct,
    barsSinceBreakout: evidence.barsSinceBreakout,
    touches: evidence.touches,
    roomToResistancePct: evidence.roomToResistancePct,
    breakoutTolerance: evidence.breakoutTolerance,
    breakoutZone: evidence.breakoutZone,
    lifecycle: evidence.lifecycle,
    reasons: evidence.reasons,
  };
}

const unavailableEvidence = () =>
  compactEvidence({
    status: "insufficient_data",
    kind: "none",
    breakoutSource: "none",
    timeframe: BREAKOUT_TIMEFRAME,
    score: 0,
    quietZone: false,
    breakoutLevel: null,
    distanceFromLevelPct: null,
    barsSinceBreakout: null,
    touches: 0,
    roomToResistancePct: null,
    breakoutTolerance: null,
    breakoutZone: null,
    lifecycle: null,
    reasons: ["Не удалось получить закрытые свечи BingX"],
    pivots: [],
    levels: [],
    trendline: null,
    retestZone: null,
  });

export async function getBreakoutAnalysisCandidates(): Promise<
  BreakoutShadowCandidate[]
> {
  const currentCandidates = toBreakoutCandidates(await getScannerCandidates());
  const candidates = await mapWithConcurrency(
    currentCandidates,
    BREAKOUT_CONCURRENCY,
    async (candidate): Promise<BreakoutShadowCandidate> => {
      const { priority: _priority, ...snapshot } = candidate;
      try {
        return {
          ...snapshot,
          evidence: compactEvidence(
            analyzeBreakout(await getBreakoutCandles(candidate.symbol)),
          ),
        };
      } catch {
        return { ...snapshot, evidence: unavailableEvidence() };
      }
    },
  );
  return candidates.sort(
    (left, right) => right.evidence.score - left.evidence.score,
  );
}

export async function persistBreakoutAnalysisSnapshots(
  candidates: BreakoutShadowCandidate[],
): Promise<void> {
  if (candidates.length === 0) return;
  const captureWindowMs =
    Math.floor(Date.now() / (30 * 60 * 1000)) * 30 * 60 * 1000;
  const values = candidates.map(
    (candidate) => sql`(
      ${candidate.symbol},
      ${candidate.source},
      ${candidate.price},
      ${candidate.price24h},
      ${candidate.cycleCount},
      ${toPostgresTextArrayLiteral(candidate.layers)}::text[],
      ${JSON.stringify(candidate.evidence)}::jsonb,
      now(),
      to_timestamp(${captureWindowMs} / 1000.0)
    )`,
  );
  await dbWriteBestEffort(
    "breakoutAnalysis/persist-snapshots",
    () =>
      db.execute(sql`
        INSERT INTO breakout_analysis_snapshots (
          symbol, candidate_source, price, price_24h, cycle_count,
          layers, evidence, analyzed_at, capture_window
        )
        VALUES ${sql.join(values, sql`, `)}
        ON CONFLICT (symbol, candidate_source, capture_window) DO NOTHING
      `),
    { attempts: 1, perAttemptTimeoutMs: 2000 },
  );
}

export async function captureBreakoutAnalysisShadowSnapshot(): Promise<number> {
  const candidates = await getBreakoutAnalysisCandidates();
  await persistBreakoutAnalysisSnapshots(candidates);
  return candidates.length;
}
