const WINDOW_MS = 30 * 24 * 60 * 60_000;
const MAX_ROWS = 3_000;
const ELIGIBLE_FINAL_STATUSES = new Set(["profit", "bu_stop", "stop_loss"]);
const MAP_SOURCES = new Set([
  "coinglass_aggregated_heatmap_model2_3d",
  "coinglass_binance_heatmap_model2_3d",
]);
import { LC_STOP_SLOTS, readLcStopBids } from "./lc-stop-bid-observations.js";

type BidObservationRow = Record<string, unknown>;

type SignalRow = Record<string, unknown> & {
  id: unknown;
  symbol: unknown;
  detected_at: unknown;
  closed_at: unknown;
  status: unknown;
  original_entry_price: unknown;
  entry_price: unknown;
  pnl_percent: unknown;
  decision_metrics: unknown;
  peak_15m_pct: unknown;
  elapsed_15m_ms: unknown;
  peak_1h_pct: unknown;
  elapsed_1h_ms: unknown;
};

type RepeatSignal = {
  trackedId: number | null;
  symbol: string;
  detectedAt: string | null;
  closedAt: string | null;
  status: string;
  entryPrice: number | null;
  realizedPnlPercent: number | null;
  priorSignalStatus: string | null;
  previousClosedAt: string | null;
  hoursSincePreviousClose: number | null;
  priorSignalStopped: boolean;
  first15mPeakPct: number | null;
  first1hPeakPct: number | null;
  entryMapEvidence: ReturnType<typeof captureMapEvidence>;
  postStopBids: ReturnType<typeof shapeStopBids>;
  nextLcEntryPrice: number | null;
  nextLcDetectedAt: string | null;
  nextLcStatus: string | null;
  nextLcRealizedPnlPercent: number | null;
  nextLcClosedAt: string | null;
};

function shapeStopBids(
  rows: BidObservationRow[],
  closedAt: string | null,
  now: Date,
) {
  const closed = closedAt ? Date.parse(closedAt) : NaN;
  if (!Number.isFinite(closed)) return [];
  let priorObserved: { price: number; qty: number; usd: number }[] = [];
  return LC_STOP_SLOTS.map((slot) => {
    const scheduled = new Date(closed + slot * 60_000);
    const row = rows.find((item) => Number(item.slot_minutes) === slot);
    const raw = row?.bids;
    const bids = (Array.isArray(raw) ? raw : [])
      .flatMap((item) => {
        const level = jsonObject(item);
        const price = positive(level?.price),
          qty = positive(level?.qty),
          usd = positive(level?.usd);
        return price != null && qty != null && usd != null
          ? [{ price, qty, usd }]
          : [];
      })
      .slice(0, 20);
    const observed =
      row?.status === "observed" && dateIso(row.observed_at) != null;
    const repeatedPrices = observed
      ? bids
          .filter((bid) =>
            priorObserved.some((previous) => previous.price === bid.price),
          )
          .map((bid) => bid.price)
      : [];
    if (observed) priorObserved = bids;
    return {
      slotMinutes: slot,
      scheduledAt: scheduled.toISOString(),
      observedAt: observed ? dateIso(row?.observed_at) : null,
      source: String(row?.source ?? "BingX perpetual swap depth"),
      status: observed
        ? "observed"
        : now.getTime() < scheduled.getTime()
          ? "upcoming"
          : now.getTime() <= scheduled.getTime() + 8 * 60_000 &&
              (!row || row.status === "pending")
            ? "pending"
            : "missing",
      reason: observed
        ? null
        : String(
            row?.status === "pending" &&
              now.getTime() > scheduled.getTime() + 8 * 60_000
              ? "capture_interrupted"
              : (row?.reason ??
                  (now.getTime() < scheduled.getTime()
                    ? "not_due"
                    : "no_capture")),
          ),
      referencePrice: observed ? positive(row?.reference_price) : null,
      bids: observed ? bids : [],
      repeatedPrices,
    };
  });
}

function numberOrNull(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || value.trim() === "") return null;
  const valueNumber = Number(value);
  return Number.isFinite(valueNumber) ? valueNumber : null;
}

function positive(value: unknown): number | null {
  const number = numberOrNull(value);
  return number != null && number > 0 ? number : null;
}

function dateIso(value: unknown): string | null {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function jsonObject(value: unknown): Record<string, unknown> | null {
  let parsed = value;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed) as unknown;
    } catch {
      return null;
    }
  }
  return parsed != null && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : null;
}

