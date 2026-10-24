import assert from "node:assert/strict";
import { test, afterEach } from "node:test";
import {
  coinglassFetch,
  resetCoinglassGovernorForTests,
  setCoinglassGovernorClockForTests,
  extendCoinglassCooldownForTests,
  getCoinglassGovernorSnapshot,
} from "../src/lib/coinglass_governor.js";

const realFetch = globalThis.fetch;
let virtualTime = 0;

function response(status = 200, headers?: Record<string, string>) {
  return new Response("{}", { status, headers });
}

afterEach(() => {
  globalThis.fetch = realFetch;
  resetCoinglassGovernorForTests();
});

test("one governor enforces global concurrency across endpoint callers", async () => {
  virtualTime = 0;
  setCoinglassGovernorClockForTests(
    () => virtualTime,
    async (ms) => {
      virtualTime += ms;
    },
  );
  let active = 0;
  let peak = 0;
  const release: (() => void)[] = [];
  globalThis.fetch = (async () => {
    active++;
    peak = Math.max(peak, active);
    await new Promise<void>((resolve) => release.push(resolve));
    active--;
    return response();
  }) as typeof fetch;

  const jobs = Array.from({ length: 10 }, (_, i) =>
    coinglassFetch(`https://cg.test/endpoint-${i}`, {}, { endpoint: `e${i}` }),
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(peak, 6);
  for (let i = 0; i < 10; i++) {
    release.shift()?.();
    await new Promise((resolve) => setImmediate(resolve));
  }
  await Promise.all(jobs);
  assert.equal(getCoinglassGovernorSnapshot().started, 10);
});

test("critical and high queues overtake normal and low work", async () => {
  virtualTime = 0;
  setCoinglassGovernorClockForTests(
    () => virtualTime,
    async (ms) => {
      virtualTime += ms;
    },
  );
  const started: string[] = [];
  const releases: Array<() => void> = [];
  globalThis.fetch = (async (input) => {
    started.push(String(input));
    if (started.length <= 6)
      await new Promise<void>((resolve) => releases.push(resolve));
    return response();
  }) as typeof fetch;

  const blockers = Array.from({ length: 6 }, (_, i) =>
    coinglassFetch(`https://cg.test/blocker-${i}`, {}),
  );
  await new Promise((resolve) => setImmediate(resolve));
  const low = coinglassFetch("https://cg.test/low", {}, { priority: "low" });
  const critical = coinglassFetch(
    "https://cg.test/critical",
    {},
    { priority: "critical" },
  );
  const high = coinglassFetch("https://cg.test/high", {}, { priority: "high" });
  await new Promise((resolve) => setImmediate(resolve));
  releases.splice(0).forEach((resolve) => resolve());
  await new Promise((resolve) => setImmediate(resolve));
  releases.splice(0).forEach((resolve) => resolve());
  await Promise.all([...blockers, low, critical, high]);
  const queuedOrder = started.slice(6);
  assert.equal(queuedOrder.length, 3);
  assert.ok(
    queuedOrder.indexOf("https://cg.test/critical") <
      queuedOrder.indexOf("https://cg.test/low"),
  );
  assert.ok(
    queuedOrder.indexOf("https://cg.test/high") <
      queuedOrder.indexOf("https://cg.test/low"),
  );
});

test("429 shares Retry-After cooldown without real waiting", async () => {
  virtualTime = 0;
  setCoinglassGovernorClockForTests(
    () => virtualTime,
    async (ms) => {
      virtualTime += ms;
    },
  );
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return calls === 1 ? response(429, { "Retry-After": "5" }) : response();
  }) as typeof fetch;
  await coinglassFetch("https://cg.test/rate-limit", {});
  await coinglassFetch("https://cg.test/after-rate-limit", {});
  const snapshot = getCoinglassGovernorSnapshot();
  assert.equal(calls, 2);
  assert.equal(snapshot.rateLimited429, 1);
  assert.ok((snapshot.cooldownUntil ?? 0) >= 5000);
  assert.ok(virtualTime >= 5000);
});

