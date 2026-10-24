import { logger } from "./logger.js";

/**
 * Wraps a DB read with retry logic for Neon pool-timeout resilience.
 * Returns { ok: true, value } on success or { ok: false } after all attempts.
 *
 * Use for cycle-start DB reads where a failure means the entire cycle/job is
 * skipped and has no recovery until the next scheduled run.
 *
 * Unlike dbWriteBestEffort (best-effort, fire-and-forget), this helper WAITS
 * between retries (default 5s) and propagates ok:false so the caller can
 * skip the cycle gracefully instead of proceeding with stale/empty data.
 */
export async function dbReadWithRetry<T>(
  label: string,
  fn: () => Promise<T>,
  attempts = 3,
  delayMs = 5_000,
  perAttemptTimeoutMs = 8_000,
): Promise<{ ok: true; value: T } | { ok: false }> {
  let lastErr: unknown = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const work = fn();
      // A caller deadline is not cancellation for node-postgres. Observe a late
      // failure, but never start another copy of the same read while it may
      // still occupy a pool connection.
      void work.catch((lateErr) =>
        logger.warn({ err: lateErr, label }, "Timed-out DB read settled late"),
      );
      const value = await Promise.race([
        work,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () =>
              reject(
                new Error(
                  `${label}: read attempt timed out after ${perAttemptTimeoutMs}ms`,
                ),
              ),
            perAttemptTimeoutMs,
          );
        }),
      ]).finally(() => {
        if (timeout) clearTimeout(timeout);
      });
      return { ok: true, value };
    } catch (err) {
      lastErr = err;
      logger.warn(
        { err, attempt },
        `${label}: fetch attempt ${attempt}/${attempts} failed`,
      );
      const timedOut =
        err instanceof Error &&
        err.message.includes(`timed out after ${perAttemptTimeoutMs}ms`);
      if (timedOut) {
        logger.warn(
          { err, attempt },
          `${label}: read timed out; skipping retry to avoid DB pool amplification`,
        );
        break;
      }
      if (attempt < attempts) await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  logger.error(
    { err: lastErr },
    `${label}: fetch failed after ${attempts} attempts — skipping`,
  );
  return { ok: false };
}
