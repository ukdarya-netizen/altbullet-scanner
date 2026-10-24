import { recordLoopCoinglass } from "./loop-timing.js";
import { marketCycleLeaseContext } from "./marketCycleContext.js";
import {
  memoDisabled,
  memoLookup,
  memoPolicy,
  memoStore,
} from "./coinglass-memo.js";

export type CoinglassPriority = "critical" | "high" | "normal" | "low";
type Waiter = {
  priority: CoinglassPriority;
  created: number;
  sequence: number;
  resolve: () => void;
  reject: (error: unknown) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
};
type Shared = {
  promise: Promise<ResponseSnapshot>;
  controller: AbortController;
  subscribers: number;
};
type ResponseSnapshot = {
  status: number;
  statusText: string;
  headers: Array<[string, string]>;
  body: Uint8Array;
};

const MAX_IN_FLIGHT = 6;
// Plan STANDARD: 300 req/min per key. One start per 250 ms = 240/min = 80%.
const MIN_START_GAP_MS = 250;
const MAX_COOLDOWN_MS = 60_000;
const AGING_MS = 2_000;
let active = 0;
let schedulerRunning = false;
let lastStartAt = 0;
let cooldownUntil = 0;
let consecutive429 = 0;
let started = 0;
let completed = 0;
let reused = 0;
let rateLimited = 0;
let testNow: (() => number) | undefined;
let testSleep: ((ms: number) => Promise<void>) | undefined;
let enqueueSequence = 0;
const queues: Record<CoinglassPriority, Waiter[]> = {
  critical: [],
  high: [],
  normal: [],
  low: [],
};
const inflight = new Map<string, Shared>();
// Diagnostics: separates time waiting for admission from real HTTP time.
const MAX_WAIT_SAMPLES = 8000;
let queueWaitSamples: number[] = [];
let httpSamples: number[] = [];
let httpLimited = 0;
let windowEndpointCounts = new Map<string, number>();
// Per (endpoint, symbol, interval) starts in the current window: a key started
// more than once is a duplicate (same data requested again inside one cycle).
let windowKeyCounts = new Map<string, number>();
let windowLimitedKeys = new Set<string>();
let windowRetriesAfterLimit = 0;
let windowLimitedByEndpoint = new Map<string, number>();
let windowRetryAfterMaxMs = 0;
let windowCooldownAddedMs = 0;
// Requests answered from the response memo (no HTTP), per endpoint.
let windowMemoHits = new Map<string, number>();
// Calling function of requests to endpoints whose origin is questioned.
let windowCallers = new Map<string, number>();
// Every HTTP request counted by its call chain (up to 4 frames, file:line).
let windowCallSites = new Map<string, number>();
const MAX_CALL_SITE_KEYS = 500;
function callSiteChain(): string {
  const prev = Error.stackTraceLimit;
  Error.stackTraceLimit = 30;
  const frames = (new Error().stack ?? "").split("\n").slice(1);
  Error.stackTraceLimit = prev;
  const out: string[] = [];
  for (const f of frames) {
    if (CALLER_SKIP.test(f)) continue;
    const m = /at (?:async )?(.+?) \((?:.*[\\/])?([^\\/]+:\d+):\d+\)/.exec(f);
    const n = /at (?:.*[\\/])?([^\\/]+:\d+):\d+/.exec(f);
    const label = m ? `${m[1]}@${m[2]}` : n ? n[1]! : null;
    if (label) out.push(label);
    if (out.length >= 4) break;
  }
  return out.length ? out.join(" < ") : "unknown";
}
const CALLER_TRACKED = /whale-index|large-limit-order/;
const CALLER_SKIP =
  /coinglass_governor|cg_latency|whale_index|node:internal|processTicksAndRejections/;