function captureMapEvidence(
  metricsValue: unknown,
  detectedAt: string | null,
  entryPrice: number | null,
) {
  const metrics = jsonObject(metricsValue);
  const shadow = jsonObject(metrics?.liqHeatmapShadow);
  if (!shadow) {
    return {
      status: "missing" as const,
      reason: metrics
        ? "liq_heatmap_shadow_missing"
        : "decision_metrics_missing",
      source: null,
      fetchedAt: null,
      belowShareWithin5Pct: null,
    };
  }
  const source = typeof shadow.source === "string" ? shadow.source : null;
  const fetchedAt =
    typeof shadow.fetchedAt === "string" ? shadow.fetchedAt : null;
  const unavailable = (reason: string) => ({
    status: "unavailable" as const,
    reason,
    source,
    fetchedAt,
    belowShareWithin5Pct: null,
  });
  if (shadow.available !== true)
    return unavailable(
      typeof shadow.reason === "string" ? shadow.reason : "capture_unavailable",
    );
  const fetchedMs = fetchedAt == null ? NaN : Date.parse(fetchedAt);
  const detectedMs = detectedAt == null ? NaN : Date.parse(detectedAt);
  if (!Number.isFinite(fetchedMs))
    return unavailable("missing_or_invalid_fetched_at");
  if (!Number.isFinite(detectedMs)) return unavailable("invalid_detected_at");
  if (fetchedMs > detectedMs) return unavailable("fetched_after_detection");
  if (detectedMs - fetchedMs > 10 * 60_000)
    return unavailable("stale_at_detection");
  if (!MAP_SOURCES.has(source ?? ""))
    return unavailable("unsupported_map_source");

  const capturedEntry = positive(shadow.entryPrice);
  if (
    entryPrice == null ||
    capturedEntry == null ||
    Math.abs(capturedEntry - entryPrice) / entryPrice > 0.01
  ) {
    return unavailable("entry_price_mismatch");
  }
  const bands = jsonObject(shadow.bands);
  const below = numberOrNull(bands?.below0to5);
  const above = numberOrNull(bands?.above0to5);
  if (below == null || above == null || below < 0 || above < 0)
    return unavailable("invalid_0to5_bands");
  const total = below + above;
  if (!(total > 0)) return unavailable("empty_0to5_bands");
  return {
    status: "available" as const,
    reason: null,
    source,
    fetchedAt,
    belowShareWithin5Pct: Number((below / total).toFixed(6)),
  };
}

function sampledPeak(
  value: unknown,
  elapsed: unknown,
  min: number,
  max: number,
) {
  const peak = numberOrNull(value);
  const elapsedMs = numberOrNull(elapsed);
  return peak != null &&
    elapsedMs != null &&
    elapsedMs >= min &&
    elapsedMs <= max
    ? peak
    : null;
}

function buildOutcomeCohorts(
  signals: Array<{
    entryMapStatus: string;
    status: string;
    realizedPnlPercent: number | null;
    priorSignalStopped?: boolean;
  }>,
  key: "entryMapStatus",
  labels: readonly string[],
) {
  return labels.map((label) => {
    const cohort = signals.filter((signal) => signal[key] === label);
    const eligible = cohort.filter((signal) =>
      ELIGIBLE_FINAL_STATUSES.has(signal.status),
    );
    const pnlKnown = eligible.filter(
      (signal) => signal.realizedPnlPercent != null,
    );
    return {
      group: label,
      signalDenominator: cohort.length,
      eligibleOutcomeDenominator: eligible.length,
      realizedPnlDenominator: pnlKnown.length,
      realizedAbove10Count: pnlKnown.filter(
        (signal) => signal.realizedPnlPercent! > 10,
      ).length,
      stopLossCount: eligible.filter((signal) => signal.status === "stop_loss")
        .length,
    };
  });
}

