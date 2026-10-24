// ── Fast-fail DB write helpers ────────────────────────────────────────────────
// Two helpers with different failure semantics:
//
// dbWriteBestEffort — для некритичных путей (cleanup, debug-лог, heartbeat):
//   при неудаче логирует warn и возвращает null — не бросает.
//   Цель — НЕ ждать полный connectionTimeoutMillis пула (15с) на каждую попытку,
//   а сдаться быстро, чтобы не занимать слот пула и не растягивать цикл скана.
//
// dbWriteStrict — для критичных бизнес-записей (oi_watch, tracked_signals):
//   при неудаче бросает исключение — вызывающий код должен обработать failure.
//   Гарантирует, что in-memory стейт и DB остаются консистентными: если запись
//   не прошла, исключение поднимается в per-symbol catch и символ пропускается.
//
// Важно: Promise.race не отменяет сам DB-запрос. Поэтому после caller timeout
// нельзя начинать второй запрос: первый может всё ещё занимать pool slot или
// позже закоммититься. Fast-fail возвращает управление, но не умножает нагрузку.
//
// См. .agents/memory/db-read-retry-helper.md для истории соседней проблемы.
import { logger } from "./logger.js";
import {
  assertMarketCycleLeaseOwnership,
  SchedulerLeaseLostError,
} from "./schedulerLease.js";

export interface DbWriteFastOptions {
  /** Сколько попыток всего (включая первую). По умолчанию 2. */
  attempts?: number;
  /** Максимум ожидания на одну попытку, мс. По умолчанию 2500. */
  perAttemptTimeoutMs?: number;
  /** Пауза между попытками, мс. По умолчанию 400. */
  retryDelayMs?: number;
}

async function waitForWriteOrTimeout<T>(
  label: string,
  fn: () => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const work = fn();
  // A late rejection must always be observed after the caller stopped waiting.
  void work.catch((err) =>
    logger.warn({ err, label }, "Timed-out DB write settled late"),
  );
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`${label}: timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

/**
 * Выполняет fn() с коротким таймаутом на попытку и малым числом ретраев.
 * Best-effort: при неудаче логирует warn и возвращает null — не бросает.
 * Только для некритичных путей (cleanup, debug-лог, heartbeat).
 */
export async function dbWriteBestEffort<T>(
  label: string,
  fn: () => Promise<T>,
  opts: DbWriteFastOptions = {},
): Promise<T | null> {
  const attempts = opts.attempts ?? 2;
  const perAttemptTimeoutMs = opts.perAttemptTimeoutMs ?? 2500;
  const retryDelayMs = opts.retryDelayMs ?? 400;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      assertMarketCycleLeaseOwnership(label);
      return await waitForWriteOrTimeout(label, fn, perAttemptTimeoutMs);
    } catch (err) {
      if (err instanceof SchedulerLeaseLostError) {
        logger.info({ label }, "Skipped stale market-cycle best-effort write");
        return null;
      }
      const timedOut =
        err instanceof Error &&
        err.message.includes(`timed out after ${perAttemptTimeoutMs}ms`);
      // The original request is still in flight after a caller timeout. Do not
      // retry it and turn one exhausted connection into N exhausted connections.
      if (timedOut) {
        logger.warn(
          { err, attempt, attempts },
          `${label}: write timed out; skipping retry to avoid DB pool amplification`,
        );
        return null;
      }
      if (attempt < attempts) {
        logger.warn(
          { err, attempt, attempts },
          `${label}: write attempt ${attempt}/${attempts} failed — retrying fast`,
        );
        await new Promise((r) => setTimeout(r, retryDelayMs));
      } else {
        logger.warn(
          { err, attempt, attempts },
          `${label}: write failed after ${attempts} attempt(s) — skipping (non-critical)`,
        );
      }
    }
  }
  return null;
}

/**
 * Выполняет fn() с коротким таймаутом на попытку и малым числом ретраев.
 * Strict: при неудаче после всех попыток бросает исключение — не возвращает null.
 * Использовать для критичных бизнес-записей (oi_watch, tracked_signals), где
 * молчаливый провал рассинхронизирует in-memory и DB стейт.
 */
export async function dbWriteStrict<T>(
  label: string,
  fn: () => Promise<T>,
  opts: DbWriteFastOptions = {},
): Promise<T> {
  const attempts = opts.attempts ?? 2;
  const perAttemptTimeoutMs = opts.perAttemptTimeoutMs ?? 2500;
  const retryDelayMs = opts.retryDelayMs ?? 400;
  let lastErr: unknown;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      assertMarketCycleLeaseOwnership(label);
      return await waitForWriteOrTimeout(label, fn, perAttemptTimeoutMs);
    } catch (err) {
      if (err instanceof SchedulerLeaseLostError) throw err;
      lastErr = err;
      const timedOut =
        err instanceof Error &&
        err.message.includes(`timed out after ${perAttemptTimeoutMs}ms`);
      if (timedOut) {
        logger.error(
          { err, attempt, attempts },
          `${label}: write timed out; refusing retry with unknown outcome`,
        );
        break;
      }
      if (attempt < attempts) {
        logger.warn(
          { err, attempt, attempts },
          `${label}: write attempt ${attempt}/${attempts} failed — retrying`,
        );
        await new Promise((r) => setTimeout(r, retryDelayMs));
      } else {
        logger.error(
          { err, attempt, attempts },
          `${label}: write failed after ${attempts} attempt(s) — throwing (critical)`,
        );
      }
    }
  }
  throw lastErr;
}
