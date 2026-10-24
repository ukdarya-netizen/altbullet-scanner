import { access, appendFile, writeFile } from "node:fs/promises";

const role = process.env.SCANNER_OVERLAP_ROLE;
const readyFile = process.env.SCANNER_OVERLAP_READY_FILE;
const cancelFile = process.env.SCANNER_OVERLAP_CANCEL_FILE;
const transportFile = process.env.SCANNER_OVERLAP_TRANSPORT_FILE;
const resultFile = process.env.SCANNER_OVERLAP_RESULT_FILE;

if (
  (role !== "scanner" && role !== "background") ||
  !readyFile ||
  !cancelFile ||
  !transportFile ||
  !resultFile
) {
  throw new Error("scanner overlap worker environment is incomplete");
}

const transportPath = transportFile!;
const resultPath = resultFile!;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForFile(path: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await access(path);
      return;
    } catch {
      await sleep(20);
    }
  }
  throw new Error(`Timed out waiting for ${path}`);
}

async function appendEvent(event: Record<string, unknown>): Promise<void> {
  await appendFile(transportPath, `${JSON.stringify(event)}\n`, "utf8");
}

async function writeResult(result: Record<string, unknown>): Promise<void> {
  await writeFile(resultPath, `${JSON.stringify(result)}\n`, "utf8");
}

if (role === "scanner") {
  const [
    { pool },
    { marketFetch, getMarketRequestBudgetSnapshot },
    { runOutsideMarketCycleLease, withMarketCycleLease },
  ] = await Promise.all([
    import("@workspace/db"),
    import("../src/lib/marketRequestBudget.js"),
    import("../src/lib/schedulerLease.js"),
  ]);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const label = String(input);
    await appendEvent({ role, event: "start", label });
    if (label === "mock://fast-cycle/priority") {
      return new Response("critical", { status: 200 });
    }
    return new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      const onAbort = () => {
        signal?.removeEventListener("abort", onAbort);
        void appendEvent({ role, event: "abort", label }).finally(() =>
          reject(
            signal?.reason instanceof Error
              ? signal.reason
              : new Error("mock transport aborted"),
          ),
        );
      };
      if (signal?.aborted) {
        onAbort();
      } else {
        signal?.addEventListener("abort", onAbort, { once: true });
      }
    });
  };

  const callerController = new AbortController();
  let requestResults: PromiseSettledResult<Response>[] = [];

  try {
    const outcome = await withMarketCycleLease(
      "scanner",
      async () => {
        const activeRequests = Array.from({ length: 10 }, (_, index) =>
          marketFetch(
            `mock://scanner/active-${index}`,
            {},
            { label: `scanner-active-${index}` },
          ),
        );

        const deadline = Date.now() + 5_000;
        while (
          getMarketRequestBudgetSnapshot().inFlight < 10 &&
          Date.now() < deadline
        ) {
          await sleep(5);
        }
        if (getMarketRequestBudgetSnapshot().inFlight !== 10) {
          throw new Error("scanner transport budget did not fill");
        }

        const queuedRequest = marketFetch(
          "mock://scanner/queued",
          {},
          { label: "scanner-queued" },
        );
        const criticalRequest = runOutsideMarketCycleLease(() =>
          marketFetch(
            "mock://fast-cycle/priority",
            {},
            { label: "fast-cycle-priority", priority: "critical" },
          ),
        );
        const queueDeadline = Date.now() + 5_000;
        while (
          (getMarketRequestBudgetSnapshot().queuedScan < 1 ||
            getMarketRequestBudgetSnapshot().queuedCritical < 1) &&
          Date.now() < queueDeadline
        ) {
          await sleep(5);
        }
        const queueSnapshot = getMarketRequestBudgetSnapshot();
        if (
          queueSnapshot.queuedScan !== 1 ||
          queueSnapshot.queuedCritical !== 1
        ) {
          throw new Error(
            "scanner and FastCycle transport requests did not queue",
          );
        }

        const allRequestResults = Promise.allSettled([
          ...activeRequests,
          queuedRequest,
          criticalRequest,
        ]);
        await writeFile(readyFile, "scanner-owned\n", "utf8");
        await waitForFile(cancelFile);
        callerController.abort(new Error("scanner overlap test cancellation"));
        requestResults = await allRequestResults;
        return {
          requestResults: requestResults.map((result) => result.status),
          budget: getMarketRequestBudgetSnapshot(),
        };
      },
      { signal: callerController.signal, ttlMs: 5_000, heartbeatMs: 500 },
    );

    await writeResult({
      role,
      outcome: outcome.acquired ? "completed" : "not-acquired",
      requestResults: requestResults.map((result) => result.status),
    });
  } catch (error) {
    await writeResult({
      role,
      error: error instanceof Error ? error.name : String(error),
      requestResults: requestResults.map((result) => result.status),
      aborted: callerController.signal.aborted,
    });
  } finally {
    globalThis.fetch = originalFetch;
    await pool.end();
  }
} else {
  const [
    { pool },
    { runOutsideMarketCycleLease },
    { marketFetch },
    { getOptionalMarketJobDeferral },
  ] = await Promise.all([
    import("@workspace/db"),
    import("../src/lib/schedulerLease.js"),
    import("../src/lib/marketRequestBudget.js"),
    import("../src/lib/schedulerBackgroundPolicy.js"),
  ]);

  const started: string[] = [];
  globalThis.fetch = async (input) => {
    const label = String(input);
    started.push(label);
    await appendEvent({ role, event: "start", label });
    return new Response("ok", { status: 200 });
  };

  const deferredJobs = ["oi-watch", "liq-cascade", "analytics-backfill"];
  const rescheduled: Array<{ job: string; reason: string }> = [];

  try {
    await waitForFile(readyFile);
    for (const job of deferredJobs) {
      const deferral = await getOptionalMarketJobDeferral(false);
      if (deferral) {
        rescheduled.push({
          job,
          reason: deferral,
        });
        continue;
      }
      await marketFetch(
        `mock://background/${job}`,
        {},
        { label: job, priority: "background" },
      );
    }

    await runOutsideMarketCycleLease(() =>
      marketFetch(
        "mock://fast-cycle/critical",
        {},
        { label: "fast-cycle", priority: "critical" },
      ),
    );
    await writeFile(readyFile + ".background", "critical-complete\n", "utf8");
    await writeResult({
      role,
      leaseBusyDuringOverlap: rescheduled.length === deferredJobs.length,
      deferredJobs,
      rescheduled,
      started,
    });
  } catch (error) {
    await writeResult({
      role,
      error: error instanceof Error ? error.name : String(error),
      deferredJobs,
      rescheduled,
      started,
    });
  } finally {
    await pool.end();
  }
}
