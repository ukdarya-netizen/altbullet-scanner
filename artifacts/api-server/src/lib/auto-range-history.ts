export interface AutoRangeHistoryCandle {
  time: number;
}

export type AutoRangeHistoryAttemptStatus =
  | "succeeded"
  | "short_history"
  | "cancelled"
  | "failed";

export interface AutoRangeHistoryAttempt {
  key: string;
  status: AutoRangeHistoryAttemptStatus;
  rows?: number;
  closedCandles?: number;
  error?: unknown;
}

export interface AutoRangeHistoryBatchStats {
  attempted: number;
  succeeded: number;
  shortHistory: number;
  cancelled: number;
  failed: number;
  deferred: number;
  selected: number;
  queuedRemaining: number;
  attempts: AutoRangeHistoryAttempt[];
}

/**
 * Optional compact storage: candles are kept as one Float64Array
 * (stride numbers per candle, time first) instead of one object each.
 */
export interface AutoRangeCandleCodec<T extends AutoRangeHistoryCandle> {
  stride: number;
  write(candle: T, out: Float64Array, offset: number): void;
  read(data: Float64Array, offset: number): T;
  /** Same result as countClosedCandles(read(all rows)), without building objects. */
  countClosed(data: Float64Array): number;
}

interface AutoRangeHistoryCacheEntry<T extends AutoRangeHistoryCandle> {
  /** Object storage (no codec). */
  candles: T[] | null;
  /** Compact storage (codec). */
  packed: Float64Array | null;
  count: number;
  closedCount: number;
  lastSuccessfulFetchAt: number;
}

interface AutoRangeHistoryQueueEntry {
  priority: number;
  retryAfter: number;
}

export interface AutoRangeHistoryQueueOptions<
  T extends AutoRangeHistoryCandle,
> {
  countClosedCandles(candles: readonly T[]): number;
  codec?: AutoRangeCandleCodec<T>;
  requiredClosedCandles?: number;
  fetchLimit?: number;
  cacheLimit?: number;
  /** Max candles kept per symbol (defaults to cacheLimit, the old behaviour). */
  candleLimit?: number;
  queueLimit?: number;
  maxItemsPerCycle?: number;
  concurrency?: number;
  transientRetryMs?: number;
  successfulShortHistoryRetryMs?: number;
  /** Called after each completed full-history fetch (for durable persistence). */
  onFetched?(
    key: string,
    candles: readonly T[],
    lastSuccessfulFetchAt: number,
  ): void;
}

export const AUTO_RANGE_HISTORY_LIMIT = 901;
/** 1H replay needs N=2000 bars plus up to a week of weekly-anchor slack. */
/**
 * 1H replay window (bars). Rollback without a code deploy: set the environment
 * variable AUTO_RANGE_1H_REPLAY_WINDOW=600 (the former value) and restart.
 */
export const AUTO_RANGE_1H_REPLAY_WINDOW_DEFAULT = 2_000;
export function resolveAutoRange1hReplayWindow(
  env: Record<string, string | undefined> = process.env,
): number {
  const n = Number(env.AUTO_RANGE_1H_REPLAY_WINDOW);
  return Number.isInteger(n) && n >= 300 && n <= 3_000
    ? n
    : AUTO_RANGE_1H_REPLAY_WINDOW_DEFAULT;
}
/** Bars to fetch: window + up to 7 days of weekly-anchor slack (never below the old 901). */
export const autoRangeHistoryFetchLimit = (window: number): number =>
  Math.max(AUTO_RANGE_HISTORY_LIMIT, window + 200);
/**
 * Bars the detector can read: anchoredAutoRangeWindow (auto-range-pine.ts:22-34)
 * returns window..window+168 bars (weekly grid, 7*24 1H bars), plus the forming
 * bar that normalizeClosedBreakoutCandles drops (breakout-analysis.ts:418).
 */
export const AUTO_RANGE_1H_ANCHOR_SLACK_BARS = 7 * 24;
export const autoRangeHistoryCandleLimit = (window: number): number =>
  window + AUTO_RANGE_1H_ANCHOR_SLACK_BARS + 2;
