import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { getKlinesRange, type BingXKline } from "./bingx.js";
import { replayLcWaitingOrderBlocks } from "./lc-waiting-ob.js";
import {
  evaluateObFollowup,
  hasCompleteObCoverage as hasCompleteCoverage,
  isObHypothesisTerminal,
  classifyMissedStrongWinner,
  LC_OB_FIFTEEN_MINUTES as FIFTEEN_MINUTES,
  LC_OB_HYPOTHESIS_VERSION as OB_HYPOTHESIS_VERSION,
  LC_OB_MAX_FOLLOWUP_MS,
  obPolicyDecisionWithAvailability,
  resolveFrozenOb,
  summarizeObCohorts,
  type ObCohortSummary,
  type NumericCandle,
  type ObProximity,
} from "./lc-ob-hypothesis.js";
import { logger } from "./logger.js";

const TABLE = "lc_waiting_shadow_observations";
const LEASE_MS = 5 * 60_000;
const MAX_INSERT = 100;
const MAX_CYCLE = 12;
const MAX_CONCURRENCY = 3;
const MIN_BARS = 200;
const MAX_OPEN_REPORT_ROWS = 300;
const MAX_RECENT_REPORT_ROWS = 100;
const MAX_REPORT_ROWS = 300;
type Row = {
  id: number;
  tracked_signal_id: number;
  signal_id: number | null;
  symbol: string;
  detected_at: Date | string;
  original_entry: number;
  source_evidence: Record<string, unknown>;
  chosen_target: number | null;
  chosen_source: string | null;
  touch_at: Date | string | null;
  status: string;
  claim_token: string;
};

type Candle = BingXKline;
export async function ensureLcWaitingShadowSchema(): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext('lc_waiting_shadow_schema'))`,
    );
    await tx.execute(sql`
      CREATE TABLE IF NOT EXISTS ${sql.raw(TABLE)} (
        id bigserial PRIMARY KEY,
        tracked_signal_id integer NOT NULL UNIQUE,
        signal_id integer,
        symbol text NOT NULL,
        detected_at timestamptz NOT NULL,
        original_entry double precision NOT NULL,
        source_evidence jsonb NOT NULL,
        chosen_source text,
        chosen_target double precision,
        chosen_zone_low double precision,
        chosen_distance_pct double precision,
        status text NOT NULL DEFAULT 'preparing',
        touch_at timestamptz,
        tp10_at timestamptz,
        sl10_at timestamptz,
        post24_status text NOT NULL DEFAULT 'not_started',
        tracker_final_status text,
        tracker_final_pnl double precision,
        last_price_at timestamptz,
        next_retry_at timestamptz NOT NULL DEFAULT now(),
        lease_until timestamptz,
        claim_token text,
        attempts integer NOT NULL DEFAULT 0,
        last_error text,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await tx.execute(sql`
      CREATE INDEX IF NOT EXISTS lc_waiting_shadow_due_idx
      ON ${sql.raw(TABLE)} (next_retry_at, lease_until, updated_at)
      WHERE status NOT IN ('complete', 'expired', 'no_target')
    `);
  });
}

function asMs(value: Date | string): number {
  return new Date(value).getTime();
}

function closedBars(
  rows: Candle[],
  cutoff: number,
  intervalMs: number,
): NumericCandle[] {
  return rows
    .map((row) => ({
      time: Number(row.time),
      open: Number(row.open),
      high: Number(row.high),
      low: Number(row.low),
      close: Number(row.close),
    }))
    .filter(
      (row) =>
        Number.isFinite(row.time) &&
        row.time + intervalMs <= cutoff &&
        [row.open, row.high, row.low, row.close].every(Number.isFinite),
    )
    .sort((a, b) => a.time - b.time);
}

function toObCandle(candle: NumericCandle) {
  return {
    time: candle.time,
    open: candle.open,
    high: candle.high,
    low: candle.low,
    close: candle.close,
  };
}

function mergeObEvaluation(
  hypothesis: Record<string, any>,
  result: Awaited<ReturnType<typeof evaluateObFollowup>>,
  originalEntry: number,
): Record<string, unknown> {
  const policies = Array.isArray(hypothesis.policies)
    ? (hypothesis.policies as Array<Record<string, any>>).map((policy) => ({
        ...policy,
        outcome:
          policy.decision === "wait"
            ? result.followup.outcome
            : policy.decision,
        entryPrice:
          policy.decision === "enter_now"
            ? originalEntry
            : policy.decision === "wait"
              ? (hypothesis.zone?.high ?? null)
              : null,
      }))
    : hypothesis.policies;
  return { ...hypothesis, ...result, policies };
}

