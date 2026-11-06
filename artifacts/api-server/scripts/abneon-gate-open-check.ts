/**
 * READ-ONLY check (owner 2026-11-06): which OPEN ABNeon positions the new pre-touch volume gate
 * (abneon-volume-gate.ts: ≥ 11 of 12 1H bars before the first touch above their 20-bar average on
 * CoinGlass aggregated futures volume) would not have let through. Writes nothing to the database.
 *
 * For every open tracked neon_support_bounce row: the detector event (arm, trigger, zone top) from
 * stealth_abneon_shadow_candidates, BingX 1H candles, CoinGlass aggregated 1H volume → blue count.
 * Prints a CSV: tracked_id, symbol, detected_at, armed_at, trigger, zone_top, blue, verdict.
 *
 * Run (from artifacts/api-server): pnpm dlx tsx scripts/abneon-gate-open-check.ts
 */
import { pool } from "@workspace/db";
import { preTouchBlueCount, ABNEON_PRE_TOUCH_BLUE_MIN } from "../src/lib/abneon-volume-gate.js";
import { cgHistory } from "./study-v2/cg.js";
import { ensureDir, klines } from "./study-v2/lib.js";

const H1 = 3_600_000;
const CACHE = "../../reports/.cache-gatecheck";

async function main() {
  ensureDir(CACHE);
  const open = await pool.query<{ id: number; symbol: string; signal_id: number; detected_at: Date }>(
    `SELECT ts.id, ts.symbol, ts.signal_id, s.detected_at
       FROM tracked_signals ts JOIN signals s ON s.id = ts.signal_id
      WHERE ts.sentiment_key = 'neon_support_bounce' AND ts.status IN ('active', 'in_run')
      ORDER BY ts.id`,
  );
  const now = Math.floor(Date.now() / H1) * H1;
  const lines = ["tracked_id,symbol,detected_at,armed_at,trigger_at,zone_top,blue_of_12,verdict"];
  for (const r of open.rows) {
    const det = new Date(r.detected_at).getTime();
    const ev = await pool.query<{ frozen_level: number; armed_at: Date; trigger_candle_at: Date }>(
      `SELECT frozen_level, armed_at, trigger_candle_at FROM stealth_abneon_shadow_candidates
        WHERE symbol = $1 AND detection_method = 'abneon_support_bounce' AND trigger_candle_at IS NOT NULL
          AND trigger_candle_at <= to_timestamp($2 / 1000.0) + interval '2 hours'
        ORDER BY trigger_candle_at DESC LIMIT 1`,
      [r.symbol, det],
    );
    const e = ev.rows[0];
    const trig = e ? new Date(e.trigger_candle_at).getTime() : null;
    if (!e || trig === null || Math.abs(det - trig) > 6 * H1) {
      lines.push([r.id, r.symbol, new Date(det).toISOString(), "", "", "", "", "no_event"].join(","));
      continue;
    }
    const arm = new Date(e.armed_at).getTime();
    const start = Math.min(arm, trig) - 80 * H1;
    let verdict = "no_data", blue: number | string = "";
    try {
      const h1 = await klines(CACHE, r.symbol, "1h", start, Math.min(now, trig + 2 * H1));
      const agg = await cgHistory(CACHE, r.symbol, "aggfut", start, Math.min(now, trig + 2 * H1));
      const usd = new Map<number, number>([...(agg ?? new Map()).values()].map((b) => [b.time, b.buy + b.sell]));
      const g = preTouchBlueCount({ candles1h: h1, aggUsdByTime: usd, armCandleTime: arm, triggerCandleTime: trig, zoneTop: Number(e.frozen_level) });
      if (g.ok) { blue = g.blue; verdict = g.blue >= ABNEON_PRE_TOUCH_BLUE_MIN ? "pass" : "close"; }
      else verdict = `no_data_${g.reason}`;
    } catch (err) {
      verdict = `error_${String(err).slice(0, 60).replace(/,/g, ";")}`;
    }
    lines.push([r.id, r.symbol, new Date(det).toISOString(), new Date(arm).toISOString(), new Date(trig).toISOString(), e.frozen_level, blue, verdict].join(","));
  }
  console.log(lines.join("\n"));
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
