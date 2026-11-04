/**
 * telemetryQueue — generic single-flight serialized async queue with
 * capped-exponential-backoff retry on write failure.
 *
 * Used by scanner.ts to flush prescan_history and prescan_snapshots rows
 * asynchronously without blocking the active scan and without creating
 * unbounded concurrent writers.
 *
 * Guaranteed properties:
 *   1. Items are drained in FIFO order.
 *   2. Only one writer runs at a time (single-flight via `active` flag).
 *   3. A second push() while a writer is active is a no-op for the writer
 *      (item is enqueued and will be picked up by the running drain loop).
 *   4. If new items arrive while the writer is draining, they are processed in
 *      the same pass without starting a new writer.
 *   5. An initial recovery delay (recoveryDelayMs) is applied once per writer
 *      activation before the first write attempt.
 *   6. On write failure the failed item is retained at the head of the queue
 *      and retried after a capped exponential backoff delay:
 *        delay = min(retryBaseDelayMs * 2^(attempt - 1), retryMaxDelayMs)
 *      No maximum attempt count — items are retried until they succeed.
 *      This ensures no analytics rows are silently dropped.
 *   7. FIFO is preserved: the failed head item retries before later items.
 *   8. Busy-loop prevention: each retry waits at least retryBaseDelayMs.
 */

export interface TelemetryQueueOptions<T> {
  /**
   * Applied once per writer activation (not per item) before the first write.
   * Lets the Neon pool recover after a heavy scan before analytics writes start.
   */
  recoveryDelayMs: number;

  /**
   * Async write function.  Should throw (or return a rejected Promise) to
   * signal failure — the item will be retained and retried with backoff.
   * Should resolve (or return void) to signal success — the item is removed.
   */
  write: (item: T) => Promise<void>;

  /**
   * Base backoff delay for the first retry (ms).  Subsequent retries double
   * up to retryMaxDelayMs.  Defaults to 30_000 (30 s).
   */
  retryBaseDelayMs?: number;

  /**
   * Maximum backoff delay per retry (ms).  Defaults to 8 * 60_000 (8 min).
   */
  retryMaxDelayMs?: number;

  /**
   * Called after each failed write attempt before the retry delay is applied.
   * Useful for logging.  Never throws — errors here are swallowed.
   */
  onRetry?: (err: unknown, item: T, attempt: number) => void;
}

export class TelemetryQueue<T> {
  private readonly queue: T[] = [];
  private active = false;
  private readonly opts: Required<Omit<TelemetryQueueOptions<T>, "onRetry">> & {
    onRetry?: TelemetryQueueOptions<T>["onRetry"];
  };

  constructor(opts: TelemetryQueueOptions<T>) {
    this.opts = {
      recoveryDelayMs: opts.recoveryDelayMs,
      write: opts.write,
      retryBaseDelayMs: opts.retryBaseDelayMs ?? 30_000,
      retryMaxDelayMs: opts.retryMaxDelayMs ?? 8 * 60_000,
      onRetry: opts.onRetry,
    };
  }

  /** Enqueue an item and start the writer if it is not already running. */
  push(item: T): void {
    this.queue.push(item);
    this._kick();
  }

  /** Number of items currently waiting (including any item being retried). */
  get depth(): number {
    return this.queue.length;
  }

  /** True while the writer is running (including between retries). */
  get isActive(): boolean {
    return this.active;
  }

  private _kick(): void {
    if (this.active) return;
    this.active = true;
    void this._run();
  }

  private async _run(): Promise<void> {
    try {
      // One-time pool-recovery wait before the first write of this activation.
      await _sleep(this.opts.recoveryDelayMs);

      let attempt = 0; // reset per item; counts failures for the current head

      while (this.queue.length > 0) {
        // Peek at the head — do NOT shift yet; shift only on success.
        const item = this.queue[0]!;
        try {
          await this.opts.write(item);
          // Success: remove from queue, reset attempt counter for next item.
          this.queue.shift();
          attempt = 0;
        } catch (err) {
          attempt++;
          try {
            this.opts.onRetry?.(err, item, attempt);
          } catch {
            // never let the callback crash the writer
          }
          // Capped exponential backoff before the next retry of the same item.
          const delay = Math.min(
            this.opts.retryBaseDelayMs * Math.pow(2, attempt - 1),
            this.opts.retryMaxDelayMs,
          );
          await _sleep(delay);
          // Item remains at queue[0]; next loop iteration retries it.
        }
      }
    } finally {
      this.active = false;
      // Re-check: items may have arrived while we were writing.
      if (this.queue.length > 0) this._kick();
    }
  }
}

export type TelemetryOutboxId = number | string;

/** Thin setTimeout wrapper — extracted so tests can see it clearly. */
function _sleep(ms: number): Promise<void> {
  return new Promise<void>((r) => setTimeout(r, ms));
}

export interface DurableTelemetryClaim<T> {
  id: TelemetryOutboxId;
  payload: T;
  attempt: number;
  claimToken: string;
}

/**
 * A DB-backed wrapper around TelemetryQueue.
 *
 * `enqueue()` does not hand data to the in-memory queue until the outbox row
 * exists. Failed target writes are returned to durable retry state, so a
 * restart can replay the exact immutable payload rather than reconstructing it
 * from the mutable scanner map.
 */