function pickHeatmapTarget(
  metrics: unknown,
  entry: number,
  detectedAt: number,
): {
  status: string;
  reason: string | null;
  fetchedAt: string | null;
  candidates: Array<{ source: string; target: number }>;
} {
  const unavailable = (
    status: string,
    reason: string,
    fetchedAt: string | null = null,
  ) => ({
    status,
    reason,
    fetchedAt,
    candidates: [] as Array<{ source: string; target: number }>,
  });
  if (!metrics || typeof metrics !== "object")
    return unavailable("missing", "decision_metrics_missing");
  const shadow = (metrics as Record<string, unknown>).liqHeatmapShadow;
  if (!shadow || typeof shadow !== "object")
    return unavailable("missing", "liq_heatmap_shadow_missing");
  const map = shadow as Record<string, unknown>;
  const fetchedAtText =
    typeof map.fetchedAt === "string" ? map.fetchedAt : null;
  const fetchedAt = fetchedAtText ? Date.parse(fetchedAtText) : NaN;
  if (map.available !== true) {
    return unavailable(
      "unavailable",
      typeof map.reason === "string" ? map.reason : "source_not_available",
      fetchedAtText,
    );
  }
  if (!Number.isFinite(fetchedAt))
    return unavailable(
      "unavailable",
      "missing_or_invalid_fetched_at",
      fetchedAtText,
    );
  if (fetchedAt > detectedAt)
    return unavailable("unavailable", "fetched_after_detection", fetchedAtText);
  if (detectedAt - fetchedAt > 10 * 60_000)
    return unavailable("unavailable", "stale_at_detection", fetchedAtText);
  if (!Array.isArray(map.topBelow))
    return unavailable("unavailable", "top_below_missing", fetchedAtText);
  const candidates = map.topBelow.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const price = Number((item as Record<string, unknown>).price);
    const distance = ((entry - price) / entry) * 100;
    return Number.isFinite(price) &&
      price > 0 &&
      distance >= 1 &&
      distance <= 10
      ? [{ source: "coinglass", target: price }]
      : [];
  });
  return {
    status: "available_fresh_at_detection",
    reason: null,
    fetchedAt: fetchedAtText,
    candidates,
  };
}

async function prepare(row: Row): Promise<void> {
  const detectedAt = asMs(row.detected_at);
  const entry = Number(row.original_entry);
  const [hourlyResult, fourHourlyResult] = await Promise.allSettled([
    getKlinesRange(
      row.symbol,
      "1h",
      detectedAt - 20 * 24 * 60 * 60_000,
      detectedAt,
      { strictPayload: true },
    ),
    getKlinesRange(
      row.symbol,
      "4h",
      detectedAt - 50 * 24 * 60 * 60_000,
      detectedAt,
      { strictPayload: true },
    ),
  ]);
  const replayTimeframe = (
    result: PromiseSettledResult<Candle[]>,
    intervalMs: number,
  ) => {
    if (result.status === "rejected") {
      return {
        evidence: {
          status: "unavailable",
          candleCount: 0,
          reason: String(result.reason),
        },
        zones: [] as Array<{
          source: string;
          target: number;
          zoneLow: number;
          timeframe: "1h" | "4h";
          createdAt: number;
          detectedAt: number;
        }>,
      };
    }
    const candles = closedBars(result.value, detectedAt, intervalMs);
    if (candles.length < MIN_BARS) {
      return {
        evidence: {
          status: "insufficient_closed_bars",
          candleCount: candles.length,
          reason: `requires_${MIN_BARS}`,
        },
        zones: [] as Array<{
          source: string;
          target: number;
          zoneLow: number;
          timeframe: "1h" | "4h";
          createdAt: number;
          detectedAt: number;
        }>,
      };
    }
    try {
      const replay = replayLcWaitingOrderBlocks(candles.map(toObCandle), entry);
      return {
        evidence: {
          status: "available",
          candleCount: candles.length,
          reason: null,
        },
        zones: replay.orderBlocks
          .filter((zone) => zone.bias === "bullish")
          .map((zone) => ({
            source: intervalMs === 60 * 60_000 ? "ob_1h" : "ob_4h",
            target: zone.high,
            zoneLow: zone.low,
            timeframe:
              intervalMs === 60 * 60_000 ? ("1h" as const) : ("4h" as const),
            createdAt: zone.createdAt,
            detectedAt: zone.detectedAt,
          })),
      };
    } catch (error) {
      return {
        evidence: {
          status: "replay_error",
          candleCount: candles.length,
          reason: error instanceof Error ? error.message : String(error),
        },
        zones: [] as Array<{
          source: string;
          target: number;
          zoneLow: number;
          timeframe: "1h" | "4h";
          createdAt: number;
          detectedAt: number;
        }>,
      };
    }
  };
  const oneHour = replayTimeframe(hourlyResult, 60 * 60_000);
  const fourHour = replayTimeframe(fourHourlyResult, 4 * 60 * 60_000);
  const allObZones = [...oneHour.zones, ...fourHour.zones];
  const obZones = allObZones.filter((candidate) => {
    const distance = ((entry - candidate.target) / entry) * 100;
    return candidate.target < entry && distance >= 1 && distance <= 10;
  });
  const nearestDemand = allObZones
    .filter((candidate) => candidate.zoneLow <= entry)
    .map((candidate) => {
      const insideZone = candidate.target >= entry;
      const distancePct = ((entry - candidate.target) / entry) * 100;
      return {
        ...candidate,
        insideZone,
        distancePct,
        sortDistancePct: insideZone ? 0 : distancePct,
      };
    })
    .sort((left, right) => left.sortDistancePct - right.sortDistancePct)[0];
  const bothObSourcesAvailable =
    oneHour.evidence.status === "available" &&
    fourHour.evidence.status === "available";
  const frozenOb = {
    ...resolveFrozenOb(
      entry,
      nearestDemand
        ? {
            high: nearestDemand.target,
            low: nearestDemand.zoneLow,
            timeframe: nearestDemand.timeframe,
            createdAt: nearestDemand.createdAt,
            detectedAt: nearestDemand.detectedAt,
          }
        : undefined,
      bothObSourcesAvailable,
    ),
    sourceAvailability: {
      ob1h: oneHour.evidence.status,
      ob4h: fourHour.evidence.status,
    },
  };
  const policies = ([1, 2] as const).map((thresholdPct) => ({
    thresholdPct,
    decision: obPolicyDecisionWithAvailability(
      frozenOb.distancePct,
      thresholdPct,
      frozenOb.zone !== null,
      bothObSourcesAvailable,
      frozenOb.insideZone,
    ),
  }));
  const obHypothesis = {
    version: OB_HYPOTHESIS_VERSION,
    preparedAt: new Date().toISOString(),
    ...frozenOb,
    policies,
    followup: {
      status: "pending",
      touchAt: null,
      invalidatedAt: null,
      outcome: "pending",
      firstPlus8Status: "pending",
      firstPlus10Status: "pending",
      firstMinus10Status: "pending",
    },
    originalEntryComparison: {
      status: "pending",
      firstPlus8At: null,
      firstPlus8Status: "pending",
      firstPlus10At: null,
      firstPlus10Status: "pending",
      firstMinus10At: null,
      firstMinus10Status: "pending",
      peakPct24h: null,
    },
  };
  const heatmap = pickHeatmapTarget(
    row.source_evidence.decision_metrics,
    entry,
    detectedAt,
  );
  const candidates = [
    ...obZones,
    ...heatmap.candidates.map((candidate) => ({
      ...candidate,
      zoneLow: null as number | null,
    })),
  ].sort((a, b) => b.target - a.target);
  const selected = candidates[0];
  const sourceAdequate =
    oneHour.evidence.status === "available" ||
    fourHour.evidence.status === "available" ||
    heatmap.status === "available_fresh_at_detection";
  const allEvidence = {
    ...row.source_evidence,
    sourceAvailability: {
      coinglass: {
        status: heatmap.status,
        reason: heatmap.reason,
        fetchedAt: heatmap.fetchedAt,
        candidateCount: heatmap.candidates.length,
      },
      ob1h: oneHour.evidence,
      ob4h: fourHour.evidence,
    },
    ob1hZones: oneHour.zones,
    ob4hZones: fourHour.zones,
    obHypothesis,
    coinglassTopBelowCandidates: heatmap.candidates,
    targetCandidates: candidates,
  };
  const preparedStatus = selected
    ? "waiting"
    : sourceAdequate
      ? "no_target"
      : "unavailable";

  await db.execute(sql`
    UPDATE ${sql.raw(TABLE)}
    SET source_evidence = ${JSON.stringify(allEvidence)}::jsonb,
        chosen_source = ${selected?.source ?? null},
        chosen_target = ${selected?.target ?? null},
        chosen_zone_low = ${selected?.zoneLow ?? null},
        chosen_distance_pct = ${selected ? ((entry - selected.target) / entry) * 100 : null},
        status = ${preparedStatus},
        next_retry_at = CASE WHEN ${preparedStatus} = 'waiting'
                             THEN now() ELSE now() + interval '15 minutes' END,
        last_error = NULL, updated_at = now()
    WHERE id = ${row.id} AND claim_token = ${row.claim_token}
  `);
}

