import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Response memo for CoinGlass GET requests, applied inside the governor so it
 * covers every caller. A response is reused until the interval's next bar
 * boundary (at most 15 min): a closed bar never changes, and only the still
 * forming bar can be stale. A cached series with a larger `limit` answers a
 * request with a smaller `limit` (newest bars). Calls that need the live
 * forming bar run inside runWithoutMemo().
 */
const noMemo = new AsyncLocalStorage<boolean>();
export function runWithoutMemo<T>(fn: () => T): T {
  return noMemo.run(true, fn);
}
export function memoDisabled(): boolean {
  return noMemo.getStore() === true;
}

const MEMO_PATH =
  /\/api\/(?:futures|spot)\/(?:aggregated-taker-buy-sell-volume\/history|aggregated-cvd\/history|open-interest\/aggregated-history|price\/history|coins-markets|netflow-list|supported-(?:exchange-pairs|coins)|pairs-markets|funding-rate\/accumulated-exchange-list|global-long-short-account-ratio\/history)$/;
const MAX_BAR_TTL_MS = 15 * 60_000;
const CLOSED_WINDOW_TTL_MS = 30 * 60_000;
const NO_INTERVAL_TTL_MS = 5 * 60_000;
const MIN_TTL_MS = 5_000;
const MAX_BYTES = 60 * 1024 * 1024;
const UNIT_MS: Record<string, number> = {
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

export interface MemoPolicy {
  baseKey: string;
  limit: number | null;
  ttlMs: number;
}

function intervalMs(raw: string | null): number | null {
  const m = raw ? /^(\d+)([mhdw])$/.exec(raw) : null;
  return m ? Number(m[1]) * UNIT_MS[m[2]!]! : null;
}

export function memoPolicy(url: string, nowMs: number): MemoPolicy | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (!MEMO_PATH.test(u.pathname)) return null;
  const p = u.searchParams;
  const ranged = p.has("start_time") || p.has("end_time");
  const limitRaw = p.get("limit");
  const limit =
    limitRaw != null && Number(limitRaw) > 0 ? Number(limitRaw) : null;
  const rest = [...p.entries()]
    .filter(([k]) => ranged || k !== "limit")
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  const bar = intervalMs(p.get("interval"));
  let ttlMs = NO_INTERVAL_TTL_MS;
  if (bar) {
    const end = Number(p.get("end_time"));
    ttlMs =
      Number.isFinite(end) && end > 0 && end <= nowMs - bar
        ? CLOSED_WINDOW_TTL_MS
        : Math.min(MAX_BAR_TTL_MS, (Math.floor(nowMs / bar) + 1) * bar - nowMs);
  }
  return {
    baseKey: `${u.pathname}?${rest}`,
    limit: ranged ? null : limit,
    ttlMs: Math.max(MIN_TTL_MS, ttlMs),
  };
}

type Snap = {
  status: number;
  statusText: string;
  headers: Array<[string, string]>;
  body: Uint8Array;
};
type Entry = {
  limit: number | null;
  expiresAt: number;
  snapshot: Snap;
};
const entries = new Map<string, Entry>();
let totalBytes = 0;

function evict(): void {
  for (const [k, e] of entries) {
    if (totalBytes <= MAX_BYTES) break;
    entries.delete(k);
    totalBytes -= e.snapshot.body.byteLength;
  }
}

export function memoLookup(
  policy: MemoPolicy,
  nowMs: number,
): { snapshot: Snap; sliced: boolean } | null {
  const e = entries.get(policy.baseKey);
  if (!e) return null;
  if (e.expiresAt <= nowMs) {
    entries.delete(policy.baseKey);
    totalBytes -= e.snapshot.body.byteLength;
    return null;
  }
  if (policy.limit === null) {
    return e.limit === null ? { snapshot: e.snapshot, sliced: false } : null;
  }
  if (e.limit === null || e.limit < policy.limit) return null;
  if (e.limit === policy.limit) return { snapshot: e.snapshot, sliced: false };
  try {
    const parsed = JSON.parse(new TextDecoder().decode(e.snapshot.body)) as {
      data?: unknown;
    };
    if (!Array.isArray(parsed.data)) return null;
    parsed.data = parsed.data.slice(-policy.limit);
    return {
      snapshot: {
        ...e.snapshot,
        body: new TextEncoder().encode(JSON.stringify(parsed)),
      },
      sliced: true,
    };
  } catch {
    return null;
  }
}

/** Stores only successful answers (HTTP 200 and CoinGlass code "0"). */
export function memoStore(
  policy: MemoPolicy,
  snapshot: Snap,
  nowMs: number,
): void {
  if (snapshot.status !== 200) return;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(snapshot.body)) as {
      code?: unknown;
      data?: unknown;
    };
    if (String(parsed.code) !== "0") return;
    // An empty series is "no data yet", not an answer to keep.
    if (Array.isArray(parsed.data) && parsed.data.length === 0) return;
  } catch {
    return;
  }
  const old = entries.get(policy.baseKey);
  if (old) {
    // Keep the wider series when a narrower request finishes later.
    if (
      old.expiresAt > nowMs &&
      old.limit !== null &&
      policy.limit !== null &&
      old.limit > policy.limit
    )
      return;
    totalBytes -= old.snapshot.body.byteLength;
    entries.delete(policy.baseKey);
  }
  entries.set(policy.baseKey, {
    limit: policy.limit,
    expiresAt: nowMs + policy.ttlMs,
    snapshot,
  });
  totalBytes += snapshot.body.byteLength;
  evict();
}

/** Current memo footprint (entries and stored response bytes). */
export function memoStats(): { entries: number; bytes: number } {
  return { entries: entries.size, bytes: totalBytes };
}

export function clearMemoForTests(): void {
  entries.clear();
  totalBytes = 0;
}
