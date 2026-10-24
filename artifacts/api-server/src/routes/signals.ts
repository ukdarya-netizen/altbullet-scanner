import { Router } from "express";
import { db, signalsTable, trackedSignalsTable } from "@workspace/db";
import { ACTIVE_PATTERN_KEYS } from "../lib/dead-patterns.js";
import { desc, eq, gte, sql, and, inArray } from "drizzle-orm";
import { getTableColumns } from "drizzle-orm";
import { getCached, setCached } from "../lib/routeCache.js";

const router = Router();

export function serializeTrackedRunnerFields(input: {
  trackedRunnerState: string | null;
  trackedCoreClosedAt: Date | null;
}) {
  return {
    trackedRunnerState: input.trackedRunnerState ?? null,
    trackedCoreClosedAt: input.trackedCoreClosedAt?.toISOString() ?? null,
  };
}

router.get("/signals", async (req, res) => {
  try {
    const limit = Math.min(
      parseInt((req.query.limit as string) ?? "50") || 50,
      200,
    );
    const offset = Math.max(
      parseInt((req.query.offset as string) ?? "0") || 0,
      0,
    );
    const type = req.query.type as string | undefined;
    const status = req.query.status as string | undefined;
    const pattern = req.query.pattern as string | undefined;
    const scope = req.query.scope === "real" ? "real" : "all";

    const cacheKey = `signals:list:${limit}:${offset}:${type ?? ""}:${status ?? ""}:${pattern ?? ""}:${scope}`;
    const hit = getCached<object>(cacheKey);
    if (hit) {
      res.json(hit);
      return;
    }

    const conditions: ReturnType<typeof eq>[] = [];

    if (type && type !== "all") {
      conditions.push(
        eq(
          signalsTable.type,
          type as
            | "volume_spike"
            | "oi_increase"
            | "funding_rate"
            | "strict_alpha"
            | "alpha"
            | "super_alpha"
            | "short_sniper",
        ),
      );
    }

    if (pattern && pattern !== "all") {
      conditions.push(eq(signalsTable.sentimentKey, pattern));
    }

    if (scope === "real") {
      conditions.push(
        sql`EXISTS (
          SELECT 1 FROM tracked_signals ts
          WHERE ts.signal_id = signals.id
            AND ts.status <> 'reclassified'
        )` as any,
      );
    }

    // Status filter via correlated subquery
    if (status && status !== "all") {
      if (status === "active") {
        conditions.push(
          sql`(
          SELECT COALESCE(status, 'active') FROM tracked_signals ts
          WHERE ts.signal_id = signals.id
          ORDER BY ts.id DESC LIMIT 1
        ) = 'active'` as any,
        );
      } else {
        conditions.push(
          sql`(
          SELECT status FROM tracked_signals ts
          WHERE ts.signal_id = signals.id
          ORDER BY ts.id DESC LIMIT 1
        ) = ${status}` as any,
        );
      }
    }

    const where = conditions.length > 0 ? and(...conditions) : undefined;

    const signals = await db
      .select({
        ...getTableColumns(signalsTable),
        // Tracker status fields
        trackedStatus: sql<string | null>`(
          SELECT status FROM tracked_signals ts
          WHERE ts.signal_id = signals.id
          ORDER BY ts.id DESC LIMIT 1
        )`,
        trackedRunnerState: sql<string | null>`(
          SELECT runner_state FROM tracked_signals ts
          WHERE ts.signal_id = signals.id
          ORDER BY ts.id DESC LIMIT 1
        )`,
        trackedCoreClosedAt: sql<Date | null>`(
          SELECT core_closed_at FROM tracked_signals ts
          WHERE ts.signal_id = signals.id
          ORDER BY ts.id DESC LIMIT 1
        )`,
        trackedPnl: sql<number | null>`(
          SELECT pnl_percent FROM tracked_signals ts
          WHERE ts.signal_id = signals.id
          ORDER BY ts.id DESC LIMIT 1
        )`,
        // Tracker position fields
        trackedEntryPrice: sql<number | null>`(
          SELECT entry_price FROM tracked_signals ts
          WHERE ts.signal_id = signals.id
          ORDER BY ts.id DESC LIMIT 1
        )`,
        trackedPeakPrice: sql<number | null>`(
          SELECT peak_price FROM tracked_signals ts
          WHERE ts.signal_id = signals.id
          ORDER BY ts.id DESC LIMIT 1
        )`,
        trackedTrailingStop: sql<number | null>`(
          SELECT trailing_stop_level FROM tracked_signals ts
          WHERE ts.signal_id = signals.id
          ORDER BY ts.id DESC LIMIT 1
        )`,
        trackedExitPrice: sql<number | null>`(
          SELECT exit_price FROM tracked_signals ts
          WHERE ts.signal_id = signals.id
          ORDER BY ts.id DESC LIMIT 1
        )`,
        trackedIsShort: sql<boolean>`COALESCE((
          SELECT is_short FROM tracked_signals ts
          WHERE ts.signal_id = signals.id
          ORDER BY ts.id DESC LIMIT 1
        ), false)`,
        // Персональный стоп/тейки по Liquidation Heatmap
        trackedStopPrice: sql<number | null>`(
          SELECT stop_loss_price FROM tracked_signals ts
          WHERE ts.signal_id = signals.id
          ORDER BY ts.id DESC LIMIT 1
        )`,
        trackedStopPct: sql<number | null>`(
          SELECT stop_loss_pct FROM tracked_signals ts
          WHERE ts.signal_id = signals.id
          ORDER BY ts.id DESC LIMIT 1
        )`,
        trackedStopSource: sql<string | null>`(
          SELECT stop_source FROM tracked_signals ts
          WHERE ts.signal_id = signals.id
          ORDER BY ts.id DESC LIMIT 1
        )`,
        trackedTakeTargets: sql<unknown>`(
          SELECT take_targets FROM tracked_signals ts
          WHERE ts.signal_id = signals.id
          ORDER BY ts.id DESC LIMIT 1
        )`,
        telegramDeliveryStatus: sql<string | null>`(
          SELECT status FROM telegram_delivery_events tde
          WHERE tde.event_key = ('signal:' || signals.id::text)
          ORDER BY tde.id DESC LIMIT 1
        )`,
      })
      .from(signalsTable)
      .where(where)
      .orderBy(desc(signalsTable.detectedAt))
      .limit(limit)
      .offset(offset);

    const [totalResult] = await db
      .select({ count: sql<number>`count(*)` })
      .from(signalsTable)
      .where(where);

    const result = {
      signals: signals.map((s) => ({
        ...s,
        detectedAt: s.detectedAt.toISOString(),
        trackedStatus: s.trackedStatus ?? null,
        ...serializeTrackedRunnerFields(s),
        trackedPnl: s.trackedStatus === "bu_stop" ? 0 : (s.trackedPnl ?? null),
        trackedEntryPrice: s.trackedEntryPrice ?? null,
        trackedPeakPrice: s.trackedPeakPrice ?? null,
        trackedTrailingStop: s.trackedTrailingStop ?? null,
        trackedExitPrice:
          s.trackedStatus === "bu_stop"
            ? (s.trackedEntryPrice ?? null)
            : (s.trackedExitPrice ?? null),
        trackedIsShort: Boolean(s.trackedIsShort),
        trackedStopPrice: s.trackedStopPrice ?? null,
        trackedStopPct: s.trackedStopPct ?? null,
        trackedStopSource: s.trackedStopSource ?? null,
        trackedTakeTargets:
          (s.trackedTakeTargets as
            | { price: number; pctFromEntry: number; liqUsd: number }[]
            | null) ?? null,
        telegramDeliveryStatus: s.telegramDeliveryStatus ?? null,
      })),
      total: Number(totalResult.count),
    };
    setCached(cacheKey, result, 15_000);
    res.json(result);
  } catch (err) {
    req.log.error({ err }, "Failed to get signals");
    res.status(500).json({ error: "Failed to get signals" });
  }
});

