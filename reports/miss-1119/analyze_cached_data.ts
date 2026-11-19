import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { computeSupportZones } from "../../artifacts/api-server/src/lib/stealth-abneon-detectors.js";
import {
  H4_MS,
  D1_MS,
  isNeonVsaBright,
  neonBreakoutColour,
  neonLevelCrossing4h,
  type NlCandle,
} from "../../artifacts/api-server/src/lib/stealth-neon-level-breakout.js";
import {
  LUCY_LONG_BARS,
  closesAboveMiddle,
  lucyColour,
  touchVolumeNotGrey,
} from "../../artifacts/api-server/src/lib/abneon-volume-gate.js";
import { ruleEntryOnArm } from "../../artifacts/api-server/src/lib/abneon-rule-entry.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const CACHE = resolve(ROOT, "reports/.cache");
const OUT = resolve(ROOT, "reports/miss-1119");
const SYMBOLS = ["FTR-USDT", "IRYS-USDT", "LUNC-USDT", "PIPPIN-USDT", "SENT-USDT", "VELVET-USDT"];
const H1 = 3_600_000;
const H4 = H4_MS;
const D1 = D1_MS;
const FROM = Date.parse("2026-11-14T00:00:00Z");
const TO = Date.parse("2026-11-19T12:00:00Z");
const STEALTH_FROM = Date.parse("2026-11-17T00:00:00Z");
const STEALTH_TO = Date.parse("2026-11-19T12:00:00Z");
const SIX = 6;

type Candle = NlCandle;
type VolumeItem = { time: number; buy: number; sell: number; cvd?: number };
type OiItem = { time: number; value: number };
type Json = Record<string, any>;
type Candidate = {
  id: number;
  symbol: string;
  detection_method: string;
  frozen_level: number | null;
  armed_at: string;
  trigger_candle_at: string | null;
  status: string;
  terminal_reason: string | null;
  live_eligible: boolean;
  volume_evidence: Json | null;
  created_at: string;
  updated_at: string;
};
type Tracked = {
  id: number;
  symbol: string;
  sentiment_key: string;
  detected_at: string;
  entry_price: number;
  exit_price: number | null;
  status: string;
  pnl_percent: number | null;
  peak_price: number | null;
  closed_at: string | null;
  updated_at: string;
  cancel_reason: string | null;
  before_neutral: Json | null;
  decision_metrics: Json | null;
  stealth_detection_method: string | null;
};

const iso = (t: number | null | undefined) =>
  t == null || !Number.isFinite(t) ? "" : new Date(t).toISOString();
const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;
const pct = (a: number | null, b: number | null) =>
  a != null && b != null && b !== 0 ? Math.round(((a / b - 1) * 100) * 100) / 100 : null;

