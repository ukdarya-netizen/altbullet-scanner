import type { RequestHandler } from "express";

export type ScannerHealthDeliveryRow = {
  recipientRole: string;
  status: string;
  reason: string;
  queueClass: string;
  rows: number;
  oldestAt?: unknown;
};

export type ScannerHealthApiName =
  | "coinglass"
  | "coinalyze"
  | "coingecko"
  | "coinpaprika";

export type ScannerHealthState = {
  running: boolean;
  isScanning: boolean;
  lastScanAt: unknown;
  nextScanAt: unknown;
  lastScanDurationMs: number | null;
  lastFailureAt: unknown;
  lastFailureReason: string | null;
  retryAt: unknown;
  activeMarketLeaseExpiresAt: unknown;
  marketsScanned: number;
  scanIntervalMs: number;
  bingxConnected: boolean;
  telegramConnected: boolean;
  lastCgTelemetry: {
    cgTimeoutPct: unknown;
    cgP50Ms: unknown;
    cgP95Ms: unknown;
    cgMaxMs: unknown;
    cgReq: unknown;
    cgReqPerMin: unknown;
    elLagP95Ms: unknown;
    windowMin: unknown;
  } | null;
  oiWatchInsertErrors: number;
  cgTimeoutsLastScan: number;
};

export type ScannerHealthLease = {
  busy: boolean;
  ownerToken: string | null;
  acquiredAt: unknown;
  heartbeatAt: unknown;
  expectedExpiryAt: unknown;
};

export type ScannerHealthDependencies = {
  getScannerState: () => Promise<ScannerHealthState>;
  getTelegramDeliveryHealth: () => Promise<readonly ScannerHealthDeliveryRow[]>;
  getDiscoveryScannerLeaseStatus: () => Promise<ScannerHealthLease>;
  getWatcherJobTimings: () => Record<string, unknown>;
  getApiConnected: (api: ScannerHealthApiName) => boolean;
  pingDatabase: () => Promise<void>;
  getDbPoolSnapshot: () => unknown;
  getSchedulerPoolSnapshot: () => unknown;
};

/**
 * PostgreSQL drivers may return timestamp values as either Date instances or
 * strings depending on the query path and runtime configuration. Keep the
 * health endpoint's date contract stable for both cases.
 */
export function normalizeHealthDate(value: unknown): string | null {
  if (value === null || value === undefined) return null;

  const date =
    value instanceof Date
      ? value
      : typeof value === "string" || typeof value === "number"
        ? new Date(value)
        : null;

  if (!date || Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

export function serializeTelegramDeliveryHealth(
  rows: readonly ScannerHealthDeliveryRow[],
): Array<{
  recipientRole: string;
  status: string;
  reason: string;
  queueClass: string;
  rows: number;
  oldestAt: string | null;
}> {
  return rows.map((row) => ({
    recipientRole: row.recipientRole,
    status: row.status,
    reason: row.reason,
    queueClass: row.queueClass,
    rows: row.rows,
    oldestAt: normalizeHealthDate(row.oldestAt),
  }));
}

export function createScannerBotHealthHandler(
  dependencies: ScannerHealthDependencies,
): RequestHandler {
  return async (req, res) => {
    try {
      const [state, deliveryHealth, discoveryLease] = await Promise.all([
        dependencies.getScannerState(),
        dependencies.getTelegramDeliveryHealth(),
        dependencies.getDiscoveryScannerLeaseStatus(),
      ]);
      const jobs = dependencies.getWatcherJobTimings();

      let dbPingMs: number | null = null;
      let dbOk = false;
      try {
        const startedAt = Date.now();
        await dependencies.pingDatabase();
        dbPingMs = Date.now() - startedAt;
        dbOk = true;
      } catch {
        dbOk = false;
      }

      res.json({
        scanner: {
          running: state.running,
          isScanning: state.isScanning,
          lastScanAt: normalizeHealthDate(state.lastScanAt),
          nextScanAt: normalizeHealthDate(state.nextScanAt),
          lastScanDurationMs: state.lastScanDurationMs,
          lastFailureAt: normalizeHealthDate(state.lastFailureAt),
          lastFailureReason: state.lastFailureReason,
          retryAt: normalizeHealthDate(state.retryAt),
          activeMarketLeaseExpiresAt: normalizeHealthDate(
            state.activeMarketLeaseExpiresAt,
          ),
          marketsScanned: state.marketsScanned,
          scanIntervalMs: state.scanIntervalMs,
        },
        cgLatency: state.lastCgTelemetry
          ? {
              timeoutPct: state.lastCgTelemetry.cgTimeoutPct,
              p50Ms: state.lastCgTelemetry.cgP50Ms,
              p95Ms: state.lastCgTelemetry.cgP95Ms,
              maxMs: state.lastCgTelemetry.cgMaxMs,
              req: state.lastCgTelemetry.cgReq,
              reqPerMin: state.lastCgTelemetry.cgReqPerMin,
              elLagP95Ms: state.lastCgTelemetry.elLagP95Ms,
              windowMin: state.lastCgTelemetry.windowMin,
            }
          : null,
        connections: {
          bingx: state.bingxConnected,
          telegram: state.telegramConnected,
          coinglass: dependencies.getApiConnected("coinglass"),
          coinalyze: dependencies.getApiConnected("coinalyze"),
          coinGecko: dependencies.getApiConnected("coingecko"),
          coinPaprika: dependencies.getApiConnected("coinpaprika"),
        },
        jobs,
        db: {
          ok: dbOk,
          pingMs: dbPingMs,
          appPool: dependencies.getDbPoolSnapshot(),
          schedulerPool: dependencies.getSchedulerPoolSnapshot(),
          discoveryLease: {
            busy: discoveryLease.busy,
            ownerToken: discoveryLease.ownerToken,
            acquiredAt: normalizeHealthDate(discoveryLease.acquiredAt),
            heartbeatAt: normalizeHealthDate(discoveryLease.heartbeatAt),
            expiresAt: normalizeHealthDate(discoveryLease.expectedExpiryAt),
          },
        },
        oiWatch: {
          insertErrors: state.oiWatchInsertErrors,
          cgTimeoutsLastScan: state.cgTimeoutsLastScan,
        },
        telegramDeliveries: serializeTelegramDeliveryHealth(deliveryHealth),
      });
    } catch (err) {
      req.log.error({ err }, "Failed to get bot health");
      res.status(500).json({ error: "Failed to get bot health" });
    }
  };
}