test("identical in-flight requests are deduplicated", async () => {
  virtualTime = 0;
  setCoinglassGovernorClockForTests(
    () => virtualTime,
    async (ms) => {
      virtualTime += ms;
    },
  );
  let calls = 0;
  let resolve!: (value: Response) => void;
  globalThis.fetch = (async () => {
    calls++;
    return new Promise<Response>((r) => (resolve = r));
  }) as typeof fetch;
  const a = coinglassFetch("https://cg.test/same", {});
  await new Promise((resolve) => setImmediate(resolve));
  const b = coinglassFetch("https://cg.test/same", {});
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  resolve(response());
  await Promise.all([a, b]);
  assert.equal(getCoinglassGovernorSnapshot().inflightReuse, 1);
});

test("deduplicated subscribers receive independently readable response bodies", async () => {
  let resolveFetch!: (value: Response) => void;
  globalThis.fetch = (async () =>
    new Promise<Response>(
      (resolve) => (resolveFetch = resolve),
    )) as typeof fetch;
  const first = coinglassFetch("https://cg.test/body-sharing", {});
  await new Promise((resolve) => setImmediate(resolve));
  const second = coinglassFetch("https://cg.test/body-sharing", {});
  resolveFetch(
    new Response(JSON.stringify({ payload: "read twice" }), {
      headers: { "Content-Type": "application/json", "Retry-After": "7" },
    }),
  );
  const [firstResponse, secondResponse] = await Promise.all([first, second]);
  assert.deepEqual(await firstResponse.json(), { payload: "read twice" });
  assert.deepEqual(await secondResponse.json(), { payload: "read twice" });
});

test("204 responses preserve null body status metadata", async () => {
  globalThis.fetch = (async () =>
    new Response(null, {
      status: 204,
      statusText: "No Content",
      headers: { "X-CoinGlass": "empty" },
    })) as typeof fetch;
  const result = await coinglassFetch("https://cg.test/no-content", {});
  assert.equal(result.status, 204);
  assert.equal(result.statusText, "No Content");
  assert.equal(result.headers.get("X-CoinGlass"), "empty");
  assert.equal(await result.text(), "");
});

test("binary response metadata and bytes round-trip to subscribers", async () => {
  const bytes = new Uint8Array([0, 1, 127, 128, 255]);
  globalThis.fetch = (async () =>
    new Response(bytes, {
      status: 206,
      statusText: "Partial Content",
      headers: {
        "Content-Type": "application/octet-stream",
        "X-CoinGlass": "binary",
      },
    })) as typeof fetch;
  const result = await coinglassFetch("https://cg.test/binary", {});
  assert.equal(result.status, 206);
  assert.equal(result.statusText, "Partial Content");
  assert.equal(result.headers.get("Content-Type"), "application/octet-stream");
  assert.equal(result.headers.get("X-CoinGlass"), "binary");
  assert.deepEqual(new Uint8Array(await result.arrayBuffer()), bytes);
});

test("already-consumed transport rejects subscribers without hanging or unhandled rejection", async () => {
  const consumed = new Response(JSON.stringify({ payload: true }));
  await consumed.text();
  globalThis.fetch = (async () => consumed) as typeof fetch;
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  const request = coinglassFetch("https://cg.test/consumed-body", {});
  await assert.rejects(request, TypeError);
  await new Promise((resolve) => setImmediate(resolve));
  process.off("unhandledRejection", onUnhandled);
  assert.equal(unhandled.length, 0);
});

test("dedup key includes API key, method, body, and response headers", async () => {
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return response();
  }) as typeof fetch;
  await Promise.all([
    coinglassFetch("https://cg.test/key", { headers: { "CG-API-KEY": "a" } }),
    coinglassFetch("https://cg.test/key", { headers: { "CG-API-KEY": "b" } }),
    coinglassFetch("https://cg.test/key", { method: "POST", body: "a" }),
    coinglassFetch("https://cg.test/key", { method: "POST", body: "b" }),
  ]);
  assert.equal(calls, 4);
});

test("API-level 429 JSON enters the shared cooldown without consuming caller body", async () => {
  virtualTime = 0;
  setCoinglassGovernorClockForTests(
    () => virtualTime,
    async (ms) => {
      virtualTime += ms;
    },
  );
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return calls === 1
      ? new Response(
          JSON.stringify({ code: "429", msg: "rate limit exceeded" }),
          {
            headers: { "Content-Type": "application/json", "Retry-After": "3" },
          },
        )
      : response();
  }) as typeof fetch;
  const first = await coinglassFetch("https://cg.test/api-rate", {});
  const firstPayload = (await first.json()) as { code?: string };
  assert.equal(firstPayload.code, "429");
  await coinglassFetch("https://cg.test/after-api-rate", {});
  assert.ok(virtualTime >= 3000);
  assert.equal(getCoinglassGovernorSnapshot().rateLimited429, 1);
});