function callerLabel(): string {
  const frames = (new Error().stack ?? "").split("\n").slice(1);
  for (const f of frames) {
    if (CALLER_SKIP.test(f)) continue;
    const m = /at (?:async )?(.+?) \((?:.*[\\/])?([^\\/]+:\d+):\d+\)/.exec(f);
    if (m) return `${m[1]}@${m[2]}`;
    const n = /at (?:.*[\\/])?([^\\/]+:\d+):\d+/.exec(f);
    if (n) return n[1]!;
  }
  return "unknown";
}
const MAX_TRACKED_KEYS = 20_000;
function requestKey(endpoint: string, url: string): string {
  try {
    const p = new URL(url).searchParams;
    return `${endpoint}|${p.get("symbol") ?? "-"}|${p.get("interval") ?? p.get("range") ?? "-"}|${p.get("limit") ?? "-"}`;
  } catch {
    return `${endpoint}|-|-|-`;
  }
}
// Requests started per endpoint per wall-clock minute (peak-per-minute stats).
let windowMinuteCounts = new Map<string, Map<number, number>>();
function pctl(a: number[], p: number): number {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}
/** Returns and resets queue-wait vs HTTP-time stats since the last call. */
export function drainCoinglassGovernorTimings() {
  const duplicates = [...windowKeyCounts.entries()]
    .filter(([, n]) => n > 1)
    .sort((a, b) => b[1] - a[1]);
  const out = {
    n: httpSamples.length,
    queueWaitP50Ms: pctl(queueWaitSamples, 50),
    queueWaitP95Ms: pctl(queueWaitSamples, 95),
    queueWaitMaxMs: pctl(queueWaitSamples, 100),
    httpP50Ms: pctl(httpSamples, 50),
    httpP95Ms: pctl(httpSamples, 95),
    httpMaxMs: pctl(httpSamples, 100),
    rateLimited: httpLimited,
    duplicateRequests: duplicates.reduce((a, [, n]) => a + n - 1, 0),
    retriesAfterLimit: windowRetriesAfterLimit,
    rateLimitedByEndpoint: Object.fromEntries(windowLimitedByEndpoint),
    retryAfterMaxMs: windowRetryAfterMaxMs,
    cooldownAddedMs: windowCooldownAddedMs,
    callersByEndpoint: Object.fromEntries(
      [...windowCallers.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30),
    ),
    callSites: Object.fromEntries(
      [...windowCallSites.entries()].sort((a, b) => b[1] - a[1]).slice(0, 80),
    ),
    memoHits: [...windowMemoHits.values()].reduce((a, n) => a + n, 0),
    memoHitsByEndpoint: Object.fromEntries(
      [...windowMemoHits.entries()].sort((a, b) => b[1] - a[1]),
    ),
    topDuplicates: duplicates.slice(0, 20).map(([key, n]) => ({ key, n })),
    cooldownActive: cooldownUntil > Date.now(),
    byEndpoint: Object.fromEntries(
      [...windowEndpointCounts.entries()].sort((a, b) => b[1] - a[1]),
    ),
    byEndpointPeakPerMin: Object.fromEntries(
      [...windowMinuteCounts.entries()].map(([endpoint, minutes]) => [
        endpoint,
        Math.max(0, ...minutes.values()),
      ]),
    ),
    totalPeakPerMin: Math.max(
      0,
      ...Object.values(
        [...windowMinuteCounts.values()].reduce<Record<number, number>>(
          (acc, minutes) => {
            for (const [minute, n] of minutes)
              acc[minute] = (acc[minute] ?? 0) + n;
            return acc;
          },
          {},
        ),
      ),
    ),
  };
  windowEndpointCounts = new Map();
  windowKeyCounts = new Map();
  windowLimitedKeys = new Set();
  windowRetriesAfterLimit = 0;
  windowLimitedByEndpoint = new Map();
  windowRetryAfterMaxMs = 0;
  windowCooldownAddedMs = 0;
  windowMemoHits = new Map();
  windowCallers = new Map();
  windowCallSites = new Map();
  windowMinuteCounts = new Map();
  queueWaitSamples = [];
  httpSamples = [];
  httpLimited = 0;
  return out;
}
const endpointCounts = new Map<string, number>();

const now = () => testNow?.() ?? Date.now();
const abortError = () =>
  typeof DOMException !== "undefined"
    ? new DOMException("CoinGlass request cancelled", "AbortError")
    : Object.assign(new Error("CoinGlass request cancelled"), {
        name: "AbortError",
      });