async function advanceNoTarget(row: Row): Promise<void> {
  const evidence = row.source_evidence as Record<string, unknown>;
  const hypothesis = evidence.obHypothesis as Record<string, any> | undefined;
  if (hypothesis?.version !== OB_HYPOTHESIS_VERSION) {
    await db.execute(sql`
      UPDATE ${sql.raw(TABLE)}
      SET next_retry_at = 'infinity'::timestamptz,
          updated_at = now()
      WHERE id = ${row.id} AND claim_token = ${row.claim_token}
    `);
    return;
  }
  const detectedAt = asMs(row.detected_at);
  const now = Date.now();
  const candlesRaw = await getKlinesRange(
    row.symbol,
    "15m",
    detectedAt,
    Math.min(now, detectedAt + LC_OB_MAX_FOLLOWUP_MS),
    { strictPayload: true },
  );
  const candles = closedBars(candlesRaw, now, FIFTEEN_MINUTES);
  const obResult = evaluateObFollowup(
    candles,
    detectedAt,
    Number(row.original_entry),
    hypothesis as Parameters<typeof evaluateObFollowup>[3],
    now,
  );
  const updatedHypothesis = mergeObEvaluation(
    hypothesis,
    obResult,
    Number(row.original_entry),
  );
  const updateEvidence = {
    ...evidence,
    obHypothesis: updatedHypothesis,
  };
  const terminal = isObHypothesisTerminal(updatedHypothesis, detectedAt, now);
  await db.execute(sql`
    UPDATE ${sql.raw(TABLE)}
    SET source_evidence = ${JSON.stringify(updateEvidence)}::jsonb,
        next_retry_at = CASE WHEN ${terminal} THEN 'infinity'::timestamptz
                             ELSE now() + interval '15 minutes' END,
        updated_at = now()
    WHERE id = ${row.id} AND claim_token = ${row.claim_token}
  `);
}