test("repeated API-level 429 responses escalate shared backoff", async () => {
  virtualTime = 0;
  setCoinglassGovernorClockForTests(
    () => virtualTime,
    async (ms) => {
      virtualTime += ms;
    },
  );
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return new Response(
      JSON.stringify({ code: "429", msg: "quota exceeded" }),
      {
        headers: { "Content-Type": "application/json" },
      },
    );
  }) as typeof fetch;
  await coinglassFetch("https://cg.test/repeated-1", {});
  const firstUntil = getCoinglassGovernorSnapshot().cooldownUntil ?? 0;
  await coinglassFetch("https://cg.test/repeated-2", {});
  const secondUntil = getCoinglassGovernorSnapshot().cooldownUntil ?? 0;
  assert.equal(calls, 2);
  assert.ok(secondUntil > firstUntil);
});

test("one subscriber abort does not cancel a joined subscriber", async () => {
  let resolveFetch!: (r: Response) => void;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    });
  }) as typeof fetch;
  const firstController = new AbortController();
  const first = coinglassFetch("https://cg.test/shared-abort", {
    signal: firstController.signal,
  });
  await new Promise((resolve) => setImmediate(resolve));
  const second = coinglassFetch("https://cg.test/shared-abort", {});
  firstController.abort();
  resolveFetch(response());
  await assert.rejects(first);
  await second;
  assert.equal(calls, 1);
});

test("all subscribers abort while queued removes work and never starts transport", async () => {
  virtualTime = 0;
  setCoinglassGovernorClockForTests(
    () => virtualTime,
    async (ms) => {
      virtualTime += ms;
    },
  );
  const releases: Array<(r: Response) => void> = [];
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return new Promise<Response>((resolve) => releases.push(resolve));
  }) as typeof fetch;
  const blockers = Array.from({ length: 6 }, (_, i) =>
    coinglassFetch(`https://cg.test/block-${i}`, {}),
  );
  await new Promise((resolve) => setImmediate(resolve));
  const aController = new AbortController();
  const bController = new AbortController();
  const a = coinglassFetch("https://cg.test/never-start", {
    signal: aController.signal,
  });
  const b = coinglassFetch("https://cg.test/never-start", {
    signal: bController.signal,
  });
  aController.abort(new DOMException("a", "AbortError"));
  bController.abort(new DOMException("b", "AbortError"));
  await assert.rejects(
    a,
    (e: unknown) => e instanceof DOMException && e.message === "a",
  );
  await assert.rejects(
    b,
    (e: unknown) => e instanceof DOMException && e.message === "b",
  );
  assert.equal(getCoinglassGovernorSnapshot().queued.normal, 0);
  releases.splice(0).forEach((resolve) => resolve(response()));
  await Promise.all(blockers);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 6);
});

test("shared queued cancellation has no unhandled rejection", async () => {
  virtualTime = 0;
  setCoinglassGovernorClockForTests(
    () => virtualTime,
    async (ms) => {
      virtualTime += ms;
    },
  );
  const releaseBlockers: Array<(value: Response) => void> = [];
  globalThis.fetch = (async (url) => {
    if (String(url).includes("unhandled-block")) {
      return new Promise<Response>((resolve) => releaseBlockers.push(resolve));
    }
    return response();
  }) as typeof fetch;
  const blockers = Array.from({ length: 6 }, (_, i) =>
    coinglassFetch(`https://cg.test/unhandled-block-${i}`, {}),
  );
  await new Promise((resolve) => setImmediate(resolve));

  const firstController = new AbortController();
  const secondController = new AbortController();
  const first = coinglassFetch("https://cg.test/unhandled-shared", {
    signal: firstController.signal,
  });
  const second = coinglassFetch("https://cg.test/unhandled-shared", {
    signal: secondController.signal,
  });
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  firstController.abort();
  secondController.abort();
  await Promise.allSettled([first, second]);
  await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  process.off("unhandledRejection", onUnhandled);

  assert.equal(unhandled.length, 0);
  releaseBlockers.splice(0).forEach((resolve) => resolve(response()));
  await Promise.all(blockers);
});