export const AUTO_RANGE_HISTORY_MIN_CLOSED_CANDLES = 100;
export const AUTO_RANGE_HISTORY_CACHE_LIMIT = 1_500;
export const AUTO_RANGE_HISTORY_TRANSIENT_RETRY_MS = 60_000;
export const AUTO_RANGE_HISTORY_SUCCESSFUL_SHORT_RETRY_MS = 6 * 60 * 60 * 1_000;
export const AUTO_RANGE_HISTORY_CONCURRENCY = 8;
export const AUTO_RANGE_HISTORY_FETCHES_PER_CYCLE = 48;
export const AUTO_RANGE_HISTORY_OLDEST_RESERVATION = 4;
export const AUTO_RANGE_HISTORY_WARMUP_BUDGET_MS = 60_000;

/**
 * Owns Auto Range cache/backoff/queue semantics without importing scanner,
 * database, logger, or network clients.
 */
export class AutoRangeHistoryQueue<T extends AutoRangeHistoryCandle> {
  private readonly cache = new Map<string, AutoRangeHistoryCacheEntry<T>>();
  private readonly queue = new Map<string, AutoRangeHistoryQueueEntry>();
  private readonly running = new Set<string>();

  private readonly requiredClosedCandles: number;
  private readonly fetchLimit: number;
  private readonly cacheLimit: number;
  private readonly candleLimit: number;
  private readonly queueLimit: number;
  private readonly maxItemsPerCycle: number;
  private readonly oldestReservation: number;
  private readonly concurrency: number;
  private readonly transientRetryMs: number;
  private readonly successfulShortHistoryRetryMs: number;

  constructor(private readonly options: AutoRangeHistoryQueueOptions<T>) {
    this.requiredClosedCandles =
      options.requiredClosedCandles ?? AUTO_RANGE_HISTORY_MIN_CLOSED_CANDLES;
    this.fetchLimit = options.fetchLimit ?? AUTO_RANGE_HISTORY_LIMIT;
    this.cacheLimit = options.cacheLimit ?? AUTO_RANGE_HISTORY_CACHE_LIMIT;
    this.candleLimit = options.candleLimit ?? this.cacheLimit;
    this.queueLimit = options.queueLimit ?? AUTO_RANGE_HISTORY_CACHE_LIMIT;
    this.maxItemsPerCycle =
      options.maxItemsPerCycle ?? AUTO_RANGE_HISTORY_FETCHES_PER_CYCLE;
    this.oldestReservation = AUTO_RANGE_HISTORY_OLDEST_RESERVATION;
    this.concurrency = options.concurrency ?? AUTO_RANGE_HISTORY_CONCURRENCY;
    this.transientRetryMs =
      options.transientRetryMs ?? AUTO_RANGE_HISTORY_TRANSIENT_RETRY_MS;
    this.successfulShortHistoryRetryMs =
      options.successfulShortHistoryRetryMs ??
      AUTO_RANGE_HISTORY_SUCCESSFUL_SHORT_RETRY_MS;
  }

  get queueSize(): number {
    return this.queue.size;
  }

  get cacheSize(): number {
    return this.cache.size;
  }

  getQueuedEntries(): Array<{
    key: string;
    priority: number;
    retryAfter: number;
  }> {
    return [...this.queue.entries()].map(([key, entry]) => ({
      key,
      priority: entry.priority,
      retryAfter: entry.retryAfter,
    }));
  }

  /** Restores a persisted entry at startup; never overwrites a fresher one. */
  hydrate(key: string, candles: readonly T[], lastSuccessfulFetchAt: number) {
    const existing = this.cache.get(key);
    if (existing && existing.lastSuccessfulFetchAt >= lastSuccessfulFetchAt) {
      return;
    }
    this.merge(key, candles);
    const merged = this.cache.get(key);
    this.setCache(
      key,
      merged
        ? { ...merged, lastSuccessfulFetchAt }
        : this.makeEntry([...candles], lastSuccessfulFetchAt),
    );
    if (this.hasRequiredHistory(key)) this.queue.delete(key);
  }

  /** Keys whose full history is ready (candidates for persistence). */
  readyKeys(): string[] {
    return [...this.cache.keys()].filter((key) => this.hasRequiredHistory(key));
  }

  getLastFetchAt(key: string): number {
    return this.cache.get(key)?.lastSuccessfulFetchAt ?? 0;
  }

  getCandles(key: string): readonly T[] {
    const entry = this.cache.get(key);
    return entry ? this.entryCandles(entry) : [];
  }

  /** Compact rows (codec mode only); null when absent or no codec. */
  getPackedRows(key: string): Float64Array | null {
    return this.cache.get(key)?.packed ?? null;
  }

