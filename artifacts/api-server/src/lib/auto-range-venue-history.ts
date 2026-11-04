import {
  fetchLcAutoRangeVenueHistory,
  LC_OB_SPOT_VENUES,
  type LcAutoRangeVenueHistory,
  type LcObVenue,
} from "./lc-ob-wait.js";

export const AUTO_RANGE_VENUE_HISTORY_CONCURRENCY = 2;
export const AUTO_RANGE_VENUE_HISTORY_FETCHES_PER_CYCLE = 2;
export const AUTO_RANGE_VENUE_HISTORY_QUEUE_LIMIT = 5_000;
export const AUTO_RANGE_VENUE_HISTORY_CACHE_LIMIT = 1_000;
export const AUTO_RANGE_VENUE_HISTORY_RETRY_MS = 60_000;
export const AUTO_RANGE_VENUE_HISTORY_SHORT_RETRY_MS = 6 * 60 * 60_000;
export const AUTO_RANGE_VENUE_HISTORY_REFRESH_MS = 15 * 60_000;

export const AUTO_RANGE_EXTERNAL_VENUES = LC_OB_SPOT_VENUES.filter(
  (venue) => venue !== "bingx",
);

type HistoryRecord =
  | { status: "ready"; history: LcAutoRangeVenueHistory; fetchedAt: number }
  | {
      status: "unknown";
      reason: string;
      fetchedAt: number;
      retryAfter: number;
    };

interface QueueRecord {
  priority: number;
  retryAfter: number;
}

export interface AutoRangeVenueHistoryStats {
  attempted: number;
  succeeded: number;
  unknown: number;
  deferred: number;
  queuedRemaining: number;
  attempts: Array<{
    symbol: string;
    venue: LcObVenue;
    status: "succeeded" | "unknown" | "failed" | "cancelled";
    reason?: string;
  }>;
}

/**
 * Small bounded, lease-aware queue for external venue histories. It owns no
 * exchange logic and never mixes candle series; each cache entry is one
 * symbol/venue pair containing that venue's separate 4H and 1H history.
 */
export class AutoRangeVenueHistoryQueue {
  private readonly cache = new Map<string, HistoryRecord>();
  private readonly queue = new Map<string, QueueRecord>();
  private readonly running = new Set<string>();

  get queueSize(): number {
    return this.queue.size;
  }

  get(symbol: string, venue: LcObVenue): HistoryRecord | null {
    return this.cache.get(this.key(symbol, venue)) ?? null;
  }

  enqueue(symbol: string, venue: LcObVenue, priority = 0, now = Date.now()) {
    if (venue === "bingx") return false;
    const key = this.key(symbol, venue);
    const queued = this.queue.get(key);
    if (queued) {
      queued.priority = Math.max(queued.priority, priority);
      return true;
    }
    const cached = this.cache.get(key);
    if (
      cached &&
      cached.status === "ready" &&
      now < cached.fetchedAt + AUTO_RANGE_VENUE_HISTORY_REFRESH_MS
    ) {
      return false;
    }
    if (cached && cached.status === "unknown" && now < cached.retryAfter) {
      return false;
    }
    if (this.queue.size >= AUTO_RANGE_VENUE_HISTORY_QUEUE_LIMIT) return false;
    this.queue.set(key, { priority, retryAfter: 0 });
    return true;
  }