function signalReason(signal?: AbortSignal): unknown {
  return signal?.reason ?? abortError();
}
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signalReason(signal));
  const timer = testSleep
    ? testSleep(ms)
    : new Promise<void>((resolve) => setTimeout(resolve, ms));
  return Promise.race([
    timer,
    new Promise<void>((_, reject) =>
      signal?.addEventListener("abort", () => reject(signalReason(signal)), {
        once: true,
      }),
    ),
  ]);
}
function priority(): CoinglassPriority {
  const job = marketCycleLeaseContext.getStore()?.job;
  return job === "scanner" ? "normal" : job ? "low" : "critical";
}
function remove(w: Waiter) {
  const q = queues[w.priority];
  const i = q.indexOf(w);
  if (i >= 0) q.splice(i, 1);
}
function nextWaiter(): Waiter | undefined {
  const t = now();
  const all = (Object.keys(queues) as CoinglassPriority[]).flatMap((p) =>
    queues[p].map((w) => ({ w, p })),
  );
  if (!all.length) return undefined;
  const aged = all.filter(({ w }) => t - w.created >= AGING_MS);
  const candidates = aged.length ? aged : all;
  if (aged.some(({ w }) => t - w.created >= AGING_MS * 4)) {
    const oldest = [...all].sort(
      (a, b) => a.w.created - b.w.created || a.w.sequence - b.w.sequence,
    )[0];
    remove(oldest.w);
    return oldest.w;
  }
  const rank: Record<CoinglassPriority, number> = {
    critical: 4,
    high: 3,
    normal: 2,
    low: 1,
  };
  candidates.sort(
    (a, b) =>
      rank[b.p] - rank[a.p] ||
      a.w.created - b.w.created ||
      a.w.sequence - b.w.sequence,
  );
  remove(candidates[0].w);
  return candidates[0].w;
}
function grant(w: Waiter) {
  if (w.signal?.aborted) {
    w.reject(signalReason(w.signal));
    return;
  }
  w.signal?.removeEventListener("abort", w.onAbort!);
  w.resolve();
}
async function scheduler() {
  if (schedulerRunning) return;
  schedulerRunning = true;
  try {
    while (active < MAX_IN_FLIGHT) {
      const w = nextWaiter();
      if (!w) break;
      try {
        while (true) {
          const wait = Math.max(
            0,
            Math.max(lastStartAt + MIN_START_GAP_MS, cooldownUntil) - now(),
          );
          if (!wait) break;
          await sleep(wait, w.signal);
          if (w.signal?.aborted) throw signalReason(w.signal);
        }
        active++;
        lastStartAt = now();
        grant(w);
      } catch (error) {
        w.reject(error);
      }
    }
  } finally {
    schedulerRunning = false;
    if (active < MAX_IN_FLIGHT && Object.values(queues).some((q) => q.length))
      void scheduler().catch(() => {
        // Each waiter receives admission errors; observe detached drain.
      });
  }
}
function enqueue(p: CoinglassPriority, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signalReason(signal));
  return new Promise((resolve, reject) => {
    const w: Waiter = {
      priority: p,
      created: now(),
      sequence: enqueueSequence++,
      resolve,
      reject,
      signal,
    };
    w.onAbort = () => {
      remove(w);
      reject(signalReason(signal));
    };
    signal?.addEventListener("abort", w.onAbort, { once: true });
    queues[p].push(w);
    void scheduler().catch(() => {
      // Each waiter receives admission errors; observe detached drain.
    });
  });
}
function release() {
  active = Math.max(0, active - 1);
  void scheduler().catch(() => {
    // Each waiter receives admission errors; observe detached drain.
  });
}
function keyFor(url: string, init: RequestInit): string {
  const headers = new Headers(init.headers);
  const normalized = [...headers.entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  );
  let body = "";
  if (typeof init.body === "string") body = init.body;
  else if (init.body instanceof URLSearchParams) body = init.body.toString();
  else if (init.body) body = String(init.body);
  return JSON.stringify([
    init.method?.toUpperCase() ?? "GET",
    url,
    body,
    normalized,
  ]);
}
function retryAfter(res: Response) {
  const v = res.headers.get("retry-after");
  const seconds = Number(v);
  if (v && Number.isFinite(seconds)) return seconds * 1000;
  const date = v ? Date.parse(v) : NaN;
  return Number.isFinite(date) ? Math.max(0, date - now()) : 0;
}
async function snapshotResponse(res: Response): Promise<ResponseSnapshot> {
  return {
    status: res.status,
    statusText: res.statusText,
    headers: [...res.headers.entries()],
    body: new Uint8Array(await res.arrayBuffer()),
  };
}
function responseFromSnapshot(snapshot: ResponseSnapshot): Response {
  const nullBodyStatus =
    snapshot.status === 204 ||
    snapshot.status === 205 ||
    snapshot.status === 304;
  return new Response(nullBodyStatus ? null : new Uint8Array(snapshot.body), {
    status: snapshot.status,
    statusText: snapshot.statusText,
    headers: snapshot.headers,
  });
}
async function noteResponse(res: Response): Promise<boolean> {
  let apiLimited = false;
  try {
    const clone = res.clone();
    const json = (await clone.json()) as {
      code?: unknown;
      msg?: unknown;
      message?: unknown;
    };
    const text = `${json.code ?? ""} ${json.msg ?? ""} ${json.message ?? ""}`;
    apiLimited =
      String(json.code) === "429" ||
      /rate.?limit|too many request|quota/i.test(text);
  } catch {
    /* non-JSON responses are handled by endpoint parsers */
  }
  if (res.status !== 429 && !apiLimited) return false;
  rateLimited++;
  consecutive429++;
  const backoff = Math.min(
    MAX_COOLDOWN_MS,
    1000 * 2 ** Math.min(6, consecutive429 - 1),
  );
  const headerMs = retryAfter(res);
  const before = Math.max(cooldownUntil, now());
  cooldownUntil = Math.max(cooldownUntil, now() + headerMs, now() + backoff);
  windowRetryAfterMaxMs = Math.max(windowRetryAfterMaxMs, headerMs);
  windowCooldownAddedMs += Math.max(0, cooldownUntil - before);
  return true;
}
function subscriber(shared: Shared, signal?: AbortSignal): Promise<Response> {
  shared.subscribers++;
  return new Promise((resolve, reject) => {
    let done = false;
    const leave = () => {
      if (done) return;
      done = true;
      shared.subscribers--;
      if (!shared.subscribers) shared.controller.abort();
      signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      leave();
      reject(signalReason(signal));
    };
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    void shared.promise
      .then(
        (snapshot) => {
          if (!done) {
            try {
              const res = responseFromSnapshot(snapshot);
              leave();
              resolve(res);
            } catch (error) {
              leave();
              reject(error);
            }
          }
        },
        (e) => {
          if (!done) {
            leave();
            reject(e);
          }
        },
      )
      .catch((error) => {
        // Also own failures from the subscriber delivery callback itself.
        if (!done) {
          leave();
          reject(error);
        }
      });
  });
}

