import assert from "node:assert/strict";
import { test } from "node:test";
import {
  getMarketRequestBudgetSnapshot,
  marketFetch,
  runMarketRequest,
} from "../src/lib/marketRequestBudget.js";
import { marketCycleLeaseContext } from "../src/lib/marketCycleContext.js";
import { dbReadWithRetry } from "../src/lib/dbReadWithRetry.js";
import { snapshotCgTelemetry } from "../src/lib/cg_latency.js";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 250,
): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > until) throw new Error("Timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

test("market request budget caps, prioritizes, and cancels queued work", async () => {
  const releases = Array.from({ length: 10 }, () => deferred());
  const starts: string[] = [];

  const active = releases.map((release, i) =>
    runMarketRequest(
      `hold-${i}`,
      async () => {
        starts.push(`hold-${i}`);
        await release.promise;
      },
      { priority: "scan" },
    ),
  );
  await waitFor(() => getMarketRequestBudgetSnapshot().inFlight === 10);

  const queuedScan = runMarketRequest(
    "queued-scan",
    async () => {
      starts.push("scan");
    },
    { priority: "scan" },
  );
  const criticalRelease = deferred();
  const queuedCritical = runMarketRequest(
    "queued-critical",
    async () => {
      starts.push("critical");
      await criticalRelease.promise;
    },
    { priority: "critical" },
  );

  releases[0].resolve();
  await waitFor(() => starts.includes("critical"));
  assert.ok(
    !starts.includes("scan"),
    "open-position work must overtake queued scan enrichment",
  );

  criticalRelease.resolve();
  for (const release of releases.slice(1)) release.resolve();
  await Promise.all([...active, queuedScan, queuedCritical]);
  assert.deepEqual(getMarketRequestBudgetSnapshot(), {
    inFlight: 0,
    limit: 10,
    queuedCritical: 0,
    queuedScan: 0,
    queuedBackground: 0,
  });

  const cancellationReleases = Array.from({ length: 10 }, () => deferred());
  const cancellationActive = cancellationReleases.map((release, i) =>
    runMarketRequest(`hold-${i}`, () => release.promise, { priority: "scan" }),
  );
  await waitFor(() => getMarketRequestBudgetSnapshot().inFlight === 10);

  const controller = new AbortController();
  const cancelled = runMarketRequest(
    "cancelled-before-start",
    async () => {
      throw new Error("cancelled request must never run");
    },
    { priority: "scan", signal: controller.signal },
  );
  controller.abort();

  await assert.rejects(cancelled, /cancelled/i);
  assert.equal(getMarketRequestBudgetSnapshot().queuedScan, 0);

  for (const release of cancellationReleases) release.resolve();
  await Promise.all(cancellationActive);
});

test("marketFetch forwards market-cycle cancellation to transport", async () => {
  const originalFetch = globalThis.fetch;
  const controller = new AbortController();
  let transportSignal: AbortSignal | undefined;
  globalThis.fetch = ((_input: string | URL, init?: RequestInit) => {
    transportSignal = init?.signal ?? undefined;
    return new Promise<Response>((_resolve, reject) => {
      transportSignal?.addEventListener(
        "abort",
        () => reject(new Error("transport aborted")),
        { once: true },
      );
    });
  }) as typeof fetch;

  try {
    const pending = marketCycleLeaseContext.run(
      {
        job: "scanner",
        ownerToken: "test",
        signal: controller.signal,
        throwIfLost: () => undefined,
      },
      () =>
        marketFetch(
          "https://example.test/trending",
          { signal: AbortSignal.timeout(5_000) },
          { label: "test:trending" },
        ),
    );
    await waitFor(() => transportSignal !== undefined);
    controller.abort();
    await assert.rejects(pending, /aborted/);
    assert.equal(transportSignal?.aborted, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("bounded DB reads return promptly and retry only for a transient failure", async () => {
  const startedAt = Date.now();
  const timedOut = await dbReadWithRetry(
    "test bounded read",
    () => new Promise<never>(() => undefined),
    1,
    0,
    20,
  );
  assert.deepEqual(timedOut, { ok: false });
  assert.ok(Date.now() - startedAt < 250);

  let calls = 0;
  const recovered = await dbReadWithRetry(
    "test transient read",
    async () => {
      calls++;
      if (calls === 1) throw new Error("temporary pool timeout");
      return ["recovered"];
    },
    2,
    0,
    100,
  );
  assert.deepEqual(recovered, { ok: true, value: ["recovered"] });
  assert.equal(calls, 2);

  // A timed-out prescan read must not prevent the next cycle's read from
  // running. This is deliberately a separate invocation, matching the
  // scanner's next scheduled cycle rather than a retry inside the same read.
  const nextCycle = await dbReadWithRetry(
    "test next-cycle prescan read",
    async () => ({ cycle: 2, rows: ["preserved"] }),
    1,
    0,
    100,
  );
  assert.deepEqual(nextCycle, {
    ok: true,
    value: { cycle: 2, rows: ["preserved"] },
  });
});

test("CoinGlass breaker, whitelist, and cancellation prevent OI request storms", async () => {
  process.env.COINGLASS_API_KEY = "test-coinglass-key";
  const originalFetch = globalThis.fetch;
  const originalRandom = Math.random;
  Math.random = () => 0;
  // Start a clean telemetry window so the assertions describe only this
  // fault-injection run and remain independent of other tests.
  snapshotCgTelemetry();

  try {
    const {
      batchGetCoinglassOI,
      resetCoinglassOiStateForTests,
      setCgSupportedCoinsForTests,
    } = await import("../src/lib/coinglass_oi.js");

    let outageRequests = 0;
    globalThis.fetch = (async () => {
      outageRequests++;
      return new Response(JSON.stringify({ code: "500", data: [] }), {
        status: 503,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    resetCoinglassOiStateForTests();
    const outageSymbols = Array.from(
      { length: 24 },
      (_, index) => `OUTAGE${index}-USDT`,
    );
    const outageResult = await batchGetCoinglassOI(outageSymbols);
    assert.equal(outageResult.size, outageSymbols.length);
    assert.ok(
      outageRequests < 12,
      `circuit breaker should prevent most calls, received ${outageRequests}`,
    );

    let unsupportedRequests = 0;
    globalThis.fetch = (async () => {
      unsupportedRequests++;
      throw new Error("unsupported symbol must not reach CoinGlass");
    }) as typeof fetch;
    resetCoinglassOiStateForTests();
    setCgSupportedCoinsForTests(["BTC"]);
    const unsupported = await batchGetCoinglassOI(["NOTLISTED-USDT"]);
    assert.equal(unsupported.get("NOTLISTED-USDT")?.available, false);
    assert.equal(unsupportedRequests, 0);

    let activeRequests = 0;
    let abortedRequests = 0;
    globalThis.fetch = ((_: string | URL, init?: RequestInit) => {
      activeRequests++;
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => {
            abortedRequests++;
            reject(new DOMException("aborted", "AbortError"));
          },
          { once: true },
        );
      });
    }) as typeof fetch;
    resetCoinglassOiStateForTests();
    // Keep one genuine upstream failure in the breaker, then prove that the
    // five transports cancelled by Phase 0 do not add to that count.
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ code: "500", data: [] }), {
        status: 503,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;
    await batchGetCoinglassOI(["PRIOR-FAILURE-USDT"]);

    globalThis.fetch = ((_: string | URL, init?: RequestInit) => {
      activeRequests++;
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => {
            abortedRequests++;
            reject(new DOMException("aborted", "AbortError"));
          },
          { once: true },
        );
      });
    }) as typeof fetch;
    const controller = new AbortController();
    const slowSymbols = Array.from(
      { length: 24 },
      (_, index) => `SLOW${index}-USDT`,
    );
    const pending = batchGetCoinglassOI(
      slowSymbols,
      undefined,
      undefined,
      controller.signal,
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();
    const cancelled = await Promise.race([
      pending,
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error("OI batch did not drain after abort")),
          500,
        ),
      ),
    ]);
    assert.equal(cancelled.size, slowSymbols.length);
    assert.ok(abortedRequests > 0);
    assert.ok(
      activeRequests <= 5,
      `queued symbols must not open new requests after abort (received ${activeRequests})`,
    );

    let postAbortRequests = 0;
    globalThis.fetch = (async () => {
      postAbortRequests++;
      return new Response(
        JSON.stringify({
          code: "0",
          data: Array.from({ length: 50 }, (_, index) => ({
            time: 1_700_000_000 + index * 1_800,
            close: String(100 + index),
          })),
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    }) as typeof fetch;
    const postAbort = await batchGetCoinglassOI(["RECOVERED-USDT"]);
    assert.ok(
      postAbortRequests > 0,
      "local cancellation must not open the breaker for the next batch",
    );
    assert.equal(postAbort.get("RECOVERED-USDT")?.available, true);

    const telemetry = snapshotCgTelemetry();
    assert.ok(telemetry.cgReq > 0);
    assert.ok(
      telemetry.cgErrors > 0,
      "HTTP 5xx fault injection must be visible as CoinGlass errors",
    );
    assert.ok(
      telemetry.cgTimeouts > 0,
      "local cancellation of timed-out transports must be visible as timeouts",
    );
    assert.ok(
      telemetry.cgTimeoutPct > 0,
      "phase timing telemetry must expose degraded CoinGlass availability",
    );
  } finally {
    globalThis.fetch = originalFetch;
    Math.random = originalRandom;
  }
});