  async fetchBatch(input: {
    signal: AbortSignal;
    now?: () => number;
    fetchHistory(
      symbol: string,
      venue: LcObVenue,
      now: number,
      signal: AbortSignal,
    ): Promise<
      | { usable: true; history: LcAutoRangeVenueHistory }
      | { usable: false; reason: string }
    >;
  }): Promise<AutoRangeVenueHistoryStats> {
    const now = input.now ?? Date.now;
    const eligible = [...this.queue.entries()].filter(
      ([key, record]) => !this.running.has(key) && record.retryAfter <= now(),
    );
    const oldestReservation = eligible.slice(0, 1);
    const prioritized = eligible
      .slice(oldestReservation.length)
      .sort((left, right) => right[1].priority - left[1].priority);
    const selected = [...oldestReservation, ...prioritized]
      .slice(0, AUTO_RANGE_VENUE_HISTORY_FETCHES_PER_CYCLE)
      .map(([key]) => key);
    const stats: AutoRangeVenueHistoryStats = {
      attempted: 0,
      succeeded: 0,
      unknown: 0,
      deferred: 0,
      queuedRemaining: this.queue.size,
      attempts: [],
    };
    let cursor = 0;
    const worker = async () => {
      while (!input.signal.aborted) {
        const key = selected[cursor++];
        if (!key) return;
        const queueRecord = this.queue.get(key);
        if (!queueRecord || this.running.has(key)) continue;
        const separator = key.indexOf(":");
        const venue = key.slice(0, separator) as LcObVenue;
        const symbol = key.slice(separator + 1);
        this.running.add(key);
        stats.attempted += 1;
        try {
          const result = await input.fetchHistory(
            symbol,
            venue,
            now(),
            input.signal,
          );
          if (input.signal.aborted) {
            queueRecord.retryAfter = now() + AUTO_RANGE_VENUE_HISTORY_RETRY_MS;
            stats.attempts.push({ symbol, venue, status: "cancelled" });
            continue;
          }
          if (result.usable) {
            this.setCache(key, {
              status: "ready",
              history: result.history,
              fetchedAt: now(),
            });
            this.queue.delete(key);
            stats.succeeded += 1;
            stats.attempts.push({ symbol, venue, status: "succeeded" });
          } else {
            const shortHistory = result.reason.startsWith(
              "insufficient-closed-bars-",
            );
            const retryAfter =
              now() +
              (shortHistory
                ? AUTO_RANGE_VENUE_HISTORY_SHORT_RETRY_MS
                : AUTO_RANGE_VENUE_HISTORY_RETRY_MS);
            this.setCache(key, {
              status: "unknown",
              reason: result.reason,
              fetchedAt: now(),
              retryAfter,
            });
            queueRecord.retryAfter = retryAfter;
            this.moveToEnd(key);
            stats.unknown += 1;
            stats.attempts.push({
              symbol,
              venue,
              status: "unknown",
              reason: result.reason,
            });
          }
        } catch (error) {
          queueRecord.retryAfter = now() + AUTO_RANGE_VENUE_HISTORY_RETRY_MS;
          this.moveToEnd(key);
          stats.unknown += 1;
          if (!input.signal.aborted) {
            this.setCache(key, {
              status: "unknown",
              reason:
                error instanceof Error ? error.message : "history-fetch-failed",
              fetchedAt: now(),
              retryAfter: queueRecord.retryAfter,
            });
          }
          stats.attempts.push({
            symbol,
            venue,
            status: input.signal.aborted ? "cancelled" : "failed",
            reason:
              error instanceof Error ? error.message : "history-fetch-failed",
          });
        } finally {
          this.running.delete(key);
        }
      }
    };
    await Promise.all(
      Array.from(
        {
          length: Math.min(
            AUTO_RANGE_VENUE_HISTORY_CONCURRENCY,
            selected.length,
          ),
        },
        () => worker(),
      ),
    );
    stats.deferred = [...this.queue.keys()].filter(
      (key) => !selected.includes(key),
    ).length;
    stats.queuedRemaining = this.queue.size;
    return stats;
  }

  private key(symbol: string, venue: LcObVenue): string {
    return `${venue}:${symbol.toUpperCase()}`;
  }

  private setCache(key: string, record: HistoryRecord): void {
    this.cache.delete(key);
    this.cache.set(key, record);
    while (this.cache.size > AUTO_RANGE_VENUE_HISTORY_CACHE_LIMIT) {
      const oldest = this.cache.keys().next().value as string | undefined;
      if (!oldest) break;
      this.cache.delete(oldest);
    }
  }

  private moveToEnd(key: string): void {
    const record = this.queue.get(key);
    if (!record) return;
    this.queue.delete(key);
    this.queue.set(key, record);
  }
}

export const autoRangeVenueHistoryQueue = new AutoRangeVenueHistoryQueue();

export function fetchAutoRangeVenueHistory(
  symbol: string,
  venue: LcObVenue,
  now: number,
  signal: AbortSignal,
) {
  return fetchLcAutoRangeVenueHistory(symbol, venue, now, signal);
}
