import { eq, sql } from "drizzle-orm";
import { db, signalsTable } from "@workspace/db";
import type { Signal } from "@workspace/db";
import { getKlinesRange } from "./bingx.js";
import { logger } from "./logger.js";
import {
  applyStealthLiveVolumeRule,
  checkStealthCandleGate,
  checkStealthVolumeGate,
} from "./stealth-volume-gate.js";
import {
  evaluateBreakoutQuality,
  STEALTH_FIRE_WINDOW_MS,
} from "./stealth-verdict-journal.js";

/**
 * Owner decision 2026-10-21 (replay of 241 closed 1H Range signals): after a
 * 1H Range "returned to Range" cancellation, ONE re-entry per arm is allowed
 * when, within 48 hours of the cancel, a closed 1H candle closes back above the
 * frozen level AND that candle passes the same live filters as a normal fire
 * (aggregated volume rule, close >= 1% above the level, body >= 1 ATR14).
 */
export const STEALTH_REENTRY_WINDOW_MS = 48 * 60 * 60 * 1_000;
export const STEALTH_REENTRY_KEY_PREFIX = "reentry:";
export const STEALTH_REENTRY_ENTRY_SOURCE = "stealth_range_reentry";
const HOUR_MS = 3_600_000;

interface Kline {
  time: number;
  open: string | number;
  high: string | number;
  low: string | number;
  close: string | number;
}

/**
 * Closed 1H candles that closed above the level after the cancel and still
 * inside the 48h window, oldest first. `freshMs` limits evaluation to candles
 * whose close is recent (the same stale-fire window as a normal breakout).
 */
export function selectReentryCandles(
  klines: ReadonlyArray<Kline>,
  cancelledAtMs: number,
  level: number,
  nowMs: number,
  freshMs: number = STEALTH_FIRE_WINDOW_MS,
): Kline[] {
  return [...klines]
    .sort((a, b) => a.time - b.time)
    .filter((k) => {
      const closeAt = k.time + HOUR_MS;
      const close = Number(k.close);
      return (
        closeAt > cancelledAtMs &&
        closeAt <= cancelledAtMs + STEALTH_REENTRY_WINDOW_MS &&
        closeAt <= nowMs &&
        nowMs - closeAt <= freshMs &&
        Number.isFinite(close) &&
        close > level
      );
    });
}

export interface ReentryCandidate {
  trackedId: number;
  signalId: number;
  symbol: string;
  cancelledAt: Date;
  armId: number;
  level: number;
  lower: number;
}

export interface ReentryDeps {
  trackSignal: (params: Record<string, unknown>) => Promise<unknown>;
  discardUntrackedSignal: (id: number, reason: string) => Promise<boolean>;
  broadcastSignalAlert: (
    signal: Signal,
    options: { eventKey: string },
  ) => Promise<number>;
  getLivePrice: (symbol: string) => Promise<number | null>;
}

export async function listReentryCandidates(
  nowMs: number = Date.now(),
): Promise<ReentryCandidate[]> {
  const since = new Date(nowMs - STEALTH_REENTRY_WINDOW_MS);
  const res = await db.execute(sql`
    SELECT t.id AS tracked_id, t.signal_id, t.symbol, t.closed_at,
           a.id AS arm_id, a.breakout_level,
           a.structure_json #>> '{autoRangeIdentity,lower}' AS lower
      FROM tracked_signals t
      JOIN stealth_breakout_armed_setups a
        ON a.fired_signal_id = t.signal_id AND a.symbol = t.symbol
       AND a.level_source = 'auto_range_1h'
     WHERE t.sentiment_key = 'stealth_breakout'
       AND t.status = 'cancelled'
       AND t.cancel_reason = 'stealth_returned_to_range'
       AND t.closed_at >= ${since}
       AND t.signal_id IS NOT NULL
       AND t.decision_metrics #> '{stealthReentry}' IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM signals s
          WHERE s.broadcast_window_key = ${STEALTH_REENTRY_KEY_PREFIX}::text || t.id::text
       )
  `);
  const out: ReentryCandidate[] = [];
  for (const raw of res.rows as Array<Record<string, unknown>>) {
    const level = Number(raw.breakout_level);
    const lower = Number(raw.lower);
    const closedAt = raw.closed_at;
    if (!(level > 0) || !(lower > 0) || !(lower < level) || !closedAt) continue;
    out.push({
      trackedId: Number(raw.tracked_id),
      signalId: Number(raw.signal_id),
      symbol: String(raw.symbol),
      cancelledAt:
        closedAt instanceof Date
          ? closedAt
          : new Date(
              /Z|[+-]\d\d:?\d\d$/.test(String(closedAt))
                ? String(closedAt)
                : `${String(closedAt).replace(" ", "T")}Z`,
            ),
      armId: Number(raw.arm_id),
      level,
      lower,
    });
  }
  return out;
}

/** One pass: at most one re-entry per arm, never throws. */
export async function runStealthRangeReentries(
  deps: ReentryDeps,
  nowMs: number = Date.now(),
): Promise<number> {
  let fired = 0;
  let candidates: ReentryCandidate[];
  try {
    candidates = await listReentryCandidates(nowMs);
  } catch (err) {
    logger.warn({ err }, "Stealth re-entry: candidate query failed");
    return 0;
  }
  for (const c of candidates) {
    try {
      if (await tryReenter(c, deps, nowMs)) fired++;
    } catch (err) {
      logger.warn(
        { err, symbol: c.symbol, trackedId: c.trackedId },
        "Stealth re-entry: evaluation failed",
      );
    }
  }
  return fired;
}

