import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import type { BingXKline } from "./bingx.js";
import { getBtcDailyCandles } from "./btc-market-history.js";
import {
  getBtcDailyPerformanceWindow,
  getDubaiDay,
} from "./btc-daily-performance.js";
import { loadBtcDominanceObservations } from "./btc-dominance-observations.js";
import {
  buildBtcCrossHistory,
  formatPgDate,
  findCrossingEvents,
  type BtcCrossHistory,
  type CrossObservationDay,
} from "./btc-cross-alert-policy.js";

type Anchor = {
  day: string;
  btcPrice: number;
  btcDominance: number;
};

const OWNER_KEY =
  process.env.OWNER_EMAIL?.trim().toLowerCase() || "dashboard-owner";

function dubaiDayStart(day: string): Date {
  const [year, month, date] = day.split("-").map(Number);
  return new Date(Date.UTC(year!, month! - 1, date!) - 4 * 60 * 60 * 1000);
}

export async function ensureBtcCrossAlertsSchema(): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext('btc_cross_alerts_schema'))`,
    );
    await tx.execute(sql`
      CREATE TABLE IF NOT EXISTS btc_cross_alert_state (
        id integer PRIMARY KEY DEFAULT 1,
        anchor_day date,
        anchor_btc_price double precision,
        anchor_btc_dominance double precision,
        activation_day date,
        last_evaluated_day date,
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT btc_cross_alert_state_singleton_chk CHECK (id = 1),
        CONSTRAINT btc_cross_alert_state_anchor_chk CHECK (
          (anchor_day IS NULL AND anchor_btc_price IS NULL AND anchor_btc_dominance IS NULL)
          OR
          (anchor_day IS NOT NULL AND anchor_btc_price > 0 AND anchor_btc_dominance > 0 AND anchor_btc_dominance <= 100)
        )
      )
    `);
    await tx.execute(sql`
      ALTER TABLE btc_cross_alert_state
      ADD COLUMN IF NOT EXISTS activation_day date
    `);
    // Existing deployments used last_evaluated_day as a moving cursor. Freeze
    // the current value as the activation boundary when upgrading.
    await tx.execute(sql`
      UPDATE btc_cross_alert_state
      SET activation_day = last_evaluated_day
      WHERE activation_day IS NULL AND last_evaluated_day IS NOT NULL
    `);
    await tx.execute(sql`
      CREATE TABLE IF NOT EXISTS btc_cross_alert_events (
        id serial PRIMARY KEY,
        day date NOT NULL,
        direction text NOT NULL,
        btc_price double precision NOT NULL,
        btc_dominance double precision NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT btc_cross_alert_events_direction_chk
          CHECK (direction IN ('btc_outperformed', 'dominance_outperformed')),
        CONSTRAINT btc_cross_alert_events_price_chk CHECK (btc_price > 0),
        CONSTRAINT btc_cross_alert_events_dominance_chk
          CHECK (btc_dominance > 0 AND btc_dominance <= 100)
      )
    `);
    await tx.execute(sql`
      CREATE UNIQUE INDEX IF NOT EXISTS btc_cross_alert_events_day_uq
      ON btc_cross_alert_events (day)
    `);
    await tx.execute(sql`
      CREATE INDEX IF NOT EXISTS btc_cross_alert_events_day_desc_idx
      ON btc_cross_alert_events (day DESC)
    `);
    await tx.execute(sql`
      CREATE TABLE IF NOT EXISTS btc_cross_alert_owner_state (
        owner_key text NOT NULL,
        event_id integer NOT NULL REFERENCES btc_cross_alert_events(id) ON DELETE CASCADE,
        read_at timestamptz,
        CONSTRAINT btc_cross_alert_owner_event_pk PRIMARY KEY (owner_key, event_id)
      )
    `);
    await tx.execute(sql`
      CREATE INDEX IF NOT EXISTS btc_cross_alert_owner_unread_idx
      ON btc_cross_alert_owner_state (owner_key, read_at)
    `);
  });
}

async function loadObservations(
  now: Date,
  priceCandles: readonly Pick<BingXKline, "time" | "close">[],
): Promise<{
  days: CrossObservationDay[];
  closedThrough: string | null;
}> {
  const window = getBtcDailyPerformanceWindow(now);
  const today = getDubaiDay(now);
  const chartDays = window.days.filter((day) => day < today);
  if (!chartDays.length) return { days: [], closedThrough: null };
  const end = dubaiDayStart(today);
  const result = await db.execute(sql`
    SELECT observed_at, price
    FROM btc_regime_observations
    WHERE observed_at >= ${window.start}
      AND observed_at < ${end}
      AND price IS NOT NULL
      AND price > 0
    ORDER BY observed_at ASC
  `);
  const prices = new Map<string, { value: number; time: number }>();
  for (const row of result.rows as Record<string, unknown>[]) {
    const observedAt = new Date(row.observed_at as Date | string);
    const price = Number(row.price);
    if (!Number.isFinite(price) || price <= 0 || observedAt > now) continue;
    const day = getDubaiDay(observedAt);
    const existing = prices.get(day);
    if (!existing || observedAt.getTime() > existing.time) {
      prices.set(day, { value: price, time: observedAt.getTime() });
    }
  }
  const candlePrices = new Map<string, { value: number; time: number }>();
  for (const candle of priceCandles) {
    const closeAt = new Date(candle.time + 86_400_000);
    const value = Number(candle.close);
    if (
      !Number.isFinite(candle.time) ||
      !Number.isFinite(value) ||
      value <= 0 ||
      closeAt > now
    ) {
      continue;
    }
    const day = getDubaiDay(closeAt);
    if (day >= today || !chartDays.includes(day)) continue;
    const existing = candlePrices.get(day);
    if (!existing || closeAt.getTime() > existing.time) {
      candlePrices.set(day, { value, time: closeAt.getTime() });
    }
  }
  for (const [day, candlePrice] of candlePrices) {
    if (!prices.has(day)) prices.set(day, candlePrice);
  }

  const dominance = await loadBtcDominanceObservations(now);
  const dominanceByDay = new Map<
    string,
    { value: number; time: number; source: "coinglass" | "coingecko" }
  >();
  for (const point of dominance) {
    const at = new Date(point.observedAt);
    if (at >= end || point.value <= 0 || point.value > 100) continue;
    const day = getDubaiDay(at);
    const existing = dominanceByDay.get(day);
    const preferred =
      existing?.source === "coinglass" && point.source === "coingecko"
        ? false
        : existing?.source !== "coinglass" && point.source === "coinglass"
          ? true
          : !existing || at.getTime() > existing.time;
    if (preferred) {
      dominanceByDay.set(day, {
        value: point.value,
        time: at.getTime(),
        source: point.source,
      });
    }
  }
  const days = chartDays.map((day): CrossObservationDay => {
    const price = prices.get(day);
    const dom = dominanceByDay.get(day);
    return {
      day,
      btcPrice: price?.value ?? null,
      btcDominance: dom?.value ?? null,
      dominanceObservedAt: dom ? new Date(dom.time) : null,
      dominanceSource: dom?.source ?? null,
    };
  });
  return { days, closedThrough: chartDays.at(-1) ?? null };
}

export async function reconcileBtcCrossAlerts(
  now = new Date(),
  suppliedCandles?: readonly Pick<BingXKline, "time" | "close">[],
): Promise<BtcCrossHistory> {
  // Fetch/cache confirmed market data before opening the transaction; no
  // provider/network work is allowed while holding the reconciliation lock.
  const candles = suppliedCandles ?? (await getBtcDailyCandles());
  const { days, closedThrough } = await loadObservations(now, candles);
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext('btc_cross_alert_reconcile'))`,
    );
    const stateResult = await tx.execute(sql`
      SELECT
        to_char(anchor_day, 'YYYY-MM-DD') AS anchor_day,
        anchor_btc_price,
        anchor_btc_dominance,
        to_char(activation_day, 'YYYY-MM-DD') AS activation_day
      FROM btc_cross_alert_state
      WHERE id = 1
      FOR UPDATE
    `);
    const state = (stateResult.rows as Record<string, unknown>[])[0];
    let anchor: Anchor | null =
      state?.anchor_day != null &&
      state.anchor_btc_price != null &&
      state.anchor_btc_dominance != null
        ? {
            day: formatPgDate(String(state.anchor_day)),
            btcPrice: Number(state.anchor_btc_price),
            btcDominance: Number(state.anchor_btc_dominance),
          }
        : null;
    let activationDay =
      state?.activation_day == null
        ? null
        : formatPgDate(String(state.activation_day));
    if (!state) {
      const firstJoint = days.find(
        (point) => point.btcPrice != null && point.btcDominance != null,
      );
      if (firstJoint) {
        anchor = {
          day: firstJoint.day,
          btcPrice: firstJoint.btcPrice!,
          btcDominance: firstJoint.btcDominance!,
        };
      }
      // The first reconciliation establishes the baseline at the newest
      // completed day; it must never emit historical crossings.
      activationDay = anchor ? closedThrough : null;
      await tx.execute(sql`
        INSERT INTO btc_cross_alert_state
          (id, anchor_day, anchor_btc_price, anchor_btc_dominance, activation_day, last_evaluated_day)
        VALUES
          (1, ${anchor?.day ?? null}, ${anchor?.btcPrice ?? null},
           ${anchor?.btcDominance ?? null}, ${activationDay}, ${activationDay})
      `);
    } else if (!anchor) {
      const firstJoint = days.find(
        (point) => point.btcPrice != null && point.btcDominance != null,
      );
      if (firstJoint) {
        anchor = {
          day: firstJoint.day,
          btcPrice: firstJoint.btcPrice!,
          btcDominance: firstJoint.btcDominance!,
        };
        activationDay = closedThrough;
        await tx.execute(sql`
          UPDATE btc_cross_alert_state
          SET anchor_day = ${anchor.day},
              anchor_btc_price = ${anchor.btcPrice},
              anchor_btc_dominance = ${anchor.btcDominance},
              activation_day = ${activationDay},
              last_evaluated_day = ${activationDay},
              updated_at = now()
          WHERE id = 1 AND anchor_day IS NULL
        `);
      }
    } else if (activationDay == null) {
      // Upgrade/repair path: do not infer crossings before an explicit cursor.
      activationDay = closedThrough;
      await tx.execute(sql`
        UPDATE btc_cross_alert_state
        SET activation_day = ${activationDay},
            last_evaluated_day = COALESCE(last_evaluated_day, ${activationDay}),
            updated_at = now()
        WHERE id = 1 AND activation_day IS NULL
      `);
    }
    if (anchor && activationDay && closedThrough) {
      const history = buildBtcCrossHistory(days, anchor);
      // Bounded history is intentionally re-evaluated each pass so late daily
      // observations can complete a formerly gapped pair. The immutable
      // activation date prevents retroactive initial alerts; the unique day
      // index prevents repeats.
      for (const event of findCrossingEvents(history, activationDay)) {
        await tx.execute(sql`
          INSERT INTO btc_cross_alert_events (day, direction, btc_price, btc_dominance)
          VALUES (${event.day}, ${event.direction}, ${event.btcPrice}, ${event.btcDominance})
          ON CONFLICT (day) DO NOTHING
        `);
      }
    }
    return buildBtcCrossHistory(days, anchor);
  });
}