async function json<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}
async function jsonl<T>(path: string): Promise<T[]> {
  const text = await readFile(path, "utf8");
  return text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as T);
}
function candles(path: string): Promise<{ from: number; to: number; items: number[][] }> {
  return json(path);
}
function toCandles(rows: number[][]): Candle[] {
  return rows.map(([time, open, high, low, close, volume]) => ({
    time, open, high, low, close, volume,
  })).filter((c) => Number.isFinite(c.time) && c.close > 0).sort((a, b) => a.time - b.time);
}
function cacheItems(items: VolumeItem[]): Map<number, number> {
  return new Map(items.map((x) => [x.time, x.buy + x.sell]).filter((x) => Number.isFinite(x[1]) && x[1] >= 0));
}
function h4BarsFromHourly(base4h: Candle[], h1: Candle[], end: number): Candle[] {
  const byTime = new Map(base4h.map((c) => [c.time, c]));
  const one = new Map(h1.map((c) => [c.time, c]));
  const first = Math.floor((base4h.at(-1)?.time ?? 0) / H4) * H4 + H4;
  for (let start = first; start + H4 <= end; start += H4) {
    const part = [0, 1, 2, 3].map((i) => one.get(start + i * H1));
    if (part.some((c) => !c)) continue;
    const bars = part as Candle[];
    byTime.set(start, {
      time: start,
      open: bars[0]!.open,
      high: Math.max(...bars.map((c) => c.high)),
      low: Math.min(...bars.map((c) => c.low)),
      close: bars[3]!.close,
      // BingX candle volume is retained only as price-candle metadata, never used for Lucy.
      volume: bars.reduce((sum, c) => sum + c.volume, 0),
    });
  }
  return [...byTime.values()].filter((c) => c.time + H4 <= end).sort((a, b) => a.time - b.time);
}
function aggregateFourHour(
  h4: Candle[],
  hourly: Map<number, number>,
  allowPartial = false,
): { values: Map<number, number>; coverage: Map<number, number> } {
  const values = new Map<number, number>();
  const coverage = new Map<number, number>();
  for (const c of h4) {
    const values4 = [0, 1, 2, 3].map((i) => hourly.get(c.time + i * H1));
    const known = values4.filter((x) => x != null).length;
    coverage.set(c.time, known);
    if (allowPartial) {
      values.set(c.time, values4.reduce<number>((sum, x) => sum + (x != null && x > 0 ? x : 0), 0));
    } else if (known === 4 && values4.every((x) => x != null && x > 0)) {
      values.set(c.time, (values4 as number[]).reduce((sum, x) => sum + x, 0));
    }
  }
  return { values, coverage };
}
function candleWindowColors(
  candles: Candle[],
  indexByTime: Map<number, number>,
  totalHourly: Map<number, number>,
  candleTime: number,
): { colour: string | null; coverage: number } {
  const i = indexByTime.get(candleTime);
  if (i == null || i < LUCY_LONG_BARS - 1) return { colour: null, coverage: 0 };
  const bars = candles.slice(i - LUCY_LONG_BARS + 1, i + 1);
  let coverage = 0;
  for (let j = 0; j < bars.length; j++) {
    if (j && bars[j]!.time - bars[j - 1]!.time !== H1) return { colour: null, coverage };
    if (!(totalHourly.get(bars[j]!.time)! > 0)) return { colour: null, coverage };
    coverage++;
  }
  const vol = bars.map((b) => totalHourly.get(b.time)!);
  return { colour: lucyColour(vol, vol.length - 1), coverage };
}
function oiAt(bars: OiItem[], closeAt: number) {
  let idx = -1;
  for (let i = 0; i < bars.length; i++) {
    if (bars[i]!.time + 15 * 60_000 <= closeAt) idx = i;
    else break;
  }
  if (idx < 0) return { time: null, value: null, change15mPct: null };
  const now = bars[idx]!;
  const prev = idx > 0 ? bars[idx - 1]! : null;
  return {
    time: now.time,
    value: now.value,
    change15mPct: prev && prev.value > 0 ? pct(now.value, prev.value) : null,
  };
}
function csvCell(v: unknown): string {
  const s = v == null ? "" : typeof v === "string" ? v : typeof v === "object" ? JSON.stringify(v) : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}
async function writeCsv(name: string, rows: Json[]) {
  const columns = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const text = [columns.join(","), ...rows.map((r) => columns.map((c) => csvCell(r[c])).join(","))].join("\n") + "\n";
  await writeFile(resolve(OUT, name), text);
}

