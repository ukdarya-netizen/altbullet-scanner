export type ScannerWatchdogActivity =
  | { kind: "running"; startedAt: Date | null }
  | {
      kind: "settlement_fence";
      pendingSince: Date | null;
      graceExpiresAt: Date | null;
      restartRequested: boolean;
    }
  | { kind: "idle" };

export type WatchdogScanStateSource =
  | "scanner-running"
  | "scanner-lease-wait"
  | "lease-control-plane-recovery"
  | "lease-release-recovery"
  | "settlement-fence"
  | "idle";

export type WatchdogScanState = {
  isScanning: boolean;
  source: WatchdogScanStateSource;
  blocker: string;
  expectedAction: string;
};

export type WatchdogRecoverySummary = {
  failureReason: string | null;
  expectedLeaseExpiryAt: Date | null;
};

/**
 * Measure an active scan from its own start time, not from the prior
 * successful completion. During a slow but healthy cycle those timestamps can
 * be far apart; using the completion cursor would report a false 100-minute
 * stall and could trigger a worker restart while position management runs.
 */
export function getWatchdogElapsedMs(input: {
  activity: ScannerWatchdogActivity;
  scannerLeaseBusy: boolean;
  lastSuccessfulScanAt: Date | null;
  persistedScanStartedAt: Date | null;
  now?: number;
}): number | null {
  const now = input.now ?? Date.now();
  if (input.activity.kind === "running") {
    return input.activity.startedAt
      ? Math.max(0, now - input.activity.startedAt.getTime())
      : null;
  }

  if (input.activity.kind === "settlement_fence") {
    const anchor = input.activity.pendingSince ?? input.lastSuccessfulScanAt;
    return anchor ? Math.max(0, now - anchor.getTime()) : null;
  }

  const persistedStart = input.persistedScanStartedAt;
  const lastSuccess = input.lastSuccessfulScanAt;
  const persistedScanIsActive =
    input.scannerLeaseBusy &&
    persistedStart !== null &&
    (lastSuccess === null || persistedStart.getTime() > lastSuccess.getTime());
  const anchor = persistedScanIsActive ? persistedStart : lastSuccess;
  return anchor ? Math.max(0, now - anchor.getTime()) : null;
}

/**
 * The scheduler status comes from the same control-plane that may be down.
 * Never let a failed status read erase the recovery reason the watchdog needs
 * to report. A local control-plane recovery also makes an extra read useless.
 */
export async function readWatchdogDiscoveryLeaseStatus(
  activity: ScannerWatchdogActivity,
  recovery: WatchdogRecoverySummary | null,
  readStatus:
    | (() => Promise<{
        busy: boolean;
        expectedExpiryAt: Date | null;
      }>)
    | null,
): Promise<{
  lease: { busy: boolean; expectedExpiryAt: Date | null };
  controlPlaneUnavailable: boolean;
}> {
  const idleLease = { busy: false, expectedExpiryAt: null };
  if (
    activity.kind !== "idle" ||
    recovery?.failureReason === "lease_control_plane_unavailable" ||
    !readStatus
  ) {
    return { lease: idleLease, controlPlaneUnavailable: false };
  }
  try {
    return { lease: await readStatus(), controlPlaneUnavailable: false };
  } catch {
    return { lease: idleLease, controlPlaneUnavailable: true };
  }
}

/**
 * A watchdog can run in a different API worker than the scanner. It must use
 * the scanner's dedicated lease and durable recovery reason, not the shared
 * market-cycle row owned by watcher/background jobs.
 */
export function resolveWatchdogScanState(
  activity: ScannerWatchdogActivity,
  scannerLease: { busy: boolean; expectedExpiryAt: Date | null },
  recovery: WatchdogRecoverySummary | null,
  now = Date.now(),
): WatchdogScanState {
  if (activity.kind === "settlement_fence") {
    return {
      isScanning: false,
      source: "settlement-fence",
      blocker: "предыдущий discovery-цикл не завершил settlement fence",
      expectedAction: activity.restartRequested
        ? "перезапуск worker уже запрошен; ожидаем новый worker"
        : activity.graceExpiresAt && activity.graceExpiresAt.getTime() > now
          ? "ожидаем завершение fence до grace period; затем worker будет перезапущен"
          : "нужен безопасный перезапуск worker",
    };
  }
  if (activity.kind === "running") {
    return {
      isScanning: true,
      source: "scanner-running",
      blocker: "discovery scanner выполняет цикл",
      expectedAction: "watchdog ждёт завершения цикла",
    };
  }
  if (scannerLease.busy) {
    return {
      isScanning: true,
      source: "scanner-lease-wait",
      blocker: "другой worker удерживает discovery-scanner lease",
      expectedAction: scannerLease.expectedExpiryAt
        ? `ждём lease до ${scannerLease.expectedExpiryAt.toISOString()}`
        : "ждём освобождения discovery lease",
    };
  }
  if (
    recovery?.failureReason === "lease_release_failed" &&
    recovery.expectedLeaseExpiryAt &&
    recovery.expectedLeaseExpiryAt.getTime() > now
  ) {
    return {
      isScanning: false,
      source: "lease-release-recovery",
      blocker: "discovery lease не подтверждённо освобождён после сбоя БД",
      expectedAction: `повторить discovery после TTL ${recovery.expectedLeaseExpiryAt.toISOString()}`,
    };
  }
  if (recovery?.failureReason === "lease_control_plane_unavailable") {
    return {
      isScanning: false,
      source: "lease-control-plane-recovery",
      blocker:
        "discovery scanner не может связаться с PostgreSQL control-plane для lease",
      expectedAction:
        "scanner повторяет acquisition с коротким backoff; необязательные DB jobs отложены",
    };
  }
  return {
    isScanning: false,
    source: "idle",
    blocker: "discovery scanner не выполняется и не удерживается другим worker",
    expectedAction: "проверить worker и подключение к БД",
  };
}