async function tryReenter(
  c: ReentryCandidate,
  deps: ReentryDeps,
  nowMs: number,
): Promise<boolean> {
  const cancelledMs = c.cancelledAt.getTime();
  // History for ATR14 (>= 16 candles before the trigger) plus the window.
  const klines = await getKlinesRange(
    c.symbol,
    "1h",
    Math.floor(cancelledMs / HOUR_MS) * HOUR_MS - 20 * HOUR_MS,
    nowMs,
    { strictPayload: true },
  );
  const fresh = selectReentryCandles(klines, cancelledMs, c.level, nowMs);
  for (const candle of fresh) {
    const trigger = candle.time;
    // Live filter 1: close >= 1% above the level and body >= 1 ATR14. Missing
    // data fails open, exactly like the normal fire path.
    const quality = evaluateBreakoutQuality(klines, trigger, c.level);
    if (quality.pass === false) continue;
    // Live filter 2: aggregated futures/spot volume rule (CoinGlass).
    const candleGate = await checkStealthCandleGate(c.symbol, trigger, "1h", {
      upper: c.level,
      lower: c.lower,
    });
    const liveVolume = await checkStealthVolumeGate(
      c.symbol,
      trigger,
      "1h",
      nowMs,
      true,
    );
    const gate = applyStealthLiveVolumeRule(candleGate, liveVolume);
    if (!gate.pass) continue;
    const price = await deps.getLivePrice(c.symbol);
    if (price === null || !(price > 0) || price < c.level) continue;
    return await fire(c, deps, {
      trigger,
      price,
      distPct: quality.distPct,
      bodyAtr: quality.bodyAtr,
      futuresRatio: gate.futuresRatio,
      spotRatio: gate.spotRatio,
    });
  }
  return false;
}

async function fire(
  c: ReentryCandidate,
  deps: ReentryDeps,
  ev: {
    trigger: number;
    price: number;
    distPct: number | null;
    bodyAtr: number | null;
    futuresRatio: number | null;
    spotRatio: number | null;
  },
): Promise<boolean> {
  const [orig] = await db
    .select()
    .from(signalsTable)
    .where(eq(signalsTable.id, c.signalId))
    .limit(1);
  if (!orig) return false;
  const { id: _id, ...rest } = orig;
  // The unique broadcast key is the atomic "one re-entry per arm" guard.
  const rows = await db
    .insert(signalsTable)
    .values({
      ...rest,
      price: ev.price,
      stealthRangeLifecycleKey: null,
      broadcastWindowKey: `${STEALTH_REENTRY_KEY_PREFIX}${c.trackedId}`,
      telegramAlertQueued: false,
      altBulletSnapshotRequestedAt: new Date(),
      altBulletSnapshotClaimedAt: null,
      altBulletSnapshotClaimToken: null,
      altBulletSnapshotAttemptCount: 0,
      altBulletSnapshotRetryAfter: null,
      altBulletSnapshotLastError: null,
      detectedAt: new Date(),
    })
    .onConflictDoNothing()
    .returning();
  const inserted = rows[0];
  if (!inserted) return false;
  const tracked = await deps.trackSignal({
    symbol: inserted.symbol,
    signalId: inserted.id,
    signalType: inserted.type,
    sentiment: inserted.sentiment,
    sentimentKey: "stealth_breakout",
    stealthDetectionMethod: inserted.stealthDetectionMethod ?? null,
    alphaScore: inserted.alphaScore ?? null,
    entrySource: STEALTH_REENTRY_ENTRY_SOURCE,
    entryPrice: ev.price,
    entryOi: inserted.openInterest ?? null,
    entryCvd15m: inserted.entryCvd15m ?? null,
    entryCvd30m: inserted.entryCvd30m ?? null,
    entryCvd1h: inserted.entryCvd1h ?? null,
    entryCvd4h: inserted.entryCvd4h ?? null,
    decisionMetrics: {
      stealthReentry: {
        ofTrackedId: c.trackedId,
        ofArmId: c.armId,
        level: c.level,
        lower: c.lower,
        levelSource: "auto_range_1h",
        reclaimCandleTime: ev.trigger,
        distPct: ev.distPct,
        bodyAtr: ev.bodyAtr,
        futuresRatio: ev.futuresRatio,
        spotRatio: ev.spotRatio,
      },
    },
  });
  if (tracked === false || tracked === "skip") {
    await deps.discardUntrackedSignal(
      inserted.id,
      tracked === false
        ? "stealth_reentry_track_failed"
        : "stealth_reentry_duplicate_active",
    );
    return false;
  }
  const queued = await deps.broadcastSignalAlert(inserted, {
    eventKey: `signal:${inserted.id}`,
  });
  if (queued > 0) {
    await db
      .update(signalsTable)
      .set({ telegramAlertQueued: true })
      .where(eq(signalsTable.id, inserted.id));
  }
  logger.info(
    { symbol: c.symbol, fromTracked: c.trackedId, price: ev.price },
    "Stealth re-entry fired after Range-return cancel",
  );
  return true;
}