async function advanceTerminalMixed(row: Row): Promise<void> {
  const detectedAt = asMs(row.detected_at);
  const now = Date.now();
  const candlesRaw = await getKlinesRange(
    row.symbol,
    "15m",
    detectedAt,
    Math.min(now, detectedAt + LC_OB_MAX_FOLLOWUP_MS),
    { strictPayload: true },
  );
  const candles = closedBars(candlesRaw, now, FIFTEEN_MINUTES);
  const evidence = row.source_evidence as Record<string, unknown>;
  const hypothesis = evidence.obHypothesis as
    | Record<string, unknown>
    | undefined;
  const result = evaluateObFollowup(
    candles,
    detectedAt,
    Number(row.original_entry),
    hypothesis as Parameters<typeof evaluateObFollowup>[3],
    now,
  );
  const updatedHypothesis = hypothesis
    ? mergeObEvaluation(
        hypothesis as Record<string, any>,
        result,
        Number(row.original_entry),
      )
    : { ...result };
  const updateEvidence = { ...evidence, obHypothesis: updatedHypothesis };
  const terminal = isObHypothesisTerminal(updatedHypothesis, detectedAt, now);
  await db.execute(sql`
    UPDATE ${sql.raw(TABLE)}
    SET source_evidence = ${JSON.stringify(updateEvidence)}::jsonb,
        next_retry_at = CASE WHEN ${terminal} THEN 'infinity'::timestamptz
                             ELSE now() + interval '15 minutes' END,
        updated_at = now()
    WHERE id = ${row.id} AND claim_token = ${row.claim_token}
  `);
}

async function advance(row: Row): Promise<void> {
  const detectedAt = asMs(row.detected_at);
  const now = Date.now();
  const observationEnd = Math.min(now, detectedAt + 48 * 60 * 60_000);
  const candlesRaw = await getKlinesRange(
    row.symbol,
    "15m",
    detectedAt,
    observationEnd,
    { strictPayload: true },
  );
  const candles = closedBars(candlesRaw, now, FIFTEEN_MINUTES);
  const entry = Number(row.original_entry);
  const target = Number(row.chosen_target);
  let touchAt = row.touch_at ? asMs(row.touch_at) : null;
  let tpAt: number | null = null;
  let slAt: number | null = null;
  let passageCoverageComplete = false;
  const evidence = row.source_evidence as Record<string, unknown>;
  let coverageFailure = false;
  if (touchAt === null) {
    const firstPostDetectionCandle =
      Math.ceil(detectedAt / FIFTEEN_MINUTES) * FIFTEEN_MINUTES;
    for (const candle of candles) {
      if (
        candle.time < firstPostDetectionCandle ||
        candle.time + FIFTEEN_MINUTES > detectedAt + 24 * 60 * 60_000
      )
        continue;
      if (candle.low <= target) {
        const possibleTouchAt = candle.time + FIFTEEN_MINUTES;
        if (hasCompleteCoverage(candles, detectedAt, possibleTouchAt)) {
          touchAt = possibleTouchAt;
        } else {
          coverageFailure = true;
        }
        break;
      }
    }
  } else if (!hasCompleteCoverage(candles, detectedAt, touchAt)) {
    coverageFailure = true;
  }
  const followupDeadline =
    touchAt === null
      ? detectedAt + 24 * 60 * 60_000
      : touchAt + 24 * 60 * 60_000;
  if (touchAt !== null) {
    const stop = target * 0.9;
    const takeProfit = target * 1.1;
    for (const candle of candles) {
      if (candle.time < touchAt || candle.time >= followupDeadline) continue;
      const hitsStop = candle.low <= stop;
      const hitsTp = candle.high >= takeProfit;
      if (hitsStop && hitsTp) {
        passageCoverageComplete = hasCompleteCoverage(
          candles,
          detectedAt,
          candle.time + FIFTEEN_MINUTES,
        );
        if (passageCoverageComplete) {
          slAt = candle.time + FIFTEEN_MINUTES;
        } else {
          coverageFailure = true;
        }
        break;
      }
      if (hitsStop) {
        passageCoverageComplete = hasCompleteCoverage(
          candles,
          detectedAt,
          candle.time + FIFTEEN_MINUTES,
        );
        if (passageCoverageComplete) {
          slAt = candle.time + FIFTEEN_MINUTES;
        } else {
          coverageFailure = true;
        }
        break;
      }
      if (hitsTp) {
        passageCoverageComplete = hasCompleteCoverage(
          candles,
          detectedAt,
          candle.time + FIFTEEN_MINUTES,
        );
        if (passageCoverageComplete) {
          tpAt = candle.time + FIFTEEN_MINUTES;
        } else {
          coverageFailure = true;
        }
        break;
      }
    }
  }

  const coverageEnd = Math.min(observationEnd, followupDeadline);
  const complete =
    !coverageFailure && hasCompleteCoverage(candles, detectedAt, coverageEnd);
  const finalPassageComplete = Boolean(tpAt || slAt) && passageCoverageComplete;
  const touched = Boolean(touchAt);
  const waitingExpired = now >= followupDeadline;
  const final = tpAt || slAt;
  let status = row.status;
  let post24 = "pending";
  if (final && finalPassageComplete) {
    status = "complete";
    post24 = tpAt ? "tp10" : "sl10";
  } else if (!touched && waitingExpired && complete) {
    status = "expired";
    post24 = "no_touch";
  } else if (touched && waitingExpired && complete) {
    status = "complete";
    post24 = "no_10pct_passage";
  } else if (!complete) {
    status = "incomplete";
  } else if (touched) {
    status = "touched";
  } else {
    status = "waiting";
  }

  const updateEvidence: Record<string, unknown> = {
    ...evidence,
    originalEntryPrice: entry,
    hypotheticalEntryPrice: target,
    hypotheticalTp10Price: target * 1.1,
    hypotheticalSl10Price: target * 0.9,
    tp10At: finalPassageComplete ? tpAt : null,
    sl10At: finalPassageComplete ? slAt : null,
    followupDeadline,
    lastCoverageEnd: coverageEnd,
    coverageComplete: complete,
  };
  const obResult = evaluateObFollowup(
    candles,
    detectedAt,
    entry,
    evidence.obHypothesis as Parameters<typeof evaluateObFollowup>[3],
    now,
  );
  const priorObHypothesis = evidence.obHypothesis as
    | Record<string, any>
    | undefined;
  if (priorObHypothesis?.version === OB_HYPOTHESIS_VERSION) {
    const updatedHypothesis = mergeObEvaluation(
      priorObHypothesis,
      obResult,
      entry,
    );
    updateEvidence.obHypothesis = updatedHypothesis;
    const obTerminal = isObHypothesisTerminal(
      updatedHypothesis,
      detectedAt,
      now,
    );
    const mixedTerminal = status === "complete" || status === "expired";
    await db.execute(sql`
      UPDATE ${sql.raw(TABLE)}
      SET status = ${status}, touch_at = ${touchAt ? new Date(touchAt) : null},
          tp10_at = ${finalPassageComplete && tpAt ? new Date(tpAt) : null},
          sl10_at = ${finalPassageComplete && slAt ? new Date(slAt) : null},
          post24_status = ${post24}, source_evidence = ${JSON.stringify(updateEvidence)}::jsonb,
          last_price_at = ${candles.length ? new Date(candles[candles.length - 1]!.time + FIFTEEN_MINUTES) : null},
          next_retry_at = CASE WHEN ${mixedTerminal} AND ${obTerminal}
                               THEN 'infinity'::timestamptz
                               ELSE now() + interval '15 minutes' END,
          last_error = ${complete ? null : "15m_history_gap_or_incomplete"}, updated_at = now()
      WHERE id = ${row.id} AND claim_token = ${row.claim_token}
    `);
    return;
  }
  await db.execute(sql`
    UPDATE ${sql.raw(TABLE)}
    SET status = ${status}, touch_at = ${touchAt ? new Date(touchAt) : null},
        tp10_at = ${finalPassageComplete && tpAt ? new Date(tpAt) : null},
        sl10_at = ${finalPassageComplete && slAt ? new Date(slAt) : null},
        post24_status = ${post24}, source_evidence = ${JSON.stringify(updateEvidence)}::jsonb,
        last_price_at = ${candles.length ? new Date(candles[candles.length - 1]!.time + FIFTEEN_MINUTES) : null},
        next_retry_at = CASE WHEN ${status} IN ('complete', 'expired')
                             THEN 'infinity'::timestamptz
                             ELSE now() + interval '15 minutes' END,
        last_error = ${complete ? null : "15m_history_gap_or_incomplete"}, updated_at = now()
    WHERE id = ${row.id} AND claim_token = ${row.claim_token}
  `);
}

