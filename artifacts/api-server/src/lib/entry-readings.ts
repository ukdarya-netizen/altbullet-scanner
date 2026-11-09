/**
 * VSA and Wyckoff at the entry of every signal (owner 2026-11-04): Impulse Buy, Stealth, ABNeon and
 * Liquidation Cascade. Before this they were written only for open positions from FastCycle, both
 * were skipped together when the entry candle was missing, and signals older than ~20 days never got
 * a volume — so production had none. Now:
 *   - each reading is written on its own (a failed VSA never blocks Wyckoff and back);
 *   - a background pass restores both for every signal of the last 60 days that lacks them;
 *   - the reason of every failed attempt is kept in memory and shown on «Аналитика».
 * Price OHLC from BingX 1H candles, volume = aggregated CoinGlass futures volume (all exchanges).
 * Observation only — no decision reads these.
 */
import { db, pool, vsaEntryMetricsTable, wyckoffEntryMetricsTable } from "@workspace/db";
import { getKlinesRange } from "./bingx.js";
import * as cgTaker from "./coinglass_taker.js";
import { computeVsa, type Ohlc } from "./vsa-metrics.js";
import { computeWyckoff } from "./wyckoff-metrics.js";
import { logger } from "./logger.js";
import { entryExtrasCoverage, runEntryExtrasBackfillCycle } from "./entry-extras.js";
import { runVolumeColorsBackfillCycle, volumeColorsCoverage } from "./entry-volume-colors.js";
import { runIctBackfillCycle } from "./entry-ict.js";

export const ENTRY_READING_KEYS = ["impulse_buy", "stealth_breakout", "neon_support_bounce", "liquidation_cascade"] as const;
const H1 = 3_600_000;
const LOOKBACK_BARS = 120;
const BACKFILL_DAYS = 60;
const RETRY_AFTER_MS = 6 * H1;
/** CoinGlass not answering is temporary: retry sooner. */
const RETRY_NO_VOLUME_MS = 30 * 60_000;

type SignalRef = { id: number; symbol: string; sentimentKey: string | null; detectedAt: Date };
export type ReadingResult = { vsa: "written" | "exists" | "failed"; wyckoff: "written" | "exists" | "failed"; reason: string | null };

/**
 * The two tables, created here if missing (owner 2026-11-04: production never ran the startup
 * maintenance that created them, so nothing could be written). Same DDL as the startup migration.
 */
let tablesReady: Promise<void> | null = null;
export function ensureEntryReadingTables(): Promise<void> {
  tablesReady ??= (async () => {
    for (const t of ["vsa_entry_metrics", "wyckoff_entry_metrics"]) {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS ${t} (
          id                serial PRIMARY KEY,
          tracked_signal_id integer NOT NULL,
          symbol            text NOT NULL,
          sentiment_key     text NOT NULL,
          source            text NOT NULL,
          recorded_at       timestamp NOT NULL DEFAULT now(),
          metrics           jsonb NOT NULL
        )`);
      await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS ${t}_signal_unique ON ${t} (tracked_signal_id)`);
    }
  })().catch((err) => { tablesReady = null; throw err; });
  return tablesReady;
}

/** Last failure per signal (reason, when) — shown on «Аналитика», retried after RETRY_AFTER_MS. */
const failures = new Map<number, { reason: string; at: number }>();
const inflight = new Set<number>();

/** The last closed 1H candle before the signal. */
export const entryCandleOf = (detectedAt: Date) => Math.floor(detectedAt.getTime() / H1) * H1 - H1;