test("timeout and ordinary abort reasons remain classifiable", async () => {
  const timeout = AbortSignal.timeout(1);
  await new Promise((resolve) => setTimeout(resolve, 5));
  globalThis.fetch = (async (_url, init) => {
    const signal = init?.signal;
    await new Promise<void>((_, reject) =>
      signal?.addEventListener("abort", () => reject(signal.reason)),
    );
    return response();
  }) as typeof fetch;
  await assert.rejects(
    coinglassFetch("https://cg.test/timeout-reason", { signal: timeout }),
    (e: unknown) => e instanceof DOMException && e.name === "TimeoutError",
  );
  const controller = new AbortController();
  const ordinary = coinglassFetch("https://cg.test/abort-reason", {
    signal: controller.signal,
  });
  controller.abort(new DOMException("cancelled", "AbortError"));
  await assert.rejects(
    ordinary,
    (e: unknown) => e instanceof DOMException && e.name === "AbortError",
  );
});

test("cooldown extension during an admission sleep is rechecked", async () => {
  virtualTime = 0;
  let firstSleep = true;
  setCoinglassGovernorClockForTests(
    () => virtualTime,
    async (ms) => {
      if (firstSleep) {
        firstSleep = false;
        extendCoinglassCooldownForTests(5000);
      }
      virtualTime += ms;
    },
  );
  const starts: number[] = [];
  globalThis.fetch = (async () => {
    starts.push(virtualTime);
    return response();
  }) as typeof fetch;
  await coinglassFetch("https://cg.test/cooldown-extension", {});
  assert.ok(starts[0] >= 5000);
});

test("aged low priority admits during a sustained critical backlog", async () => {
  virtualTime = 0;
  setCoinglassGovernorClockForTests(
    () => virtualTime,
    async (ms) => {
      virtualTime += ms;
    },
  );
  const starts: string[] = [];
  let lowStartTime = -1;
  let criticalQueuedAtLow = 0;
  let criticalStartedAtLow = 0;
  const blockers: Array<(r: Response) => void> = [];
  globalThis.fetch = (async (url) => {
    const requestUrl = String(url);
    starts.push(requestUrl);
    if (requestUrl === "https://cg.test/aged-low") {
      lowStartTime = virtualTime;
      const snapshot = getCoinglassGovernorSnapshot();
      criticalQueuedAtLow = snapshot.queued.critical;
      criticalStartedAtLow = starts.filter((entry) =>
        entry.includes("/critical/"),
      ).length;
    }
    if (requestUrl.includes("/block/")) {
      return new Promise<Response>((resolve) => blockers.push(resolve));
    }
    if (requestUrl.includes("/critical/")) {
      return new Promise<Response>((resolve) =>
        setImmediate(() => resolve(response())),
      );
    }
    return response();
  }) as typeof fetch;
  const active = Array.from({ length: 6 }, (_, i) =>
    coinglassFetch(`https://cg.test/block/${i}`, {}),
  );
  await new Promise((resolve) => setImmediate(resolve));
  const low = coinglassFetch(
    "https://cg.test/aged-low",
    {},
    { priority: "low" },
  );
  const critical = Array.from({ length: 200 }, (_, i) =>
    coinglassFetch(
      `https://cg.test/critical/${i}`,
      {},
      { priority: "critical" },
    ),
  );
  await new Promise((resolve) => setImmediate(resolve));
  // Hold all six slots until the low waiter has crossed the aging bound.
  virtualTime = 8_000;
  blockers.splice(0).forEach((resolve) => resolve(response()));
  await Promise.all([...active, ...critical]);
  await low;
  const lowIndex = starts.indexOf("https://cg.test/aged-low");
  assert.ok(lowIndex >= 0);
  // The low waiter is deliberately older than the 8s aging override while
  // critical work is still queued. Strict priority would drain all critical
  // work first and fail this assertion.
  assert.ok(lowStartTime >= 8_000);
  assert.ok(lowStartTime <= 16_000);
  assert.ok(criticalStartedAtLow > 0);
  assert.ok(criticalQueuedAtLow > 0);
  assert.ok(
    starts.slice(lowIndex + 1).some((entry) => entry.includes("/critical/")),
  );
});
