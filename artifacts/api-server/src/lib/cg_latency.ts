/**
 * Телеметрия латентности CoinGlass-запросов + лаг event loop.
 *
 * Цель — отличить «CoinGlass медленный» от «мы сами захлебнулись»:
 *  - cgTimedFetch() оборачивает fetch к CoinGlass, замеряет длительность каждой
 *    HTTP-попытки и классифицирует исход (ok / timeout / error).
 *  - monitorEventLoopDelay замеряет лаг event loop: если p95 лага велик (сотни мс),
 *    таймауты внешних API — следствие локальной перегрузки инстанса, а не API.
 *
 * Снапшот и сброс окна делает сканер в конце цикла (лог "Scan complete").
 * Диагностический модуль: никогда не бросает, при ошибке телеметрии просто молчит.
 */
import { monitorEventLoopDelay, type IntervalHistogram } from "node:perf_hooks";
import {
  isTracedSymbol,
  recordCgTrace,
  type CgTraceReason,
} from "./coinglass-arm-trace.js";
import { composeMarketRequestSignal } from "./marketRequestBudget.js";
import {
  coinglassFetch,
  getCoinglassGovernorSnapshot,
  type CoinglassPriority,
} from "./coinglass_governor.js";

/** Process-wide queue/cooldown counters for health endpoints and scan logs. */
export { getCoinglassGovernorSnapshot };

const MAX_SAMPLES = 8000; // ~достаточно на самый длинный цикл; защита памяти

// ─── Shared governor transport ─────────────────────────────────────────────
// Ограничиваем одновременные CG-запросы: при 20+ параллельных fetch
// event loop блокируется очередью микрозадач → таймауты нарастают лавиной.
// 5 одновременных запросов = плавная нагрузка при runConcurrent(4) + джобы.
let durations: number[] = [];
let okCount = 0;
let timeoutCount = 0;
let errorCount = 0;
let windowStartedAt = Date.now();

let elHistogram: IntervalHistogram | null = null;
try {
  elHistogram = monitorEventLoopDelay({ resolution: 20 });
  elHistogram.enable();
} catch {
  elHistogram = null;
}

export type CgOutcome = "ok" | "timeout" | "error";

/** Записывает одну HTTP-попытку к CoinGlass. */
export function recordCgLatency(durationMs: number, outcome: CgOutcome): void {
  if (durations.length < MAX_SAMPLES) durations.push(durationMs);
  if (outcome === "ok") okCount++;
  else if (outcome === "timeout") timeoutCount++;
  else errorCount++;
}

/**
 * Обёртка вокруг fetch для CoinGlass-запросов: замеряет длительность попытки
 * и классифицирует исход. Поведение fetch не меняет — ошибки пробрасываются.
 */
export async function cgTimedFetch(
  url: string,
  init: RequestInit,
  options: { priority?: CoinglassPriority; endpoint?: string } = {},
): Promise<Response> {
  const signal = composeMarketRequestSignal(init.signal);
  const t0 = Date.now();
  const target = traceTarget(url, options.endpoint);
  try {
    const res = await coinglassFetch(url, { ...init, signal }, options);
    recordCgLatency(Date.now() - t0, res.ok ? "ok" : "error");
    if (target) void traceResponse(target, res, Date.now() - t0);
    return res;
  } catch (err) {
    const isTimeout =
      err instanceof Error &&
      (err.name === "TimeoutError" || err.name === "AbortError");
    recordCgLatency(Date.now() - t0, isTimeout ? "timeout" : "error");
    if (target) {
      const reason: CgTraceReason =
        err instanceof Error && err.name === "TimeoutError"
          ? "timeout"
          : err instanceof Error && err.name === "AbortError"
            ? "deadline_or_abort"
            : "transport_error";
      recordCgTrace({
        endpoint: target.endpoint,
        symbol: target.symbol,
        interval: target.interval,
        status: null,
        latencyMs: Date.now() - t0,
        reason,
      });
    }
    throw err;
  }
}

interface TraceTarget {
  endpoint: string;
  symbol: string;
  interval: string | null;
}

/** Trace only requests for symbols with a qualified/firing arm. */
function traceTarget(url: string, endpoint?: string): TraceTarget | null {
  try {
    const u = new URL(url);
    const symbol = u.searchParams.get("symbol");
    if (!isTracedSymbol(symbol)) return null;
    return {
      endpoint: endpoint ?? u.pathname,
      symbol: symbol!,
      interval: u.searchParams.get("interval") ?? u.searchParams.get("range"),
    };
  } catch {
    return null;
  }
}

async function traceResponse(
  target: TraceTarget,
  res: Response,
  latencyMs: number,
): Promise<void> {
  let reason: CgTraceReason;
  if (res.status === 429) reason = "http_429";
  else if (!res.ok) reason = `http_${res.status}`;
  else {
    try {
      const body = (await res.clone().json()) as {
        code?: unknown;
        data?: unknown;
      };
      if (body.code !== undefined && String(body.code) !== "0")
        reason = `api_code_${String(body.code)}`;
      else if (Array.isArray(body.data) && body.data.length === 0)
        reason = "empty_response";
      else reason = "ok";
    } catch {
      reason = "transport_error";
    }
  }
  recordCgTrace({ ...target, status: res.status, latencyMs, reason });
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(
    sorted.length - 1,
    Math.floor((p / 100) * sorted.length),
  );
  return sorted[idx];
}

export interface CgTelemetrySnapshot {
  /** Всего HTTP-попыток к CoinGlass за окно (по инструментированным модулям: OI + SpotCVD) */
  cgReq: number;
  cgOk: number;
  cgTimeouts: number;
  cgErrors: number;
  /** Доля таймаутов, % */
  cgTimeoutPct: number;
  cgP50Ms: number;
  cgP95Ms: number;
  cgMaxMs: number;
  /** Средний темп запросов за окно, req/min */
  cgReqPerMin: number;
  /** Лаг event loop за окно, мс (p50/p95/max). Здоровый p95 < 50мс. */
  elLagP50Ms: number;
  elLagP95Ms: number;
  elLagMaxMs: number;
  /** Длительность окна замера, мин */
  windowMin: number;
}

/** Возвращает статистику за окно с прошлого снапшота и начинает новое окно. */
export function snapshotCgTelemetry(): CgTelemetrySnapshot {
  const now = Date.now();
  const windowMs = Math.max(1, now - windowStartedAt);
  const sorted = [...durations].sort((a, b) => a - b);
  const total = okCount + timeoutCount + errorCount;

  const nsToMs = (v: number) => Math.round(v / 1e6);
  const snap: CgTelemetrySnapshot = {
    cgReq: total,
    cgOk: okCount,
    cgTimeouts: timeoutCount,
    cgErrors: errorCount,
    cgTimeoutPct: total > 0 ? Math.round((timeoutCount / total) * 100) : 0,
    cgP50Ms: percentile(sorted, 50),
    cgP95Ms: percentile(sorted, 95),
    cgMaxMs: sorted.length > 0 ? sorted[sorted.length - 1] : 0,
    cgReqPerMin: Math.round(total / (windowMs / 60000)),
    elLagP50Ms: elHistogram ? nsToMs(elHistogram.percentile(50)) : -1,
    elLagP95Ms: elHistogram ? nsToMs(elHistogram.percentile(95)) : -1,
    elLagMaxMs: elHistogram ? nsToMs(elHistogram.max) : -1,
    windowMin: +(windowMs / 60000).toFixed(1),
  };

  durations = [];
  okCount = 0;
  timeoutCount = 0;
  errorCount = 0;
  windowStartedAt = now;
  elHistogram?.reset();

  return snap;
}