async function loadInputs(symbol: string, entryCandle: number, priority: "high" | "low") {
  const raw = await getKlinesRange(symbol, "1h", entryCandle - LOOKBACK_BARS * H1, entryCandle + H1).catch(() => []);
  const candles: Ohlc[] = raw
    .map((k) => ({ time: Number(k.time), open: Number(k.open), high: Number(k.high), low: Number(k.low), close: Number(k.close) }))
    .filter((k) => k.time <= entryCandle && Number.isFinite(k.close))
    .sort((a, b) => a.time - b.time);
  const bars = Math.ceil((Date.now() - entryCandle) / H1) + LOOKBACK_BARS + 2;
  const volumes = bars <= 4500
    ? await cgTaker.getAggFuturesVolumeByInterval(symbol, "1h", bars, Date.now(), priority, priority === "low" ? 60_000 : 15_000).catch(() => null)
    : null;
  return { candles, volumes };
}

/**
 * Impulse Buy live gate (owner 2026-11-05): Wyckoff phase at the entry — the same reading as the one
 * written after the signal (last closed 1H candle, BingX price, aggregated CoinGlass volume, 48 bars).
 * 30 days, 111 signals: «breakout_without_base» 34 → 5 reached +10%, 9 stopped, closed sum −87.6%;
 * the rest 77 → 19 / 7, +14.8%. Returns null when the phase cannot be measured (caller lets it pass).
 */
export async function impulseWyckoffPhaseNow(symbol: string, nowMs = Date.now()): Promise<string | null> {
  return (await impulseWyckoffCheck(symbol, nowMs)).phase;
}

/**
 * The same reading with the reason when the phase is not measured (owner 2026-11-09: the live gate is
 * fail-closed — no phase, no signal — and the phase / reason the gate saw is written into the snapshot).
 */
export async function impulseWyckoffCheck(symbol: string, nowMs = Date.now()): Promise<{ phase: string | null; reason: string | null; entryCandle: number }> {
  const entryCandle = entryCandleOf(new Date(nowMs));
  try {
    const { candles, volumes } = await loadInputs(symbol, entryCandle, "high");
    if (!volumes) return { phase: null, reason: "no_aggregated_volume", entryCandle };
    if (!candles.some((c) => c.time === entryCandle)) return { phase: null, reason: "no_entry_candle_1h", entryCandle };
    const w = computeWyckoff(candles, volumes, entryCandle);
    if (w.phase === "insufficient_history") return { phase: null, reason: "insufficient_history", entryCandle };
    return { phase: w.phase, reason: null, entryCandle };
  } catch (e) {
    return { phase: null, reason: `error:${String(e).slice(0, 80)}`, entryCandle };
  }
}