export class DurableTelemetryQueue<T> {
  private readonly queuedIds = new Set<TelemetryOutboxId>();
  private readonly queue: TelemetryQueue<TelemetryOutboxId>;
  private readonly opts: Required<
    Omit<DurableTelemetryQueueOptions<T>, "onRetry">
  > & {
    onRetry?: DurableTelemetryQueueOptions<T>["onRetry"];
  };
  private drainInFlight: Promise<void> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private readonly retryTimers = new Set<ReturnType<typeof setTimeout>>();

  constructor(opts: DurableTelemetryQueueOptions<T>) {
    this.opts = {
      recoveryDelayMs: opts.recoveryDelayMs,
      write: opts.write,
      store: opts.store,
      retryBaseDelayMs: opts.retryBaseDelayMs ?? 30_000,
      retryMaxDelayMs: opts.retryMaxDelayMs ?? 8 * 60_000,
      pollIntervalMs: opts.pollIntervalMs ?? 30_000,
      onRetry: opts.onRetry,
    };
    this.queue = new TelemetryQueue<TelemetryOutboxId>({
      recoveryDelayMs: this.opts.recoveryDelayMs,
      write: async (id) => {
        try {
          await this._writeClaimed(id);
        } finally {
          this.queuedIds.delete(id);
        }
      },
    });
  }

  /** Persist first, then schedule the durable item for a serialized drain. */
  async enqueue(payload: T): Promise<void> {
    await this.opts.store.enqueue(payload);
    void this.drain().catch(() => {
      // The outbox row remains pending; polling/startup recovery will retry it.
    });
  }

  /**
   * Discover ready/retry/expired-lease records and hand each one to the
   * single-flight queue. This is safe to call from startup, timers, or after
   * enqueue; queuedIds prevents duplicate in-process scheduling.
   */
  async drain(): Promise<void> {
    if (this.drainInFlight) return this.drainInFlight;
    this.drainInFlight = (async () => {
      const ids = await this.opts.store.listDueIds();
      for (const id of ids) {
        if (this.queuedIds.has(id)) continue;
        this.queuedIds.add(id);
        this.queue.push(id);
      }
    })().finally(() => {
      this.drainInFlight = null;
    });
    return this.drainInFlight;
  }

  /** Begin restart recovery plus periodic durable retry polling. */
  async start(): Promise<void> {
    await this.drain();
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => {
      void this.drain().catch(() => {
        // A later poll will retry discovery; do not create unhandled rejections.
      });
    }, this.opts.pollIntervalMs);
  }

  /** Mainly useful for controlled shutdowns and unit tests. */
  stop(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    for (const timer of this.retryTimers) clearTimeout(timer);
    this.retryTimers.clear();
  }

  get depth(): number {
    return this.queue.depth;
  }

  get isActive(): boolean {
    return this.queue.isActive;
  }

  private async _writeClaimed(id: TelemetryOutboxId): Promise<void> {
    const claim = await this.opts.store.claim(id);
    if (!claim) return; // claimed by another worker or deferred until a later retry

    try {
      await this.opts.write(claim.payload);
      // If this acknowledgement times out after a committed target insert, the
      // payload is safely replayed through the target tables' unique keys.
      await this.opts.store.acknowledge(claim);
    } catch (err) {
      const delayMs = Math.min(
        this.opts.retryBaseDelayMs *
          Math.pow(2, Math.max(0, claim.attempt - 1)),
        this.opts.retryMaxDelayMs,
      );
      try {
        await this.opts.store.retry(claim, { delayMs, error: err });
      } catch {
        // Leave the lease in place. Its expiry is also durable recovery state.
        // Throwing lets the in-memory queue retry while this process is alive.
        throw err;
      }
      try {
        this.opts.onRetry?.(err, claim.payload, claim.attempt);
      } catch {
        // Never let optional logging break durable retry scheduling.
      }
      const timer = setTimeout(() => {
        this.retryTimers.delete(timer);
        void this.drain().catch(() => {
          // Polling remains the fallback if this one-shot wake-up fails.
        });
      }, delayMs);
      this.retryTimers.add(timer);
    }
  }
}

export interface DurableTelemetryQueueOptions<T> {
  recoveryDelayMs: number;
  write: (payload: T) => Promise<void>;
  store: DurableTelemetryStore<T>;
  retryBaseDelayMs?: number;
  retryMaxDelayMs?: number;
  pollIntervalMs?: number;
  onRetry?: (err: unknown, payload: T, attempt: number) => void;
}

/**
 * Storage boundary for telemetry that must survive a process restart.
 *
 * The store owns durable retry state and cross-process leases. The queue below
 * only serializes work that has already been captured by that store.
 */
export interface DurableTelemetryStore<T> {
  enqueue(payload: T): Promise<void>;
  listDueIds(): Promise<TelemetryOutboxId[]>;
  claim(id: TelemetryOutboxId): Promise<DurableTelemetryClaim<T> | null>;
  acknowledge(claim: DurableTelemetryClaim<T>): Promise<void>;
  retry(
    claim: DurableTelemetryClaim<T>,
    params: { delayMs: number; error: unknown },
  ): Promise<void>;
}
