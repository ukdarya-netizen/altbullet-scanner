// db and drizzle are imported lazily: this module is on the import path of the
// CoinGlass clients, which plain-node unit tests load without the DB workspace.
async function dbTools() {
  const [{ db }, { sql }] = await Promise.all([
    import("@workspace/db"),
    import("drizzle-orm"),
  ]);
  return { db, sql };
}

/**
 * Per-request trace of CoinGlass calls for symbols that hold a qualified or
 * firing Stealth arm. Makes a null (429 / breaker_skip / timeout / deadline /
 * not_requested / empty_response / bad mapping) visible after the fact.
 */
export type CgTraceReason =
  | "ok"
  | "http_429"
  | "timeout"
  | "deadline_or_abort"
  | "empty_response"
  | "breaker_skip"
  | "not_requested"
  | "mapping_unsupported"
  | "transport_error"
  | "collision"
  | "breaker_skip_final"
  | `oi_${string}`
  | `http_${number}`
  | `api_code_${string}`;

export interface CgTraceRow {
  ts: Date;
  endpoint: string;
  symbol: string;
  interval: string | null;
  status: number | null;
  latencyMs: number | null;
  reason: CgTraceReason;
}

const MAX_BUFFER = 5000;
let traced = new Set<string>();
let buffer: CgTraceRow[] = [];

export async function ensureCoinglassArmTraceSchema(): Promise<void> {
  const { db, sql } = await dbTools();
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS coinglass_arm_request_trace (
      id bigserial PRIMARY KEY,
      ts timestamptz NOT NULL,
      endpoint text NOT NULL,
      symbol text NOT NULL,
      interval text,
      http_status integer,
      latency_ms integer,
      reason text NOT NULL
    )
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS coinglass_arm_request_trace_symbol_ts_idx
      ON coinglass_arm_request_trace (symbol, ts)
  `);
}

/** Base ticker as CoinGlass sees it: ATOM, ATOMUSDT, ATOM-USDT -> ATOM. */
export function traceBaseSymbol(raw: string): string {
  return raw
    .toUpperCase()
    .replace(/-?USDT$/, "")
    .replace(/-$/, "");
}

export function setTracedArmSymbols(symbols: Iterable<string>): void {
  traced = new Set([...symbols].map(traceBaseSymbol));
}

export function addTracedArmSymbol(symbol: string): void {
  traced.add(traceBaseSymbol(symbol));
}

export function isTracedSymbol(raw: string | null | undefined): boolean {
  return !!raw && traced.has(traceBaseSymbol(raw));
}

export function recordCgTrace(row: Omit<CgTraceRow, "ts">): void {
  if (!isTracedSymbol(row.symbol)) return;
  if (buffer.length >= MAX_BUFFER) buffer.shift();
  buffer.push({ ...row, symbol: traceBaseSymbol(row.symbol), ts: new Date() });
}

/** Reason for a skipped request (breaker, cycle deadline): no HTTP was made. */
export function recordCgSkip(
  symbol: string,
  endpoint: string,
  reason: CgTraceReason,
): void {
  recordCgTrace({
    endpoint,
    symbol,
    interval: null,
    status: null,
    latencyMs: null,
    reason,
  });
}

export function drainCgTraceBuffer(): CgTraceRow[] {
  const out = buffer;
  buffer = [];
  return out;
}

export async function writeCgTrace(rows: CgTraceRow[]): Promise<void> {
  if (rows.length === 0) return;
  const { db, sql } = await dbTools();
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    await db.execute(sql`
      INSERT INTO coinglass_arm_request_trace
        (ts, endpoint, symbol, interval, http_status, latency_ms, reason)
      SELECT * FROM unnest(
        ${chunk.map((r) => r.ts.toISOString())}::timestamptz[],
        ${chunk.map((r) => r.endpoint)}::text[],
        ${chunk.map((r) => r.symbol)}::text[],
        ${chunk.map((r) => r.interval)}::text[],
        ${chunk.map((r) => r.status)}::int[],
        ${chunk.map((r) => r.latencyMs)}::int[],
        ${chunk.map((r) => r.reason)}::text[]
      )
    `);
  }
  await db.execute(
    sql`DELETE FROM coinglass_arm_request_trace WHERE ts < now() - interval '7 days'`,
  );
}

/** Flushes buffered rows without ever failing the scanner cycle. */
export function flushCgTrace(): void {
  const rows = drainCgTraceBuffer();
  if (rows.length === 0) return;
  void import("./dbWriteFast.js").then(({ dbWriteBestEffort }) =>
    dbWriteBestEffort("coinglass-arm-trace", () => writeCgTrace(rows)),
  );
}