/** Writes the missing VSA and/or Wyckoff reading of one signal. Never throws. */
export async function recordEntryReadings(t: SignalRef, opts: { priority?: "high" | "low"; have?: { vsa: boolean; wyckoff: boolean } } = {}): Promise<ReadingResult> {
  const out: ReadingResult = { vsa: "exists", wyckoff: "exists", reason: null };
  if (!ENTRY_READING_KEYS.includes((t.sentimentKey ?? "") as (typeof ENTRY_READING_KEYS)[number])) return out;
  if (inflight.has(t.id)) return out;
  inflight.add(t.id);
  try {
    await ensureEntryReadingTables();
    const have = opts.have ?? await (async () => {
      const r = await pool.query(
        `SELECT EXISTS (SELECT 1 FROM vsa_entry_metrics WHERE tracked_signal_id = $1) AS vsa,
                EXISTS (SELECT 1 FROM wyckoff_entry_metrics WHERE tracked_signal_id = $1) AS wyckoff`, [t.id]);
      return { vsa: Boolean(r.rows[0]?.vsa), wyckoff: Boolean(r.rows[0]?.wyckoff) };
    })();
    if (have.vsa && have.wyckoff) return out;
    const entryCandle = entryCandleOf(t.detectedAt);
    const { candles, volumes } = await loadInputs(t.symbol, entryCandle, opts.priority ?? "low");
    const reasons: string[] = [];
    if (!candles.some((c) => c.time === entryCandle)) reasons.push("нет свечи входа BingX 1H");
    if (!volumes) reasons.push(`нет агрегированного объёма CoinGlass (${cgTaker.lastAggVolumeError ?? "кэш/ключ"})`);
    const source = Date.now() - t.detectedAt.getTime() <= 30 * 60_000 ? "live" : "backfill";
    const base = { trackedSignalId: t.id, symbol: t.symbol, sentimentKey: t.sentimentKey ?? "unknown", source };

    if (!have.vsa) {
      const read = computeVsa(candles, volumes, [entryCandle - 2 * H1, entryCandle - H1, entryCandle]);
      const entry = read.find((c) => Date.parse(c.time) === entryCandle);
      if (entry && entry.volumeRatio !== null) {
        await db.insert(vsaEntryMetricsTable).values({
          ...base,
          metrics: {
            entryCandle: entry,
            prev1: read.find((c) => Date.parse(c.time) === entryCandle - H1) ?? null,
            prev2: read.find((c) => Date.parse(c.time) === entryCandle - 2 * H1) ?? null,
            source: "bingx_price_ohlc+coinglass_agg_volume",
          },
        }).onConflictDoNothing();
        out.vsa = "written";
      } else {
        out.vsa = "failed";
        if (entry && entry.volumeRatio === null) reasons.push("объём свечи входа не сопоставился с историей");
      }
    }
    if (!have.wyckoff) {
      const w = computeWyckoff(candles, volumes, entryCandle);
      if (w.phase !== "insufficient_history" && volumes) {
        const counts: Record<string, number> = {};
        for (const e of w.events) counts[e.type] = (counts[e.type] ?? 0) + 1;
        await db.insert(wyckoffEntryMetricsTable).values({ ...base, metrics: { ...w, counts } }).onConflictDoNothing();
        out.wyckoff = "written";
      } else {
        out.wyckoff = "failed";
        if (w.phase === "insufficient_history") reasons.push("мало истории свечей до входа");
      }
    }
    out.reason = reasons.length ? [...new Set(reasons)].join("; ") : null;
    if (out.vsa === "failed" || out.wyckoff === "failed") failures.set(t.id, { reason: out.reason ?? "неизвестно", at: Date.now() });
    else failures.delete(t.id);
    return out;
  } catch (err) {
    const reason = `ошибка: ${err instanceof Error ? err.message.slice(0, 160) : String(err)}`;
    failures.set(t.id, { reason, at: Date.now() });
    logger.warn({ err, symbol: t.symbol }, "entry VSA/Wyckoff reading failed (non-critical)");
    return { vsa: "failed", wyckoff: "failed", reason };
  } finally {
    inflight.delete(t.id);
  }
}

/** One restore pass: signals of the last 60 days missing a reading, newest first, one at a time. */
export async function runEntryReadingsBackfillCycle(limit = 40, gapMs = 2_000, priority: "high" | "low" = "low"): Promise<{ tried: number; written: number; failed: number }> {
  await ensureEntryReadingTables();
  // Signals still waiting for their retry are left out in SQL, so they never block the rest.
  const cooling = [...failures.entries()]
    .filter(([, f]) => Date.now() - f.at < (f.reason.includes("CoinGlass") ? RETRY_NO_VOLUME_MS : RETRY_AFTER_MS))
    .map(([id]) => id);
  const { rows } = await pool.query(
    `SELECT t.id, t.symbol, t.sentiment_key, t.detected_at,
            (v.tracked_signal_id IS NOT NULL) AS has_vsa, (w.tracked_signal_id IS NOT NULL) AS has_wy
     FROM tracked_signals t
     LEFT JOIN vsa_entry_metrics v ON v.tracked_signal_id = t.id
     LEFT JOIN wyckoff_entry_metrics w ON w.tracked_signal_id = t.id
     WHERE t.sentiment_key = ANY($1::text[]) AND t.detected_at > now() - ($2::int * interval '1 day')
       AND t.detected_at < now() - interval '5 minutes'
       AND (v.tracked_signal_id IS NULL OR w.tracked_signal_id IS NULL)
       AND NOT (t.id = ANY($3::int[]))
     ORDER BY CASE WHEN t.sentiment_key IN ('impulse_buy', 'stealth_breakout') THEN 0 ELSE 1 END,
              t.detected_at > now() - interval '30 days' DESC, t.detected_at DESC
     LIMIT $4`, [[...ENTRY_READING_KEYS], BACKFILL_DAYS, cooling, limit]);
  let tried = 0, written = 0, failed = 0;
  for (const r of rows) {
    tried += 1;
    const res = await recordEntryReadings(
      { id: r.id, symbol: r.symbol, sentimentKey: r.sentiment_key, detectedAt: new Date(r.detected_at) },
      { priority, have: { vsa: r.has_vsa, wyckoff: r.has_wy } },
    );
    if (res.vsa === "written" || res.wyckoff === "written") written += 1;
    if (res.vsa === "failed" || res.wyckoff === "failed") failed += 1;
    await new Promise((resolve) => setTimeout(resolve, gapMs));
  }
  if (tried) logger.info({ tried, written, failed }, "entry VSA/Wyckoff restore pass");
  return { tried, written, failed };
}