export async function getBtcCrossAlerts() {
  const result = await db.execute(sql`
    SELECT e.id, to_char(e.day, 'YYYY-MM-DD') AS day, e.direction,
           e.btc_price, e.btc_dominance, s.read_at,
           COUNT(*) FILTER (WHERE s.read_at IS NULL) OVER () AS unread_count
    FROM btc_cross_alert_events e
    LEFT JOIN btc_cross_alert_owner_state s
      ON s.event_id = e.id AND s.owner_key = ${OWNER_KEY}
    ORDER BY e.day DESC
  `);
  const rows = result.rows as Record<string, unknown>[];
  return {
    unreadCount: rows.length ? Number(rows[0]!.unread_count) : 0,
    events: rows.map((row) => ({
      id: Number(row.id),
      day: formatPgDate(String(row.day)),
      direction: String(row.direction),
      btcPrice: Number(row.btc_price),
      btcDominance: Number(row.btc_dominance),
      readAt:
        row.read_at == null
          ? null
          : new Date(row.read_at as Date | string).toISOString(),
    })),
  };
}

export async function markBtcCrossAlertRead(id: number): Promise<boolean> {
  const result = await db.execute(sql`
    INSERT INTO btc_cross_alert_owner_state (owner_key, event_id, read_at)
    SELECT ${OWNER_KEY}, id, now()
    FROM btc_cross_alert_events
    WHERE id = ${id}
    ON CONFLICT (owner_key, event_id)
    DO UPDATE SET read_at = COALESCE(
      btc_cross_alert_owner_state.read_at,
      EXCLUDED.read_at
    )
    RETURNING event_id
  `);
  return result.rows.length > 0;
}