export async function coinglassFetch(
  url: string,
  init: RequestInit,
  options: { priority?: CoinglassPriority; endpoint?: string } = {},
): Promise<Response> {
  const startedAt = Date.now();
  try {
    return await coinglassFetchUntimed(url, init, options);
  } finally {
    recordLoopCoinglass(Date.now() - startedAt);
  }
}
async function coinglassFetchUntimed(
  url: string,
  init: RequestInit,
  options: { priority?: CoinglassPriority; endpoint?: string } = {},
): Promise<Response> {
  const signal = init.signal ?? undefined;
  const memo =
    (init.method ?? "GET").toUpperCase() === "GET" && !memoDisabled()
      ? memoPolicy(url, now())
      : null;
  if (memo) {
    const hit = memoLookup(memo, now());
    if (hit) {
      const label = options.endpoint ?? new URL(url).pathname;
      windowMemoHits.set(label, (windowMemoHits.get(label) ?? 0) + 1);
      return responseFromSnapshot(hit.snapshot);
    }
  }
  const caller = CALLER_TRACKED.test(options.endpoint ?? url)
    ? callerLabel()
    : null;
  const callSite = callSiteChain();
  const key = keyFor(url, init);
  const existing = inflight.get(key);
  if (existing) {
    reused++;
    return subscriber(existing, signal);
  }
  const controller = new AbortController();
  const shared: Shared = {
    controller,
    subscribers: 0,
    promise: Promise.resolve({
      status: 200,
      statusText: "",
      headers: [],
      body: new Uint8Array(),
    }),
  };
  shared.promise = (async () => {
    // The queue belongs to the shared request, not one subscriber. A caller
    // aborting must not remove a request still needed by another joiner.
    const enqueuedAt = now();
    await enqueue(options.priority ?? priority(), controller.signal);
    if (queueWaitSamples.length < MAX_WAIT_SAMPLES)
      queueWaitSamples.push(now() - enqueuedAt);
    const httpStart = now();
    const endpoint = options.endpoint ?? new URL(url).pathname;
    endpointCounts.set(endpoint, (endpointCounts.get(endpoint) ?? 0) + 1);
    const reqKey = requestKey(endpoint, url);
    if (
      windowKeyCounts.size < MAX_TRACKED_KEYS ||
      windowKeyCounts.has(reqKey)
    ) {
      windowKeyCounts.set(reqKey, (windowKeyCounts.get(reqKey) ?? 0) + 1);
    }
    if (windowLimitedKeys.has(reqKey)) windowRetriesAfterLimit++;
    {
      const sk = `${endpoint} <- ${callSite}`;
      if (
        windowCallSites.size < MAX_CALL_SITE_KEYS ||
        windowCallSites.has(sk)
      ) {
        windowCallSites.set(sk, (windowCallSites.get(sk) ?? 0) + 1);
      }
    }
    if (caller) {
      const ck = `${endpoint} <- ${caller}`;
      windowCallers.set(ck, (windowCallers.get(ck) ?? 0) + 1);
    }
    windowEndpointCounts.set(
      endpoint,
      (windowEndpointCounts.get(endpoint) ?? 0) + 1,
    );
    const minuteIndex = Math.floor(now() / 60_000);
    const endpointMinutes =
      windowMinuteCounts.get(endpoint) ?? new Map<number, number>();
    endpointMinutes.set(
      minuteIndex,
      (endpointMinutes.get(minuteIndex) ?? 0) + 1,
    );
    windowMinuteCounts.set(endpoint, endpointMinutes);
    started++;
    try {
      const res = await fetch(url, { ...init, signal: controller.signal });
      const snapshot = await snapshotResponse(res);
      if (httpSamples.length < MAX_WAIT_SAMPLES)
        httpSamples.push(now() - httpStart);
      const limited = await noteResponse(responseFromSnapshot(snapshot));
      if (limited) {
        httpLimited++;
        windowLimitedByEndpoint.set(
          endpoint,
          (windowLimitedByEndpoint.get(endpoint) ?? 0) + 1,
        );
        windowLimitedKeys.add(reqKey);
      }
      if (!limited) consecutive429 = 0;
      completed++;
      if (memo) memoStore(memo, snapshot, now());
      return snapshot;
    } finally {
      release();
    }
  })();
  // Subscribers may all abort before this shared transport settles. Keep
  // ownership of the transport rejection independent of subscriber lifetime.
  void shared.promise.catch(() => {
    // Preserve the original rejection for subscribers.
  });
  inflight.set(key, shared);
  try {
    return await subscriber(shared, signal);
  } finally {
    if (shared.subscribers === 0) inflight.delete(key);
  }
}
/** Sizes of every module-level collection (process_health memory diagnostics). */
export function coinglassGovernorCollectionSizes(): {
  entries: number;
} & Record<string, number> {
  let minuteCells = 0;
  for (const m of windowMinuteCounts.values()) minuteCells += m.size;
  const waiting =
    queues.critical.length +
    queues.high.length +
    queues.normal.length +
    queues.low.length;
  return {
    entries:
      inflight.size +
      waiting +
      windowCallSites.size +
      windowKeyCounts.size +
      endpointCounts.size,
    inflight: inflight.size,
    activeRequests: active,
    queuedCritical: queues.critical.length,
    queuedHigh: queues.high.length,
    queuedNormal: queues.normal.length,
    queuedLow: queues.low.length,
    queueWaitSamples: queueWaitSamples.length,
    httpSamples: httpSamples.length,
    windowEndpointCounts: windowEndpointCounts.size,
    windowKeyCounts: windowKeyCounts.size,
    windowLimitedKeys: windowLimitedKeys.size,
    windowLimitedByEndpoint: windowLimitedByEndpoint.size,
    windowMemoHits: windowMemoHits.size,
    windowCallers: windowCallers.size,
    windowCallSites: windowCallSites.size,
    windowMinuteEndpoints: windowMinuteCounts.size,
    windowMinuteCells: minuteCells,
    endpointCounts: endpointCounts.size,
  };
}
export function getCoinglassGovernorSnapshot() {
  return {
    started,
    completed,
    inflightReuse: reused,
    rateLimited429: rateLimited,
    cooldownUntil: cooldownUntil || null,
    inFlight: active,
    queued: {
      critical: queues.critical.length,
      high: queues.high.length,
      normal: queues.normal.length,
      low: queues.low.length,
    },
    endpoints: Object.fromEntries(endpointCounts),
  };
}
export function resetCoinglassGovernorForTests() {
  for (const q of Object.values(queues)) q.splice(0);
  for (const s of inflight.values()) s.controller.abort();
  inflight.clear();
  active = 0;
  schedulerRunning = false;
  lastStartAt = 0;
  cooldownUntil = 0;
  consecutive429 = 0;
  started = completed = reused = rateLimited = 0;
  endpointCounts.clear();
  windowMinuteCounts.clear();
  enqueueSequence = 0;
  testNow = undefined;
  testSleep = undefined;
}
export function setCoinglassGovernorClockForTests(
  nowFn: () => number,
  sleepFn: (ms: number) => Promise<void>,
) {
  testNow = nowFn;
  testSleep = sleepFn;
}
export function extendCoinglassCooldownForTests(until: number) {
  cooldownUntil = Math.max(cooldownUntil, until);
}