/** Purely shape bounded tracked LC history as descriptive, read-only evidence. */
export function buildLcRepeatWatchReport(
  inputRows: readonly SignalRow[],
  now = new Date(),
  bidRows: readonly BidObservationRow[] = [],
) {
  const bidsById = new Map<number, BidObservationRow[]>();
  for (const row of bidRows) {
    const id = Number(row.tracked_signal_id);
    bidsById.set(id, [...(bidsById.get(id) ?? []), row]);
  }
  const lowerBound = now.getTime() - WINDOW_MS;
  const rows = inputRows
    .map((row) => {
      const detectedAt = dateIso(row.detected_at);
      return {
        row,
        detectedAt,
        detectedMs: detectedAt ? Date.parse(detectedAt) : NaN,
        closedMs: Date.parse(dateIso(row.closed_at) ?? ""),
      };
    })
    .filter(
      (item) =>
        Number.isFinite(item.detectedMs) &&
        item.detectedMs <= now.getTime() &&
        (item.detectedMs >= lowerBound ||
          (String(item.row.status) === "stop_loss" &&
            item.closedMs >= lowerBound &&
            item.closedMs <= now.getTime())),
    )
    .sort(
      (left, right) =>
        left.detectedMs - right.detectedMs ||
        Number(left.row.id) - Number(right.row.id),
    );

  const bySymbol = new Map<string, RepeatSignal[]>();
  for (const { row, detectedAt } of rows) {
    const symbol = String(row.symbol);
    const status = String(row.status);
    const entryPrice =
      positive(row.original_entry_price) ?? positive(row.entry_price);
    const realizedPnlPercent = ELIGIBLE_FINAL_STATUSES.has(status)
      ? numberOrNull(row.pnl_percent)
      : null;
    const mapEvidence = captureMapEvidence(
      row.decision_metrics,
      detectedAt,
      entryPrice,
    );
    const signal = {
      trackedId: numberOrNull(row.id),
      symbol,
      detectedAt,
      closedAt: dateIso(row.closed_at),
      status,
      entryPrice,
      realizedPnlPercent,
      priorSignalStatus: null as string | null,
      previousClosedAt: null as string | null,
      hoursSincePreviousClose: null as number | null,
      priorSignalStopped: false,
      first15mPeakPct: sampledPeak(
        row.peak_15m_pct,
        row.elapsed_15m_ms,
        15 * 60_000,
        30 * 60_000,
      ),
      first1hPeakPct: sampledPeak(
        row.peak_1h_pct,
        row.elapsed_1h_ms,
        60 * 60_000,
        90 * 60_000,
      ),
      entryMapEvidence: mapEvidence,
      postStopBids:
        status === "stop_loss"
          ? shapeStopBids(
              bidsById.get(Number(row.id)) ?? [],
              dateIso(row.closed_at),
              now,
            )
          : [],
      nextLcEntryPrice: null as number | null,
      nextLcDetectedAt: null as string | null,
      nextLcStatus: null as string | null,
      nextLcRealizedPnlPercent: null as number | null,
      nextLcClosedAt: null as string | null,
    };
    const history = bySymbol.get(symbol) ?? [];
    for (const stopped of history) {
      if (
        stopped.status === "stop_loss" &&
        stopped.closedAt &&
        detectedAt &&
        Date.parse(stopped.closedAt) <= Date.parse(detectedAt) &&
        stopped.nextLcDetectedAt == null
      ) {
        stopped.nextLcEntryPrice = entryPrice;
        stopped.nextLcDetectedAt = detectedAt;
        stopped.nextLcStatus = status;
        stopped.nextLcRealizedPnlPercent = realizedPnlPercent;
        stopped.nextLcClosedAt = signal.closedAt;
      }
    }
    const prior = history.at(-1);
    if (prior) {
      signal.priorSignalStatus = prior.status;
      const priorClosedMs = prior.closedAt ? Date.parse(prior.closedAt) : NaN;
      const currentDetectedMs = detectedAt ? Date.parse(detectedAt) : NaN;
      const priorClosedByDetection =
        Number.isFinite(priorClosedMs) &&
        Number.isFinite(currentDetectedMs) &&
        priorClosedMs <= currentDetectedMs;
      signal.previousClosedAt = priorClosedByDetection ? prior.closedAt : null;
      signal.priorSignalStopped =
        prior.status === "stop_loss" && priorClosedByDetection;
      if (priorClosedByDetection) {
        const hours = (currentDetectedMs - priorClosedMs) / 3_600_000;
        signal.hoursSincePreviousClose =
          Number.isFinite(hours) && hours >= 0
            ? Number(hours.toFixed(4))
            : null;
      }
    }
    history.push(signal);
    bySymbol.set(symbol, history);
  }

  const groups = [...bySymbol.entries()]
    .filter(
      ([, history]) =>
        history.length >= 2 ||
        history.some((signal) => signal.status === "stop_loss"),
    )
    .map(([symbol, history]) => ({
      symbol,
      signalCount: history.length,
      stopCount: history.filter((signal) => signal.status === "stop_loss")
        .length,
      latestStatus: history.at(-1)!.status,
      latestDetectedAt: history.at(-1)!.detectedAt,
      signals: history,
    }))
    .sort(
      (a, b) =>
        b.signalCount - a.signalCount ||
        String(b.latestDetectedAt).localeCompare(String(a.latestDetectedAt)) ||
        a.symbol.localeCompare(b.symbol),
    );
  const repeatedRows = groups.flatMap((group) =>
    group.signals.map((signal) => ({
      entryMapStatus: String(
        (signal.entryMapEvidence as { status: string }).status,
      ),
      status: String(signal.status),
      realizedPnlPercent: numberOrNull(signal.realizedPnlPercent),
      priorSignalStopped: signal.priorSignalStopped === true,
    })),
  );
  const eligibleRows = repeatedRows.filter((signal) =>
    ELIGIBLE_FINAL_STATUSES.has(signal.status),
  );
  const summary = {
    repeatedSymbolCount: groups.filter((group) => group.signalCount >= 2)
      .length,
    signalCount: repeatedRows.length,
    immediatelyAfterStopCount: repeatedRows.filter(
      (signal) => signal.priorSignalStopped,
    ).length,
    validEntryMapCount: repeatedRows.filter(
      (signal) => signal.entryMapStatus === "available",
    ).length,
    missingEntryMapCount: repeatedRows.filter(
      (signal) => signal.entryMapStatus === "missing",
    ).length,
    openSignalCount: repeatedRows.filter((signal) =>
      ["active", "in_run"].includes(signal.status),
    ).length,
    terminalSignalCount: repeatedRows.filter(
      (signal) => !["active", "in_run"].includes(signal.status),
    ).length,
    eligibleOutcomeCount: eligibleRows.length,
  };
  return {
    generatedAt: now.toISOString(),
    windowDays: 30 as const,
    summary,
    groups,
    cohorts: {
      entryMapStatus: buildOutcomeCohorts(repeatedRows, "entryMapStatus", [
        "available",
        "unavailable",
        "missing",
      ]),
    },
    methodology: {
      windowBasis:
        "Signals are selected by detected_at within the trailing 30 days, plus older signals closed by stop_loss in that window. Symbols with at least two selected LC signals or one stop_loss are returned. Repeated-symbol count excludes single-stop histories.",
      priorSignal:
        "Sequence is ordered by detected_at then tracked id within the selected window. priorSignalStatus is the immediately preceding row's current/final tracked status. Closure-derived fields require that row's closed_at to be no later than the current signal's detected_at; priorSignalStopped is true only for an immediately preceding stop_loss that had already closed by the current detection. Overlapping closures remain false/null.",
      realizedOutcomes:
        "Only final profit, bu_stop, and stop_loss rows expose realized PnL. Cohorts report signal, eligible-outcome, and measurable-PnL denominators; missing maps are never classified as no-cluster.",
      mapEvidence:
        "Entry map evidence uses only decision_metrics.liqHeatmapShadow captured no more than 10 minutes before detection, available=true, a matching entry price, recognized aggregated/Binance source, and finite nonnegative 0–5% band totals with positive combined intensity. Band totals come from the full capture and are not rejected because its top-three bins omit the 0–5% range. No current heatmap snapshots or outcome-based cluster inference are used.",
      trajectory:
        "Peak values come only from the originating tracked signal's unique 15m/1h trajectory rows at 15–30 and 60–90 elapsed minutes respectively.",
      postStopBids:
        "BingX perpetual depth samples at 0/15/60/120 minutes after actual stop close (8-minute grace). Each sample shows only visible bids below the same response's best ask, never liquidation orders. Repeated prices mean seen in two observed samples, not continuously resting. Missing/upcoming samples are not evidence of an empty book. Next LC entry and realized outcome are chronological, not causal.",
      decisionUse: false,
      tradingChanges: false,
    },
  };
}