async function main() {
  const candidates = await jsonl<Candidate>(resolve(OUT, "shadow_candidates.jsonl"));
  const tracked = await jsonl<Tracked>(resolve(OUT, "tracked_signals_all.jsonl"));
  const prescan = await jsonl<Json>(resolve(OUT, "prescan_snapshots.jsonl"));
  const prescanHistory = await jsonl<Json>(resolve(OUT, "prescan_history.jsonl"));
  const prescanTracker = await jsonl<Json>(resolve(OUT, "prescan_tracker.jsonl"));
  const decisions = await jsonl<Json>(resolve(OUT, "pattern_decisions.jsonl"));
  const rejects = await jsonl<Json>(resolve(OUT, "reject_reason_summary.jsonl"));

  const all = new Map<string, {
    h1: Candle[]; h4: Candle[]; d1: Candle[];
    fut1: Map<number, number>; spot1: Map<number, number>;
    fut4: Map<number, number>; spot4: Map<number, number>;
    fut4Coverage: Map<number, number>; h1Color: Map<number, string | null>;
    d1OpenTimes: number[]; oi15: OiItem[]; spotMissing: boolean;
  }>();

  for (const symbol of SYMBOLS) {
    const [h1Raw, h4Raw, d1Raw, futRaw, spotRaw, oiRaw] = await Promise.all([
      candles(resolve(CACHE, `${symbol}_1h.json`)),
      candles(resolve(CACHE, `${symbol}_4h.json`)),
      candles(resolve(CACHE, `${symbol}_1d.json`)),
      json<{ items: VolumeItem[] }>(resolve(CACHE, `${symbol}_cg_aggfut.json`)),
      json<{ items: VolumeItem[] }>(resolve(CACHE, `${symbol}_cg_aggspot.json`)),
      json<{ items: OiItem[] }>(resolve(CACHE, `${symbol}_cg15m_oi.json`)),
    ]);
    const h1 = toCandles(h1Raw.items).filter((c) => c.time + H1 <= TO);
    const h4 = h4BarsFromHourly(toCandles(h4Raw.items), h1, TO);
    const d1 = toCandles(d1Raw.items).filter((c) => c.time + D1 <= TO);
    const fut1 = cacheItems(futRaw.items ?? []);
    const spot1 = cacheItems(spotRaw.items ?? []);
    const total1 = new Map<number, number>();
    for (const [time, fut] of fut1) {
      if (fut > 0) total1.set(time, fut + Math.max(0, spot1.get(time) ?? 0));
    }
    const h1Index = new Map(h1.map((c, i) => [c.time, i]));
    const h1Color = new Map<number, string | null>();
    for (const c of h1) h1Color.set(c.time, candleWindowColors(h1, h1Index, total1, c.time).colour);
    const fut4 = aggregateFourHour(h4, fut1);
    const spot4 = aggregateFourHour(h4, spot1, true);
    all.set(symbol, {
      h1, h4, d1, fut1, spot1, fut4: fut4.values, spot4: spot4.values,
      fut4Coverage: fut4.coverage, h1Color, d1OpenTimes: d1.map((c) => c.time),
      oi15: (oiRaw.items ?? []).sort((a, b) => a.time - b.time),
      spotMissing: (spotRaw.items ?? []).length === 0,
    });
  }

  const zoneRows: Json[] = [];
  const stealthRows: Json[] = [];
  const crossings: Json[] = [];
  for (const symbol of SYMBOLS) {
    const d = all.get(symbol)!;
    const h4Index = new Map(d.h4.map((c, i) => [c.time, i]));
    const h1Index = new Map(d.h1.map((c, i) => [c.time, i]));
    const zonesByEffectiveDailyClose = new Map<number, ReturnType<typeof computeSupportZones>>();
    for (const bar of d.h4) {
      const closeAt = bar.time + H4;
      if (closeAt < STEALTH_FROM || closeAt > STEALTH_TO) continue;
      const closedDaily = d.d1.filter((c) => c.time + D1 <= closeAt);
      const dailyCloseAt = closedDaily.at(-1)?.time + D1 || 0;
      let zones = zonesByEffectiveDailyClose.get(dailyCloseAt);
      if (!zones) {
        zones = computeSupportZones(closedDaily);
        zonesByEffectiveDailyClose.set(dailyCloseAt, zones);
        zones.forEach((z, i) => zoneRows.push({
          symbol, zones_effective_at: iso(dailyCloseAt), zone_index_returned_by_detector: i + 1,
          top: z.top, bottom: z.bottom, center: z.center, pivot_count: z.count,
          closed_daily_bars: closedDaily.length,
        }));
      }
      const idx = h4Index.get(bar.time)!;
      const prefix = d.h4.slice(0, idx + 1);
      const cross = neonLevelCrossing4h(prefix, bar.time, zones);
      const colour = neonBreakoutColour(prefix, d.fut4, d.spot4);
      const cov = d.fut4Coverage.get(bar.time) ?? 0;
      const oi = oiAt(d.oi15, closeAt);
      const row = {
        symbol, candle_open_utc: iso(bar.time), candle_close_utc: iso(closeAt),
        open: bar.open, high: bar.high, low: bar.low, close: bar.close,
        previous_close: prefix.at(-2)?.close ?? null,
        daily_zones: zones,
        price_crossed_daily_zone_top: cross != null,
        crossed_level_top: cross?.level.top ?? null,
        crossed_level_bottom: cross?.level.bottom ?? null,
        crossed_zones: cross?.crossed ?? [],
        futures_agg_4h_usd: d.fut4.get(bar.time) ?? null,
        spot_agg_4h_usd: d.spotMissing ? 0 : d.spot4.get(bar.time) ?? null,
        futures_hour_coverage_in_4h: cov,
        lucy_120_bar_coverage: prefix.length >= LUCY_LONG_BARS
          ? prefix.slice(-LUCY_LONG_BARS).filter((c) => d.fut4.has(c.time)).length : prefix.length,
        lucy_volume_colour: colour,
        lucy_bright_M_or_W: isNeonVsaBright(colour),
        oi15m_last_closed_at: oi.time == null ? null : iso(oi.time + 15 * 60_000),
        oi15m_close: oi.value,
        oi15m_change_pct: oi.change15mPct,
        recheck_plus_5m: "historical_recheck_not_durable_in_DB; deployment_log_not_available",
        recheck_plus_10m: "historical_recheck_not_durable_in_DB; deployment_log_not_available",
        recheck_plus_15m: "historical_recheck_not_durable_in_DB; deployment_log_not_available",
      };
      stealthRows.push(row);
      if (cross) crossings.push({ ...row, event_type: "stealth_price_cross" });
    }
  }

  const abCandidates = candidates.filter((c) => c.detection_method === "abneon_support_bounce");
  const candidateRows: Json[] = [];
  const touch4hRows: Json[] = [];
  const touchEvents = new Map<string, Json>();
  for (const c of abCandidates) {
    const d = all.get(c.symbol);
    if (!d) continue;
    const ev = c.volume_evidence?.detectorEvidence ?? {};
    const ruleEv = ev.ruleEntry ?? {};
    const zone = ruleEv.zone ?? {
      top: ev.supportTop ?? c.frozen_level,
      bottom: ev.supportBottom ?? null,
    };
    if (!(Number(zone.top) > 0 && Number(zone.bottom) > 0)) continue;
    const armTime = Number(ev.armCandleTime) || Date.parse(c.armed_at);
    const observedAt = Date.parse(c.updated_at);
    const h1Closed = d.h1.filter((x) => x.time + H1 <= observedAt);
    const h4Closed = d.h4.filter((x) => x.time + H4 <= observedAt);
    const result = await ruleEntryOnArm({
      candles1h: h1Closed,
      candles4h: h4Closed,
      zone: { top: Number(zone.top), bottom: Number(zone.bottom) },
      armTime,
      nowMs: observedAt,
      lucy: async (triggerCandleTime, closeAt) => touchVolumeNotGrey({
        candles1h: h1Closed,
        candles4h: h4Closed,
        agg4hUsdByTime: d.fut4,
        spot4hUsdByTime: d.spotMissing ? null : d.spot4,
        armCandleTime: armTime,
        triggerCandleTime,
        zoneTop: Number(zone.top),
        nowMs: closeAt,
      }),
    });

    const firstTest = h1Closed.find((x) => x.time >= armTime && x.low <= Number(zone.top) * 1.02) ?? null;
    let lowest = Infinity;
    let lowestAt: number | null = null;
    const greens: Json[] = [];
    if (firstTest) {
      let started = false;
      for (const b of h1Closed) {
        if (b.time < firstTest.time) continue;
        started = true;
        if (!started) continue;
        const closeAt = b.time + H1;
        if (b.low < lowest) { lowest = b.low; lowestAt = closeAt; }
        if (b.close > b.open && b.close >= Number(zone.bottom)) {
          greens.push({
            candle_open_utc: iso(b.time), candle_close_utc: iso(closeAt),
            open: b.open, low: b.low, close: b.close,
            hours_after_current_low: lowestAt == null ? null : Math.round(((closeAt - lowestAt) / H1) * 100) / 100,
            within_R8_8h_window: lowestAt != null && closeAt - lowestAt <= 8 * H1,
            Lucy_1h_colour: d.h1Color.get(b.time) ?? null,
          });
        }
      }
    }
    const touchTime = firstTest?.time ?? null;
    const volumeTouchTime = result.status === "entry"
      ? result.touch.firstTouchTime
      : touchTime;
    const gateH4Bar = volumeTouchTime == null ? null : d.h4
      .filter((x) => x.time <= volumeTouchTime && x.time + H4 <= observedAt)
      .at(-1) ?? null;
    const gateH4Start = gateH4Bar?.time ?? null;
    const afterTestH4Start = touchTime == null ? null : Math.floor(touchTime / H4) * H4;
    const touchColours = result.status === "entry"
      ? result.touch.colours
      : result.status === "void"
        ? result.colours ?? []
        : ruleEv.colours ?? [];
    const firstBrightColourIx = touchColours.findIndex((colour: string) => colour !== "N");
    const gateFirstBright4h = firstBrightColourIx >= 0 && gateH4Start != null
      ? gateH4Start + firstBrightColourIx * H4 : null;
    const h1Bright = touchTime == null ? null : d.h1.find((x) => x.time >= touchTime && d.h1Color.get(x.time) != null && d.h1Color.get(x.time) !== "N");
    const h4BrightAfterTest = afterTestH4Start == null ? null : d.h4.find((x) =>
      x.time >= afterTestH4Start &&
      (neonBreakoutColour(d.h4.slice(0, d.h4.findIndex((c) => c.time === x.time) + 1), d.fut4, d.spotMissing ? null : d.spot4) ?? "N") !== "N",
    );
    const firedSignal = c.status === "fired"
      ? tracked.find((t) => t.symbol === c.symbol && t.sentiment_key === "neon_support_bounce" &&
        Date.parse(t.detected_at) >= Date.parse(c.armed_at) - 2 * H1 &&
        Date.parse(t.detected_at) <= observedAt + 2 * H1)
      : undefined;
    const h1BrightAt = h1Bright?.time ?? null;
    const actualR8 = ruleEv.void ?? ruleEv.detectorReason ?? (ruleEv.detectorStatus === "qualified" ? "qualified" : null);
    let firstUpperBright4hCloseAt: number | null = null;
    if (touchTime != null) {
      for (const bar of d.h4) {
        if (bar.time < (gateH4Start ?? afterTestH4Start!) || bar.time + H4 > TO) continue;
        const i = d.h4.findIndex((x) => x.time === bar.time);
        const colour = neonBreakoutColour(d.h4.slice(0, i + 1), d.fut4, d.spotMissing ? null : d.spot4);
        const upper = closesAboveMiddle(bar);
        const oi = oiAt(d.oi15, bar.time + H4);
        const row4 = {
          candidate_id: c.id, symbol: c.symbol,
          R8_test_1h_open_utc: iso(touchTime), test_low: firstTest?.low ?? null,
          Lucy_volume_touch_1h_derived: iso(volumeTouchTime),
          production_or_cached_gate_4h_open_utc: iso(gateH4Start),
          is_4h_bar_selected_for_touch_gate: bar.time === gateH4Start,
          touch_gate_colour_from_record_or_replay: bar.time === gateH4Start ? touchColours[0] ?? null : null,
          candidate_zone_top: Number(zone.top), candidate_zone_bottom: Number(zone.bottom),
          candle_4h_open_utc: iso(bar.time), candle_4h_close_utc: iso(bar.time + H4),
          open: bar.open, high: bar.high, low: bar.low, close: bar.close,
          futures_agg_usd: d.fut4.get(bar.time) ?? null,
          spot_agg_usd: d.spotMissing ? 0 : d.spot4.get(bar.time) ?? 0,
          futures_1h_components_present: d.fut4Coverage.get(bar.time) ?? 0,
          lucy_120_bar_coverage: d.h4.slice(Math.max(0, i - LUCY_LONG_BARS + 1), i + 1)
            .filter((x) => d.fut4.has(x.time)).length,
          lucy_colour_cached_hourly_aggregate: colour,
          non_grey: colour != null && colour !== "N",
          close_in_upper_half: upper,
          first_non_grey_close_upper_half_after_test: false,
          oi15m_last_closed_at_utc: (oi.time == null) ? null : iso(oi.time + 15 * 60_000),
          oi15m_close: oi.value, oi15m_change_pct: oi.change15mPct,
        };
        if (firstUpperBright4hCloseAt == null && row4.non_grey && upper) {
          firstUpperBright4hCloseAt = bar.time + H4;
          row4.first_non_grey_close_upper_half_after_test = true;
        }
        touch4hRows.push(row4);
      }
    }
    const row = {
      candidate_id: c.id, symbol: c.symbol, armed_at: c.armed_at,
      observed_at: c.updated_at, frozen_level: c.frozen_level,
      zone_top: Number(zone.top), zone_bottom: Number(zone.bottom),
      production_status: c.status, production_terminal_reason: c.terminal_reason,
      production_live_eligible: c.live_eligible,
      production_R8_void: ruleEv.void ?? null,
      production_R8_detector_reason: ruleEv.detectorReason ?? ev.reason ?? null,
      production_touch_colours: ruleEv.colours ?? null,
      production_rule_status: ruleEv.detectorStatus ?? null,
      cached_R8_status: result.status,
      cached_R8_reason: result.status === "void" ? result.reason : result.status === "waiting" ? result.reason : "entry",
      cached_R8_colours: result.status === "entry" ? result.touch.colours : [],
      first_test_1h_open_utc: iso(touchTime),
      first_test_1h_low: firstTest?.low ?? null,
      lowest_test_low: Number.isFinite(lowest) ? lowest : null,
      lowest_test_low_at: iso(lowestAt),
      green_1h_candidates_within_and_outside_8h: greens,
      green_1h_candidates_after_final_low_within_8h: greens.filter((g) => {
        const closeAt = Date.parse(String(g.candle_close_utc));
        return lowestAt != null && closeAt >= lowestAt && closeAt - lowestAt <= 8 * H1;
      }),
      first_bright_Lucy_1h_at_or_after_test_utc: iso(h1BrightAt),
      hours_touch_to_first_bright_Lucy_1h: touchTime != null && h1BrightAt != null ? (h1BrightAt - touchTime) / H1 : null,
      Lucy_volume_touch_time_1h_derived: iso(volumeTouchTime),
      Lucy_volume_gate_selected_4h_open_utc: iso(gateH4Start),
      Lucy_volume_touch_colours: touchColours,
      first_bright_Lucy_4h_bar_close_at_or_after_R8_test_utc: h4BrightAfterTest ? iso(h4BrightAfterTest.time + H4) : null,
      hours_R8_test_to_first_bright_Lucy_4h_bar_close: touchTime != null && h4BrightAfterTest
        ? (h4BrightAfterTest.time + H4 - touchTime) / H1 : null,
      first_non_grey_4h_close_upper_half_after_test_utc: iso(firstUpperBright4hCloseAt),
      hours_test_to_first_non_grey_4h_close_upper_half: touchTime != null && firstUpperBright4hCloseAt != null
        ? (firstUpperBright4hCloseAt - touchTime) / H1 : null,
      T0_tracked_signal_at: firedSignal?.detected_at ?? null,
      T0_tracked_signal_id: firedSignal?.id ?? null,
      hours_touch_to_T0: touchTime != null && firedSignal ? (Date.parse(firedSignal.detected_at) - touchTime) / H1 : null,
      oi15m_at_touch: touchTime == null ? null : oiAt(d.oi15, touchTime + H1),
      oi15m_at_T0: firedSignal ? oiAt(d.oi15, Date.parse(firedSignal.detected_at)) : null,
      production_rule_entry_detail: ruleEv,
      evidence_detector_reason: ev.reason ?? null,
    };
    candidateRows.push(row);

    if (touchTime != null) {
      const key = `${c.symbol}|${Number(zone.top)}|${Number(zone.bottom)}|${touchTime}`;
      const old = touchEvents.get(key);
      if (old) {
        (old.candidate_ids as number[]).push(c.id);
      } else {
        touchEvents.set(key, {
          symbol: c.symbol, zone_top: Number(zone.top), zone_bottom: Number(zone.bottom),
          touch_1h_open_utc: iso(touchTime), touch_1h_low: firstTest?.low ?? null,
          touch_1h_close: firstTest?.close ?? null, candidate_ids: [c.id],
        });
      }
    }
  }

  const hypotheticalRows: Json[] = [];
  for (const event of touchEvents.values()) {
    const d = all.get(event.symbol)!;
    const touchTime = Date.parse(event.touch_1h_open_utc);
    const targetOpen = touchTime + 96 * H1;
    const entryBar = d.h1.find((x) => x.time >= targetOpen && x.time + H1 <= TO);
    if (!entryBar) {
      hypotheticalRows.push({
        ...event,
        first_closed_1h_bar_close_at_or_after_touch_plus_96h: iso(targetOpen + H1),
        hypothetical_entry_price: null,
        result_window_status: "96h entry not yet observed by 2026-11-19T12:00Z",
        observed_post_entry_hours: null,
        observed_high_after_entry: null,
        observed_high_at: null,
        observed_low_after_entry: null,
        observed_low_at: null,
      });
      continue;
    }
    const entryCloseAt = entryBar.time + H1;
    const until = Math.min(TO, entryCloseAt + 72 * H1);
    const future = d.h1.filter((x) => x.time >= entryCloseAt && x.time + H1 <= until);
    const hi = future.reduce<Candle | null>((best, x) => !best || x.high > best.high ? x : best, null);
    const lo = future.reduce<Candle | null>((best, x) => !best || x.low < best.low ? x : best, null);
    hypotheticalRows.push({
      ...event,
      first_closed_1h_bar_close_at_or_after_touch_plus_96h: iso(entryCloseAt),
      hypothetical_entry_price: entryBar.close,
      result_window_status: TO < entryCloseAt + 72 * H1 ? "72h outcome right-censored at data cutoff" : "72h complete",
      observed_post_entry_hours: future.length,
      observed_high_after_entry: hi?.high ?? null,
      observed_high_at: hi ? iso(hi.time) : null,
      observed_high_pct_from_entry: hi ? pct(hi.high, entryBar.close) : null,
      observed_low_after_entry: lo?.low ?? null,
      observed_low_at: lo ? iso(lo.time) : null,
      observed_low_pct_from_entry: lo ? pct(lo.low, entryBar.close) : null,
    });
  }

  const timingRows: Json[] = [];
  for (const t of tracked) {
    const detected = Date.parse(t.detected_at);
    if (detected < FROM || detected > TO || !["neon_support_bounce", "stealth_breakout"].includes(t.sentiment_key)) continue;
    const dm = t.decision_metrics ?? {};
    const isAb = t.sentiment_key === "neon_support_bounce";
    const level = isAb ? dm.neonLevel?.ruleEntry : dm.stealthNeonLevel;
    const breakoutOpen = isAb ? null : Date.parse(level?.candleOpenAt ?? "");
    const breakoutClose = isAb ? null : breakoutOpen! + (level?.tf === "1d" ? D1 : H4);
    const eventTime = isAb ? Number(level?.testTime) : breakoutClose!;
    const d = all.get(t.symbol)!;
    const h1Bright = Number.isFinite(eventTime)
      ? d.h1.find((x) => x.time >= eventTime && d.h1Color.get(x.time) != null && d.h1Color.get(x.time) !== "N")
      : undefined;
    const h4Start = isAb
      ? Number.isFinite(eventTime) ? Math.floor(eventTime / H4) * H4 : null
      : Number.isFinite(breakoutOpen!) ? breakoutOpen! : null;
    const h4Bright = h4Start == null ? undefined : d.h4.find((x) => {
      if (x.time < h4Start) return false;
      const i = d.h4.findIndex((y) => y.time === x.time);
      if (i < 0) return false;
      const colour = neonBreakoutColour(d.h4.slice(0, i + 1), d.fut4, d.spotMissing ? null : d.spot4);
      return colour != null && colour !== "N";
    });
    const outcome = (t.before_neutral as Json | null)?.status ?? t.status;
    const recordedColours = isAb ? String(level?.touchColours ?? "") : String(level?.volumeColour ?? "");
    const recordedGate4h = isAb && Number.isFinite(eventTime)
      ? d.h4.filter((x) => x.time <= eventTime && x.time + H4 <= detected).at(-1)
      : undefined;
    timingRows.push({
      symbol: t.symbol, tracked_signal_id: t.id, pattern: t.sentiment_key,
      outcome, t0: t.detected_at, entry_price: t.entry_price,
      event_or_touch_time: iso(eventTime),
      breakout_candle_open_at: isAb ? null : iso(breakoutOpen),
      breakout_candle_close_at: isAb ? null : iso(breakoutClose),
      lucy_1h_first_bright_at_or_after_touch: h1Bright ? iso(h1Bright.time) : null,
      hours_touch_to_bright_1h: h1Bright && Number.isFinite(eventTime) ? (h1Bright.time - eventTime) / H1 : null,
      lucy_4h_first_bright_candle_close_at_or_after_event: h4Bright ? iso(h4Bright.time + H4) : null,
      hours_event_close_or_touch_to_bright_4h_close: h4Bright && Number.isFinite(eventTime) ? (h4Bright.time + H4 - eventTime) / H1 : null,
      hours_event_close_or_R8_test_to_T0: Number.isFinite(eventTime) ? (detected - eventTime) / H1 : null,
      recorded_breakout_or_touch_colour: recordedColours || null,
      recorded_gate_4h_open_utc: recordedGate4h ? iso(recordedGate4h.time) : null,
      cached_Lucy_4h_colour_at_touch: h4Start == null ? null : neonBreakoutColour(d.h4.slice(0, d.h4.findIndex((x) => x.time === h4Start) + 1), d.fut4, d.spotMissing ? null : d.spot4),
    });
  }

  const scanCoverageRows: Json[] = [];
  for (const symbol of SYMBOLS) {
    const snaps = prescan.filter((x) => x.symbol === symbol && Date.parse(x.recorded_at ?? x.snapshot_at ?? x.cycle_at) >= FROM && Date.parse(x.recorded_at ?? x.snapshot_at ?? x.cycle_at) <= TO);
    const hist = prescanHistory.filter((x) => x.symbol === symbol && Date.parse(x.ts ?? x.recorded_at ?? x.snapshot_at ?? x.cycle_at) >= FROM && Date.parse(x.ts ?? x.recorded_at ?? x.snapshot_at ?? x.cycle_at) <= TO);
    const tracker = prescanTracker.find((x) => x.symbol === symbol);
    const dec = decisions.filter((x) => x.symbol === symbol);
    scanCoverageRows.push({
      symbol,
      production_prescan_snapshots: snaps.length,
      earliest_prescan_record_in_window: snaps.map((x) => x.recorded_at ?? x.snapshot_at ?? x.cycle_at).sort()[0] ?? null,
      latest_prescan_record_in_window: snaps.map((x) => x.recorded_at ?? x.snapshot_at ?? x.cycle_at).sort().at(-1) ?? null,
      production_prescan_history_rows: hist.length,
      prescan_tracker_cycle_count_current: tracker?.cycle_count ?? null,
      prescan_tracker_first_seen_at_current: tracker?.first_seen_at ? iso(Number(tracker.first_seen_at)) : null,
      pattern_decisions_in_export: dec.length,
      first_decision_in_export: dec.map((x) => x.decision_at).sort()[0] ?? null,
      last_decision_in_export: dec.map((x) => x.decision_at).sort().at(-1) ?? null,
      note: "Earliest stored prescan row is evidence of observation, not proof of first exchange-universe inclusion.",
    });
  }

  const signalRows = tracked.filter((t) => t.detected_at >= "2026-11-14T00:00:00" && t.detected_at <= "2026-11-19T12:00:00").map((t) => ({
    id: t.id, symbol: t.symbol, pattern: t.sentiment_key, detected_at: t.detected_at,
    status: t.status, outcome_before_neutral: t.before_neutral?.status ?? null,
    entry_price: t.entry_price, exit_price: t.exit_price, pnl_percent: t.pnl_percent,
    peak_price: t.peak_price, closed_at: t.closed_at, cancel_reason: t.cancel_reason,
  }));
  const eventRows = [
    ...crossings.map((c) => ({ symbol: c.symbol, event_type: "stealth_price_cross", event_at: c.candle_close_utc, linked_signal_id: null })),
    ...tracked.filter((t) => t.detected_at >= "2026-11-14T00:00:00" && t.detected_at <= "2026-11-19T12:00:00")
      .map((t) => ({ symbol: t.symbol, event_type: "tracked_signal_T0", event_at: t.detected_at, linked_signal_id: t.id })),
  ];
  const overlapRows: Json[] = [];
  for (const event of eventRows) {
    const eventAt = Date.parse(event.event_at);
    const other = tracked.filter((t) => {
      if (t.symbol !== event.symbol || t.id === event.linked_signal_id) return false;
      const start = Date.parse(t.detected_at);
      let end: number | null = t.closed_at ? Date.parse(t.closed_at) : null;
      const before = t.before_neutral ?? {};
      if (before.closedAt) end = Date.parse(before.closedAt);
      else if (t.status === "reclassified") end = Date.parse(t.updated_at);
      return start < eventAt && (end == null || end >= eventAt);
    });
    overlapRows.push({
      symbol: event.symbol, event_type: event.event_type, event_at: event.event_at,
      linked_signal_id: event.linked_signal_id,
      overlapping_position_count: other.length,
      overlapping_positions: other.map((t) => ({ id: t.id, pattern: t.sentiment_key, detected_at: t.detected_at, status: t.status, end_at: t.closed_at ?? (t.status === "reclassified" ? t.updated_at : null), cancel_reason: t.cancel_reason })),
      source_rule: "trackSignal selects same symbol with status active/in_run; then returns skip at watcher.ts:2460-2474, 2581-2615.",
    });
  }

  await writeCsv("daily_zones.csv", zoneRows);
  await writeCsv("stealth_4h_candles.csv", stealthRows);
  await writeCsv("abneon_candidates.csv", candidateRows);
  await writeCsv("abneon_touch_4h.csv", touch4hRows);
  await writeCsv("abneon_96h_entry_72h_observed.csv", hypotheticalRows);
  await writeCsv("signal_volume_timing.csv", timingRows);
  await writeCsv("scan_coverage.csv", scanCoverageRows);
  await writeCsv("signal_outcomes.csv", signalRows);
  await writeCsv("same_symbol_position_overlap.csv", overlapRows);
  await writeCsv("scan_reject_reason_summary.csv", rejects);

  const coverage = SYMBOLS.map((symbol) => {
    const d = all.get(symbol)!;
    const lastH1 = d.h1.at(-1)?.time ?? null;
    const lastH4 = d.h4.at(-1)?.time ?? null;
    const lastFut = [...d.fut1.keys()].sort((a, b) => a - b).at(-1) ?? null;
    const lastSpot = [...d.spot1.keys()].sort((a, b) => a - b).at(-1) ?? null;
    const lastOi = d.oi15.at(-1)?.time ?? null;
    return {
      symbol, h1_price_last_open: iso(lastH1), h4_price_last_open: iso(lastH4),
      cg_futures_1h_last_open: iso(lastFut), cg_spot_1h_last_open: iso(lastSpot),
      cg_spot_cache_empty: d.spotMissing, cg_oi15m_last_open: iso(lastOi),
    };
  });
  await writeCsv("data_coverage.csv", coverage);

  const summary = {
    window: { from: iso(FROM), to: iso(TO) },
    symbols: SYMBOLS,
    prescan_snapshots: prescan.length,
    prescan_history: prescanHistory.length,
    shadow_candidate_rows: candidates.length,
    abneon_candidates: abCandidates.length,
    pattern_decision_rows: decisions.length,
    tracked_signal_rows_all_time: tracked.length,
    stealth_4h_candles: stealthRows.length,
    daily_zone_rows: zoneRows.length,
    price_crosses: crossings.length,
    unique_abneon_touch_events: touchEvents.size,
    hypothetical_96h_rows: hypotheticalRows.length,
    abneon_touch_4h_rows: touch4hRows.length,
    tracked_signals_in_window: signalRows.length,
    same_symbol_events: overlapRows.length,
    volume_reconstruction: "CoinGlass aggregate 1h USD bars summed into 4h buckets; CoinGlass spot missing is treated as 0, futures coverage is required.",
    data_coverage: coverage,
    historical_deployment_logs_found: false,
    historical_rechecks: "No timestamped durable DB table found; deployment log lookups returned no rows.",
  };
  await writeFile(resolve(OUT, "analysis-manifest.json"), JSON.stringify(summary, null, 2) + "\n");
  console.log(JSON.stringify(summary));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