  private entryCandles(entry: AutoRangeHistoryCacheEntry<T>): readonly T[] {
    if (entry.candles) return entry.candles;
    const codec = this.options.codec;
    if (!entry.packed || !codec) return [];
    const out: T[] = new Array(entry.count);
    for (let i = 0; i < entry.count; i++) {
      out[i] = codec.read(entry.packed, i * codec.stride);
    }
    return out;
  }

  private makeEntry(
    candles: T[],
    lastSuccessfulFetchAt: number,
  ): AutoRangeHistoryCacheEntry<T> {
    const codec = this.options.codec;
    if (!codec) {
      return {
        candles,
        packed: null,
        count: candles.length,
        closedCount: 0,
        lastSuccessfulFetchAt,
      };
    }
    const packed = new Float64Array(candles.length * codec.stride);
    candles.forEach((c, i) => codec.write(c, packed, i * codec.stride));
    return {
      candles: null,
      packed,
      count: candles.length,
      closedCount: codec.countClosed(packed),
      lastSuccessfulFetchAt,
    };
  }

  /** Why a key does not (yet) have the required history; for diagnostics. */
  describeHistoryState(key: string, now = Date.now()): string {
    if (this.hasRequiredHistory(key)) return "ready";
    const entry = this.cache.get(key);
    const queued = this.queue.get(key);
    if (queued) {
      if (this.running.has(key)) return "fetching_now";
      if (queued.retryAfter > now) return "queued_retry_after_failure";
      return entry && entry.lastSuccessfulFetchAt > 0
        ? "queued_after_short_history"
        : "queued_never_fetched";
    }
    if (entry && entry.lastSuccessfulFetchAt > 0) {
      return "fetched_short_history";
    }
    return entry && entry.count > 0
      ? "partial_prefetch_not_queued"
      : "not_requested";
  }

  getLastSuccessfulFetchAt(key: string): number {
    return this.cache.get(key)?.lastSuccessfulFetchAt ?? 0;
  }

  enqueue(key: string, priority: number, now = Date.now()): boolean {
    const queued = this.queue.get(key);
    if (queued) {
      queued.priority = Math.max(queued.priority, priority);
      return true;
    }
    if (this.hasRequiredHistory(key)) return false;
    const lastSuccessfulFetchAt =
      this.cache.get(key)?.lastSuccessfulFetchAt ?? 0;
    if (
      lastSuccessfulFetchAt > 0 &&
      now < lastSuccessfulFetchAt + this.successfulShortHistoryRetryMs
    ) {
      return false;
    }
    if (this.queue.size >= this.queueLimit) return false;
    this.queue.set(key, { priority, retryAfter: 0 });
    return true;
  }

  merge(key: string, incoming: readonly T[]): void {
    const existing = this.cache.get(key);
    const codec = this.options.codec;
    if (codec) {
      this.mergePacked(key, existing, incoming, codec);
    } else {
      const candlesByTime = new Map<number, T>();
      for (const candle of existing?.candles ?? []) {
        candlesByTime.set(candle.time, candle);
      }
      for (const candle of incoming) {
        if (Number.isFinite(candle.time)) {
          candlesByTime.set(candle.time, candle);
        }
      }
      const candles = [...candlesByTime.values()]
        .sort((left, right) => left.time - right.time)
        .slice(-this.candleLimit);
      this.setCache(
        key,
        this.makeEntry(candles, existing?.lastSuccessfulFetchAt ?? 0),
      );
    }
    if (!this.running.has(key) && this.hasRequiredHistory(key)) {
      this.queue.delete(key);
    }
  }

  /** Numeric merge: no per-candle objects are created for stored rows. */
  private mergePacked(
    key: string,
    existing: AutoRangeHistoryCacheEntry<T> | undefined,
    incoming: readonly T[],
    codec: AutoRangeCandleCodec<T>,
  ): void {
    const stride = codec.stride;
    // time -> [source (0 = stored, 1 = incoming), index]
    const byTime = new Map<number, [number, number]>();
    if (existing?.packed) {
      for (let i = 0; i < existing.count; i++) {
        byTime.set(existing.packed[i * stride]!, [0, i]);
      }
    }
    for (let j = 0; j < incoming.length; j++) {
      const t = incoming[j]!.time;
      if (Number.isFinite(t)) byTime.set(t, [1, j]);
    }
    const times = [...byTime.keys()]
      .sort((a, b) => a - b)
      .slice(-this.candleLimit);
    const packed = new Float64Array(times.length * stride);
    times.forEach((t, k) => {
      const [src, idx] = byTime.get(t)!;
      if (src === 0) {
        packed.set(
          existing!.packed!.subarray(idx * stride, (idx + 1) * stride),
          k * stride,
        );
      } else codec.write(incoming[idx]!, packed, k * stride);
    });
    this.setCache(key, {
      candles: null,
      packed,
      count: times.length,
      closedCount: codec.countClosed(packed),
      lastSuccessfulFetchAt: existing?.lastSuccessfulFetchAt ?? 0,
    });
  }