export async function runLcWaitingShadowCycle(): Promise<void> {
  await ensureLcWaitingShadowSchema();
  const inserted = await db.execute(sql`
    INSERT INTO ${sql.raw(TABLE)}
      (tracked_signal_id, signal_id, symbol, detected_at, original_entry, source_evidence,
       tracker_final_status, tracker_final_pnl)
    SELECT t.id, t.signal_id, t.symbol, t.detected_at,
           COALESCE(t.original_entry_price, t.entry_price)::double precision,
           jsonb_build_object('decision_metrics', t.decision_metrics,
             'entry_source', t.entry_source, 'entry_metrics_provenance', t.entry_metrics_provenance,
             'sentiment_key', t.sentiment_key, 'signal_type', t.signal_type),
           CASE WHEN t.status::text IN ('active', 'in_run') THEN NULL ELSE t.status::text END,
           CASE WHEN t.status::text IN ('active', 'in_run') THEN NULL ELSE t.pnl_percent END
    FROM tracked_signals t
    WHERE t.sentiment_key = 'liquidation_cascade'
      AND t.signal_id IS NOT NULL
      AND t.detected_at >= now() - interval '48 hours'
      AND NOT EXISTS (
        SELECT 1 FROM ${sql.raw(TABLE)} existing
        WHERE existing.tracked_signal_id = t.id
      )
    ORDER BY t.detected_at DESC
    LIMIT ${MAX_INSERT}
    ON CONFLICT (tracked_signal_id) DO NOTHING
    RETURNING id
  `);
  await db.execute(sql`
    UPDATE ${sql.raw(TABLE)} o
    SET tracker_final_status = t.status::text,
        tracker_final_pnl = t.pnl_percent,
        updated_at = now()
    FROM tracked_signals t
    WHERE o.tracked_signal_id = t.id
      AND t.status::text NOT IN ('active', 'in_run')
      AND (o.tracker_final_status IS DISTINCT FROM t.status::text
        OR o.tracker_final_pnl IS DISTINCT FROM t.pnl_percent)
  `);
  await db.execute(sql`
    UPDATE ${sql.raw(TABLE)}
    SET next_retry_at = now(), updated_at = now()
    WHERE status IN ('complete', 'expired')
      AND next_retry_at = 'infinity'::timestamptz
      AND source_evidence->'obHypothesis'->>'version' = ${String(OB_HYPOTHESIS_VERSION)}
      AND NOT (
        (
          source_evidence->'obHypothesis'->'originalEntryComparison'->>'status' = 'completed'
          OR (
            source_evidence->'obHypothesis'->'originalEntryComparison'->>'status' = 'unknown'
            AND detected_at + (${LC_OB_MAX_FOLLOWUP_MS} * interval '1 millisecond') <= now()
          )
        )
        AND (
          source_evidence->'obHypothesis'->>'status' IN ('no_zone', 'unavailable')
          OR source_evidence->'obHypothesis'->'followup'->>'status' = 'completed'
          OR (
            source_evidence->'obHypothesis'->'followup'->>'status' = 'unknown'
            AND detected_at + (${LC_OB_MAX_FOLLOWUP_MS} * interval '1 millisecond') <= now()
          )
        )
      )
  `);
  const claimToken = randomUUID();
  const claims = await db.execute<Row>(sql`
    WITH due AS (
      SELECT id FROM ${sql.raw(TABLE)}
      WHERE status IN ('preparing', 'unavailable', 'waiting', 'touched', 'incomplete', 'no_target', 'complete', 'expired')
        AND next_retry_at <= now()
        AND (lease_until IS NULL OR lease_until < now())
      ORDER BY next_retry_at, detected_at
      FOR UPDATE SKIP LOCKED
      LIMIT ${MAX_CYCLE}
    )
    UPDATE ${sql.raw(TABLE)} o
    SET lease_until = now() + (${LEASE_MS} * interval '1 millisecond'),
        claim_token = ${claimToken}, attempts = attempts + 1, updated_at = now()
    FROM due WHERE o.id = due.id
    RETURNING o.*
  `);
  const rows = claims.rows ?? [];
  logger.info(
    { inserted: inserted.rows.length, claimed: rows.length },
    "LC waiting shadow cycle started",
  );

  for (let offset = 0; offset < rows.length; offset += MAX_CONCURRENCY) {
    await Promise.all(
      rows.slice(offset, offset + MAX_CONCURRENCY).map(async (row) => {
        try {
          if (row.status === "preparing" || row.status === "unavailable")
            await prepare(row);
          else if (row.status === "no_target") await advanceNoTarget(row);
          else if (row.status === "complete" || row.status === "expired")
            await advanceTerminalMixed(row);
          else await advance(row);
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          logger.warn(
            { id: row.id, symbol: row.symbol, error: message },
            "LC waiting shadow observation retry",
          );
          await db.execute(sql`
          UPDATE ${sql.raw(TABLE)}
          SET status = CASE
                WHEN status IN ('preparing', 'unavailable') THEN 'unavailable'
                WHEN status IN ('complete', 'expired', 'no_target') THEN status
                ELSE 'incomplete'
              END,
              next_retry_at = now() + interval '15 minutes',
              last_error = ${message.slice(0, 1000)}, updated_at = now()
          WHERE id = ${row.id} AND claim_token = ${row.claim_token}
        `);
        } finally {
          await db.execute(sql`
          UPDATE ${sql.raw(TABLE)}
          SET lease_until = NULL, claim_token = NULL, updated_at = now()
          WHERE id = ${row.id} AND claim_token = ${row.claim_token}
        `);
        }
      }),
    );
  }
}