/**
 * The restore loop (owner 2026-11-04: the 10-minute job waited for an idle scanner and almost never
 * ran). One signal after another. Normal mode: 5 s apart, CoinGlass at LOW priority (waits behind the
 * scanner). `fast` (CAB_RESTORE_ONLY=1, scanner and watcher stopped): the whole CoinGlass budget —
 * the governor still spaces requests within the plan's rate.
 * Order: Impulse Buy and Stealth first (last 30 days, then older), then ABNeon and LC.
 */
let loopStarted = false;
/** What each restore loop is doing — shown on «Аналитика» (owner 2026-11-04: no guessing). */
type LoopStatus = { mode: string; passes: number; lastPassAt: string | null; lastTried: number; lastWritten: number; running: boolean; lastError: string | null };
const loopStatus: Record<string, LoopStatus> = {};
/**
 * Restore-only mode is retired (owner 2026-11-05: the history is restored; the variable could not be
 * found and removed from the deployment). The server never stops the scanner for it any more; the
 * restore queues keep running in the background behind the scanner.
 */
export const restoreOnlyMode = () => false;
/** What the server actually sees in CAB_RESTORE_ONLY (not a credential) — shown on «Аналитика». */
const restoreEnvSeen = () => {
  const v = process.env.CAB_RESTORE_ONLY;
  return v === undefined ? "переменной нет" : `значение «${v.slice(0, 12)}» (длина ${v.length})`;
};
export function startEntryReadingsRestoreLoop(opts: { fast?: boolean } = {}): void {
  if (loopStarted) return;
  loopStarted = true;
  const gapMs = opts.fast ? 200 : 5_000;
  const idleMs = opts.fast ? 60_000 : 10 * 60_000;
  // Separate loops (owner 2026-11-04: breakout / IB parameters must not wait for VSA / Wyckoff), but
  // 2026-11-06: they run ONE AT A TIME and only while the database pool is free. Six loops working at
  // once took most of the 8 pool connections; on 05.11 the scanner and the stop watcher timed out on
  // «timeout exceeded when trying to connect» and the stop cycle hung. Background work never competes.
  let bgChain: Promise<unknown> = Promise.resolve();
  const poolBusy = () => pool.waitingCount > 0 || (pool.totalCount >= 6 && pool.idleCount === 0);
  const exclusive = <T,>(fn: () => Promise<T>): Promise<T> => {
    const run = bgChain.then(async () => {
      for (let i = 0; i < 60 && poolBusy(); i++) await new Promise((r) => setTimeout(r, 1_000));
      return fn();
    });
    bgChain = run.catch(() => undefined);
    return run;
  };
  const loop = (name: string, rawPass: () => Promise<{ tried: number }>) => {
    const pass = () => exclusive(rawPass);
    const st: LoopStatus = (loopStatus[name] = { mode: opts.fast ? "быстрый" : "фоновый", passes: 0, lastPassAt: null, lastTried: 0, lastWritten: 0, running: false, lastError: null });
    const tick = async () => {
      let next = idleMs;
      st.running = true;
      try {
        const r = await pass() as { tried: number; written?: number };
        st.lastTried = r.tried; st.lastWritten = r.written ?? 0; st.lastError = null;
        if (r.tried > 0) next = gapMs;
      } catch (err) {
        st.lastError = err instanceof Error ? err.message.slice(0, 200) : String(err);
        logger.warn({ err }, `${name} restore loop failed (non-critical)`);
      }
      st.running = false; st.passes += 1; st.lastPassAt = new Date().toISOString();
      setTimeout(() => void tick(), next).unref?.();
    };
    setTimeout(() => void tick(), opts.fast ? 5_000 : 60_000).unref?.();
  };
  const batch = opts.fast ? 25 : 20;
  const priority = opts.fast ? "high" : "low";
  loop("entry VSA/Wyckoff", () => runEntryReadingsBackfillCycle(batch, gapMs, priority));
  loop("entry extras", () => runEntryExtrasBackfillCycle(batch, gapMs, priority));
  // Owner's «VSA Wyckoff Volume» colours on the 48 hours before the entry (owner 2026-11-04).
  loop("volume colours", () => runVolumeColorsBackfillCycle(batch, gapMs, priority));
  // 2026-11-06 (owner): Range is no longer tracked anywhere and the old Stealth is retired — the
  // «neon levels» and «range inside» readings of old Stealth breakouts are not computed any more.
  // ICT at the entry of every signal, 15m and 1H (owner 2026-11-05).
  loop("ict", () => runIctBackfillCycle(25, 1_000));
}

