import assert from "node:assert/strict";
import { test } from "node:test";
import {
  getWatchdogElapsedMs,
  readWatchdogDiscoveryLeaseStatus,
  resolveWatchdogScanState,
} from "../src/lib/watchdog-scan-state.js";

test("watchdog identifies a real discovery cycle", () => {
  assert.deepEqual(
    resolveWatchdogScanState(
      { kind: "running", startedAt: null },
      { busy: false, expectedExpiryAt: null },
      null,
    ),
    {
      isScanning: true,
      source: "scanner-running",
      blocker: "discovery scanner выполняет цикл",
      expectedAction: "watchdog ждёт завершения цикла",
    },
  );
});

test("watchdog measures an active cycle from its start, not the prior success", () => {
  const now = Date.parse("2026-11-07T10:43:32.000Z");
  const lastSuccessfulScanAt = new Date("2026-11-07T09:00:04.000Z");
  const startedAt = new Date("2026-11-07T10:23:55.000Z");
  assert.equal(
    getWatchdogElapsedMs({
      activity: { kind: "running", startedAt },
      scannerLeaseBusy: false,
      lastSuccessfulScanAt,
      persistedScanStartedAt: startedAt,
      now,
    }),
    19 * 60_000 + 37_000,
  );
});

test("watchdog uses a newer persisted start for a scan running on another worker", () => {
  const now = Date.parse("2026-11-07T10:43:32.000Z");
  const lastSuccessfulScanAt = new Date("2026-11-07T09:00:04.000Z");
  const startedAt = new Date("2026-11-07T10:23:55.000Z");
  assert.equal(
    getWatchdogElapsedMs({
      activity: { kind: "idle" },
      scannerLeaseBusy: true,
      lastSuccessfulScanAt,
      persistedScanStartedAt: startedAt,
      now,
    }),
    19 * 60_000 + 37_000,
  );
});

test("watchdog ignores a persisted start when no worker holds the scan lease", () => {
  const now = Date.parse("2026-11-07T10:43:32.000Z");
  const lastSuccessfulScanAt = new Date("2026-11-07T09:00:04.000Z");
  assert.equal(
    getWatchdogElapsedMs({
      activity: { kind: "idle" },
      scannerLeaseBusy: false,
      lastSuccessfulScanAt,
      persistedScanStartedAt: new Date("2026-11-07T10:23:55.000Z"),
      now,
    }),
    103 * 60_000 + 28_000,
  );
});

test("watchdog cannot infer a current scan duration without a start timestamp", () => {
  assert.equal(
    getWatchdogElapsedMs({
      activity: { kind: "running", startedAt: null },
      scannerLeaseBusy: false,
      lastSuccessfulScanAt: new Date("2026-11-07T09:00:04.000Z"),
      persistedScanStartedAt: null,
      now: Date.parse("2026-11-07T10:43:32.000Z"),
    }),
    null,
  );
});

test("watchdog distinguishes another scanner worker from background work", () => {
  const expiry = new Date(Date.now() + 60_000);
  assert.deepEqual(
    resolveWatchdogScanState(
      { kind: "idle" },
      { busy: true, expectedExpiryAt: expiry },
      null,
    ),
    {
      isScanning: true,
      source: "scanner-lease-wait",
      blocker: "другой worker удерживает discovery-scanner lease",
      expectedAction: `ждём lease до ${expiry.toISOString()}`,
    },
  );
});

test("watchdog reports an unreleased discovery lease after a database outage", () => {
  const expiry = new Date(Date.now() + 60_000);
  assert.deepEqual(
    resolveWatchdogScanState(
      { kind: "idle" },
      { busy: false, expectedExpiryAt: null },
      {
        failureReason: "lease_release_failed",
        expectedLeaseExpiryAt: expiry,
      },
    ),
    {
      isScanning: false,
      source: "lease-release-recovery",
      blocker: "discovery lease не подтверждённо освобождён после сбоя БД",
      expectedAction: `повторить discovery после TTL ${expiry.toISOString()}`,
    },
  );
});

test("watchdog identifies an unavailable discovery lease control-plane", () => {
  assert.deepEqual(
    resolveWatchdogScanState(
      { kind: "idle" },
      { busy: false, expectedExpiryAt: null },
      {
        failureReason: "lease_control_plane_unavailable",
        expectedLeaseExpiryAt: null,
      },
    ),
    {
      isScanning: false,
      source: "lease-control-plane-recovery",
      blocker:
        "discovery scanner не может связаться с PostgreSQL control-plane для lease",
      expectedAction:
        "scanner повторяет acquisition с коротким backoff; необязательные DB jobs отложены",
    },
  );
});

test("watchdog keeps reporting control-plane recovery when the status read fails", async () => {
  const result = await readWatchdogDiscoveryLeaseStatus(
    { kind: "idle" },
    null,
    async () => {
      throw new Error("Connection terminated due to connection timeout");
    },
  );
  assert.deepEqual(result, {
    lease: { busy: false, expectedExpiryAt: null },
    controlPlaneUnavailable: true,
  });
});

test("watchdog does not query a known unavailable control-plane again", async () => {
  let statusCalls = 0;
  const result = await readWatchdogDiscoveryLeaseStatus(
    { kind: "idle" },
    {
      failureReason: "lease_control_plane_unavailable",
      expectedLeaseExpiryAt: null,
    },
    async () => {
      statusCalls++;
      return { busy: true, expectedExpiryAt: new Date() };
    },
  );
  assert.equal(statusCalls, 0);
  assert.deepEqual(result, {
    lease: { busy: false, expectedExpiryAt: null },
    controlPlaneUnavailable: false,
  });
});

test("a live discovery lease takes precedence over a historical release failure", () => {
  const expiry = new Date(Date.now() + 60_000);
  assert.deepEqual(
    resolveWatchdogScanState(
      { kind: "idle" },
      { busy: true, expectedExpiryAt: expiry },
      {
        failureReason: "lease_release_failed",
        expectedLeaseExpiryAt: expiry,
      },
    ),
    {
      isScanning: true,
      source: "scanner-lease-wait",
      blocker: "другой worker удерживает discovery-scanner lease",
      expectedAction: `ждём lease до ${expiry.toISOString()}`,
    },
  );
});

test("watchdog reports a stuck settlement fence and its restart action", () => {
  const graceExpiresAt = new Date(Date.now() + 60_000);
  assert.deepEqual(
    resolveWatchdogScanState(
      {
        kind: "settlement_fence",
        pendingSince: new Date(),
        graceExpiresAt,
        restartRequested: false,
      },
      { busy: false, expectedExpiryAt: null },
      null,
    ),
    {
      isScanning: false,
      source: "settlement-fence",
      blocker: "предыдущий discovery-цикл не завершил settlement fence",
      expectedAction:
        "ожидаем завершение fence до grace period; затем worker будет перезапущен",
    },
  );
});