export async function getLcWaitingShadowReport(): Promise<{
  shadowOnly: true;
  settings: { ttlHours: 24; postTouchHours: 24; nearMinPct: 1; nearMaxPct: 10 };
  summary: {
    total: number;
    waiting: number;
    touched: number;
    expired: number;
    noTarget: number;
    unavailable: number;
    complete: number;
    incomplete: number;
  };
  obAnalysis: {
    version: number;
    rows: number;
    legacyUnknown: number;
    proximityCounts: Record<ObProximity, number>;
    finalizedRealized: {
      total: number;
      above8Pct: number;
      above10Pct: number;
      stopsAtOrBelowMinus10Pct: number;
      exactStopLossCount: number;
    };
    medianTimeToPlus8Minutes: number | null;
    medianTimeToPlus10Minutes: number | null;
    cohorts: Record<ObProximity, ObCohortSummary>;
    policies: Record<
      "1%" | "2%",
      {
        enterNow: number;
        wait: number;
        noTarget: number;
        unavailable: number;
        touched: number;
        noTouch: number;
        completed: number;
        pending: number;
        unknown: number;
        missedOriginalStrongWinners: number;
        missedOriginalStrongWinnersPending: number;
      }
    >;
  };
  rows: Array<Record<string, unknown>>;
}> {
  await ensureLcWaitingShadowSchema();
  const [aggregate, latest, allHypotheses] = await Promise.all([
    db.execute(sql`
    SELECT count(*)::integer AS total,
           count(*) FILTER (WHERE status = 'waiting')::integer AS waiting,
           count(*) FILTER (WHERE status = 'touched')::integer AS touched,
           count(*) FILTER (WHERE status = 'expired')::integer AS expired,
           count(*) FILTER (WHERE status = 'no_target')::integer AS no_target,
           count(*) FILTER (WHERE status = 'unavailable')::integer AS unavailable,
           count(*) FILTER (WHERE status = 'complete')::integer AS complete,
           count(*) FILTER (WHERE status = 'incomplete')::integer AS incomplete
    FROM ${sql.raw(TABLE)}
  `),
    db.execute(sql`
      WITH open_rows AS (
        SELECT t.id AS tracked_signal_id, t.signal_id, t.symbol, t.detected_at,
               COALESCE(t.original_entry_price, t.entry_price)::double precision AS original_entry,
               o.chosen_target, o.chosen_source, o.chosen_distance_pct,
               COALESCE(o.status, 'unobserved') AS status, o.touch_at, o.tp10_at,
               o.sl10_at, o.post24_status, o.tracker_final_status,
               o.tracker_final_pnl, o.source_evidence,
               t.status::text AS current_tracker_status, true AS is_open
        FROM tracked_signals t
        LEFT JOIN ${sql.raw(TABLE)} o ON o.tracked_signal_id = t.id
        WHERE t.sentiment_key = 'liquidation_cascade'
          AND t.status::text IN ('active', 'in_run')
        ORDER BY t.detected_at DESC, t.id DESC
        LIMIT ${MAX_OPEN_REPORT_ROWS}
      ),
      recent_rows AS (
        SELECT o.tracked_signal_id, o.signal_id, o.symbol, o.detected_at,
               o.original_entry, o.chosen_target, o.chosen_source,
               o.chosen_distance_pct, o.status, o.touch_at, o.tp10_at,
               o.sl10_at, o.post24_status, o.tracker_final_status,
               o.tracker_final_pnl, o.source_evidence,
               t.status::text AS current_tracker_status, false AS is_open
        FROM ${sql.raw(TABLE)} o
        LEFT JOIN tracked_signals t ON t.id = o.tracked_signal_id
        ORDER BY o.detected_at DESC, o.tracked_signal_id DESC
        LIMIT ${MAX_RECENT_REPORT_ROWS}
      ),
      selected AS (
        SELECT * FROM open_rows
        UNION ALL
        SELECT r.* FROM recent_rows r
        WHERE NOT EXISTS (
          SELECT 1 FROM open_rows o
          WHERE o.tracked_signal_id = r.tracked_signal_id
        )
      )
      SELECT tracked_signal_id, signal_id, symbol, detected_at, original_entry,
             chosen_target, chosen_source, chosen_distance_pct, status, touch_at,
             tp10_at, sl10_at, post24_status, tracker_final_status,
             tracker_final_pnl, source_evidence, current_tracker_status
      FROM selected
      ORDER BY is_open DESC, detected_at DESC, tracked_signal_id DESC
      LIMIT ${MAX_REPORT_ROWS}
    `),
    db.execute(sql`
      SELECT detected_at, original_entry, tracker_final_status,
             tracker_final_pnl, source_evidence
      FROM ${sql.raw(TABLE)}
    `),
  ]);
  const counts = aggregate.rows[0] as Record<string, unknown> | undefined;
  const numeric = (key: string) => Number(counts?.[key] ?? 0);
  const proximityCounts: Record<ObProximity, number> = {
    inside_or_within_1pct: 0,
    between_1_2pct: 0,
    beyond_2pct: 0,
    no_zone: 0,
    unavailable: 0,
  };
  const policyCounts = {
    "1%": {
      enterNow: 0,
      wait: 0,
      noTarget: 0,
      unavailable: 0,
      touched: 0,
      noTouch: 0,
      completed: 0,
      pending: 0,
      unknown: 0,
      missedOriginalStrongWinners: 0,
      missedOriginalStrongWinnersPending: 0,
    },
    "2%": {
      enterNow: 0,
      wait: 0,
      noTarget: 0,
      unavailable: 0,
      touched: 0,
      noTouch: 0,
      completed: 0,
      pending: 0,
      unknown: 0,
      missedOriginalStrongWinners: 0,
      missedOriginalStrongWinnersPending: 0,
    },
  };
  const plus8Minutes: number[] = [];
  const plus10Minutes: number[] = [];
  let legacyUnknown = 0;
  let realizedFinalized = 0;
  let realizedAbove8 = 0;
  let realizedAbove10 = 0;
  let realizedStops = 0;
  let exactStopLossCount = 0;
  const cohorts = summarizeObCohorts(
    allHypotheses.rows.map((raw) => {
      const item = raw as Record<string, unknown>;
      const evidence = item.source_evidence as Record<string, unknown> | null;
      const hypothesis = evidence?.obHypothesis as
        | Record<string, unknown>
        | undefined;
      return {
        proximity:
          hypothesis?.version === OB_HYPOTHESIS_VERSION
            ? hypothesis.proximity
            : "unavailable",
        detectedAt: asMs(item.detected_at as Date | string),
        trackerFinalStatus:
          item.tracker_final_status == null
            ? null
            : String(item.tracker_final_status),
        trackerFinalPnl:
          item.tracker_final_pnl == null
            ? null
            : (item.tracker_final_pnl as number | string),
        originalEntryComparison:
          hypothesis?.version === OB_HYPOTHESIS_VERSION
            ? (hypothesis.originalEntryComparison as Record<string, unknown>)
            : { status: "unknown" },
      };
    }),
  );
  for (const raw of allHypotheses.rows) {
    const item = raw as Record<string, any>;
    const evidence = item.source_evidence as Record<string, any> | null;
    const hypothesis = evidence?.obHypothesis as
      | Record<string, any>
      | undefined;
    if (hypothesis?.version !== OB_HYPOTHESIS_VERSION) {
      legacyUnknown += 1;
    } else {
      const proximity = hypothesis.proximity as ObProximity;
      if (proximity in proximityCounts) proximityCounts[proximity] += 1;
      const comparison = hypothesis.originalEntryComparison ?? {};
      const detected = asMs(item.detected_at);
      if (comparison.status === "completed") {
        for (const [timeKey, statusKey, values] of [
          ["firstPlus8At", "firstPlus8Status", plus8Minutes],
          ["firstPlus10At", "firstPlus10Status", plus10Minutes],
        ] as const) {
          const value = comparison[timeKey];
          const time = value == null ? NaN : Number(value);
          if (
            comparison[statusKey] === "hit" &&
            Number.isFinite(time) &&
            time >= detected
          )
            values.push((time - detected) / 60_000);
        }
      }
      for (const [threshold, policy] of [
        ["1%", policyCounts["1%"]],
        ["2%", policyCounts["2%"]],
      ] as const) {
        const decision = (
          hypothesis.policies as Array<Record<string, any>> | undefined
        )?.find((entry) => `${entry.thresholdPct}%` === threshold);
        if (!decision) {
          policy.unknown += 1;
          continue;
        }
        if (decision.decision === "enter_now") policy.enterNow += 1;
        else if (decision.decision === "wait") policy.wait += 1;
        else if (decision.decision === "no_target") policy.noTarget += 1;
        else {
          policy.unavailable += 1;
          policy.unknown += 1;
        }
        const outcome = decision.outcome ?? hypothesis.followup?.outcome;
        if (decision.decision === "wait") {
          if (outcome === "touched" || hypothesis.followup?.touchAt != null)
            policy.touched += 1;
          if (outcome === "no_touch") policy.noTouch += 1;
          else if (outcome === "completed") policy.completed += 1;
          else if (outcome === "pending") policy.pending += 1;
          else if (outcome === "unknown") policy.unknown += 1;
        }
        const missedWinner = classifyMissedStrongWinner(
          decision.decision,
          outcome,
          hypothesis.followup?.status,
          item.tracker_final_status == null
            ? null
            : String(item.tracker_final_status),
          item.tracker_final_pnl == null
            ? null
            : (item.tracker_final_pnl as number | string),
        );
        if (missedWinner === "missed") policy.missedOriginalStrongWinners += 1;
        else if (missedWinner === "pending")
          policy.missedOriginalStrongWinnersPending += 1;
      }
    }
    const realizedPnl =
      item.tracker_final_pnl == null ? NaN : Number(item.tracker_final_pnl);
    const finalized =
      item.tracker_final_status != null &&
      !["active", "in_run"].includes(String(item.tracker_final_status));
    if (item.tracker_final_status === "stop_loss") exactStopLossCount += 1;
    if (finalized && Number.isFinite(realizedPnl)) {
      realizedFinalized += 1;
      if (realizedPnl > 8) realizedAbove8 += 1;
      if (realizedPnl > 10) realizedAbove10 += 1;
      if (realizedPnl <= -10) realizedStops += 1;
    }
  }
  const median = (values: number[]) => {
    if (!values.length) return null;
    const ordered = [...values].sort((a, b) => a - b);
    const middle = Math.floor(ordered.length / 2);
    return ordered.length % 2
      ? ordered[middle]
      : (ordered[middle - 1]! + ordered[middle]!) / 2;
  };
  return {
    shadowOnly: true,
    settings: {
      ttlHours: 24,
      postTouchHours: 24,
      nearMinPct: 1,
      nearMaxPct: 10,
    },
    summary: {
      total: numeric("total"),
      waiting: numeric("waiting"),
      touched: numeric("touched"),
      expired: numeric("expired"),
      noTarget: numeric("no_target"),
      unavailable: numeric("unavailable"),
      complete: numeric("complete"),
      incomplete: numeric("incomplete"),
    },
    obAnalysis: {
      version: OB_HYPOTHESIS_VERSION,
      rows: allHypotheses.rows.length,
      legacyUnknown,
      proximityCounts,
      finalizedRealized: {
        total: realizedFinalized,
        above8Pct: realizedAbove8,
        above10Pct: realizedAbove10,
        stopsAtOrBelowMinus10Pct: realizedStops,
        exactStopLossCount,
      },
      medianTimeToPlus8Minutes: median(plus8Minutes),
      medianTimeToPlus10Minutes: median(plus10Minutes),
      cohorts,
      policies: policyCounts,
    },
    rows: latest.rows.map((row) => {
      const item = row as Record<string, unknown>;
      const sourceEvidence = item.source_evidence as Record<
        string,
        unknown
      > | null;
      const iso = (value: unknown) =>
        value instanceof Date
          ? value.toISOString()
          : value == null
            ? null
            : new Date(String(value)).toISOString();
      return {
        trackedSignalId: item.tracked_signal_id,
        signalId: item.signal_id,
        symbol: item.symbol,
        detectedAt: iso(item.detected_at),
        originalEntryPrice: item.original_entry,
        targetPrice: item.chosen_target,
        targetSource: item.chosen_source,
        distancePct: item.chosen_distance_pct,
        status: item.status,
        touchAt: iso(item.touch_at),
        firstTp10At: iso(item.tp10_at),
        firstSl10At: iso(item.sl10_at),
        post24Status: item.post24_status,
        originalStatus:
          item.current_tracker_status ?? item.tracker_final_status,
        originalPnlPercent: item.tracker_final_pnl,
        sourceEvidence: item.source_evidence,
        obHypothesis: sourceEvidence?.obHypothesis ?? {
          version: null,
          status: sourceEvidence ? "legacy_unknown" : "unobserved",
          proximity: "unavailable",
          reason: sourceEvidence
            ? "row_precedes_ob_hypothesis_version"
            : "open_signal_has_no_shadow_observation",
        },
      };
    }),
  };
}