/** Read-only bounded LC repeat history; this performs no market-provider calls. */
export async function getLcRepeatWatchReport(now = new Date()) {
  const [{ db }, { sql }] = await Promise.all([
    import("@workspace/db"),
    import("drizzle-orm"),
  ]);
  const start = new Date(now.getTime() - WINDOW_MS);
  const result = await db.execute(sql`
    SELECT ts.id, ts.symbol, ts.detected_at, ts.closed_at, ts.status,
           ts.original_entry_price, ts.entry_price, ts.pnl_percent,
           ts.decision_metrics,
           trajectory_15m.peak_pct AS peak_15m_pct,
           trajectory_15m.elapsed_ms AS elapsed_15m_ms,
           trajectory_1h.peak_pct AS peak_1h_pct,
           trajectory_1h.elapsed_ms AS elapsed_1h_ms
      FROM tracked_signals ts
      LEFT JOIN signal_trajectory_log trajectory_15m
        ON trajectory_15m.signal_id = ts.id
       AND trajectory_15m.interval_label = '15m'
       AND trajectory_15m.elapsed_ms BETWEEN 900000 AND 1800000
      LEFT JOIN signal_trajectory_log trajectory_1h
        ON trajectory_1h.signal_id = ts.id
       AND trajectory_1h.interval_label = '1h'
       AND trajectory_1h.elapsed_ms BETWEEN 3600000 AND 5400000
     WHERE ts.sentiment_key = 'liquidation_cascade'
        AND (ts.detected_at >= ${start}
          OR (ts.status = 'stop_loss' AND ts.closed_at >= ${start}))
       AND ts.detected_at <= ${now}
     ORDER BY ts.detected_at DESC, ts.id DESC
     LIMIT ${MAX_ROWS}
  `);
  const rows = result.rows as SignalRow[];
  const bids = await readLcStopBids(
    rows
      .filter((row) => String(row.status) === "stop_loss")
      .map((row) => Number(row.id)),
  );
  return buildLcRepeatWatchReport(rows, now, bids);
}
