import { AsyncLocalStorage } from "node:async_hooks";
import { pool } from "@workspace/db";

/**
 * Timers of the main symbol loop (after loop-start), aggregated per pattern.
 *
 * A symbol's work is split into segments: a segment starts at the symbol's
 * start ("pre") or at a pattern's `_pdbCheck(key)` call and lasts until the next
 * `_pdbCheck` or the end of the symbol. Everything the symbol awaits in that
 * segment is attributed to it:
 *   cg      – coinglassFetch calls (queue wait + HTTP), summed per call
 *   dbRead  – application-pool queries that are not INSERT/UPDATE/DELETE
 *   dbWrite – application-pool INSERT/UPDATE/DELETE queries
 *   compute – segment wall time minus cg/dbRead/dbWrite, clamped at 0 per segment
 * Concurrent calls inside one segment overlap, so the per-step sums can exceed
 * the segment wall time; transactions run on a dedicated client and are not
 * measured.
 */
interface Segment {
  label: string;
  startedAt: number;
  cgMs: number;
  cgCalls: number;
  dbReadMs: number;
  dbReadCalls: number;
  dbWriteMs: number;
  dbWriteCalls: number;
}
interface SymbolCtx {
  seg: Segment;
}
interface Totals {
  symbols: number;
  wallMs: number;
  computeMs: number;
  cgMs: number;
  cgCalls: number;
  dbReadMs: number;
  dbReadCalls: number;
  dbWriteMs: number;
  dbWriteCalls: number;
}

const store = new AsyncLocalStorage<SymbolCtx>();
let totals = new Map<string, Totals>();
let loopSymbols = 0;

function newSegment(label: string): Segment {
  return {
    label,
    startedAt: Date.now(),
    cgMs: 0,
    cgCalls: 0,
    dbReadMs: 0,
    dbReadCalls: 0,
    dbWriteMs: 0,
    dbWriteCalls: 0,
  };
}

function closeSegment(seg: Segment): void {
  const wall = Date.now() - seg.startedAt;
  const t = totals.get(seg.label) ?? {
    symbols: 0,
    wallMs: 0,
    computeMs: 0,
    cgMs: 0,
    cgCalls: 0,
    dbReadMs: 0,
    dbReadCalls: 0,
    dbWriteMs: 0,
    dbWriteCalls: 0,
  };
  t.symbols++;
  t.wallMs += wall;
  t.computeMs += Math.max(0, wall - seg.cgMs - seg.dbReadMs - seg.dbWriteMs);
  t.cgMs += seg.cgMs;
  t.cgCalls += seg.cgCalls;
  t.dbReadMs += seg.dbReadMs;
  t.dbReadCalls += seg.dbReadCalls;
  t.dbWriteMs += seg.dbWriteMs;
  t.dbWriteCalls += seg.dbWriteCalls;
  totals.set(seg.label, t);
}

/** Runs one symbol's work with its own timing context. */
export function runLoopSymbol<T>(fn: () => Promise<T>): Promise<T> {
  const ctx: SymbolCtx = { seg: newSegment("pre") };
  return store.run(ctx, async () => {
    try {
      return await fn();
    } finally {
      closeSegment(ctx.seg);
      loopSymbols++;
    }
  });
}

/** Starts a new segment (called from `_pdbCheck`). No-op outside the loop. */
export function markLoopSegment(label: string): void {
  const ctx = store.getStore();
  if (!ctx) return;
  closeSegment(ctx.seg);
  ctx.seg = newSegment(label);
}

export function recordLoopCoinglass(ms: number): void {
  const ctx = store.getStore();
  if (!ctx) return;
  ctx.seg.cgMs += ms;
  ctx.seg.cgCalls++;
}

const WRITE_SQL = /^\s*(?:with\b[\s\S]*?\b)?(insert|update|delete)\b/i;

function recordLoopDb(sqlText: string, ms: number): void {
  const ctx = store.getStore();
  if (!ctx) return;
  if (WRITE_SQL.test(sqlText)) {
    ctx.seg.dbWriteMs += ms;
    ctx.seg.dbWriteCalls++;
  } else {
    ctx.seg.dbReadMs += ms;
    ctx.seg.dbReadCalls++;
  }
}

let patched = false;
/** Wraps the application pool's promise-style query() once. */
export function installLoopDbTiming(): void {
  if (patched) return;
  patched = true;
  const p = pool as any;
  const original = p.query.bind(p) as (...args: unknown[]) => unknown;
  p.query = (...args: unknown[]) => {
    if (!store.getStore() || typeof args[args.length - 1] === "function")
      return original(...args);
    const first = args[0];
    const text =
      typeof first === "string"
        ? first
        : ((first as { text?: string } | undefined)?.text ?? "");
    const started = Date.now();
    const result = original(...args);
    if (result && typeof (result as Promise<unknown>).then === "function") {
      const done = () => recordLoopDb(text, Date.now() - started);
      (result as Promise<unknown>).then(done, done);
    }
    return result;
  };
}

/** Starts a fresh aggregation window (call at loop start). */
export function resetLoopTiming(): void {
  totals = new Map();
  loopSymbols = 0;
  installLoopDbTiming();
}

/** Returns the aggregated per-pattern timers and clears them. */
export function drainLoopTiming(): Record<string, unknown> {
  const byPattern: Record<string, Totals> = {};
  for (const [label, t] of totals) {
    byPattern[label] = {
      ...t,
      wallMs: Math.round(t.wallMs),
      computeMs: Math.round(t.computeMs),
      cgMs: Math.round(t.cgMs),
      dbReadMs: Math.round(t.dbReadMs),
      dbWriteMs: Math.round(t.dbWriteMs),
    };
  }
  const out = {
    symbols: loopSymbols,
    byPattern,
    note: "segment = from the pattern's _pdbCheck to the next _pdbCheck or symbol end; 'pre' = symbol start to first check; per-step sums are summed per call and overlap when calls run concurrently; compute = wall - cg - db per segment, min 0; DB timing covers application-pool queries, not transactions",
  };
  totals = new Map();
  loopSymbols = 0;
  return out;
}