/** For «Аналитика»: per pattern, signals of the last 60 days and how many have each reading; recent failures. */
export async function entryReadingsCoverage() {
  await ensureEntryReadingTables();
  const { rows } = await pool.query(
    `SELECT t.sentiment_key AS key, count(*)::int AS total,
            count(v.tracked_signal_id)::int AS vsa,
            count(v.tracked_signal_id) FILTER (WHERE (v.metrics->'entryCandle'->>'volumeRatio') IS NOT NULL)::int AS vsa_with_volume,
            count(w.tracked_signal_id)::int AS wyckoff
     FROM tracked_signals t
     LEFT JOIN vsa_entry_metrics v ON v.tracked_signal_id = t.id
     LEFT JOIN wyckoff_entry_metrics w ON w.tracked_signal_id = t.id
     WHERE t.sentiment_key = ANY($1::text[]) AND t.detected_at > now() - ($2::int * interval '1 day')
     GROUP BY 1 ORDER BY 1`, [[...ENTRY_READING_KEYS], BACKFILL_DAYS]);
  const reasons: Record<string, number> = {};
  for (const f of failures.values()) reasons[f.reason] = (reasons[f.reason] ?? 0) + 1;
  const extras = await entryExtrasCoverage().catch(() => null);
  const colors = await volumeColorsCoverage().catch(() => null);
  return {
    days: BACKFILL_DAYS,
    patterns: rows.map((r) => ({ ...r, extras: extras?.byKey[r.key] ?? null, colors: colors?.byKey[r.key] ?? null })),
    failedNow: failures.size,
    reasons,
    extrasFailedNow: extras?.failedNow ?? 0,
    extrasReasons: extras?.reasons ?? {},
    colorsFailedNow: colors?.failedNow ?? 0,
    colorsReasons: colors?.reasons ?? {},
    restoreOnly: restoreOnlyMode(),
    restoreEnv: restoreEnvSeen(),
    loops: loopStatus,
  };
}
