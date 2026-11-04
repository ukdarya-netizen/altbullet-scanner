import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { getKlinesRange } from "./bingx.js";
import { logger } from "./logger";

/** Owner 2026-10-18: a qualified breakout may fire only within 2h of its trigger candle close. */
export const STEALTH_FIRE_WINDOW_MS = 2 * 60 * 60 * 1000;
/** Owner 2026-10-18: breakout candle close must be >=1% above range top and body >= 1 ATR14 (1H arms). */
export const STEALTH_FILTER_MIN_DIST_PCT = 1;
export const STEALTH_FILTER_MIN_BODY_ATR = 1;
export const STEALTH_VERDICT_RETENTION_DAYS = 35;

const HOUR_MS = 3_600_000;

/** Mandatory additive gate: journal + shadow tables. */
export async function ensureStealthVerdictJournalSchema(): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext('stealth_verdict_journal_schema'))`,
    );
    await tx.execute(sql`
      CREATE TABLE IF NOT EXISTS stealth_arm_verdict_log (
        id bigserial PRIMARY KEY,
        arm_id integer NOT NULL,
        symbol text NOT NULL,
        level_source text,
        cycle_at timestamptz NOT NULL DEFAULT now(),
        verdict text NOT NULL,
        reason text NOT NULL,
        details jsonb NOT NULL DEFAULT '{}'::jsonb
      )
    `);
    await tx.execute(sql`
      CREATE INDEX IF NOT EXISTS stealth_arm_verdict_log_arm_idx
        ON stealth_arm_verdict_log (arm_id, cycle_at)
    `);
    await tx.execute(sql`
      CREATE INDEX IF NOT EXISTS stealth_arm_verdict_log_cycle_idx
        ON stealth_arm_verdict_log (cycle_at)
    `);
    await tx.execute(sql`
      CREATE TABLE IF NOT EXISTS stealth_cutoff_shadow (
        id serial PRIMARY KEY,
        arm_id integer NOT NULL,
        symbol text NOT NULL,
        level_source text,
        reason text NOT NULL,
        cut_at timestamptz NOT NULL DEFAULT now(),
        trigger_time bigint,
        level double precision,
        details jsonb NOT NULL DEFAULT '{}'::jsonb,
        outcome_status text NOT NULL DEFAULT 'pending',
        outcome jsonb,
        evaluated_at timestamptz,
        CONSTRAINT stealth_cutoff_shadow_arm_reason_unique UNIQUE (arm_id, reason)
      )
    `);
    // Every arm state transition (created, qualified, fired, closed with its
    // reason) is journaled by the database itself, in the same transaction as
    // the status change, so no code path (replace, obsolete, consumed, stale
    // window, startup migrations) can skip the journal.
    await tx.execute(sql`
      CREATE OR REPLACE FUNCTION stealth_arm_transition_journal() RETURNS trigger AS $fn$
      DECLARE
        ident jsonb;
        trig jsonb;
        verdict_name text;
      BEGIN
        IF TG_OP = 'UPDATE' AND NEW.status IS NOT DISTINCT FROM OLD.status THEN
          RETURN NEW;
        END IF;
        ident := COALESCE(
          NEW.decision_json #> '{autoRangeIdentity}',
          NEW.structure_json #> '{autoRangeIdentity}',
          '{}'::jsonb
        );
        trig := COALESCE(NEW.decision_json #> '{confirmation,triggerCandle}', '{}'::jsonb);
        verdict_name := CASE
          WHEN TG_OP = 'INSERT' THEN 'created'
          WHEN NEW.status = 'invalidated' THEN 'closed'
          ELSE NEW.status
        END;
        INSERT INTO stealth_arm_verdict_log
          (arm_id, symbol, level_source, verdict, reason, details)
        VALUES (
          NEW.id, NEW.symbol, NEW.level_source, verdict_name,
          COALESCE(NEW.terminal_reason, NEW.decision_json ->> 'reason', NEW.status),
          jsonb_build_object(
            'status', NEW.status,
            'prevStatus', CASE WHEN TG_OP = 'UPDATE' THEN OLD.status ELSE NULL END,
            'upper', ident -> 'upper',
            'lower', ident -> 'lower',
            'openedAt', ident -> 'openedAt',
            'breakoutLevel', NEW.breakout_level,
            'triggerTime', trig -> 'time',
            'triggerClose', trig -> 'close',
            'oneHourVolume', NEW.decision_json -> 'oneHourVolume',
            'participation', NEW.decision_json -> 'participation',
            'currentAutoRangeIdentity', NEW.decision_json -> 'currentAutoRangeIdentity',
            'latestUpsideBreakout', NEW.decision_json -> 'latestUpsideBreakout'
          )
        );
        RETURN NEW;
      END;
      $fn$ LANGUAGE plpgsql
    `);
    await tx.execute(sql`
      DROP TRIGGER IF EXISTS stealth_arm_transition_journal_trg
        ON stealth_breakout_armed_setups
    `);
    await tx.execute(sql`
      CREATE TRIGGER stealth_arm_transition_journal_trg
        AFTER INSERT OR UPDATE OF status ON stealth_breakout_armed_setups
        FOR EACH ROW EXECUTE FUNCTION stealth_arm_transition_journal()
    `);
  });
}

export async function recordStealthVerdict(input: {
  armId: number;
  symbol: string;
  levelSource: string | null;
  verdict: string;
  reason: string;
  details?: Record<string, unknown>;
}): Promise<void> {
  await db.execute(sql`
    INSERT INTO stealth_arm_verdict_log
      (arm_id, symbol, level_source, verdict, reason, details)
    VALUES (${input.armId}, ${input.symbol}, ${input.levelSource},
            ${input.verdict}, ${input.reason},
            ${JSON.stringify(input.details ?? {})}::jsonb)
  `);
}

export async function recordStealthCutoff(input: {
  armId: number;
  symbol: string;
  levelSource: string | null;
  reason: "stale_fire_window" | "filter_dist_body";
  triggerTime: number | null;
  level: number | null;
  details?: Record<string, unknown>;
}): Promise<void> {
  await db.execute(sql`
    INSERT INTO stealth_cutoff_shadow
      (arm_id, symbol, level_source, reason, trigger_time, level, details)
    VALUES (${input.armId}, ${input.symbol}, ${input.levelSource},
            ${input.reason}, ${input.triggerTime}, ${input.level},
            ${JSON.stringify(input.details ?? {})}::jsonb)
    ON CONFLICT (arm_id, reason) DO NOTHING
  `);
}

type Candle = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
};

function toCandles(
  rows: ReadonlyArray<{
    time: number;
    open: string | number;
    high: string | number;
    low: string | number;
    close: string | number;
  }>,
): Candle[] {
  return rows
    .map((k) => ({
      time: Number(k.time),
      open: Number(k.open),
      high: Number(k.high),
      low: Number(k.low),
      close: Number(k.close),
    }))
    .filter(
      (c) =>
        Number.isFinite(c.time) &&
        c.open > 0 &&
        c.high > 0 &&
        c.low > 0 &&
        c.close > 0,
    )
    .sort((a, b) => a.time - b.time);
}

export interface BreakoutQuality {
  pass: boolean | null;
  distPct: number | null;
  bodyAtr: number | null;
  reason: string;
}

/**
 * dist = breakout candle close above range upper (%); body/ATR14 = candle body
 * over the 14-bar Wilder-free simple mean true range of the prior bars.
 * Missing data returns pass:null (never silently a verdict).
 */
export function evaluateBreakoutQuality(
  rows: ReadonlyArray<{
    time: number;
    open: string | number;
    high: string | number;
    low: string | number;
    close: string | number;
  }>,
  triggerTime: number | null,
  rangeUpper: number | null,
): BreakoutQuality {
  const none = (reason: string): BreakoutQuality => ({
    pass: null,
    distPct: null,
    bodyAtr: null,
    reason,
  });
  if (triggerTime === null) return none("trigger_time_missing");
  if (rangeUpper === null || !(rangeUpper > 0))
    return none("range_upper_missing");
  const candles = toCandles(rows);
  const i = candles.findIndex((c) => c.time === triggerTime);
  if (i < 0) return none("trigger_candle_not_in_1h_history");
  if (i < 15) return none("fewer_than_15_prior_1h_candles");
  const trig = candles[i]!;
  let trSum = 0;
  for (let j = i - 14; j < i; j++) {
    const c = candles[j]!;
    const prev = candles[j - 1]!;
    trSum += Math.max(
      c.high - c.low,
      Math.abs(c.high - prev.close),
      Math.abs(c.low - prev.close),
    );
  }
  const atr = trSum / 14;
  if (!(atr > 0)) return none("atr_zero");
  const distPct = (trig.close / rangeUpper - 1) * 100;
  const bodyAtr = (trig.close - trig.open) / atr;
  const pass =
    distPct >= STEALTH_FILTER_MIN_DIST_PCT &&
    bodyAtr >= STEALTH_FILTER_MIN_BODY_ATR;
  return {
    pass,
    distPct,
    bodyAtr,
    reason: pass ? "ok" : "filter_dist_body",
  };
}

export interface CutoffOutcome {
  entryPrice: number;
  maxUpPct: number;
  maxDownPct: number;
  pct24h: number | null;
  hit5BeforeLevelLoss: boolean;
  cutPrice: number | null;
  afterCutMaxUpPct: number | null;
  afterCutMaxDownPct: number | null;
  afterCutPct24h: number | null;
}

/** Pure: 24h outcome of a cut-off breakout from the breakout candle close and from the cut hour open. */
export function evaluateCutoffOutcome(
  rows: Parameters<typeof toCandles>[0],
  triggerTime: number,
  cutAtMs: number,
  level: number | null,
): CutoffOutcome | null {
  const c = toCandles(rows);
  const bar0 = c.find((x) => x.time === triggerTime);
  if (!bar0) return null;
  const entry = bar0.close;
  const after = c.filter(
    (x) => x.time > triggerTime && x.time <= triggerTime + 24 * HOUR_MS,
  );
  if (after.length < 24) return null;
  let maxHigh = 0;
  let minLow = Infinity;
  let hit = false;
  let dead = false;
  for (const x of after) {
    maxHigh = Math.max(maxHigh, x.high);
    minLow = Math.min(minLow, x.low);
    if (!dead && !hit && x.high >= entry * 1.05) hit = true;
    if (level !== null && x.close < level) dead = true;
  }
  const cutOpen = Math.floor(cutAtMs / HOUR_MS) * HOUR_MS;
  const cutBar = c.find((x) => x.time === cutOpen);
  const cutWin = cutBar
    ? c.filter((x) => x.time >= cutOpen && x.time < cutOpen + 24 * HOUR_MS)
    : [];
  const complete = cutBar !== undefined && cutWin.length >= 24;
  const cutPrice = cutBar?.open ?? null;
  return {
    entryPrice: entry,
    maxUpPct: (maxHigh / entry - 1) * 100,
    maxDownPct: (minLow / entry - 1) * 100,
    pct24h: (after[after.length - 1]!.close / entry - 1) * 100,
    hit5BeforeLevelLoss: hit,
    cutPrice,
    afterCutMaxUpPct:
      complete && cutPrice
        ? (Math.max(...cutWin.map((x) => x.high)) / cutPrice - 1) * 100
        : null,
    afterCutMaxDownPct:
      complete && cutPrice
        ? (Math.min(...cutWin.map((x) => x.low)) / cutPrice - 1) * 100
        : null,
    afterCutPct24h:
      complete && cutPrice
        ? (cutWin[cutWin.length - 1]!.close / cutPrice - 1) * 100
        : null,
  };
}

/** Fills +24h outcomes for pending cut-off rows and prunes the verdict journal. */
export async function runStealthCutoffOutcomeCycle(
  now = Date.now(),
): Promise<void> {
  const pending = await db.execute(sql`
    SELECT id, symbol, trigger_time, level, EXTRACT(EPOCH FROM cut_at) * 1000 AS cut_ms
      FROM stealth_cutoff_shadow
     WHERE outcome_status = 'pending' AND trigger_time IS NOT NULL
     ORDER BY id ASC
     LIMIT 40
  `);
  for (const row of pending.rows as Array<{
    id: number;
    symbol: string;
    trigger_time: string | number;
    level: number | null;
    cut_ms: string | number;
  }>) {
    const trigger = Number(row.trigger_time);
    const cutMs = Number(row.cut_ms);
    const readyAt =
      Math.max(trigger + HOUR_MS, Math.floor(cutMs / HOUR_MS) * HOUR_MS) +
      25 * HOUR_MS;
    if (now < readyAt) continue;
    try {
      const klines = await getKlinesRange(
        row.symbol,
        "1h",
        trigger,
        Math.max(trigger, cutMs) + 26 * HOUR_MS,
        { strictPayload: true },
      );
      const outcome = evaluateCutoffOutcome(
        klines,
        trigger,
        cutMs,
        row.level === null ? null : Number(row.level),
      );
      if (!outcome) {
        // Candles for this window are missing: keep pending only for 7 days.
        if (now - readyAt > 7 * 24 * HOUR_MS) {
          await db.execute(sql`
            UPDATE stealth_cutoff_shadow
               SET outcome_status = 'candles_unavailable', evaluated_at = now()
             WHERE id = ${row.id}
          `);
        }
        continue;
      }
      await db.execute(sql`
        UPDATE stealth_cutoff_shadow
           SET outcome_status = 'done',
               outcome = ${JSON.stringify(outcome)}::jsonb,
               evaluated_at = now()
         WHERE id = ${row.id} AND outcome_status = 'pending'
      `);
    } catch (err) {
      logger.warn({ err, symbol: row.symbol }, "stealth cutoff outcome failed");
    }
  }
  await db.execute(sql`
    DELETE FROM stealth_arm_verdict_log
     WHERE cycle_at < now() - (${STEALTH_VERDICT_RETENTION_DAYS} || ' days')::interval
  `);
}