  async fetchBatch(options: {
    signal: AbortSignal;
    fetchHistory(key: string, limit: number, signal: AbortSignal): Promise<T[]>;
    now?: () => number;
  }): Promise<AutoRangeHistoryBatchStats> {
    const now = options.now ?? Date.now;
    const eligible = [...this.queue.entries()].filter(
      ([key, entry]) =>
        !this.running.has(key) &&
        entry.retryAfter <= now() &&
        !this.hasRequiredHistory(key),
    );
    const reservedOldest = eligible.slice(
      0,
      Math.min(this.oldestReservation, this.maxItemsPerCycle),
    );
    const priorityRemainder = eligible
      .slice(reservedOldest.length)
      .sort((left, right) => right[1].priority - left[1].priority)
      .slice(0, Math.max(0, this.maxItemsPerCycle - reservedOldest.length));
    const selected = [...reservedOldest, ...priorityRemainder].map(
      ([key]) => key,
    );
    const stats: AutoRangeHistoryBatchStats = {
      attempted: 0,
      succeeded: 0,
      shortHistory: 0,
      cancelled: 0,
      failed: 0,
      deferred: 0,
      selected: selected.length,
      queuedRemaining: this.queue.size,
      attempts: [],
    };
    const attemptedKeys = new Set<string>();
    let cursor = 0;

    const worker = async () => {
      while (!options.signal.aborted) {
        const key = selected[cursor++];
        if (!key) return;
        if (options.signal.aborted) return;
        if (this.running.has(key)) continue;

        const queueEntry = this.queue.get(key);
        if (!queueEntry) continue;
        this.running.add(key);
        attemptedKeys.add(key);
        stats.attempted += 1;
        let removeAfterAttempt = false;
        try {
          const candles = await options.fetchHistory(
            key,
            this.fetchLimit,
            options.signal,
          );
          if (options.signal.aborted) {
            stats.cancelled += 1;
            queueEntry.retryAfter = now() + this.transientRetryMs;
            this.moveToEnd(key);
            stats.attempts.push({ key, status: "cancelled" });
            continue;
          }

          stats.succeeded += 1;
          const closedCandles = this.options.countClosedCandles(candles);
          const isShortHistory = closedCandles < this.requiredClosedCandles;
          if (isShortHistory) {
            stats.shortHistory += 1;
          }
          // Preserve the legacy cache merge for near-complete responses while
          // leaving the readiness/detector cutoff on closed candles unchanged.
          if (!isShortHistory || candles.length >= this.requiredClosedCandles) {
            this.merge(key, candles);
          }
          this.recordSuccessfulFetch(key, now());
          removeAfterAttempt = true;
          if (!isShortHistory) {
            try {
              this.options.onFetched?.(
                key,
                this.getCandles(key),
                this.getLastFetchAt(key),
              );
            } catch {
              // persistence is best effort
            }
          }
          stats.attempts.push({
            key,
            status: isShortHistory ? "short_history" : "succeeded",
            rows: candles.length,
            closedCandles,
          });
        } catch (error) {
          const cancelled = options.signal.aborted;
          if (cancelled) {
            stats.cancelled += 1;
            queueEntry.retryAfter = now() + this.transientRetryMs;
          } else {
            stats.failed += 1;
            queueEntry.retryAfter = now() + this.transientRetryMs;
          }
          this.moveToEnd(key);
          stats.attempts.push({
            key,
            status: cancelled ? "cancelled" : "failed",
            error,
          });
        } finally {
          this.running.delete(key);
          if (removeAfterAttempt) this.queue.delete(key);
        }
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(this.concurrency, selected.length) }, () =>
        worker(),
      ),
    );