router.get("/signals/summary", async (req, res) => {
  try {
    const cacheKey = "signals:summary";
    const hit = getCached<object>(cacheKey);
    if (hit) {
      res.json(hit);
      return;
    }

    const trackerCondition = and(
      inArray(trackedSignalsTable.sentimentKey, ACTIVE_PATTERN_KEYS),
      sql`${trackedSignalsTable.status} <> 'reclassified'`,
    );

    const [totalResult] = await db
      .select({ count: sql<number>`count(*)` })
      .from(trackedSignalsTable)
      .where(trackerCondition);

    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "Asia/Dubai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(new Date());
    const today = new Date(
      Date.UTC(
        Number(parts.find((p) => p.type === "year")?.value),
        Number(parts.find((p) => p.type === "month")?.value) - 1,
        Number(parts.find((p) => p.type === "day")?.value),
      ) -
        4 * 60 * 60 * 1000,
    );

    const [todayResult] = await db
      .select({ count: sql<number>`count(*)` })
      .from(trackedSignalsTable)
      .where(and(gte(trackedSignalsTable.detectedAt, today), trackerCondition));

    const [strictAlphaResult] = await db
      .select({ count: sql<number>`count(*)` })
      .from(trackedSignalsTable)
      .where(and(gte(trackedSignalsTable.detectedAt, today), trackerCondition));

    const [strictAlphaTotalResult] = await db
      .select({ count: sql<number>`count(*)` })
      .from(trackedSignalsTable)
      .where(trackerCondition);

    const topSymbolsRaw = await db
      .select({
        symbol: trackedSignalsTable.symbol,
        count: sql<number>`count(*)`,
      })
      .from(trackedSignalsTable)
      .where(and(gte(trackedSignalsTable.detectedAt, today), trackerCondition))
      .groupBy(trackedSignalsTable.symbol)
      .orderBy(desc(sql`count(*)`))
      .limit(5);

    const summaryResult = {
      totalSignals: Number(totalResult.count),
      signalsToday: Number(todayResult.count),
      strictAlphaToday: Number(strictAlphaResult.count),
      strictAlphaTotal: Number(strictAlphaTotalResult.count),
      volumeSpikes: Number(strictAlphaResult.count),
      oiIncreases: 0,
      fundingRateAlerts: 0,
      topSymbols: topSymbolsRaw.map((r) => ({
        symbol: r.symbol,
        count: Number(r.count),
      })),
    };
    setCached(cacheKey, summaryResult, 20_000);
    res.json(summaryResult);
  } catch (err) {
    req.log.error({ err }, "Failed to get signals summary");
    res.status(500).json({ error: "Failed to get signals summary" });
  }
});

router.get("/signals/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) {
      res.status(400).json({ error: "Invalid signal ID" });
      return;
    }

    const [signal] = await db
      .select()
      .from(signalsTable)
      .where(eq(signalsTable.id, id))
      .limit(1);

    if (!signal) {
      res.status(404).json({ error: "Signal not found" });
      return;
    }

    res.json({ ...signal, detectedAt: signal.detectedAt.toISOString() });
  } catch (err) {
    req.log.error({ err }, "Failed to get signal");
    res.status(500).json({ error: "Failed to get signal" });
  }
});

export default router;
