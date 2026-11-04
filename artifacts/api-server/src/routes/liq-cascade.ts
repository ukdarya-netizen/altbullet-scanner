import { Router } from "express";
import {
  db,
  lcObWaitTable,
  liqCascadeWatchTable,
  prescanTrackerTable,
} from "@workspace/db";
import { desc, eq, gte, inArray, or } from "drizzle-orm";
import { getLiveMarketData } from "../lib/scanner.js";
import { logger } from "../lib/logger.js";
import { requireDashboardOwner } from "../middleware/dashboardAccess.js";

const router = Router();

/**
 * GET /api/liq-cascade
 * Возвращает записи Layer 10 Liquidation Cascade Watch.
 * ?hours=24 (default) — окно за сколько часов показывать (кроме watching — они всегда).
 * Watching-записи дополнительно обогащаются live-данными из prescanTracker.
 */
router.get("/liq-cascade", requireDashboardOwner, async (req, res) => {
  try {
    const hours = Math.min(
      parseInt((req.query.hours as string) ?? "24") || 24,
      168,
    );
    const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000);

    const waitHistoryCutoff = new Date(Date.now() - hours * 60 * 60 * 1000);
    const waitingRows = await db
      .select()
      .from(lcObWaitTable)
      .where(
        or(
          inArray(lcObWaitTable.status, [
            "waiting",
            "invalidated",
            "releasing",
          ]),
          gte(lcObWaitTable.expiresAt, waitHistoryCutoff),
        ),
      )
      .orderBy(desc(lcObWaitTable.detectedAt))
      .limit(200);
    const waitingWatchIds = waitingRows.map((row) => row.watchId);
    const entries = await db
      .select()
      .from(liqCascadeWatchTable)
      .where(
        or(
          eq(liqCascadeWatchTable.status, "watching"),
          gte(liqCascadeWatchTable.detectedAt, cutoff),
          ...(waitingWatchIds.length > 0
            ? [inArray(liqCascadeWatchTable.id, waitingWatchIds)]
            : []),
        ),
      )
      .orderBy(desc(liqCascadeWatchTable.detectedAt))
      .limit(200);

    // Получаем prescan_cycles для всех символов в ответе
    const allSymbols = entries.map((e) => e.symbol);
    const prescanRows =
      allSymbols.length > 0
        ? await db
            .select({
              symbol: prescanTrackerTable.symbol,
              prescanCycles: prescanTrackerTable.cycleCount,
            })
            .from(prescanTrackerTable)
            .where(inArray(prescanTrackerTable.symbol, allSymbols))
        : [];
    const cyclesMap = new Map(
      prescanRows.map((r) => [r.symbol, r.prescanCycles]),
    );
    // Обогащаем watching-записи live prescan данными
    const watchingSymbols = entries
      .filter((e) => e.status === "watching")
      .map((e) => e.symbol);

    const liveData =
      watchingSymbols.length > 0 ? getLiveMarketData(watchingSymbols) : {};

    const enriched = entries.map((e) => {
      const ld =
        e.status === "watching" && liveData[e.symbol]
          ? liveData[e.symbol]
          : null;
      return {
        id: e.id,
        symbol: e.symbol,
        status: e.status,
        detectedAt: e.detectedAt.toISOString(),
        expiresAt: e.expiresAt.toISOString(),
        priceAtDetect: e.priceAtDetect,
        price24hAtDetect: e.price24hAtDetect,
        price1hAtDetect: e.price1hAtDetect,
        oi30mAtDetect: e.oi30mAtDetect,
        oi1hAtDetect: e.oi1hAtDetect,
        oi4hAtDetect: e.oi4hAtDetect,
        spotVol24hAtDetect: e.spotVol24hAtDetect,
        spotVolMultAtDetect: e.spotVolMultAtDetect,
        spotVolMcapPct: e.spotVolMcapPct,
        cvd30mAtDetect: e.cvd30mAtDetect,
        cvd1hAtDetect: e.cvd1hAtDetect,
        cvd4hAtDetect: e.cvd4hAtDetect,
        currentPrice: e.currentPrice,
        currentPctChange: e.currentPctChange,
        lastCheckAt: e.lastCheckAt?.toISOString() ?? null,
        signalId: e.signalId,
        missReason: e.missReason,
        longLiq1hAtDetect: e.longLiq1hAtDetect,
        longLiq4hAtDetect: e.longLiq4hAtDetect,
        longLiq24hAtDetect: e.longLiq24hAtDetect,
        currentLongLiq1h: e.currentLongLiq1h,
        liqExhausted: e.liqExhausted,
        globalLongPct: e.globalLongPct,
        // Live prescan данные (null для не-watching или если токен не в prescan)
        liveOi30m: ld?.oi30m ?? null,
        liveOi1h: ld?.oi1h ?? null,
        liveOi4h: ld?.oi4h ?? null,
        liveCvd30m: ld?.cvd30m ?? null,
        liveCvd1h: ld?.cvd1h ?? null,
        liveCvd4h: ld?.cvd4h ?? null,
        livePrice1h: ld?.price1h ?? null,
        prescanCycles: cyclesMap.get(e.symbol) ?? null,
      };
    });

    const waiting = waitingRows
      .filter((row) => entries.some((entry) => entry.id === row.watchId))
      .map((row) => {
        const effectiveStatus =
          row.expiresAt.getTime() <= Date.now() &&
          (row.status === "waiting" ||
            row.status === "invalidated" ||
            row.status === "releasing")
            ? "expired"
            : row.status;
        const zones = Array.isArray(row.zones) ? (row.zones as any[]) : [];
        const invalidatedZones = new Set(
          Array.isArray(row.invalidatedZones)
            ? (row.invalidatedZones as string[])
            : [],
        );
        const zonesWithDistance = zones.map((zone) => ({
          ...zone,
          invalidated: invalidatedZones.has(
            `${zone.venue}:${zone.timeframe}:${zone.detector}:${zone.low}:${zone.high}`,
          ),
          distancePct:
            row.currentPrice != null && row.currentPrice > 0
              ? ((row.currentPrice - Number(zone.high)) / row.currentPrice) *
                100
              : null,
        }));
        const nearestDistance =
          zonesWithDistance
            .map((zone) => zone.distancePct)
            .filter((value): value is number => value != null)
            .sort((left, right) => Math.abs(left) - Math.abs(right))[0] ?? null;
        return {
          id: row.id,
          watchId: row.watchId,
          symbol: row.symbol,
          status: effectiveStatus,
          label:
            effectiveStatus === "waiting" ||
            effectiveStatus === "invalidated" ||
            effectiveStatus === "releasing"
              ? "РЕЖИМ ОЖИДАНИЯ!"
              : null,
          detectedAt: row.detectedAt.toISOString(),
          expiresAt: row.expiresAt.toISOString(),
          entryPrice: row.entryPrice,
          currentPrice: row.currentPrice,
          distancePct: nearestDistance,
          zones: zonesWithDistance,
          releasedAt: row.releasedAt?.toISOString() ?? null,
          releaseReason: row.releaseReason,
          releaseZone: row.releaseZone,
          lastCheckAt: row.lastCheckAt?.toISOString() ?? null,
        };
      });
    res.json({ entries: enriched, waiting, count: enriched.length });
  } catch (err) {
    logger.error({ err }, "GET /liq-cascade failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