    stats.deferred = [...this.queue.keys()].filter(
      (key) => !attemptedKeys.has(key),
    ).length;
    stats.queuedRemaining = this.queue.size;
    return stats;
  }

  /**
   * Enough closed candles AND a completed full-history fetch. Candles merged
   * from short prefetches (about 300 bars) must not count: the Auto Range
   * replay is path-dependent and a short start produces a different range.
   */
  private hasRequiredHistory(key: string): boolean {
    const entry = this.cache.get(key);
    if (!entry || entry.lastSuccessfulFetchAt <= 0) return false;
    const closed = entry.packed
      ? entry.closedCount
      : this.options.countClosedCandles(entry.candles ?? []);
    return closed >= this.requiredClosedCandles;
  }

  isHistoryReady(key: string): boolean {
    return this.hasRequiredHistory(key);
  }

  private recordSuccessfulFetch(key: string, fetchedAt: number): void {
    const existing = this.cache.get(key);
    this.setCache(
      key,
      existing
        ? { ...existing, lastSuccessfulFetchAt: fetchedAt }
        : this.makeEntry([], fetchedAt),
    );
  }

  private moveToEnd(key: string): void {
    const entry = this.queue.get(key);
    if (!entry) return;
    this.queue.delete(key);
    this.queue.set(key, entry);
  }

  /** Cache footprint for startup/warmup logging. */
  cacheStats(): { symbols: number; candles: number; packedBytes: number } {
    let packedBytes = 0;
    for (const entry of this.cache.values())
      packedBytes += entry.packed?.byteLength ?? 0;
    let candles = 0;
    for (const entry of this.cache.values()) candles += entry.count;
    return { symbols: this.cache.size, candles, packedBytes };
  }

  private setCache(key: string, entry: AutoRangeHistoryCacheEntry<T>): void {
    this.cache.delete(key);
    this.cache.set(key, entry);
    while (this.cache.size > this.cacheLimit) {
      const oldest = this.cache.keys().next().value as string | undefined;
      if (!oldest) break;
      this.cache.delete(oldest);
    }
  }
}

export interface AutoRangeHistoryScope {
  signal: AbortSignal;
  readonly deadlineExceeded: boolean;
  dispose(): void;
}

/** A warmup-only deadline linked to the lease, not the generic prefetch timer. */
export function createAutoRangeHistoryScope(
  leaseSignal: AbortSignal,
  budgetMs = AUTO_RANGE_HISTORY_WARMUP_BUDGET_MS,
): AutoRangeHistoryScope {
  const controller = new AbortController();
  let deadlineExceeded = false;
  const onLeaseAbort = () => controller.abort(leaseSignal.reason);
  if (leaseSignal.aborted) {
    onLeaseAbort();
  } else {
    leaseSignal.addEventListener("abort", onLeaseAbort, { once: true });
  }
  const deadlineTimer = setTimeout(() => {
    deadlineExceeded = true;
    controller.abort(new Error("Auto Range history warmup deadline exceeded"));
  }, budgetMs);

  return {
    signal: controller.signal,
    get deadlineExceeded() {
      return deadlineExceeded;
    },
    dispose() {
      clearTimeout(deadlineTimer);
      leaseSignal.removeEventListener("abort", onLeaseAbort);
    },
  };
}

export function serializeAutoRangeHistoryError(error: unknown): {
  name: string;
  message: string;
} {
  const errorRecord =
    error && typeof error === "object"
      ? (error as { name?: unknown; message?: unknown })
      : undefined;
  const name =
    typeof errorRecord?.name === "string"
      ? errorRecord.name
      : error instanceof Error
        ? error.name
        : "Error";
  const rawMessage =
    typeof errorRecord?.message === "string"
      ? errorRecord.message
      : error instanceof Error
        ? error.message
        : typeof error === "string"
          ? error
          : "Unknown Auto Range history error";
  const message = rawMessage
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [redacted]")
    .replace(
      /((?:api[_ -]?key|secret|signature|access[_ -]?token|authorization|password)\s*["':=]+\s*)[^\s,;"'&}]+/gi,
      "$1[redacted]",
    )
    .replace(
      /([?&](?:api[_-]?key|secret|signature|token|access_token|password)=)[^&\s]+/gi,
      "$1[redacted]",
    )
    .replace(/(https?:\/\/[^\s?]+)\?[^\s]+/gi, "$1?[redacted]")
    .replace(/[\r\n\t]+/g, " ")
    .slice(0, 300);
  return {
    name: name.replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 80) || "Error",
    message,
  };
}
