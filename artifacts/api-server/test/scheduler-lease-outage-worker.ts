import { access, appendFile } from "node:fs/promises";

const workerId = process.env.OUTAGE_DRILL_WORKER_ID;
const eventKey = process.env.OUTAGE_DRILL_EVENT_KEY;
const readyFile = process.env.OUTAGE_DRILL_READY_FILE;
const continueFile = process.env.OUTAGE_DRILL_CONTINUE_FILE;
const deliveryFile = process.env.OUTAGE_DRILL_DELIVERY_FILE;
const resultFile = process.env.OUTAGE_DRILL_RESULT_FILE;
const ttlMs = Number(process.env.OUTAGE_DRILL_TTL_MS ?? 500);
const heartbeatMs = Number(process.env.OUTAGE_DRILL_HEARTBEAT_MS ?? 100);
const leaseName = process.env.OUTAGE_DRILL_LEASE_NAME;
const releaseTimeoutMs = Number(
  process.env.OUTAGE_DRILL_RELEASE_TIMEOUT_MS ?? 5_000,
);
const beforeReleaseFile = process.env.OUTAGE_DRILL_BEFORE_RELEASE_FILE;
const releaseContinueFile = process.env.OUTAGE_DRILL_RELEASE_CONTINUE_FILE;

if (
  !workerId ||
  !eventKey ||
  !readyFile ||
  !continueFile ||
  !deliveryFile ||
  !resultFile
) {
  throw new Error("outage drill worker environment is incomplete");
}

async function waitForContinueFile(path: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      await access(path);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  throw new Error("outage drill worker continuation timed out");
}

globalThis.fetch = async (_input, init) => {
  await appendFile(
    deliveryFile,
    `${JSON.stringify({ workerId, bodyType: typeof init?.body })}\n`,
    "utf8",
  );
  return new Response(JSON.stringify({ ok: true, result: true }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
};

const [
  { pool },
  { runOutsideMarketCycleLease, withMarketCycleLease, withSchedulerLease },
  { drainTelegramPhotoOutbox, enqueueTelegramPhotoBroadcast },
] = await Promise.all([
  import("@workspace/db"),
  import("../src/lib/schedulerLease.js"),
  import("../src/lib/telegram-photo-outbox.js"),
]);

const writeResult = async (result: Record<string, unknown>) => {
  await appendFile(resultFile, `${JSON.stringify(result)}\n`, "utf8");
};

try {
  const runWithLease = leaseName
    ? <T>(
        job: string,
        work: Parameters<typeof withMarketCycleLease<T>>[1],
        options: Parameters<typeof withMarketCycleLease<T>>[2],
      ) => withSchedulerLease(leaseName, job, work, options)
    : withMarketCycleLease;
  const outcome = await runWithLease(
    "outage-drill",
    async (lease) => {
      // This is the durable signal write. The unique event key represents the
      // business event, so a replacement worker can safely replay this step.
      await pool.query(
        `INSERT INTO outage_business_events (event_key, first_worker_id)
         VALUES ($1, $2)
         ON CONFLICT (event_key) DO NOTHING`,
        [eventKey, workerId],
      );
      await pool.query(
        `INSERT INTO outage_signal_write_attempts (event_key, worker_id, stage)
         VALUES ($1, $2, 'first')`,
        [eventKey, workerId],
      );
      await appendFile(readyFile, `${workerId}:first-signal-written\n`, "utf8");

      // The parent test releases each worker explicitly. The original is held
      // through the real database restart until the replacement has completed,
      // so its lease-loss guard—not process termination—must stop stale work.
      await waitForContinueFile(continueFile);

      // This is deliberately after the outage window. A stale worker must
      // fail here before it can create another signal-side effect.
      lease.throwIfLost("second signal write");
      await pool.query(
        `INSERT INTO outage_signal_write_attempts (event_key, worker_id, stage)
         VALUES ($1, $2, 'second')`,
        [eventKey, workerId],
      );

      await enqueueTelegramPhotoBroadcast({
        photoPath: new URL("../assets/active_trades.png", import.meta.url)
          .pathname,
        text: `OUTAGE DRILL ${eventKey}`,
        targets: ["outage-test-target"],
        eventKey,
      });
      const delivered = await runOutsideMarketCycleLease(() =>
        drainTelegramPhotoOutbox(eventKey),
      );
      if (beforeReleaseFile) {
        await appendFile(
          beforeReleaseFile,
          `${workerId}:ready-to-release\n`,
          "utf8",
        );
      }
      if (releaseContinueFile) {
        await waitForContinueFile(releaseContinueFile);
      }
      await writeResult({ workerId, acquired: true, delivered });
      return { delivered };
    },
    { ttlMs, heartbeatMs, releaseTimeoutMs },
  );

  if (!outcome.acquired) {
    await writeResult({ workerId, acquired: false });
  }
} catch (error) {
  await writeResult({
    workerId,
    error: error instanceof Error ? error.name : String(error),
  });
} finally {
  await pool.end();
}
