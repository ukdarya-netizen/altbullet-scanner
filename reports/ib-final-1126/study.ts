import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { klines, type C } from "../../artifacts/api-server/scripts/study-v2/lib.js";
import { computeWyckoff } from "../../artifacts/api-server/src/lib/wyckoff-metrics.js";

type Obj = Record<string, any>;
type Outcome = "good" | "bad" | "open" | "ambiguous" | "no_price";
type Metric = { value: number | string | boolean | null; source: string; missingHint?: string };

const ROOT = process.cwd();
const OUT = join(ROOT, "reports/ib-final-1126");
const INPUT = join(OUT, ".input");
const CACHE = join(ROOT, "reports/.cache");
const H15 = 15 * 60_000;
const H1 = 60 * 60_000;
const D1 = 24 * H1;
const FROM = Date.parse("2026-11-09T00:00:00Z");
const SPLIT = Date.parse("2026-11-18T00:00:00Z");
const LEADER_START = Date.parse("2026-11-24T06:38:16.146Z");
const TAKER_THRESHOLDS = [-2, -1, -0.5, -0.25, 0, 0.25, 0.5, 1, 2] as const;
const LEADER_NAMES = [
  ["GTA6", "GTA6-USDT"],
  ["SSV", "SSV-USDT"],
  ["BULLA", "BULLA-USDT"],
  ["ELSA", "ELSA-USDT"],
  ["EVAA", "EVAA-USDT"],
  ["NES", "NES-USDT"],
  ["MANTRA", "MANTRA-USDT"],
  ["PRIORS", "PRIORS-USDT"],
  ["PIEVERSE", "PIEVERSE-USDT"],
  ["VRAX", "VRAX-USDT"],
  ["牛来", "NIUBI-USDT"],
  ["BTW", "BTW-USDT"],
  ["MOVE", "MOVE-USDT"],
  ["BLUR", "BLUR-USDT"],
] as const;

const METRIC_KEYS = [
  "price24h",
  "price3h",
  "price1h",
  "volumeMultiplier",
  "spotVolumeMultiplier",
  "lucy30mColour",
  "lucy30mColourPrev1",
  "lucy30mColourPrev2",
  "lucy30mColourPrev3",
  "lucy30mVolAvg20",
  "lucy30mVolAvg120",
  "welkin",
  "wyckoffPhase",
  "wyckoffReason",
  "wyckoffRangeBottom",
  "wyckoffRangeTop",
  "futTakerNetBuyPctPrev1h",
  "futTakerNetBuyPct",
  "spotTakerNetBuyPct",
  "spotTakerDominance",
  "spotNetBuy1h",
  "cvd15m",
  "cvd30m",
  "cvd1h",
  "cvd4h",
  "oi15m",
  "oi30m",
  "oi1h",
  "oi4h",
  "oi24h",
  "fundingRate",
  "liqLong1h",
  "liqLong24h",
  "liqRatio",
  "marketCapUsd",
  "spotVol24hUsd",
  "spotVolPctMcap",
  "btc24h",
  "eth24h",
  "candleVolumeUsd",
  "candleVolumeMult",
] as const;

function readJsonl(file: string): Obj[] {
  const path = join(INPUT, file);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Obj);
}

function readReportJsonl(file: string): Obj[] {
  const path = join(process.cwd(), file);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Obj);
}

function writeCsv(file: string, rows: Obj[], columns?: string[]): void {
  const keys = columns ?? [...new Set(rows.flatMap((row) => Object.keys(row)))];
  const cell = (v: unknown) => {
    if (v === null || v === undefined) return "";
    const text =
      typeof v === "object"
        ? JSON.stringify(v)
        : typeof v === "boolean"
          ? String(v)
          : String(v);
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const body = [keys.map(cell).join(","), ...rows.map((row) => keys.map((k) => cell(row[k])).join(","))].join("\n");
  writeFileSync(join(OUT, file), `${body}\n`);
}

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = typeof value === "object" ? JSON.stringify(value) : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function dateMs(value: unknown): number | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const time = typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

function iso(value: unknown): string | null {
  const t = dateMs(value);
  return t === null ? null : new Date(t).toISOString();
}

function num(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function pct(value: number | null): number | null {
  return value === null ? null : Math.round(value * 1000) / 1000;
}

function loadSignals(): Obj[] {
  return ["signals-0.jsonl", "signals-20.jsonl", "signals-40.jsonl", "signals-60.jsonl", "signals-80.jsonl"]
    .flatMap(readJsonl)
    .map((row) => ({
      ...row.signal,
      _extras: row.extras ?? {},
      _vsa: row.vsa ?? {},
      _wyckoff: row.wyckoff ?? {},
      _volumeColors: row.volume_colors ?? {},
      _source: "tracked_signals",
    }))
    .sort((a, b) => Number(a.id) - Number(b.id));
}

function reasonParts(event: Obj): string[] {
  const all = new Set<string>();
  const add = (reason: unknown) => {
    if (typeof reason !== "string" || !reason) return;
    for (const part of reason.split("+")) all.add(part);
  };
  add(event.decision_reason);
  add(event.reason);
  add(event.cancel_reason);
  for (const item of event.reason_chain ?? []) add(item.reason);
  for (const reason of event.metrics?.rejectReasons ?? []) add(reason);
  for (const reason of event.context?.rejectReasons ?? []) add(reason);
  for (const reason of event.reason_chain ?? []) {
    if (typeof reason === "string") add(reason);
  }
  return [...all];
}

function rollPdbCandidates(reviewRows: Obj[]): Obj[] {
  const days = readJsonl("candidates-2026-11-09.jsonl").length
    ? Array.from({ length: 18 }, (_, i) => `2026-11-${String(i + 9).padStart(2, "0")}`)
    : [];
  const context = new Map<number, Obj>();
  for (const day of days) {
    for (const row of readJsonl(`context-${day}.jsonl`)) context.set(Number(row.id), row.context ?? {});
  }
  const dailyRows = days.flatMap((day) => readJsonl(`candidates-${day}.jsonl`))
    .map((row) => ({ ...row, _candidate_source: "pattern_decision_snapshots daily export" }));
  const exactById = new Map<string, Obj>();
  for (const row of [...dailyRows, ...reviewRows]) {
    const id = String(row.id);
    const prior = exactById.get(id);
    if (!prior) {
      exactById.set(id, { ...row, _candidate_sources: [row._candidate_source] });
      continue;
    }
    const priorMetrics = prior.entry_metrics ?? {};
    const nextMetrics = row.entry_metrics ?? {};
    const priorCount = Object.keys(priorMetrics).length;
    const nextCount = Object.keys(nextMetrics).length;
    const primary = nextCount > priorCount ? row : prior;
    const secondary = primary === row ? prior : row;
    const exactReasons = new Map<string, number>();
    for (const item of [...(secondary.reason_chain ?? []), ...(primary.reason_chain ?? [])]) {
      const reason = typeof item === "string" ? item : item.reason;
      if (!reason) continue;
      const count = typeof item === "string" ? 1 : Number(item.count ?? 1);
      exactReasons.set(reason, Math.max(exactReasons.get(reason) ?? 0, count));
    }
    exactById.set(id, {
      ...secondary,
      ...primary,
      entry_metrics: { ...(secondary.entry_metrics ?? {}), ...(primary.entry_metrics ?? {}) },
      reason_chain: [...exactReasons.entries()].map(([reason, count]) => ({ reason, count })),
      context: context.get(Number(row.id)) ?? prior.context ?? row.context ?? {},
      _candidate_sources: [...new Set([...(prior._candidate_sources ?? []), row._candidate_source])],
    });
  }
  const rows = [...exactById.values()];
  rows.sort((a, b) => String(a.symbol).localeCompare(String(b.symbol)) || Date.parse(a.decision_at) - Date.parse(b.decision_at));
  const out: Obj[] = [];
  const lastBySymbol = new Map<string, Obj>();
  for (const row of rows) {
    const time = dateMs(row.decision_at);
    if (time === null) continue;
    const enriched = { ...row, context: context.get(Number(row.id)) ?? {}, _source: "pattern_decision_snapshots", _class: "rejected_candidate" };
    const prior = lastBySymbol.get(row.symbol);
    if (!prior || time - Number(prior._windowStart) >= D1) {
      enriched._windowStart = time;
      enriched._reasonCounts = new Map<string, number>();
      enriched._rolling_source_rows = 1;
      out.push(enriched);
      lastBySymbol.set(row.symbol, enriched);
      const counts = enriched._reasonCounts as Map<string, number>;
      for (const r of row.reason_chain ?? []) counts.set(r.reason, Number(r.count ?? 1));
      const chainReasons = new Set((row.reason_chain ?? []).map((r: Obj) => r.reason));
      for (const r of String(row.decision_reason ?? "").split("+")) if (r && !chainReasons.has(r)) counts.set(r, (counts.get(r) ?? 0) + 1);
    } else {
      prior._rolling_source_rows = Number(prior._rolling_source_rows ?? 1) + 1;
      prior._candidate_sources = [...new Set([...(prior._candidate_sources ?? []), ...(row._candidate_sources ?? [row._candidate_source])])];
      const reasons = Array.isArray(row.reason_chain) ? row.reason_chain : [];
      const counts = prior._reasonCounts as Map<string, number>;
      for (const r of reasons) counts.set(r.reason, (counts.get(r.reason) ?? 0) + Number(r.count ?? 1));
      const chainReasons = new Set(reasons.map((r: Obj) => r.reason));
      const own = String(row.decision_reason ?? "").split("+");
      for (const r of own) if (r && !chainReasons.has(r)) counts.set(r, (counts.get(r) ?? 0) + 1);
      prior._windowEnd = time;
    }
    const target = lastBySymbol.get(row.symbol)!;
    const counts = target._reasonCounts as Map<string, number>;
    target.reason_chain = [...counts.entries()].map(([reason, count]) => ({ reason, count }));
  }
  return out.map((row) => {
    const { _windowStart, _windowEnd, _reasonCounts, ...keep } = row;
    return { ...keep, window_start: iso(_windowStart), window_end: iso(_windowEnd ?? _windowStart) };
  });
}

function metric(event: Obj, key: string): Metric {
  if (event._class === "signal") {
    const s = event;
    const imp = s.impulse_decision_metrics ?? {};
    const ex = s._extras ?? {};
    const vsa = s._vsa ?? {};
    const wy = s._wyckoff ?? {};
    const color = s._volumeColors ?? {};
    const paths: Record<string, [unknown, string]> = {
      price24h: [imp.price24h ?? s.entry_price24h_pct ?? s.price_24h_at_fire, "tracked_signals.impulse_decision_metrics/tracked_signals"],
      price3h: [imp.price3h ?? s.entry_price_3h, "tracked_signals.impulse_decision_metrics/tracked_signals"],
      price1h: [imp.price1h ?? s.entry_price_1h, "tracked_signals.impulse_decision_metrics/tracked_signals"],
      volumeMultiplier: [imp.candleVolumeMult ?? imp.volumeMultiplier ?? s.entry_fut_vol_mult, "tracked_signals.impulse_decision_metrics/tracked_signals"],
      spotVolumeMultiplier: [imp.spotVolumeMultiplier ?? ex.spotVolumeMultiplier ?? s.entry_spot_vol_mult, "tracked_signals/signal_entry_extras"],
      lucy30mColour: [imp.lucy30mColour ?? imp.lucyVsa30mColour, "tracked_signals.impulse_decision_metrics"],
      lucy30mColourPrev1: [imp.lucy30mPrev1Colour, "tracked_signals.impulse_decision_metrics"],
      lucy30mColourPrev2: [imp.lucy30mPrev2Colour, "tracked_signals.impulse_decision_metrics"],
      lucy30mColourPrev3: [imp.lucy30mPrev3Colour, "tracked_signals.impulse_decision_metrics"],
      lucy30mVolAvg20: [imp.lucy30mVolAvg20, "tracked_signals.impulse_decision_metrics"],
      lucy30mVolAvg120: [imp.lucy30mVolAvg120, "tracked_signals.impulse_decision_metrics"],
      welkin: [imp.welkin ?? imp.welkinClass, "tracked_signals.impulse_decision_metrics"],
      wyckoffPhase: [wy.phase, "wyckoff_entry_metrics.metrics"],
      wyckoffReason: [wy.reason, "wyckoff_entry_metrics.metrics"],
      wyckoffRangeBottom: [wy.rangeBottom, "wyckoff_entry_metrics.metrics"],
      wyckoffRangeTop: [wy.rangeTop, "wyckoff_entry_metrics.metrics"],
      futTakerNetBuyPctPrev1h: [ex.futTakerNetBuyPctPrev1h ?? imp.futTakerNetBuyPctPrev1h, "signal_entry_extras/impulse_decision_metrics"],
      futTakerNetBuyPct: [imp.futTakerNetBuyPct ?? ex.futTakerNetBuyPct ?? s.entry_fut_taker_net_buy, "impulse_decision_metrics/signal_entry_extras/tracked_signals"],
      spotTakerNetBuyPct: [ex.spotTakerNetBuyPct ?? imp.spotTakerNetBuyPct ?? s.entry_spot_taker_net_buy, "signal_entry_extras/impulse_decision_metrics/tracked_signals"],
      spotTakerDominance: [ex.spotTakerDominance ?? imp.spotTakerDominance, "signal_entry_extras/impulse_decision_metrics"],
      spotNetBuy1h: [imp.spotNetBuy1h ?? ex.spotNetBuy1h ?? s.entry_spot_net_buy_1h, "impulse_decision_metrics/signal_entry_extras/tracked_signals"],
      cvd15m: [imp.cvd15m ?? ex.cvd15m, "impulse_decision_metrics/signal_entry_extras"],
      cvd30m: [imp.cvd30m ?? ex.cvd30m, "impulse_decision_metrics/signal_entry_extras"],
      cvd1h: [imp.cvd1h ?? ex.cvd1h, "impulse_decision_metrics/signal_entry_extras"],
      cvd4h: [imp.cvd4h ?? ex.cvd4h, "impulse_decision_metrics/signal_entry_extras"],
      oi15m: [imp.oi15m ?? ex.oi15m ?? s.entry_oi_15m, "impulse_decision_metrics/signal_entry_extras/tracked_signals"],
      oi30m: [imp.oi30m ?? ex.oi30m ?? s.entry_oi_30m, "impulse_decision_metrics/signal_entry_extras/tracked_signals"],
      oi1h: [imp.oi1h ?? ex.oi1h ?? s.entry_oi_1h, "impulse_decision_metrics/signal_entry_extras/tracked_signals"],
      oi4h: [imp.oi4h ?? ex.oi4h ?? s.entry_oi_4h, "impulse_decision_metrics/signal_entry_extras/tracked_signals"],
      oi24h: [imp.oi24h ?? ex.oi24h ?? s.entry_oi_24h, "impulse_decision_metrics/signal_entry_extras/tracked_signals"],
      fundingRate: [imp.fundingRate ?? s.entry_funding_rate, "impulse_decision_metrics/tracked_signals"],
      liqLong1h: [imp.liqLong1h ?? imp.longLiq1h ?? s.entry_liq_long1h, "impulse_decision_metrics/tracked_signals"],
      liqLong24h: [imp.liqLong24h ?? imp.longLiq24h ?? s.entry_liq_long24h, "impulse_decision_metrics/tracked_signals"],
      liqRatio: [imp.liqRatio ?? s.entry_liq_ratio, "impulse_decision_metrics/tracked_signals"],
      marketCapUsd: [imp.marketCapUsd ?? ex.marketCapUsd, "impulse_decision_metrics/signal_entry_extras"],
      spotVol24hUsd: [imp.spotVol24hUsd ?? s.entry_spot_volume_usd_24h ?? s.entry_spot_vol_24h, "impulse_decision_metrics/tracked_signals"],
      spotVolPctMcap: [imp.spotVolPctMcap ?? s.entry_spot_mcap_pct, "impulse_decision_metrics/tracked_signals"],
      btc24h: [s.entry_btc_24h, "tracked_signals"],
      eth24h: [imp.eth24h, "impulse_decision_metrics"],
      candleVolumeUsd: [imp.candleVolumeUsd ?? imp.candleRealVolume, "impulse_decision_metrics"],
      candleVolumeMult: [imp.candleVolumeMult, "impulse_decision_metrics"],
      missingReasons: [imp.missingReasons, "impulse_decision_metrics"],
    };
    const [value, source] = paths[key] ?? [null, "not captured"];
    return { value: value == null ? null : value, source: String(source) };
  }
  const e = event;
  const m = e.entry_metrics ?? e.metrics ?? {};
  const c = e.context ?? {};
  const shadow = e._class === "shadow_candidate";
  const aliases: Record<string, unknown> = {
    price24h: m.price24h ?? e.price_24h_pct ?? c.price24hMinimumPct,
    price3h: m.price3h,
    price1h: m.price1h,
    volumeMultiplier: m.volMult ?? m.candleVolumeMult ?? e.vol_mult,
    spotVolumeMultiplier: m.spotVolumeMultiplier ?? e.spot_vol_mult,
    lucy30mColour: c.lucy30mColour ?? m.lucy30mColour,
    lucy30mColourPrev1: c.lucy30mColourPrev1,
    lucy30mColourPrev2: c.lucy30mColourPrev2,
    lucy30mColourPrev3: c.lucy30mColourPrev3,
    lucy30mVolAvg20: c.lucy30mVolAvg20 ?? m.lucy30mVolAvg20,
    lucy30mVolAvg120: c.lucy30mVolAvg120 ?? m.lucy30mVolAvg120,
    welkin: c.welkin ?? m.welkin,
    wyckoffPhase: c.wyckoffPhase ?? m.wyckoffPhase,
    wyckoffReason: c.wyckoffReason ?? m.wyckoffReason,
    wyckoffRangeBottom: c.wyckoffRangeBottom ?? m.wyckoffRangeBottom,
    wyckoffRangeTop: c.wyckoffRangeTop ?? m.wyckoffRangeTop,
    futTakerNetBuyPctPrev1h: m.futTakerNetBuyPctPrev1h,
    futTakerNetBuyPct: m.futTakerNetBuyPct ?? e.decision_metrics_json?.futTakerNetBuyPct,
    spotTakerNetBuyPct: m.spotTakerNetBuyPct ?? m.spotTakerNetBuy ?? e.decision_metrics_json?.spotTakerNetBuyPct,
    spotTakerDominance: m.spotTakerDominance,
    spotNetBuy1h: m.spotNetBuy1h,
    cvd15m: m.cvd15m,
    cvd30m: m.cvd30m,
    cvd1h: m.cvd1h,
    cvd4h: m.cvd4h,
    oi15m: m.oi15m,
    oi30m: m.oi30m ?? e.oi_30m_pct,
    oi1h: m.oi1h ?? e.oi_1h_pct,
    oi4h: m.oi4h ?? e.oi_4h_pct,
    oi24h: m.oi24h,
    fundingRate: m.fundingRate ?? e.decision_metrics_json?.fundingRate,
    liqLong1h: m.liqLong1h ?? e.decision_metrics_json?.liqLong1h,
    liqLong24h: m.liqLong24h ?? m.liqLong24hUsd ?? e.decision_metrics_json?.liqLong24h,
    liqRatio: m.liqRatio ?? e.decision_metrics_json?.liqRatio,
    marketCapUsd: c.marketCapUsd ?? m.marketCapUsd,
    spotVol24hUsd: m.spotVolUsd24h ?? m.spotVol24hUsd ?? e.decision_metrics_json?.spotVol24hUsd,
    spotVolPctMcap: m.spotVolPctMcap ?? c.spotMcapPct,
    btc24h: m.btc24h,
    eth24h: m.eth24h,
    candleVolumeUsd: m.candleVolumeUsd ?? m.candleRealVolume,
    candleVolumeMult: m.candleVolumeMult,
    missingReasons: c.missingReasons ?? m.missingReasons ?? e.decision_metrics_json?.missingReasons,
  };
  const source = shadow ? "missed_signals_log.decision_metrics_json" : "pattern_decision_snapshots.entry_metrics";
  const value = aliases[key];
  return { value: value == null ? null : value, source, missingHint: (c.missingReasons ?? m.missingReasons ?? []).join("|") };
}

function eventTime(event: Obj): number | null {
  return dateMs(event.detected_at ?? event.decision_at ?? event.logged_at);
}

function eventPrice(event: Obj): number | null {
  const saved = num(event.entry_price ?? event.price_at_log);
  if (saved !== null && saved > 0) return saved;
  const candle = event.entry_metrics ?? event.metrics ?? {};
  const close = num(candle.candleClose ?? candle.candle_close ?? candle.close);
  return close !== null && close > 0 ? close : null;
}

function candleWindowCoverage(bars: C[], start: number, horizonMs: number): { complete: boolean; rows: C[] } {
  const until = start + horizonMs;
  const expectedStart = Math.ceil(start / H15) * H15;
  const expectedEnd = Math.min(until, Math.floor(Date.now() / H15) * H15);
  const rows = bars.filter((c) => c.time >= expectedStart && c.time < until);
  const complete = rows.length > 0
    && rows[0]!.time === expectedStart
    && rows[rows.length - 1]!.time + H15 >= expectedEnd
    && rows.every((c, i) => i === 0 || c.time - rows[i - 1]!.time === H15);
  return { complete, rows };
}

function findPath(bars: C[], start: number, entry: number, horizonMs: number, target = 10, stop = -8): Obj {
  if (!(entry > 0)) return { outcome: "no_price" as Outcome };
  const until = start + horizonMs;
  const { complete, rows: path } = candleWindowCoverage(bars, start, horizonMs);
  if (path.length === 0) return { outcome: "no_price" as Outcome };
  let maxPct = -Infinity;
  let minPct = Infinity;
  let maxAt: number | null = null;
  let minAt: number | null = null;
  let hitTarget: { time: number; price: number } | null = null;
  let hitStop: { time: number; price: number } | null = null;
  for (const c of path) {
    const highPct = ((c.high - entry) / entry) * 100;
    const lowPct = ((c.low - entry) / entry) * 100;
    if (highPct > maxPct) { maxPct = highPct; maxAt = c.time; }
    if (lowPct < minPct) { minPct = lowPct; minAt = c.time; }
    if (!hitTarget && highPct >= target) hitTarget = { time: c.time, price: entry * (1 + target / 100) };
    if (!hitStop && lowPct <= stop) hitStop = { time: c.time, price: entry * (1 + stop / 100) };
  }
  let outcome: Outcome = "open";
  if (hitTarget && hitStop) outcome = hitTarget.time === hitStop.time ? "ambiguous" : hitTarget.time < hitStop.time ? "good" : "bad";
  else if (hitTarget) outcome = "good";
  else if (hitStop) outcome = "bad";
  const matured = Date.now() >= until;
  return {
    outcome: !complete ? "no_price" as Outcome : outcome,
    maxPct: Number.isFinite(maxPct) ? pct(maxPct) : null,
    maxAt: iso(maxAt),
    minPct: Number.isFinite(minPct) ? pct(minPct) : null,
    minAt: iso(minAt),
    hit10At: iso(hitTarget?.time),
    hitStopAt: iso(hitStop?.time),
    hoursTo10: hitTarget ? Math.round(((hitTarget.time - start) / H1) * 100) / 100 : null,
    hoursToStop: hitStop ? Math.round(((hitStop.time - start) / H1) * 100) / 100 : null,
    observedBars: path.length,
    horizonMatured: matured,
    coverageComplete: complete,
  };
}

function firstHit(bars: C[], start: number, entry: number, threshold: number, horizonMs: number, field: "high" | "low"): Obj | null {
  const price = entry * (1 + threshold / 100);
  const end = start + horizonMs;
  const hit = bars.find((c) => c.time >= Math.ceil(start / H15) * H15 && c.time < end && (field === "high" ? c.high >= price : c.low <= price));
  return hit ? { time: hit.time, price } : null;
}

function actualReasonList(event: Obj): string[] {
  const list = reasonParts(event);
  if (event._class === "shadow_candidate") list.push(...(event.reason_chain ?? []));
  return [...new Set(list)];
}

function reasonBelongs(gate: string, reason: string): boolean {
  if (gate === "price24h_ge_15") return reason === "price24h_below_15" || reason === "price24h_unavailable";
  if (gate === "wyckoff_breakout_without_base") return reason === "wyckoff_breakout_without_base";
  if (gate === "wyckoff_fail_closed") return reason.startsWith("wyckoff_phase_unknown");
  if (gate === "lucy_climax_OMW") return reason === "ib_vsa30m_climax";
  if (gate === "K1_below_0.95") return reason === "ib_vsa30m_low_volume";
  if (gate === "no_data") return reason.startsWith("ib_vsa30m_unknown") || reason.startsWith("aggregated_data_unavailable") || reason.includes("volume_baseline_missing") || reason.includes("spot_taker_unavailable") || ["confirmed_fire_spot_data_unavailable", "confirmed_fire_mcap_unavailable", "confirmed_fire_spot_taker_unavailable"].includes(reason);
  if (gate === "spot_mcap_ge_1pct") return reason === "confirmed_fire_spot_mcap_below_min";
  if (gate === "volume_multiplier_ge_1.48") return reason.startsWith("volume_lt_1_5x") || reason === "volume_baseline_missing";
  if (gate === "price3h_lt_20") return reason === "price3h_ge_20pct" || reason === "price3h_unavailable";
  if (gate === "funding_ge_minus_0.1pct") return reason === "funding_below_minus_0_1pct";
  if (gate === "OI1h_le_20pct") return reason === "oi1h_above_20pct";
  if (gate === "long_liq24h_ge_47k") return reason === "long_liq24h_below_47k";
  if (gate === "spot_mcap_not_6_to_15") return reason === "impulse_spot_mcap_6_to_15pct" || reason === "confirmed_fire_spot_mcap_below_min";
  if (gate === "spot_taker_netbuy_gt_10") return reason === "impulse_spot_taker_netbuy_le_10pct" || reason === "confirmed_fire_spot_taker_unavailable" || reason === "confirmed_fire_spot_taker_sell_dominant";
  return false;
}

function filterRows(events: Obj[], barsBySymbol: Map<string, C[]>): Obj[] {
  const definitions = [
    ["price24h_ge_15", "price24h", (v: Metric, e: Obj) => actualReasonList(e).includes("price24h_below_15") || num(v.value) === null || num(v.value)! < 15],
    ["wyckoff_breakout_without_base", "wyckoffPhase", (v: Metric, e: Obj) => actualReasonList(e).some((r) => r.includes("wyckoff_breakout_without_base")) || v.value === "breakout_without_base"],
    ["wyckoff_fail_closed", "wyckoffPhase", (v: Metric, e: Obj) => actualReasonList(e).some((r) => r.startsWith("wyckoff_phase_unknown")) || v.value === null],
    ["lucy_climax_OMW", "lucy30mColour", (v: Metric, e: Obj) => actualReasonList(e).includes("ib_vsa30m_climax") || v.value === null || ["O", "M", "W"].includes(String(v.value))],
    ["K1_below_0.95", "lucy30mVolAvg120", (v: Metric, e: Obj) => actualReasonList(e).includes("ib_vsa30m_low_volume") || num(v.value) === null || num(v.value)! < 0.95],
    ["no_data", "missingReasons", (_v: Metric, e: Obj) => actualReasonList(e).some((r) => reasonBelongs("no_data", r)) || ["price24h", "volumeMultiplier", "wyckoffPhase", "lucy30mColour", "lucy30mVolAvg120", "fundingRate", "oi1h", "liqLong24h", "spotVolPctMcap", "spotTakerNetBuyPct"].some((key) => metric(e, key).value === null)],
    ["volume_multiplier_ge_1.48", "volumeMultiplier", (v: Metric, e: Obj) => actualReasonList(e).some((r) => r.startsWith("volume_lt_1_5x")) || num(v.value) === null || num(v.value)! < 1.48],
    ["price3h_lt_20", "price3h", (v: Metric, e: Obj) => actualReasonList(e).includes("price3h_ge_20pct") || num(v.value) === null || num(v.value)! >= 20],
    ["funding_ge_minus_0.1pct", "fundingRate", (v: Metric, e: Obj) => actualReasonList(e).includes("funding_below_minus_0_1pct") || num(v.value) === null || num(v.value)! < -0.001],
    ["OI1h_le_20pct", "oi1h", (v: Metric, e: Obj) => actualReasonList(e).includes("oi1h_above_20pct") || num(v.value) === null || num(v.value)! > 20],
    ["long_liq24h_ge_47k", "liqLong24h", (v: Metric, e: Obj) => actualReasonList(e).includes("long_liq24h_below_47k") || num(v.value) === null || num(v.value)! < 47_000],
    ["spot_mcap_ge_1pct", "spotVolPctMcap", (v: Metric, e: Obj) => actualReasonList(e).includes("confirmed_fire_spot_mcap_below_min") || num(v.value) === null || num(v.value)! < 1],
    ["spot_mcap_not_6_to_15", "spotVolPctMcap", (v: Metric, e: Obj) => actualReasonList(e).includes("impulse_spot_mcap_6_to_15pct") || (num(v.value) !== null && num(v.value)! >= 6 && num(v.value)! < 15)],
    ["spot_taker_netbuy_gt_10", "spotTakerNetBuyPct", (v: Metric, e: Obj) => actualReasonList(e).includes("impulse_spot_taker_netbuy_le_10pct") || num(v.value) === null || num(v.value)! <= 10],
  ] as const;
  const rows: Obj[] = [];
  for (const e of events) {
    const t = eventTime(e);
    const entry = eventPrice(e);
    const path = t !== null && entry !== null ? findPath(barsBySymbol.get(e.symbol) ?? [], t, entry, 72 * H1) : { outcome: "no_price" };
    const reasons = actualReasonList(e);
    for (const [gate, metricKey, fails] of definitions) {
      const m = metric(e, metricKey);
      const evidence = reasons.find((r) => reasonBelongs(gate, r));
      const known = m.value !== null && m.value !== undefined;
      const rejected = fails(m, e);
      const otherExplicitRejects = reasons.filter((r) => r !== "no_live_pattern_matched" && !reasonBelongs(gate, r));
      const otherMetricFailures = definitions
        .filter(([otherGate, otherKey, otherFails]) => otherGate !== gate && otherFails(metric(e, otherKey), e))
        .map(([otherGate]) => otherGate);
      rows.push({
        entity_type: e._class,
        id: e.id ?? e.signal_id ?? "",
        symbol: e.symbol,
        detected_at_utc: iso(t),
        outcome72h: path.outcome,
        gate,
        metric: metricKey,
        value: known ? m.value : "",
        missing_reason: known ? "" : "не записано ботом",
        recorded: known,
        would_reject_by_metric_or_reason: rejected,
        source_reason: evidence ?? "",
        other_reason_count: new Set([...otherExplicitRejects, ...otherMetricFailures]).size,
        other_metric_failures: otherMetricFailures.join("|"),
        only_recorded_block: rejected && otherExplicitRejects.length === 0 && otherMetricFailures.length === 0,
        counterfactual_outcome_if_only_block_removed: rejected && otherExplicitRejects.length === 0 && otherMetricFailures.length === 0 ? path.outcome : "",
        metric_source: m.source,
      });
    }
    const half = t !== null && t < SPLIT ? "2026-11-09_to_2026-11-17" : "2026-11-18_to_now";
    for (const metricKey of ["futTakerNetBuyPct", "futTakerNetBuyPctPrev1h"]) {
      const taker = metric(e, metricKey);
      for (const threshold of TAKER_THRESHOLDS) {
        rows.push({
          entity_type: e._class,
          id: e.id ?? e.signal_id ?? "",
          symbol: e.symbol,
          detected_at_utc: iso(t),
          outcome72h: path.outcome,
          gate: `${metricKey}_le_${threshold}`,
          metric: metricKey,
          value: taker.value ?? "",
          missing_reason: taker.value === null ? "не записано ботом" : "",
          recorded: taker.value !== null,
          would_reject_by_metric_or_reason: num(taker.value) === null || num(taker.value)! <= threshold,
          source_reason: "",
          other_reason_count: "",
          only_recorded_block: "",
          counterfactual_outcome_if_only_block_removed: "",
          time_half: half,
          metric_source: taker.source,
        });
      }
    }
  }
  return rows;
}

function wideFilterRows(longRows: Obj[], events: Obj[]): Obj[] {
  const byKey = new Map<string, Obj>();
  for (const e of events) {
    const id = e.id ?? e.signal_id ?? "";
    const time = iso(eventTime(e)) ?? "";
    const key = `${e._class}|${id}|${e.symbol}|${time}`;
    byKey.set(key, {
      entity_type: e._class,
      id,
      symbol: e.symbol,
      detected_at_utc: time,
      outcome72h: "",
      first_reason: e.decision_reason ?? e.cancel_reason ?? e.reason ?? "",
      all_reasons: actualReasonList(e),
    });
  }
  for (const r of longRows) {
    const key = `${r.entity_type}|${r.id}|${r.symbol}|${r.detected_at_utc ?? ""}`;
    const row = byKey.get(key);
    if (!row) continue;
    row.outcome72h = r.outcome72h;
    const slug = String(r.gate).replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_|_$/g, "");
    row[`value_${slug}`] = r.value;
    row[`reject_${slug}`] = r.would_reject_by_metric_or_reason;
    row[`only_block_${slug}`] = r.only_recorded_block;
    row[`removed_outcome_${slug}`] = r.counterfactual_outcome_if_only_block_removed;
    row[`missing_${slug}`] = r.missing_reason ?? "";
    if (r.time_half) row[`time_half_${slug}`] = r.time_half;
  }
  return [...byKey.values()];
}

function allEvents(signals: Obj[], pdb: Obj[], shadows: Obj[], scanRows: Obj[]): Obj[] {
  const dayReasons = new Map<string, Obj>();
  for (const r of scanRows) {
    const key = `${r.symbol}|${String(r.utc_day).slice(0, 10)}`;
    dayReasons.set(key, r);
  }
  const a = signals.map((s) => ({ ...s, _class: "signal", detected_at: s.detected_at, _source: "tracked_signals" }));
  const b = pdb.map((e) => {
    const day = String(e.decision_at).slice(0, 10);
    return { ...e, _class: "rejected_candidate", _scanRecord: dayReasons.get(`${e.symbol}|${day}`) ?? null, _scanReasons: dayReasons.get(`${e.symbol}|${day}`)?.reasons ?? [] };
  });
  const sh = shadows.map((e) => ({ ...e, _class: "shadow_candidate", detected_at: e.logged_at, entry_price: e.price_at_log, _scanReasons: [] }));
  return [...a, ...b, ...sh].sort((x, y) => (eventTime(x) ?? 0) - (eventTime(y) ?? 0) || String(x.symbol).localeCompare(String(y.symbol)));
}

function flattenMetricTree(value: unknown, prefix: string, out: Obj): void {
  if (value === null || value === undefined) {
    out[prefix] = null;
    return;
  }
  if (Array.isArray(value)) {
    out[prefix] = JSON.stringify(value);
    return;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Obj);
    if (!entries.length) out[prefix] = "{}";
    else for (const [key, child] of entries) flattenMetricTree(child, `${prefix}.${key}`, out);
    return;
  }
  out[prefix] = value;
}

function recordedBotMetrics(event: Obj): Obj {
  const fields: Obj = {};
  if (event._class === "signal") {
    for (const [key, value] of Object.entries(event)) {
      if (key.startsWith("entry_")) flattenMetricTree(value, `bot.tracked_signals.${key}`, fields);
    }
    for (const key of ["alpha_score", "price_24h_at_fire", "decision_metrics"]) {
      flattenMetricTree(event[key], `bot.tracked_signals.${key}`, fields);
    }
    flattenMetricTree(event.impulse_decision_metrics, "bot.tracked_signals.impulse_decision_metrics", fields);
    flattenMetricTree(event._extras, "bot.signal_entry_extras.metrics", fields);
    flattenMetricTree(event._vsa, "bot.vsa_entry_metrics.metrics", fields);
    flattenMetricTree(event._wyckoff, "bot.wyckoff_entry_metrics.metrics", fields);
    flattenMetricTree(event._volumeColors, "bot.signal_volume_colors.metrics", fields);
  } else if (event._class === "rejected_candidate") {
    flattenMetricTree(event.entry_metrics, "bot.pattern_decision_snapshots.entry_metrics", fields);
    flattenMetricTree(event.context, "bot.pattern_decision_snapshots.context", fields);
  } else {
    flattenMetricTree(event.decision_metrics_json, "bot.missed_signals_log.decision_metrics_json", fields);
  }
  return fields;
}

function eventRows(events: Obj[], barsBySymbol: Map<string, C[]>): Obj[] {
  return events.map((e) => {
    const t = eventTime(e);
    const entry = eventPrice(e);
    const bars = barsBySymbol.get(e.symbol) ?? [];
    const p24 = t !== null && entry !== null ? findPath(bars, t, entry, D1) : { outcome: "no_price" };
    const p72 = t !== null && entry !== null ? findPath(bars, t, entry, 72 * H1) : { outcome: "no_price" };
    const p7d = t !== null && entry !== null ? findPath(bars, t, entry, 7 * D1) : { outcome: "no_price" };
    const met: Obj = {};
    for (const key of METRIC_KEYS) met[key] = metric(e, key).value;
    const metricCells = Object.fromEntries(METRIC_KEYS.map((key) => [`metric_${key}`, met[key] ?? ""]));
    const botMetrics = recordedBotMetrics(e);
    return {
      cohort: e._class,
      id: e.id ?? e.signal_id ?? "",
      symbol: e.symbol,
      detected_at_utc: iso(t),
      entry_price: entry,
      entry_price_source: num(e.entry_price) !== null
        ? e._class === "signal" ? "tracked_signals.entry_price" : e._class === "shadow_candidate" ? "missed_signals_log.price_at_log" : "pattern_decision_snapshots.entry_price"
        : "entry_metrics.candleClose proxy",
      first_reason: e.decision_reason ?? e.cancel_reason ?? e.reason ?? (e.reason_chain?.[0]?.reason ?? ""),
      all_reasons: e.reason_chain ?? actualReasonList(e),
      source_rows_in_24h: e._rolling_source_rows ?? "",
      candidate_source_files: e._candidate_sources ?? (e._source ? [e._source] : ""),
      scan_reject_reasons: e._scanReasons ?? [],
      scan_reject_first_at: e._scanRecord?.first_at ?? "",
      scan_reject_last_at: e._scanRecord?.last_at ?? "",
      scan_reject_rows: e._scanRecord?.rows ?? "",
      bot_status: e.status ?? "",
      bot_pnl_pct: num(e.pnl_percent),
      bot_exit_price: num(e.exit_price),
      bot_closed_at: iso(e.closed_at),
      policy_version: e.policy_version ?? "",
      entry_policy_version: e.entry_policy_version ?? "",
      core_pnl_pct: num(e.core_pnl_percent),
      core_exit_price: num(e.core_exit_price),
      core_closed_at: iso(e.core_closed_at),
      runner_pnl_pct: num(e.runner_pnl_percent),
      runner_exit_price: num(e.runner_exit_price),
      runner_closed_at: iso(e.runner_closed_at),
      runner_state: e.runner_state ?? "",
      outcome_24h: p24.outcome,
      price_window_24h_complete: p24.coverageComplete ?? false,
      mfe_24h_pct: p24.maxPct,
      mae_24h_pct: p24.minPct,
      first_plus10_24h_utc: p24.hit10At,
      outcome_72h: p72.outcome,
      price_window_72h_complete: p72.coverageComplete ?? false,
      mfe_72h_pct: p72.maxPct,
      mfe_72h_utc: p72.maxAt,
      mae_72h_pct: p72.minPct,
      mae_72h_utc: p72.minAt,
      hours_to_plus10: p72.hoursTo10,
      hours_to_minus8: p72.hoursToStop,
      outcome_7d: p7d.outcome,
      price_window_7d_complete: p7d.coverageComplete ?? false,
      mfe_7d_pct: p7d.maxPct,
      mae_7d_pct: p7d.minPct,
      missing_metric_names: METRIC_KEYS.filter((key) => metric(e, key).value === null).join("|"),
      ...botMetrics,
      ...metricCells,
    };
  });
}

function followupMap(): Map<number, Obj[]> {
  const records = ["bu_stop_followup_snapshots-0.jsonl", "bu_stop_followup_snapshots-500.jsonl"]
    .flatMap(readJsonl)
    .map((x) => x.record);
  const map = new Map<number, Obj[]>();
  for (const r of records) {
    const id = Number(r.tracked_signal_id);
    if (!map.has(id)) map.set(id, []);
    map.get(id)!.push(r);
  }
  for (const rows of map.values()) rows.sort((a, b) => Number(a.hour_after_close) - Number(b.hour_after_close));
  return map;
}

function signalRecordMap(file: string): Map<number, Obj[]> {
  const map = new Map<number, Obj[]>();
  for (const row of readJsonl(file)) {
    const record = row.record ?? row;
    const id = Number(record.signal_id);
    if (!Number.isFinite(id)) continue;
    if (!map.has(id)) map.set(id, []);
    map.get(id)!.push(record);
  }
  for (const rows of map.values()) {
    rows.sort((a, b) => Date.parse(String(a.snapshot_at ?? a.observed_at ?? "")) - Date.parse(String(b.snapshot_at ?? b.observed_at ?? "")));
  }
  return map;
}

function outputMissing(events: Obj[]): Obj[] {
  const rows: Obj[] = [];
  for (const cohort of ["signal", "rejected_candidate", "shadow_candidate"]) {
    const group = events.filter((e) => e._class === cohort);
    const fields = new Set<string>(METRIC_KEYS.map((key) => `metric_${key}`));
    for (const e of group) for (const key of Object.keys(recordedBotMetrics(e))) fields.add(key);
    for (const key of [...fields].sort()) {
      const missing = group.filter((e) => {
        if (key.startsWith("metric_")) {
          const value = metric(e, key.slice("metric_".length)).value;
          return value === null || value === undefined;
        }
        const value = recordedBotMetrics(e)[key];
        return value === null || value === undefined;
      });
      if (missing.length === 0) continue;
      rows.push({
        entity_type: cohort,
        metric: key,
        value: "",
        reason: "не записано ботом",
        total_events: group.length,
        recorded_events: group.length - missing.length,
        missing_events: missing.length,
        source_checked: key.startsWith("metric_")
          ? [...new Set(missing.map((e) => metric(e, key.slice("metric_".length)).source))].join("|")
          : key.slice(0, key.lastIndexOf(".")),
        missing_examples: missing.slice(0, 15).map((e) => `${e.symbol}#${e.id ?? e.signal_id ?? ""}@${iso(eventTime(e))}`).join("|"),
      });
    }
  }
  return rows;
}

function exitSimulation(bars: C[], start: number, entry: number, maxDays: number, initialStopPct: number, trailActivation: number, trailGap: number, lockAt10 = false): Obj {
  const end = Math.min(Date.now(), start + maxDays * D1);
  const path = bars.filter((c) => c.time >= Math.ceil(start / H15) * H15 && c.time < end);
  let peak = entry;
  let stop = entry * (1 + initialStopPct / 100);
  let locked = false;
  let exit: { time: number; price: number; reason: string } | null = null;
  for (const c of path) {
    const stopBeforeCandle = stop;
    if (c.low <= stopBeforeCandle) {
      exit = {
        time: c.time + H15,
        price: stopBeforeCandle,
        reason: c.high >= entry * 1.1
          ? "ambiguous_target_and_stop_same_15m"
          : locked
            ? "protected_stop"
            : "initial_stop",
      };
      break;
    }
    peak = Math.max(peak, c.high);
    const peakPct = ((peak - entry) / entry) * 100;
    if (c.high >= entry * 1.1) {
      locked = true;
      stop = Math.max(stop, entry * (lockAt10 ? 1.05 : 1));
    }
    if (peakPct >= trailActivation) stop = Math.max(stop, entry * (1 + (peakPct - trailGap) / 100));
    if (stop > stopBeforeCandle && c.low <= stop) {
      exit = { time: c.time + H15, price: stop, reason: "ambiguous_new_stop_hit_same_15m" };
      break;
    }
  }
  if (!exit && path.length) {
    const last = path[path.length - 1]!;
    exit = { time: last.time + H15, price: last.close, reason: end >= start + maxDays * D1 ? "age_expired" : "mark_to_market" };
  }
  return {
    exit_at: iso(exit?.time),
    exit_time_ms: exit?.time ?? null,
    exit_price: pct(exit ? ((exit.price / entry) - 1) * 100 : null),
    pnl_pct: exit ? pct(((exit.price / entry) - 1) * 100) : null,
    exit_reason: exit?.reason ?? "no_price",
    peak_pct: pct(((peak / entry) - 1) * 100),
  };
}

function runnerAfterCore(bars: C[], tradeStart: number, coreExitMs: number | null, entry: number): Obj {
  if (coreExitMs === null) return { pnl_pct: null, exit_at: null, exit_time_ms: null, exit_reason: "core_still_open", peak_pct: null };
  if (coreExitMs >= tradeStart + 5 * D1) {
    return { pnl_pct: null, exit_at: null, exit_time_ms: null, exit_reason: "runner_lifetime_expired_before_core_close", peak_pct: null };
  }
  const maxEnd = Math.min(Date.now(), tradeStart + 5 * D1);
  const before = bars.filter((c) => c.time >= tradeStart && c.time < coreExitMs);
  let peak = Math.max(entry, ...before.map((c) => c.high));
  const path = bars.filter((c) => c.time >= Math.ceil(coreExitMs / H15) * H15 && c.time < maxEnd);
  let stop = entry;
  const updateStop = () => {
    const peakPct = ((peak / entry) - 1) * 100;
    if (peakPct >= 30) stop = Math.max(stop, entry * (1 + (peakPct - 30) / 100));
  };
  updateStop();
  let exit: { time: number; price: number; reason: string } | null = null;
  for (const c of path) {
    const stopBeforeCandle = stop;
    if (c.low <= stop) {
      exit = { time: c.time + H15, price: stop, reason: stop > entry ? "runner_trailing_stop" : "runner_emergency_breakeven" };
      break;
    }
    peak = Math.max(peak, c.high);
    updateStop();
    if (stop > stopBeforeCandle && c.low <= stop) {
      exit = { time: c.time + H15, price: stop, reason: "ambiguous_runner_new_stop_same_15m" };
      break;
    }
  }
  if (!exit && path.length) {
    const last = path[path.length - 1]!;
    exit = { time: last.time + H15, price: last.close, reason: maxEnd >= tradeStart + 5 * D1 ? "runner_age_expired" : "runner_mark_to_market" };
  }
  return {
    pnl_pct: exit ? pct((exit.price / entry - 1) * 100) : null,
    exit_at: iso(exit?.time),
    exit_time_ms: exit?.time ?? null,
    exit_reason: exit?.reason ?? "no_price",
    peak_pct: pct((peak / entry - 1) * 100),
  };
}

function stopsRows(signals: Obj[], barsBySymbol: Map<string, C[]>, followups: Map<number, Obj[]>): Obj[] {
  const rows: Obj[] = [];
  const stopVariants = [-5, -6, -8, -10];
  const drawdownBySignal = new Map(
    readJsonl("signal_drawdown_extrema-0.jsonl").map((r) => [Number(r.record.signal_id), r.record]),
  );
  const trajectoryBySignal = signalRecordMap("signal_trajectory_log-0.jsonl");
  const trailingBySignal = signalRecordMap("signal_trailing_events-0.jsonl");
  const profitLockBySignal = signalRecordMap("signal_profit_lock_shadow_events-0.jsonl");
  for (const s of signals) {
    const start = dateMs(s.detected_at);
    const entry = num(s.entry_price);
    if (start === null || entry === null || entry <= 0) continue;
    const bars = barsBySymbol.get(s.symbol) ?? [];
    const p72 = findPath(bars, start, entry, 72 * H1);
    const hit10 = firstHit(bars, start, entry, 10, 7 * D1, "high");
    const pullbackBars = hit10 ? bars.filter((c) => c.time >= hit10.time && c.time < hit10.time + 72 * H1) : [];
    const post10Low = hit10 && pullbackBars.length ? Math.min(...pullbackBars.map((c) => c.low)) : null;
    const adverseBefore10 = hit10
      ? bars.filter((c) => c.time >= start && c.time <= hit10.time).reduce((min, c) => Math.min(min, c.low), entry)
      : null;
    const imp = s.impulse_decision_metrics ?? {};
    const extras = s._extras ?? {};
    const candle = extras.candle ?? {};
    const signalLow = num(candle.low ?? candle.candleLow ?? imp.candleLow);
    const baseLow = num(s._wyckoff?.rangeBottom);
    const trajectory = trajectoryBySignal.get(Number(s.signal_id)) ?? [];
    const trailingEvents = trailingBySignal.get(Number(s.signal_id)) ?? [];
    const profitLockEvents = profitLockBySignal.get(Number(s.signal_id)) ?? [];
    const trajectoryPeak = trajectory.flatMap((r) => [num(r.peak_pct)]).filter((v): v is number => v !== null);
    const trajectoryPnl = trajectory.flatMap((r) => [num(r.pct_from_entry)]).filter((v): v is number => v !== null);
    const currentSim = exitSimulation(bars, start, entry, 4, -8, 15, 10);
    const sevenDayCore = exitSimulation(bars, start, entry, 7, -8, 15, 10);
    const sevenDayRunner = sevenDayCore.exit_reason === "protected_stop"
      ? runnerAfterCore(bars, start, sevenDayCore.exit_time_ms, entry)
      : null;
    const sevenDayRunnerMark = sevenDayRunner
      ? sevenDayRunner.pnl_pct ?? (bars.length ? pct(((bars[bars.length - 1]!.close / entry) - 1) * 100) : null)
      : null;
    const sevenDayWeighted = sevenDayCore.pnl_pct === null
      ? null
      : sevenDayRunner && sevenDayRunnerMark !== null
        ? 0.8 * Number(sevenDayCore.pnl_pct) + 0.2 * Number(sevenDayRunnerMark)
        : Number(sevenDayCore.pnl_pct);
    const runnerSim = currentSim.exit_reason === "protected_stop"
      ? runnerAfterCore(bars, start, currentSim.exit_time_ms, entry)
      : null;
    const runnerMark = runnerSim
      ? runnerSim.pnl_pct ?? (bars.length ? pct(((bars[bars.length - 1]!.close / entry) - 1) * 100) : null)
      : null;
    const weightedSim = currentSim.pnl_pct === null
      ? null
      : runnerSim && runnerMark !== null
        ? 0.8 * Number(currentSim.pnl_pct) + 0.2 * Number(runnerMark)
        : Number(currentSim.pnl_pct);
    const lock5Sim = exitSimulation(bars, start, entry, 4, -8, 15, 10, true);
    const stopPrices: Array<{ variant: string; pct: number | null; price: number | null }> = stopVariants.map((v) => ({ variant: `fixed_${Math.abs(v)}pct`, pct: v, price: entry * (1 + v / 100) }));
    if (signalLow !== null && signalLow < entry) stopPrices.push({ variant: "below_signal_candle_low_0.1pct", pct: (((signalLow * 0.999) / entry) - 1) * 100, price: signalLow * 0.999 });
    else stopPrices.push({ variant: "below_signal_candle_low", pct: null, price: null });
    if (baseLow !== null && baseLow < entry) stopPrices.push({ variant: "below_wyckoff_base_0.1pct", pct: (((baseLow * 0.999) / entry) - 1) * 100, price: baseLow * 0.999 });
    else stopPrices.push({ variant: "below_wyckoff_base", pct: null, price: null });
    for (const v of stopPrices) {
      const stopEnd = start + 4 * D1;
      const hit = v.price === null ? null : bars.find((c) => c.time >= start && c.time < stopEnd && c.low <= v.price!);
      const afterWindow = hit ? candleWindowCoverage(bars, hit.time, 72 * H1) : { complete: false, rows: [] as C[] };
      const after = afterWindow.rows.filter((c) => c.time > hit!.time);
      const maxAfter = after.length ? Math.max(...after.map((c) => ((c.high / entry) - 1) * 100)) : null;
      const botFollow = (followups.get(Number(s.id)) ?? []).filter((r) => Number(r.hour_after_close) <= 72);
      const recordedAfter = botFollow.length ? Math.max(...botFollow.map((r) => num(r.move_pct) ?? -Infinity)) : null;
      const recordedFollowHours = botFollow.length ? Math.max(...botFollow.map((r) => Number(r.hour_after_close))) : null;
      const variantSim = v.pct === null ? null : exitSimulation(bars, start, entry, 4, v.pct, 15, 10);
      const variantRunner = variantSim?.exit_reason === "protected_stop"
        ? runnerAfterCore(bars, start, variantSim.exit_time_ms, entry)
        : null;
      const variantRunnerMark = variantRunner
        ? variantRunner.pnl_pct ?? (bars.length ? pct(((bars[bars.length - 1]!.close / entry) - 1) * 100) : null)
        : null;
      const variantWeighted = variantSim?.pnl_pct === null || variantSim?.pnl_pct === undefined
        ? null
        : variantRunner && variantRunnerMark !== null
          ? 0.8 * Number(variantSim.pnl_pct) + 0.2 * Number(variantRunnerMark)
          : Number(variantSim.pnl_pct);
      rows.push({
        id: s.id,
        symbol: s.symbol,
        detected_at_utc: iso(start),
        bot_status: s.status,
        bot_pnl_pct: num(s.pnl_percent),
        path_group_72h: p72.outcome,
        variant: v.variant,
        stop_pct_from_entry: pct(v.pct),
        stop_price: v.price,
        stop_hit_at_utc: iso(hit?.time),
        would_stop_before_plus10: Boolean(hit && (!hit10 || hit.time < hit10.time)),
        same_15m_candle_stop_and_plus10: Boolean(hit && hit10 && hit.time === hit10.time),
        bot_drawdown_min_pct: num(drawdownBySignal.get(Number(s.signal_id))?.min_pct_from_entry),
        bot_drawdown_min_at_utc: iso(drawdownBySignal.get(Number(s.signal_id))?.min_observed_at),
        trajectory_snapshot_count: trajectory.length,
        trajectory_first_snapshot_utc: iso(trajectory[0]?.snapshot_at),
        trajectory_last_snapshot_utc: iso(trajectory.at(-1)?.snapshot_at),
        trajectory_peak_pct_max: trajectoryPeak.length ? pct(Math.max(...trajectoryPeak)) : "",
        trajectory_peak_pct_min: trajectoryPeak.length ? pct(Math.min(...trajectoryPeak)) : "",
        trajectory_pct_from_entry_max: trajectoryPnl.length ? pct(Math.max(...trajectoryPnl)) : "",
        trajectory_pct_from_entry_min: trajectoryPnl.length ? pct(Math.min(...trajectoryPnl)) : "",
        recorded_trailing_events: trailingEvents,
        recorded_profit_lock_shadow_events: profitLockEvents,
        recorded_profit_lock_activation_count: profitLockEvents.filter((r) => r.event_type === "activated").length,
        candle_drawdown_before_plus10_pct: adverseBefore10 === null ? null : pct(((adverseBefore10 / entry) - 1) * 100),
        plus10_at_utc: iso(hit10?.time),
        after_stop_72h_price_coverage_complete: afterWindow.complete,
        low_after_stop_72h_pct: hit && after.length ? pct(((Math.min(...after.map((c) => c.low)) / entry) - 1) * 100) : null,
        max_after_stop_72h_pct: maxAfter === null ? null : pct(maxAfter),
        reached_plus10_after_stop_72h: maxAfter !== null && maxAfter >= 10 ? true : afterWindow.complete ? false : "",
        actual_close_bot_followup_max_move_pct_72h: recordedAfter === null || !Number.isFinite(recordedAfter) ? "" : pct(recordedAfter),
        actual_close_bot_followup_max_hour: recordedFollowHours ?? "",
        followup_source: afterWindow.complete ? "BingX 15m candles (full 72h)" : after.length ? "BingX 15m candles (partial 72h)" : "",
        signal_candle_low: signalLow,
        wyckoff_base_low: baseLow,
        current_80_20_sim_pct: weightedSim === null ? "" : pct(weightedSim),
        current_core_sim_pct: currentSim.pnl_pct ?? "",
        current_core_exit_at_utc: currentSim.exit_at ?? "",
        current_core_exit_price_pct: currentSim.exit_price ?? "",
        current_core_sim_exit_reason: currentSim.exit_reason,
        seven_day_core_sim_pct: sevenDayCore.pnl_pct ?? "",
        seven_day_core_exit_at_utc: sevenDayCore.exit_at ?? "",
        seven_day_core_exit_reason: sevenDayCore.exit_reason,
        seven_day_80_20_sim_pct: sevenDayWeighted === null ? "" : pct(sevenDayWeighted),
        seven_day_runner_exit_at_utc: sevenDayRunner?.exit_at ?? "",
        seven_day_runner_exit_reason: sevenDayRunner?.exit_reason ?? "runner_not_opened",
        runner_only_sim_pct: runnerSim ? runnerSim.pnl_pct ?? runnerMark ?? "" : "",
        runner_exit_at_utc: runnerSim?.exit_at ?? "",
        runner_exit_reason: runnerSim?.exit_reason ?? "runner_not_opened",
        plus10_lock_plus5_sim_pct: lock5Sim.pnl_pct ?? "",
        plus10_lock_plus5_exit_reason: lock5Sim.exit_reason,
        variant_core_sim_pct: variantSim?.pnl_pct ?? "",
        variant_core_exit_reason: variantSim?.exit_reason ?? "",
        variant_80_20_sim_pct: variantWeighted === null ? "" : pct(variantWeighted),
      });
    }
  }
  return rows;
}

function cancellationRows(signals: Obj[], barsBySymbol: Map<string, C[]>, followups: Map<number, Obj[]>): Obj[] {
  const outcomes = readJsonl("signal_cancel_outcomes-0.jsonl").map((x) => x.record);
  const bySignal = new Map<number, Obj>();
  for (const row of outcomes) bySignal.set(Number(row.signal_id), row);
  const rows: Obj[] = [];
  for (const s of signals) {
    const cancellation = bySignal.get(Number(s.signal_id));
    if (!cancellation && s.status !== "cancelled") continue;
    const t = dateMs(cancellation?.sent_at ?? s.closed_at);
    const entry = num(cancellation?.entry_price ?? s.entry_price);
    const id = Number(s.id);
    const follow = (followups.get(id) ?? []).filter((r) => Number(r.hour_after_close) <= 72);
    const recordedMax = follow.length ? Math.max(...follow.map((r) => num(r.move_pct) ?? -Infinity)) : null;
    const priceWindow = t !== null ? candleWindowCoverage(barsBySymbol.get(s.symbol) ?? [], t, 72 * H1) : { complete: false, rows: [] as C[] };
    const bars = priceWindow.rows;
    const candleMax = entry !== null && bars.length ? Math.max(...bars.map((c) => ((c.high / entry) - 1) * 100)) : null;
    const maxValues = [
      ...(recordedMax !== null && Number.isFinite(recordedMax) ? [recordedMax] : []),
      ...(candleMax !== null ? [candleMax] : []),
    ];
    const max72 = maxValues.length ? Math.max(...maxValues) : null;
    const recordedMaxHour = follow.length ? Math.max(...follow.map((r) => Number(r.hour_after_close))) : null;
    const followupComplete = recordedMaxHour !== null && recordedMaxHour >= 72 || priceWindow.complete;
    const reached10 = max72 !== null && Number.isFinite(max72) && max72 >= 10;
    rows.push({
      id: s.id,
      signal_id: s.signal_id,
      symbol: s.symbol,
      cancel_reason: cancellation?.cancel_reason ?? s.cancel_reason ?? "",
      cancelled_at_utc: iso(cancellation?.sent_at ?? s.closed_at),
      entry_price: entry,
      price_at_cancel: num(cancellation?.price_at_cancel ?? s.exit_price),
      pnl_at_cancel_pct: num(cancellation?.pnl_at_cancel ?? s.pnl_percent),
      status_now: s.status,
      bot_recorded_4h_pct: num(cancellation?.price_4h_pct),
      bot_recorded_8h_pct: num(cancellation?.price_8h_pct),
      bot_recorded_24h_pct: num(cancellation?.price_24h_pct),
      max_move_72h_pct: max72 === null ? null : pct(max72),
      reached_plus10_after_cancel_72h: reached10 ? true : followupComplete ? false : "",
      classification: reached10 ? "достигла +10% за 72ч" : followupComplete ? "не достигла +10% за полные 72ч" : "окно 72ч неполное",
      snapshots_72h: follow.length,
      max_bot_followup_hour: recordedMaxHour ?? "",
      bingx_price_window_72h_complete: priceWindow.complete,
      followup_source: follow.length && bars.length ? "bu_stop_followup_snapshots + BingX 15m" : follow.length ? "bu_stop_followup_snapshots" : bars.length ? "BingX 15m candles" : "не записано ботом",
    });
  }
  return rows.sort((a, b) => String(a.cancelled_at_utc).localeCompare(String(b.cancelled_at_utc)));
}

function csvArray(file: string): Obj[] {
  const path = join(INPUT, file);
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, "utf8").trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const parse = (line: string) => {
    const out: string[] = [];
    let field = "";
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i]!;
      if (c === '"' && inQuotes && line[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') inQuotes = !inQuotes;
      else if (c === "," && !inQuotes) { out.push(field); field = ""; }
      else field += c;
    }
    out.push(field);
    return out;
  };
  const headers = parse(lines[0]!);
  return lines.slice(1).map((line) => Object.fromEntries(parse(line).map((v, i) => [headers[i]!, v])));
}

function loadAgg1h(symbol: string): Map<number, number> | null {
  const path = join(CACHE, `${symbol}_cg_aggfut.json`);
  if (!existsSync(path)) return null;
  try {
    const data = JSON.parse(readFileSync(path, "utf8"));
    return new Map((data.items ?? []).map((x: Obj) => [Number(x.time), Number(x.buy ?? 0) + Number(x.sell ?? 0)]));
  } catch {
    return null;
  }
}

async function wyckoffRows(signals: Obj[], pdb: Obj[]): Promise<Obj[]> {
  const fired = signals
    .filter((s) => s._wyckoff?.entryCandle || s._wyckoff?.phase)
    .sort((a, b) => Date.parse(a.detected_at) - Date.parse(b.detected_at))
    .slice(0, 10)
    .map((s) => ({ type: "fired", id: s.id, symbol: s.symbol, time: s.detected_at, recorded: s._wyckoff?.phase ?? null, entryCandle: s._wyckoff?.entryCandle }));
  const rejected = pdb
    .filter((e) => actualReasonList(e).includes("wyckoff_breakout_without_base"))
    .sort((a, b) => Date.parse(a.decision_at) - Date.parse(b.decision_at))
    .slice(0, 10)
    .map((e) => ({
      type: "wyckoff_rejected",
      id: e.id,
      symbol: e.symbol,
      time: e.decision_at,
      recorded: e.context?.wyckoffPhase ?? "breakout_without_base",
      entryCandle: e.entry_metrics?.candleClosedAt ?? null,
    }));
  const selected = [...fired, ...rejected];
  const rows: Obj[] = [];
  for (const s of selected) {
    const t = dateMs(s.time);
    if (t === null) continue;
    const entryTime = s.entryCandle ? Date.parse(s.entryCandle) : Math.floor(t / H1) * H1 - H1;
    const start = entryTime - 80 * H1;
    let bars: C[] = [];
    try { bars = await klines(CACHE, s.symbol, "1h", start, Date.now()); }
    catch { /* price cache stays explicitly unavailable below */ }
    const window = bars.filter((c) => c.time >= start && c.time <= entryTime);
    const volumeMap = loadAgg1h(s.symbol);
    const hasVol = volumeMap?.has(entryTime) ?? false;
    const recalc = window.length >= 40 && volumeMap && hasVol
      ? computeWyckoff(window.map((c) => ({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close })), volumeMap, entryTime)
      : null;
    const candle = window.find((c) => c.time === entryTime) ?? null;
    rows.push({
      sample_type: s.type,
      id: s.id,
      symbol: s.symbol,
      decision_at_utc: iso(t),
      entry_candle_1h_utc: iso(entryTime),
      recorded_phase: s.recorded,
      recomputed_phase: recalc?.phase ?? "",
      recompute_status: recalc ? "computed from cached BingX 1H + cached recorded aggregate futures volume" : !volumeMap ? "CoinGlass aggregate cache missing; not requested" : !hasVol ? "aggregate volume not cached at entry candle" : "BingX 1H history missing",
      entry_open: candle?.open ?? "",
      entry_high: candle?.high ?? "",
      entry_low: candle?.low ?? "",
      entry_close: candle?.close ?? "",
      base_top: recalc?.rangeTop ?? "",
      base_bottom: recalc?.rangeBottom ?? "",
      base_height_pct: recalc?.rangeHeightPct ?? "",
      entry_position_in_range: recalc?.entryPositionInRange ?? "",
      events: recalc?.events ?? "",
      comparison: recalc ? (recalc.phase === s.recorded ? "совпало с записанным" : "не совпало с записанным") : "",
      chart_read: recalc?.phase === "accumulation_then_markup" ? "рост после накопления в базе" : recalc?.phase === "breakout_without_base" ? "пробой без распознанной базы" : recalc?.phase === "accumulation" ? "база/накопление без SOS до входа" : "",
      chart_visual_review: "график TradingView не открывался; вывод только по BingX OHLC",
    });
  }
  return rows;
}

function leaderRows(barsBySymbol: Map<string, C[]>, pdb: Obj[], scanRows: Obj[], leaderMissed: Obj[]): Obj[] {
  const out: Obj[] = [];
  const mappedMissed = leaderMissed.map((x) => x.record ?? x)
    .filter((x) => x.pattern === "impulse_buy" || String(x.source ?? "").startsWith("impulse_buy:"));
  for (const [name, symbol] of LEADER_NAMES) {
    const bars15 = (barsBySymbol.get(symbol) ?? []).filter((c) => c.time >= LEADER_START - D1 && c.time < Date.now());
    const bars30: C[] = [];
    const byTime = new Map(bars15.map((c) => [c.time, c]));
    for (const a of bars15) {
      if (a.time % (30 * 60_000) !== 0) continue;
      const b = byTime.get(a.time + H15);
      if (!b) continue;
      bars30.push({ time: a.time, open: a.open, high: Math.max(a.high, b.high), low: Math.min(a.low, b.low), close: b.close, volume: a.volume + b.volume });
    }
    let growth: C | null = null;
    for (let i = 48; i < bars30.length; i++) {
      const now = bars30[i]!;
      const prior = bars30[i - 48]!;
      if (now.time - prior.time === 48 * 30 * 60_000 && now.time >= LEADER_START && prior.close > 0 && ((now.close / prior.close) - 1) * 100 >= 15) {
        growth = now;
        break;
      }
    }
    const pRows = pdb.filter((x) => x.symbol === symbol && Date.parse(x.decision_at) >= LEADER_START);
    const scan = scanRows.filter((x) => x.symbol === symbol && Date.parse(String(x.first_at)) >= LEADER_START);
    const missed = mappedMissed.filter((x) => x.symbol === symbol);
    const nearest = growth ? pRows
      .map((x) => ({ row: x, delta: Math.abs(Date.parse(x.decision_at) - growth!.time) }))
      .filter((x) => x.delta <= 45 * 60_000)
      .sort((a, b) => a.delta - b.delta)[0]?.row : null;
    const price24 = growth && bars30.find((c) => c.time === growth!.time - 24 * H1)
      ? ((growth.close / bars30.find((c) => c.time === growth!.time - 24 * H1)!.close) - 1) * 100
      : null;
    const reasons = [...new Set([
      ...scan.flatMap((x) => x.reasons ?? []),
      ...pRows.map((x) => x.decision_reason),
      ...missed.map((x) => x.reason),
    ].filter(Boolean))];
    const rejected = pRows.map((x) => x.decision_reason).find((r) => r && r !== "no_live_pattern_matched") ?? missed[0]?.reason ?? "";
    out.push({
      name,
      symbol,
      scan_log_evidence_48h: scan.length > 0 || pRows.length > 0 ? "есть запись" : "записей нет; включение в список не доказано",
      pattern_decision_rows_48h: pRows.length,
      scan_reject_symbol_day_rows_48h: scan.length,
      missed_signals_log_rows_48h: missed.length,
      first_30m_candle_p24h_ge_15_utc: iso(growth?.time),
      first_30m_open: growth?.open ?? "",
      first_30m_close: growth?.close ?? "",
      bingx_price24h_at_growth_pct: pct(price24),
      price_gate_at_growth: price24 === null ? "не определено" : price24 >= 15 ? "проходит" : "не проходит",
      closest_pdb_decision_at_45m: iso(nearest?.decision_at),
      closest_pdb_kind: nearest?.decision_kind ?? "",
      closest_pdb_reason: nearest?.decision_reason ?? "",
      recorded_wyckoff: nearest?.metrics?.wyckoffPhase ?? "",
      recorded_lucy30m: nearest?.metrics?.lucy30mColour ?? "",
      recorded_volume_mult: nearest?.metrics?.volMult ?? "",
      recorded_futures_taker: nearest?.metrics?.futTakerNetBuyPct ?? "",
      first_logged_reason: rejected,
      all_recorded_reasons_48h: reasons,
      other_filter_values: "для отсутствующих snapshots — не записано ботом",
      code_ref: reasonCode(rejected),
      conclusion: rejected ? `IB не было: в журнале записано ${rejected}` : pRows.length ? "IB не было: PDB содержит только записи без fired-сигнала; точную первопричину по 30m не подтверждает" : "IB не было: нет записи, подтверждающей включение монеты в список сканирования",
    });
  }
  return out;
}

function reasonCode(reason: string): string {
  if (reason.includes("price24h")) return "scanner.ts:10527-10535";
  if (reason.includes("wyckoff")) return "scanner.ts:10538-10564";
  if (reason.includes("ib_vsa30m")) return "scanner.ts:10566-10590";
  if (reason.includes("volume_lt")) return "scanner-patterns.ts:624-655";
  if (reason.includes("funding")) return "scanner-patterns.ts:687-694";
  if (reason.includes("oi1h")) return "scanner-patterns.ts:695-701";
  if (reason.includes("long_liq")) return "scanner-patterns.ts:703-716";
  if (reason.includes("spot_mcap") || reason.includes("spot_taker")) return "scanner.ts:8489-8639";
  if (reason.includes("no_live")) return "scanner.ts:10496-10613";
  return "";
}

function depositModel(
  trades: Array<{
    id: number;
    symbol: string;
    start: number;
    end: number;
    pnlPct: number;
    ambiguous?: boolean;
    legs?: Array<{ start: number; end: number; pnlPct: number; notionalUsd: number; marginUsd: number; ambiguous?: boolean }>;
  }>,
  notionalPerTrade = 1000,
  maxConcurrent = 10,
): Obj {
  const sorted = [...trades].sort((a, b) => a.start - b.start);
  const acceptedTrades: typeof sorted = [];
  const legRows = (trade: (typeof sorted)[number]) => trade.legs ?? [{
    start: trade.start,
    end: trade.end,
    pnlPct: trade.pnlPct,
    notionalUsd: notionalPerTrade,
    marginUsd: notionalPerTrade / 10,
    ambiguous: trade.ambiguous,
  }];
  let accepted = 0;
  let skippedCapacity = 0;
  let skippedSameSymbol = 0;
  for (const trade of sorted) {
    const activeLegs = acceptedTrades.flatMap((acceptedTrade) =>
      legRows(acceptedTrade)
        .filter((leg) => leg.start <= trade.start && leg.end > trade.start)
        .map((leg) => ({ ...leg, id: acceptedTrade.id, symbol: acceptedTrade.symbol })),
    );
    const activeTradeIds = new Set(activeLegs.map((leg) => leg.id));
    if (activeLegs.some((position) => position.symbol === trade.symbol)) {
      skippedSameSymbol++;
      continue;
    }
    const newActiveLegs = legRows(trade).filter((leg) => leg.start <= trade.start && leg.end > trade.start);
    const activeMargin = activeLegs.reduce((sum, leg) => sum + leg.marginUsd, 0);
    const newMargin = newActiveLegs.reduce((sum, leg) => sum + leg.marginUsd, 0);
    if (activeTradeIds.size >= maxConcurrent || activeMargin + newMargin > 1000) {
      skippedCapacity++;
      continue;
    }
    acceptedTrades.push(trade);
    accepted++;
  }
  const now = Date.now();
  const acceptedLegs = acceptedTrades.flatMap((trade) =>
    legRows(trade).map((leg) => ({ ...leg, id: trade.id, symbol: trade.symbol })),
  );
  const realizedUsd = acceptedLegs
    .filter((leg) => leg.end <= now)
    .reduce((sum, leg) => sum + leg.notionalUsd * leg.pnlPct / 100, 0);
  const openLegs = acceptedLegs.filter((leg) => leg.start <= now && leg.end > now);
  const openPnlUsd = openLegs.reduce((sum, leg) => sum + leg.notionalUsd * leg.pnlPct / 100, 0);
  const openTradeIds = new Set(openLegs.map((leg) => leg.id));
  const timePoints = [...new Set(acceptedLegs.flatMap((leg) => [leg.start, leg.end]))].sort((a, b) => a - b);
  let peakConcurrent = 0;
  for (const time of timePoints) {
    const count = new Set(acceptedLegs.filter((leg) => leg.start <= time && leg.end > time).map((leg) => leg.id)).size;
    peakConcurrent = Math.max(peakConcurrent, count);
  }
  const taken = acceptedTrades.map((trade) => ({
    id: trade.id,
    symbol: trade.symbol,
    pnlUsd: legRows(trade).reduce((sum, leg) => sum + leg.notionalUsd * leg.pnlPct / 100, 0),
  }));
  return {
    accepted,
    skipped_capacity: skippedCapacity,
    skipped_same_symbol: skippedSameSymbol,
    ambiguous_exits: acceptedTrades.filter((trade) => trade.ambiguous || legRows(trade).some((leg) => leg.ambiguous)).length,
    peak_concurrent: peakConcurrent,
    open_at_end: openTradeIds.size,
    realized_pnl_usd: pct(realizedUsd),
    open_mark_to_market_usd: pct(openPnlUsd),
    final_equity_usd: pct(1000 + realizedUsd + openPnlUsd),
    trades: taken,
  };
}

function splitPortfolioLegs(
  start: number,
  core: Obj,
  runner: Obj | null,
  currentMark: number | null,
  now: number,
): Array<{ start: number; end: number; pnlPct: number; notionalUsd: number; marginUsd: number; ambiguous?: boolean }> | null {
  const coreEnd = Number(core.exit_time_ms ?? now);
  const corePnl = num(core.pnl_pct);
  if (corePnl === null) return null;
  if (
    core.exit_reason !== "protected_stop"
    || !runner
    || runner.exit_reason === "runner_lifetime_expired_before_core_close"
  ) {
    return [{
      start,
      end: coreEnd,
      pnlPct: corePnl,
      notionalUsd: 1000,
      marginUsd: 100,
      ambiguous: String(core.exit_reason).startsWith("ambiguous"),
    }];
  }
  const runnerPnl = num(runner.pnl_pct) ?? currentMark;
  if (runnerPnl === null) return null;
  return [
    {
      start,
      end: coreEnd,
      pnlPct: corePnl,
      notionalUsd: 800,
      marginUsd: 80,
    },
    {
      start: coreEnd,
      end: Number(runner.exit_time_ms ?? now),
      pnlPct: runnerPnl,
      notionalUsd: 200,
      marginUsd: 20,
      ambiguous: String(runner.exit_reason).startsWith("ambiguous"),
    },
  ];
}

function currentPortfolioModel(signals: Obj[], barsBySymbol: Map<string, C[]>, stopPct = -8, lockAt10 = false, maxDays = 4): Obj {
  const now = Date.now();
  const trades: Array<{ id: number; symbol: string; start: number; end: number; pnlPct: number; ambiguous?: boolean; legs: NonNullable<ReturnType<typeof splitPortfolioLegs>> }> = [];
  let unavailable = 0;
  for (const s of signals) {
    const start = dateMs(s.detected_at);
    const entry = num(s.entry_price);
    if (start === null || entry === null || entry <= 0) {
      unavailable++;
      continue;
    }
    const bars = barsBySymbol.get(s.symbol) ?? [];
    const core = exitSimulation(bars, start, entry, maxDays, stopPct, 15, 10, lockAt10);
    const runner = core.exit_reason === "protected_stop"
      ? runnerAfterCore(bars, start, core.exit_time_ms, entry)
      : null;
    const currentMark = bars.at(-1) ? pct((bars.at(-1)!.close / entry - 1) * 100) : null;
    const legs = splitPortfolioLegs(start, core, runner, currentMark, now);
    if (!legs) {
      unavailable++;
      continue;
    }
    const totalPnl = legs.reduce((sum, leg) => sum + leg.notionalUsd * leg.pnlPct / 100, 0) / 1000 * 100;
    const end = Math.max(...legs.map((leg) => leg.end));
    trades.push({
      id: Number(s.id),
      symbol: s.symbol,
      start,
      end,
      pnlPct: totalPnl,
      legs,
      ambiguous: String(core.exit_reason).startsWith("ambiguous") || Boolean(runner && String(runner.exit_reason).startsWith("ambiguous")),
    });
  }
  return { ...depositModel(trades), excluded_no_price_or_entry: unavailable };
}

function priceStopPortfolio(signals: Obj[], barsBySymbol: Map<string, C[]>, source: "signal_candle" | "wyckoff_base"): Obj {
  const now = Date.now();
  const trades: Array<{ id: number; symbol: string; start: number; end: number; pnlPct: number; ambiguous?: boolean; legs: NonNullable<ReturnType<typeof splitPortfolioLegs>> }> = [];
  let unavailable = 0;
  for (const s of signals) {
    const start = dateMs(s.detected_at);
    const entry = num(s.entry_price);
    const imp = s.impulse_decision_metrics ?? {};
    const candle = s._extras?.candle ?? {};
    const reference = source === "signal_candle"
      ? num(candle.low ?? candle.candleLow ?? imp.candleLow)
      : num(s._wyckoff?.rangeBottom);
    const stopPrice = reference !== null ? reference * 0.999 : null;
    if (start === null || entry === null || entry <= 0 || stopPrice === null || stopPrice >= entry) {
      unavailable++;
      continue;
    }
    const stopPct = ((stopPrice / entry) - 1) * 100;
    const bars = barsBySymbol.get(s.symbol) ?? [];
    const core = exitSimulation(bars, start, entry, 4, stopPct, 15, 10);
    const runner = core.exit_reason === "protected_stop"
      ? runnerAfterCore(bars, start, core.exit_time_ms, entry)
      : null;
    const currentMark = bars.at(-1) ? pct((bars.at(-1)!.close / entry - 1) * 100) : null;
    const legs = splitPortfolioLegs(start, core, runner, currentMark, now);
    if (!legs) {
      unavailable++;
      continue;
    }
    const totalPnl = legs.reduce((sum, leg) => sum + leg.notionalUsd * leg.pnlPct / 100, 0) / 1000 * 100;
    const end = Math.max(...legs.map((leg) => leg.end));
    trades.push({
      id: Number(s.id),
      symbol: s.symbol,
      start,
      end,
      pnlPct: totalPnl,
      legs,
      ambiguous: String(core.exit_reason).startsWith("ambiguous") || Boolean(runner && String(runner.exit_reason).startsWith("ambiguous")),
    });
  }
  return { ...depositModel(trades), excluded_no_price_or_entry: unavailable };
}

function portfolioScenarios(signals: Obj[], pdb: Obj[], filters: Obj[], barsBySymbol: Map<string, C[]>): Obj[] {
  const rows: Obj[] = [];
  const add = (name: string, model: Obj, definition: string) => rows.push({
    scenario: name,
    definition,
    accepted_trades: model.accepted,
    skipped_for_capacity: model.skipped_capacity,
    skipped_same_symbol: model.skipped_same_symbol,
    ambiguous_exits: model.ambiguous_exits,
    excluded_no_price_or_entry: model.excluded_no_price_or_entry ?? 0,
    excluded_no_runner_entry: model.excluded_no_runner_entry ?? 0,
    peak_concurrent: model.peak_concurrent,
    open_at_end: model.open_at_end,
    realized_pnl_usd: model.realized_pnl_usd,
    open_mark_to_market_usd: model.open_mark_to_market_usd,
    final_equity_usd: model.final_equity_usd,
  });
  add("current 80/20", currentPortfolioModel(signals, barsBySymbol), "4d core, stop −8%, B.U. after +10%, core trailing +15/10, runner after core close +30/30 through 5d; $100 margin x10; OHLC replay");
  add("core term 7d", currentPortfolioModel(signals, barsBySymbol, -8, false, 7), "counterfactual: core can run 7d; runner policy still expires at 5d; all other rules unchanged");
  add("below signal candle", priceStopPortfolio(signals, barsBySymbol, "signal_candle"), "4d core, stop 0.1% below recorded entry-candle low; 80/20, other rules unchanged");
  add("below Wyckoff base", priceStopPortfolio(signals, barsBySymbol, "wyckoff_base"), "4d core, stop 0.1% below recorded Wyckoff base; 80/20, other rules unchanged");
  for (const stop of [-5, -6, -8, -10]) add(`stop ${stop}%`, currentPortfolioModel(signals, barsBySymbol, stop), `same rules, initial stop ${stop}%; runner 80/20; OHLC replay`);
  add("+10% then floor +5%", currentPortfolioModel(signals, barsBySymbol, -8, true), "same current model but core protected stop is +5% after +10%; OHLC replay");
  const runner = runnerOnlyPortfolio(signals, barsBySymbol);
  add("runner only", runner, "runner 20% leg only, emergency B.E., trailing +30/30, 5d; $20 margin / $200 notional");

  const gates = ["price24h_ge_15", "wyckoff_breakout_without_base", "wyckoff_fail_closed", "lucy_climax_OMW", "K1_below_0.95", "no_data", "spot_mcap_ge_1pct", "spot_mcap_not_6_to_15", "spot_taker_netbuy_gt_10"];
  const idsByGate = new Map<string, Set<number>>();
  for (const gate of gates) {
    idsByGate.set(gate, new Set(filters.filter((r) => r.entity_type === "rejected_candidate" && r.gate === gate && r.only_recorded_block).map((r) => Number(r.id))));
  }
  for (const gate of gates) {
    const extra = pdb.filter((e) => idsByGate.get(gate)!.has(Number(e.id))).map((e) => ({ ...e, detected_at: e.decision_at }));
    add(`remove ${gate}`, currentPortfolioModel([...signals, ...extra], barsBySymbol), `A plus B rows where this is the only recorded block; price-only outcome simulation`);
  }
  const thresholdPool = [...signals, ...pdb.map((e) => ({ ...e, detected_at: e.decision_at }))];
  for (const metricKey of ["futTakerNetBuyPct", "futTakerNetBuyPctPrev1h"]) {
    for (const threshold of TAKER_THRESHOLDS) {
      const retained = thresholdPool.filter((e) => {
        const value = metric(e, metricKey).value;
        return value !== null && num(value)! > threshold;
      });
      add(`${metricKey} > ${threshold}%`, currentPortfolioModel(retained, barsBySymbol), `A+B rows; missing historical taker values fail this gate`);
    }
  }
  return rows;
}

function runnerOnlyPortfolio(signals: Obj[], barsBySymbol: Map<string, C[]>): Obj {
  const now = Date.now();
  const trades: Array<{ id: number; symbol: string; start: number; end: number; pnlPct: number; ambiguous?: boolean; legs: Array<{ start: number; end: number; pnlPct: number; notionalUsd: number; marginUsd: number; ambiguous?: boolean }> }> = [];
  let unavailable = 0;
  let noRunnerEntry = 0;
  for (const s of signals) {
    const signalStart = dateMs(s.detected_at);
    const entry = num(s.entry_price);
    if (signalStart === null || entry === null || entry <= 0) {
      unavailable++;
      continue;
    }
    const bars = barsBySymbol.get(s.symbol) ?? [];
    const core = exitSimulation(bars, signalStart, entry, 4, -8, 15, 10);
    if (core.exit_reason !== "protected_stop" || core.exit_time_ms === null) {
      noRunnerEntry++;
      continue;
    }
    const start = core.exit_time_ms;
    const runner = runnerAfterCore(bars, signalStart, start, entry);
    if (runner.exit_reason === "runner_lifetime_expired_before_core_close") {
      noRunnerEntry++;
      continue;
    }
    const lastMark = bars.at(-1) ? pct(((bars.at(-1)!.close / entry) - 1) * 100) : null;
    const pnl = runner.pnl_pct ?? lastMark;
    if (pnl === null) {
      unavailable++;
      continue;
    }
    trades.push({
      id: Number(s.id),
      symbol: s.symbol,
      start,
      end: Number(runner.exit_time_ms ?? now),
      pnlPct: Number(pnl),
      legs: [{
        start,
        end: Number(runner.exit_time_ms ?? now),
        pnlPct: Number(pnl),
        notionalUsd: 200,
        marginUsd: 20,
        ambiguous: String(runner.exit_reason).startsWith("ambiguous"),
      }],
      ambiguous: String(runner.exit_reason).startsWith("ambiguous"),
    });
  }
  const model = depositModel(trades, 200, 50);
  return {
    ...model,
    excluded_no_price_or_entry: unavailable,
    excluded_no_runner_entry: noRunnerEntry,
    allocation: "runner-only after a protected core close, $20 margin / $200 notional; signals without core close are excluded",
  };
}

function summarizeGroups(events: Obj[], field = "outcome_72h"): string {
  const groups: Record<string, Obj[]> = { good: [], bad: [], open: [], ambiguous: [], no_price: [] };
  for (const e of events) {
    const key = String(e[field] ?? "no_price");
    (groups[key] ?? groups.no_price).push(e);
  }
  return Object.entries(groups).map(([name, rows]) => {
    const names = rows.map((x) => `${x.symbol}#${x.id}@${x.detected_at_utc}`).join(", ");
    return `- ${name}: ${rows.length}${names ? ` — ${names}` : ""}`;
  }).join("\n");
}

function summarizeCounts(events: Obj[], field: string): string {
  const counts: Record<string, number> = { good: 0, bad: 0, open: 0, ambiguous: 0, no_price: 0 };
  for (const e of events) {
    const key = String(e[field] ?? "no_price");
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return Object.entries(counts).map(([key, value]) => `${key}=${value}`).join("; ");
}

function pairwiseMetrics(events: Obj[]): string {
  const good = events.filter((e) => e.cohort === "signal" && e.outcome_72h === "good");
  const bad = events.filter((e) => e.cohort === "signal" && e.outcome_72h === "bad");
  const keys = [
    "price24h", "price3h", "price1h", "volumeMultiplier", "spotVolumeMultiplier",
    "lucy30mVolAvg120", "futTakerNetBuyPctPrev1h", "futTakerNetBuyPct",
    "spotTakerNetBuyPct", "spotNetBuy1h", "cvd15m", "cvd30m", "cvd1h", "cvd4h",
    "oi30m", "oi1h", "oi4h", "oi24h", "fundingRate", "liqLong1h", "liqLong24h",
    "liqRatio", "spotVol24hUsd", "spotVolPctMcap", "candleVolumeUsd", "candleVolumeMult",
  ];
  const rows = keys.map((key) => {
    const prop = `metric_${key}`;
    const g = good.filter((x) => num(x[prop]) !== null);
    const b = bad.filter((x) => num(x[prop]) !== null);
    const vals = [...new Set([...g, ...b].map((x) => num(x[prop])!))].sort((a, b) => a - b);
    let best: { score: number; cutoff: number; direction: string; goodPass: Obj[]; badPass: Obj[] } | null = null;
    for (const cutoff of vals) {
      for (const direction of ["≥", "≤"]) {
        const pass = (x: Obj) => direction === "≥" ? num(x[prop])! >= cutoff : num(x[prop])! <= cutoff;
        const gp = g.filter(pass);
        const bp = b.filter(pass);
        const tpr = gp.length / Math.max(1, g.length);
        const tnr = (b.length - bp.length) / Math.max(1, b.length);
        const score = (tpr + tnr) / 2;
        if (g.length && b.length && gp.length < g.length && bp.length < b.length && (!best || score > best.score)) {
          best = { score, cutoff, direction, goodPass: gp, badPass: bp };
        }
      }
    }
    if (!best) return `| ${key} | ${g.length}/${good.length} | ${b.length}/${bad.length} | недостаточно вариации | |`;
    const goodFail = g.filter((x) => !best!.goodPass.includes(x));
    const badFail = b.filter((x) => !best!.badPass.includes(x));
    return `| ${key} | ${g.length}/${good.length} | ${b.length}/${bad.length} | ${best.direction} ${Number(best.cutoff.toPrecision(6))} (balanced=${pct(best.score * 100)}%) | good pass: ${best.goodPass.map((x) => `${x.symbol}#${x.id}`).join(", ") || "—"}; good fail: ${goodFail.map((x) => `${x.symbol}#${x.id}`).join(", ") || "—"}; bad pass: ${best.badPass.map((x) => `${x.symbol}#${x.id}`).join(", ") || "—"}; bad fail: ${badFail.map((x) => `${x.symbol}#${x.id}`).join(", ") || "—"} |`;
  });
  return [
    "| Метрика | good с записью | bad с записью | лучший внутривыборочный разделитель | имена, проходящие разделитель |",
    "|---|---:|---:|---|---|",
    ...rows,
  ].join("\n");
}

function categoricalMetrics(events: Obj[]): string {
  const good = events.filter((e) => e.cohort === "signal" && e.outcome_72h === "good");
  const bad = events.filter((e) => e.cohort === "signal" && e.outcome_72h === "bad");
  const keys = ["lucy30mColour", "lucy30mColourPrev1", "wyckoffPhase", "spotTakerDominance", "welkin"];
  const rows: string[] = [
    "| Метрика | значение | good names | bad names |",
    "|---|---|---|---|",
  ];
  for (const key of keys) {
    const prop = `metric_${key}`;
    const values = [...new Set([...good, ...bad].map((e) => e[prop]).filter((v) => v !== "" && v !== null && v !== undefined).map(String))].sort();
    for (const value of values) {
      const g = good.filter((e) => String(e[prop]) === value);
      const b = bad.filter((e) => String(e[prop]) === value);
      rows.push(`| ${key} | ${value} | ${g.map((e) => `${e.symbol}#${e.id}`).join(", ") || "—"} | ${b.map((e) => `${e.symbol}#${e.id}`).join(", ") || "—"} |`);
    }
  }
  return rows.join("\n");
}

function takerSummary(rows: Obj[]): string {
  const out: string[] = [
    "| Период | Источник | Порог | выборка | записано | нет записи | отсечено | good | bad | open/unknown |",
    "|---|---|---:|---:|---:|---:|---:|---:|---:|---:|",
  ];
  for (const metricKey of ["futTakerNetBuyPct", "futTakerNetBuyPctPrev1h"]) {
    for (const threshold of TAKER_THRESHOLDS) {
      const gate = `${metricKey}_le_${threshold}`;
      for (const half of ["2026-11-09_to_2026-11-17", "2026-11-18_to_now"]) {
        for (const type of ["signal", "rejected_candidate"]) {
          const subset = rows.filter((r) => r.gate === gate && r.time_half === half && r.entity_type === type);
          const measured = subset.filter((r) => r.recorded);
          const cut = subset.filter((r) => r.would_reject_by_metric_or_reason);
          out.push(`| ${half} | ${type} ${metricKey} | ${threshold}% | ${subset.length} | ${measured.length} | ${subset.length - measured.length} | ${cut.length} | ${cut.filter((x) => x.outcome72h === "good").length} | ${cut.filter((x) => x.outcome72h === "bad").length} | ${cut.filter((x) => ["open", "ambiguous", "no_price"].includes(String(x.outcome72h))).length} |`);
        }
      }
    }
  }
  return out.join("\n");
}

function codeReferences(): string {
  return [
    "- Основные hard-gates IB (volume, p3h, funding, OI1h, liquidation): artifacts/api-server/src/lib/scanner-patterns.ts:607-731; MIN_VOLUME_MULT=1.48 at :83; p24h constant at :501.",
    "- p24h >=15% evaluation/rejection: artifacts/api-server/src/lib/scanner.ts:10527-10535.",
    "- Wyckoff live gate: scanner.ts:10538-10564; compute: wyckoff-metrics.ts:26-125.",
    "- Lucy O/M/W and K1 >=0.95: ib-signal-candle-vsa.ts:20-116; live evaluation: scanner.ts:10566-10590.",
    "- Confirmed-fire spot volume/MCap and spot taker gates: scanner.ts:8389-8639; exhausted-pump gate: scanner.ts:10615-10660.",
    "- Impulse Buy cancellation policy (no stale, 6h smart grace, max age 72h, CVD/OI confirmation): cancellation-policy.ts:91-105,160-173; watcher evaluation: watcher.ts:10905-11125; cancel analytics transaction: watcher.ts:14500-14535.",
    "- scan_reject_log cleanup: artifacts/api-server/src/index.ts:3656-3677; deletion threshold is 30 days.",
    "- Stop cap: watcher-config.ts:167-189 (Impulse Buy max stop 8%); default first target/trailing: watcher-config.ts:3-9,33-35,91-95.",
    "- Core/runner policy split 80/20 and runner trailing: impulse-runner-policy.ts:1-8,153-254; close/write paths: watcher.ts:6570-6682,6822-6945.",
    "- Post-close hourly follow-up collection: watcher.ts:14075-14147; snapshot values built in post-close-followup.ts:45-112.",
  ].join("\n");
}

async function main(): Promise<void> {
  const started = new Date().toISOString();
  writeFileSync(join(OUT, "run.txt"), `IB final study start: ${started}\nCoinGlass requests: 0\nPrice source: BingX public klines only; cache: reports/.cache\n`);
  const signals = loadSignals().map((s) => ({ ...s, _class: "signal" }));
  const reportBlocked1118 = readReportJsonl("reports/ib-review-1118/blocked.jsonl").map((row) => ({ ...row, _candidate_source: "reports/ib-review-1118/blocked.jsonl" }));
  const reportBlocked1119 = readReportJsonl("reports/ib-review-1119/blocked.jsonl").map((row) => ({ ...row, _candidate_source: "reports/ib-review-1119/blocked.jsonl" }));
  const pdb = rollPdbCandidates([...reportBlocked1118, ...reportBlocked1119]);
  const shadows = [...readJsonl("shadow-candidates-0.jsonl"), ...readJsonl("shadow-candidates-1.jsonl")].map((x) => ({ ...x, _class: "shadow_candidate" }));
  const scanRows = readJsonl("scan-reject-symbol-day.jsonl");
  const events = allEvents(signals, pdb, shadows, scanRows);
  const symbols = [...new Set(events.map((e) => String(e.symbol)).filter(Boolean))];
  const startBySymbol = new Map<string, number>();
  for (const e of events) {
    const t = eventTime(e);
    if (t === null) continue;
    startBySymbol.set(e.symbol, Math.min(startBySymbol.get(e.symbol) ?? Infinity, t - D1));
  }
  for (const [, symbol] of LEADER_NAMES) startBySymbol.set(symbol, Math.min(startBySymbol.get(symbol) ?? Infinity, LEADER_START - D1));
  const barsBySymbol = new Map<string, C[]>();
  let priceErrors = 0;
  const priceSymbols = [...new Set([...symbols, ...LEADER_NAMES.map((x) => x[1])])];
  let nextPriceSymbol = 0;
  const priceWorker = async () => {
    while (true) {
      const index = nextPriceSymbol++;
      const symbol = priceSymbols[index];
      if (!symbol) return;
      try {
        const bars = await klines(CACHE, symbol, "15m", Math.max(FROM - D1, startBySymbol.get(symbol) ?? FROM), Date.now());
        barsBySymbol.set(symbol, bars);
      } catch (err) {
        priceErrors++;
        appendFileSync(join(OUT, "run.txt"), `BingX klines unavailable ${symbol}: ${err instanceof Error ? err.message : String(err)}\n`);
      }
    }
  };
  await Promise.all(Array.from({ length: 4 }, () => priceWorker()));
  const eventOutput = eventRows(events, barsBySymbol);
  writeCsv("events.csv", eventOutput);
  const filtersLong = filterRows(events, barsBySymbol);
  const filters = wideFilterRows(filtersLong, events);
  writeCsv("filters.csv", filters);
  const followups = followupMap();
  const cancels = cancellationRows(signals, barsBySymbol, followups);
  writeCsv("cancels72h.csv", cancels);
  const stops = stopsRows(signals, barsBySymbol, followups);
  writeCsv("stops.csv", stops);
  const missing = outputMissing(events);
  writeCsv("missing_metrics.csv", missing);
  const wy = await wyckoffRows(signals, pdb);
  writeCsv("wyckoff_check.csv", wy);
  const leadersPdb = readJsonl("leader-pdb-48h.jsonl");
  const leaderMissed = readJsonl("leader-missed-signals.jsonl");
  const leaders = leaderRows(barsBySymbol, leadersPdb, scanRows, leaderMissed);
  writeCsv("leaders.csv", leaders);
  const portfolio = portfolioScenarios(signals, pdb, filtersLong, barsBySymbol);

  const statusCounts = Object.fromEntries([...new Set(signals.map((s) => String(s.status)))].map((status) => [status, signals.filter((s) => s.status === status).length]));
  const coreClosed = signals.filter((s) => s.core_closed_at != null);
  const runnerClosed = signals.filter((s) => s.runner_closed_at != null);
  const actualExecutionCounts = {
    policyVersion: [...new Set(signals.map((s) => s.policy_version))],
    coreClosedRows: coreClosed.length,
    runnerClosedRows: runnerClosed.length,
    rowsWithAnyCoreRunnerPnL: signals.filter((s) => num(s.core_pnl_percent) !== null || num(s.runner_pnl_percent) !== null).length,
  };
  const rawFiles = [
    ["tracked_signals", signals.length],
    ["signal_entry_extras non-empty joined rows", signals.filter((s) => Object.keys(s._extras ?? {}).length > 0).length],
    ["vsa_entry_metrics non-empty joined rows", signals.filter((s) => Object.keys(s._vsa ?? {}).length > 0).length],
    ["wyckoff_entry_metrics non-empty joined rows", signals.filter((s) => Object.keys(s._wyckoff ?? {}).length > 0).length],
    ["signal_volume_colors non-empty joined rows", signals.filter((s) => Object.keys(s._volumeColors ?? {}).length > 0).length],
    ["signal_pre_growth", 0],
    ["pattern_decision_snapshots daily export rows", Array.from({ length: 18 }, (_, i) => readJsonl(`candidates-2026-11-${String(i + 9).padStart(2, "0")}.jsonl`).length).reduce((a, b) => a + b, 0)],
    ["reports/ib-review-1118/blocked.jsonl raw", reportBlocked1118.length],
    ["reports/ib-review-1119/blocked.jsonl raw", reportBlocked1119.length],
    ["combined blocked events after rolling 24h", pdb.length],
    ["combined blocked events with review-file source", pdb.filter((e) => (e._candidate_sources ?? []).some((source: string) => source.startsWith("reports/ib-review-"))).length],
    ["missed_signals_log per-symbol-day", shadows.length],
    ["scan_reject_log grouped symbol-day rows", scanRows.length],
    ["signal_trajectory_log", readJsonl("signal_trajectory_log-0.jsonl").length],
    ["signal_drawdown_extrema", readJsonl("signal_drawdown_extrema-0.jsonl").length],
    ["signal_trailing_events", readJsonl("signal_trailing_events-0.jsonl").length],
    ["signal_profit_lock_shadow_events", readJsonl("signal_profit_lock_shadow_events-0.jsonl").length],
    ["signal_cancel_outcomes", readJsonl("signal_cancel_outcomes-0.jsonl").length],
    ["bu_stop_followup_snapshots", readJsonl("bu_stop_followup_snapshots-0.jsonl").length + readJsonl("bu_stop_followup_snapshots-500.jsonl").length],
    ["leader PDB snapshots (48h)", leadersPdb.length],
    ["leader missed_signals_log mixed-pattern rows (48h)", leaderMissed.length],
    ["leader scan_reject_log grouped symbol-reason rows (48h)", csvArray("leader-scan-rejects.csv").length],
    ["growth_leader_log mapped 14 symbols (48h)", 0],
    ["missed_movers mapped 14 symbols (48h)", 0],
    ["missed_movers_prices mapped 14 symbols (48h)", 0],
    ["missed_mover_prescan_snapshots mapped 14 symbols (48h)", 0],
    ["candidate_growth_tracking mapped 14 symbols (48h)", 0],
  ];
  const counts = {
    events: eventOutput.length,
    filters: filters.length,
    cancels: cancels.length,
    stops: stops.length,
    leaders: leaders.length,
    wyckoff: wy.length,
    missing: missing.length,
    deposit_scenarios: portfolio.length,
    prices: { symbols: barsBySymbol.size, errors: priceErrors, candles: [...barsBySymbol.values()].reduce((sum, rows) => sum + rows.length, 0) },
  };
  const sql = [
    "SELECT row_to_json(x) FROM (SELECT t.*, e.metrics AS extras, v.metrics AS vsa, w.metrics AS wyckoff, c.metrics AS volume_colors FROM tracked_signals t LEFT JOIN signal_entry_extras e ON e.tracked_signal_id=t.id LEFT JOIN vsa_entry_metrics v ON v.tracked_signal_id=t.id LEFT JOIN wyckoff_entry_metrics w ON w.tracked_signal_id=t.id LEFT JOIN signal_volume_colors c ON c.tracked_signal_id=t.id WHERE t.sentiment_key='impulse_buy' AND t.detected_at>=TIMESTAMP '2026-11-09 00:00:00' ORDER BY t.id) x;",
    "SELECT row_to_json(x) FROM (SELECT DISTINCT ON (symbol, (decision_at AT TIME ZONE 'UTC')::date) id, symbol, pattern_key, decision_kind, decision_reason, decision_at, entry_price, entry_metrics, reason_chain FROM pattern_decision_snapshots WHERE pattern_key='impulse_buy' AND decision_at>=TIMESTAMPTZ '2026-11-09 00:00:00+00' AND decision_kind='rejected' AND decision_reason<>'no_live_pattern_matched' ORDER BY symbol, (decision_at AT TIME ZONE 'UTC')::date, decision_at, id) x;",
    "SELECT symbol, date_trunc('day', cycle_at AT TIME ZONE 'UTC') AS utc_day, count(*) AS rows, min(cycle_at) AS first_at, max(cycle_at) AS last_at, array_agg(DISTINCT reason) AS reasons FROM scan_reject_log WHERE pattern='impulse_buy' AND cycle_at>=TIMESTAMPTZ '2026-11-23 06:01:04+00' GROUP BY symbol, utc_day ORDER BY utc_day, symbol;",
    "SELECT * FROM missed_signals_log WHERE pattern='impulse_buy' AND logged_at>=TIMESTAMP '2026-11-09 00:00:00' ORDER BY logged_at,id;",
    "SELECT * FROM signal_trajectory_log WHERE sentiment_key='impulse_buy' AND snapshot_at>=TIMESTAMP '2026-11-09 00:00:00' ORDER BY snapshot_at,id;",
    "SELECT * FROM signal_drawdown_extrema WHERE sentiment_key='impulse_buy' AND updated_at>=TIMESTAMP '2026-11-09 00:00:00' ORDER BY updated_at,id;",
    "SELECT * FROM signal_trailing_events WHERE sentiment_key='impulse_buy' AND observed_at>=TIMESTAMP '2026-11-09 00:00:00' ORDER BY observed_at,id;",
    "SELECT * FROM signal_profit_lock_shadow_events WHERE sentiment_key='impulse_buy' AND observed_at>=TIMESTAMP '2026-11-09 00:00:00' ORDER BY observed_at,id;",
    "SELECT * FROM signal_cancel_outcomes WHERE sentiment_key='impulse_buy' AND sent_at>=TIMESTAMP '2026-11-09 00:00:00' ORDER BY sent_at,id;",
    "SELECT * FROM bu_stop_followup_snapshots WHERE tracked_signal_id IN (SELECT id FROM tracked_signals WHERE sentiment_key='impulse_buy' AND detected_at>=TIMESTAMP '2026-11-09 00:00:00') AND hour_after_close<=72 ORDER BY tracked_signal_id,hour_after_close;",
    "WITH leaders(symbol) AS (VALUES ('GTA6-USDT'),('SSV-USDT'),('BULLA-USDT'),('ELSA-USDT'),('EVAA-USDT'),('NES-USDT'),('MANTRA-USDT'),('PRIORS-USDT'),('PIEVERSE-USDT'),('VRAX-USDT'),('NIUBI-USDT'),('BTW-USDT'),('MOVE-USDT'),('BLUR-USDT')), bounds AS (SELECT TIMESTAMP '2026-11-24 06:38:16.146' AS t0) SELECT 'growth_leader_log' AS source,count(*) AS rows,count(DISTINCT g.symbol) AS symbols,min(g.logged_at) AS first_at,max(g.logged_at) AS last_at FROM growth_leader_log g JOIN leaders l USING(symbol),bounds b WHERE g.logged_at>=b.t0 UNION ALL SELECT 'missed_movers',count(*),count(DISTINCT m.symbol),min(m.exited_at),max(m.exited_at) FROM missed_movers m JOIN leaders l USING(symbol),bounds b WHERE m.exited_at>=b.t0 UNION ALL SELECT 'missed_movers_prices',count(*),count(DISTINCT m.symbol),min(p.sampled_at),max(p.sampled_at) FROM missed_movers_prices p JOIN missed_movers m ON m.id=p.missed_mover_id JOIN leaders l USING(symbol),bounds b WHERE p.sampled_at>=b.t0 UNION ALL SELECT 'missed_mover_prescan_snapshots',count(*),count(DISTINCT m.symbol),min(p.cycle_at),max(p.cycle_at) FROM missed_mover_prescan_snapshots p JOIN missed_movers m ON m.id=p.missed_mover_id JOIN leaders l USING(symbol),bounds b WHERE p.cycle_at>=b.t0 UNION ALL SELECT 'candidate_growth_tracking',count(*),count(DISTINCT c.symbol),min(c.entry_timestamp),max(c.entry_timestamp) FROM candidate_growth_tracking c JOIN leaders l USING(symbol),bounds b WHERE c.entry_timestamp>=b.t0;",
  ];
  const filterSummaries = ["price24h_ge_15", "wyckoff_breakout_without_base", "wyckoff_fail_closed", "lucy_climax_OMW", "K1_below_0.95", "no_data", "volume_multiplier_ge_1.48", "price3h_lt_20", "funding_ge_minus_0.1pct", "OI1h_le_20pct", "long_liq24h_ge_47k", "spot_mcap_ge_1pct", "spot_mcap_not_6_to_15", "spot_taker_netbuy_gt_10"].map((gate) => {
    const subset = filtersLong.filter((x) => x.gate === gate && x.entity_type === "rejected_candidate" && x.would_reject_by_metric_or_reason);
    const sole = subset.filter((x) => x.only_recorded_block);
    return `| ${gate} | ${subset.length} | ${sole.length} | ${sole.filter((x) => x.outcome72h === "good").length} | ${sole.filter((x) => x.outcome72h === "bad").length} | ${sole.filter((x) => ["open", "ambiguous", "no_price"].includes(String(x.outcome72h))).length} |`;
  }).join("\n");
  const leadersBlock = leaders.map((r) => `- ${r.name} (${r.symbol}): ${r.conclusion}; PDB=${r.pattern_decision_rows_48h}, scan-log=${r.scan_reject_symbol_day_rows_48h}, 30m=${r.first_30m_candle_p24h_ge_15_utc ?? "не найдено"}.`).join("\n");
  const wyBlock = wy.map((r) => `- ${r.sample_type} ${r.symbol}#${r.id}: записано=${r.recorded_phase ?? "пусто"}, пересчёт=${r.recomputed_phase || r.recompute_status}, база=${r.base_bottom || "пусто"}–${r.base_top || "пусто"}, ${r.comparison || "нет сравнения"}.`).join("\n");
  const portfolioBlock = [
    "| Сценарий | приняты | без цены/входа | без runner entry | пропущены: лимит депозита | пропущены: та же монета | одновременных max | ambiguous exits | PnL реализованный $ | mark-to-market $ | итоговый депозит $ |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    ...portfolio.map((r) => `| ${r.scenario} | ${r.accepted_trades} | ${r.excluded_no_price_or_entry} | ${r.excluded_no_runner_entry} | ${r.skipped_for_capacity} | ${r.skipped_same_symbol} | ${r.peak_concurrent} | ${r.ambiguous_exits} | ${r.realized_pnl_usd} | ${r.open_mark_to_market_usd} | ${r.final_equity_usd} |`),
  ].join("\n");
  const zilRows = eventOutput.filter((x) => x.cohort === "signal" && x.symbol === "ZIL-USDT" && String(x.detected_at_utc).startsWith("2026-11-18"));
  const zilBlock = zilRows.length
    ? zilRows.map((x) => `- ZIL-USDT#${x.id}, ${x.detected_at_utc}: outcome=${x.outcome_72h}, recorded PnL=${x.bot_pnl_pct ?? ""}, futures taker 15m=${x.metric_futTakerNetBuyPct ?? ""}, prev1h=${x.metric_futTakerNetBuyPctPrev1h ?? ""}; полная запись в events.csv.`).join("\n")
    : "- В выборке tracked_signals нет сигнала ZIL-USDT за 18.11; проверить именно кейс −5.03% по данным этого среза нельзя.";
  const summary = [
    "# Impulse Buy — итоговый разбор",
    "",
    `Срез production: ${started}. Период сигналов: с 2026-11-09 00:00 UTC по срез; цены — только закрытые BingX 15m свечи. Свежих запросов CoinGlass: 0. Агрегированные метрики — только из production DB и уже имеющегося reports/.cache; поля отсутствующих метрик оставлены пустыми.`,
    "",
    "## Метод и выборки",
    `- A — ${signals.length} tracked_signals; outcome 72h по первому касанию +10% / −8% на 15m OHLC. Если оба уровня внутри одной свечи — ambiguous; незрелое окно остаётся open.`,
    `- Текущие статусы: ${JSON.stringify(statusCounts)}. Core/runner evidence в DB: ${JSON.stringify(actualExecutionCounts)}; это не заменяется симуляцией.`,
    `- B — ${pdb.length} кандидатов из ${9867} первых non-no_live/non-fired snapshot на символ/UTC-день, объединённых в 24h окна. Исход — такой же price-only proxy; причины и метрики — из PDB.`,
    `- Shadow evidence: ${shadows.length} первых записей per symbol/day из missed_signals_log; отдельно от rejected PDB, не считаются автоматически отказом.`,
    "- Повторные snapshots одной монеты в 24h объединены; все reason-chain коды сохранены. Это не число всех raw snapshots.",
    "- Имена/время/ID и значения метрик по каждой записи — events.csv; каждая фильтрация с отдельными колонками — filters.csv.",
    "",
    "## Результат A: price-only +10 до −8",
    "Каждая группа содержит все имена, id и время. good = +10 раньше −8; bad = −8 раньше +10; same 15m candle = ambiguous; no_price = неполное покрытие.",
    "### 24h",
    summarizeGroups(eventOutput.filter((x) => x.cohort === "signal"), "outcome_24h"),
    "### 72h",
    summarizeGroups(eventOutput.filter((x) => x.cohort === "signal"), "outcome_72h"),
    "### 7d",
    summarizeGroups(eventOutput.filter((x) => x.cohort === "signal"), "outcome_7d"),
    "",
    "## B: rejected PDB candidates, price-only",
    `- B candidates=${pdb.length}; following groups are not actual bot positions. Full symbol/ID/time lists are included by outcome for every horizon.`,
    "### 24h",
    summarizeGroups(eventOutput.filter((x) => x.cohort === "rejected_candidate"), "outcome_24h"),
    "### 72h",
    summarizeGroups(eventOutput.filter((x) => x.cohort === "rejected_candidate"), "outcome_72h"),
    "### 7d",
    summarizeGroups(eventOutput.filter((x) => x.cohort === "rejected_candidate"), "outcome_7d"),
    "",
    "## Shadow candidates, separately",
    summarizeCounts(eventOutput.filter((x) => x.cohort === "shadow_candidate"), "outcome_72h"),
    "",
    "## Фильтры: изолированный counterfactual",
    "Для ретроспективной проверки отсутствие обязательной метрики считается провалом фильтра; исходное поле при этом остаётся пустым с пометкой «не записано ботом». «Единственный блок» — ни другой проверяемый гейт, ни другая записанная причина не провалились. Outcome на свечах — не исполненный ботом PnL.",
    "| Фильтр | кандидаты, где сработал | единственный сохранённый блок | good | bad | open/unknown |",
    "|---|---:|---:|---:|---:|---:|",
    filterSummaries,
    "",
    "## Futures taker thresholds",
    "Threshold matrix uses decision-time values; absent metrics count as gate failure per the prior choice, remain blank in source columns, and are counted separately as 'нет записи'.",
    takerSummary(filtersLong),
    "",
    "ZIL-USDT 18.11 (проверка отдельного хорошего примера):",
    zilBlock,
    "",
    "## Good vs bad: разделяющие пороги",
    "Для каждой метрики рассчитан лучший одномерный разделитель по сбалансированной точности на текущих A good/bad; это внутривыборочная диагностика, не валидация. Все имена, проходящие порог, перечислены.",
    pairwiseMetrics(eventOutput),
    "",
    "Категориальные значения:",
    categoricalMetrics(eventOutput),
    "",
    "## Пересчёт Wyckoff",
    "Использован тот же `computeWyckoff` по кешированным BingX 1H OHLC + уже имеющемуся CoinGlass aggregated futures volume cache; новых запросов CoinGlass нет. Для 10 fired + 10 отклонённых по Wyckoff:",
    wyBlock,
    "",
    "## Отмены, стопы, выходы",
    `- Отмены в cancels72h.csv: ${cancels.length}; источник 72h follow-up указан на каждой строке.`,
    `- Stop variants в stops.csv: ${stops.length} строк (−5/−6/−8/−10, ниже минимума свечи/базы с буфером 0.1%); MAE до +10 и 72h после stop по каждому имени.`,
    "- В stops.csv отдельно рассчитаны core-only и weighted 80/20 для текущих 4 дней и counterfactual 7 дней; в 7-дневном варианте runner сохраняет кодовый срок 5 дней.",
    `- Фактические core/runner поля и bot PnL сохранены отдельно от симуляции в events.csv. В production: core closed=${coreClosed.length}, runner closed=${runnerClosed.length}, фактический PnL хотя бы одной ноги=${actualExecutionCounts.rowsWithAnyCoreRunnerPnL}; остальные остаются пустыми и не реконструируются как факт.`,
    "",
    "### Депозит $1000, маржа $100, плечо 10x",
    "Хронологическая модель: $1000 начальный баланс, максимум 10 одновременных позиций, $100 маржи / $1000 notional на вход, без комиссий и проскальзывания. Пока core открыт, используется полный размер; только при защищённом core-close 80% фиксируются и runner 20% остаётся до своего выхода. При initial stop или expiry runner не открывается. Выходы смоделированы по 15m OHLC; same-candle порядок не угадывается, сигнал отмечается ambiguous. Это модель, не фактические сделки.",
    portfolioBlock,
    "- `current 80/20` использует исторические параметры кода: core максимум 4 дня, стоп −8%, защита после +10%, trailing +15%/10 п.п.; runner после core close +30%/30 п.п. до 5 дней. `core term 7d` меняет только срок core на 7 дней. Незакрытые на срезе оцениваются по последнему закрытому close.",
    "- `remove ...` добавляет только B-записи, у которых этот gate — единственная записанная причина; это минимальная оценка удаления одного фильтра.",
    "- Runner-only учитывает только сигналы, где защищённое закрытие core открывает runner-state; $20 маржи / $200 notional, максимум 50 слотов. Сигналы без runner entry указаны отдельно.",
    "",
    "## Лидеры 26.11",
    leadersBlock,
    "",
    "30m «начало роста» определено как первая 30m свеча, закрывшаяся при BingX p24h ≥15% в окне последних 48h. Это конкретная цена-гейт точка, а не субъективная локальная впадина. Для иных входных метрик требуется запись PDB рядом по времени; иначе значение пустое и отмечено в missing_metrics.csv.",
    "",
    "## Missing metrics",
    `В missing_metrics.csv — ${missing.length} строк metric×cohort: value пусто, указаны число событий без значения, источник проверки и примеры. В events.csv сами поля метрик пустые на каждой записи, где бот их не сохранил.`,
    "",
    "## Источники production и строки выгрузок",
    "| Источник | Строк |",
    "|---|---:|",
    ...rawFiles.map(([name, count]) => `| ${name} | ${count} |`),
    "| signal_pre_growth | 0 |",
    "| growth_leader_log | 0 mapped rows in 48h leader window |",
    "| missed_movers | 0 mapped rows in 48h leader window |",
    "| missed_movers_prices | 0 mapped rows in 48h leader window |",
    "| missed_mover_prescan_snapshots | 0 mapped rows in 48h leader window |",
    "| candidate_growth_tracking | 0 mapped rows in 48h leader window |",
    "| missed_signals_log (all IB since Nov 9) | 10757 raw rows; 781 per-symbol/day rows retained for event analysis |",
    "| scan_reject_log (IB retained interval) | 111463 raw rows; coverage 2026-11-23 06:30:47.203Z–2026-11-26 06:00:50.088Z |",
    "| pattern_decision_snapshots | 69578 raw rows; 42397 non-fired/non-no_live; 9867 symbol-day first rows |",
    "",
    "### SQL selection criteria (production, SELECT only; paged exports use the same WHERE/order filters)",
    ...sql.map((q) => `\n\`\`\`sql\n${q}\n\`\`\``),
    "",
    "### Code references",
    codeReferences(),
    "",
    "## Ограничения",
    "- Код очищает scan_reject_log старше 30 дней (index.ts:3674-3677). Но в этой production-выгрузке реально получен только интервал 2026-11-23 06:30:47–2026-11-26 06:00:50 UTC; причин до 23.11 в переданном срезе нет.",
    "- `missed_signals_log` has a Nov 9 bulk-looking run of 9344 rows across 514 symbols, followed by much smaller daily counts; it is kept separate and not treated as 9344 unique rejected trades.",
    "- Wyckoff chart check is OHLC-based; TradingView was not opened.",
    "- A current status / recorded PnL is not substituted with price-path simulation. Reclassified rows without exits remain unverified actual execution.",
    "",
    `## Output row counts\n${Object.entries(counts).map(([k,v])=>`- ${k}: ${typeof v === "object" ? JSON.stringify(v) : v}`).join("\n")}`,
  ].join("\n");
  writeFileSync(join(OUT, "summary.md"), `${summary}\n`);
  appendFileSync(join(OUT, "run.txt"), [
    `Signals A: ${signals.length}`,
    `PDB first-per-symbol-day raw: 9867; rolling-24h: ${pdb.length}`,
    `missed_signals_log raw: 10757; per-symbol-day: ${shadows.length}`,
    `scan_reject_log grouped symbol-day rows: ${scanRows.length}; raw: 111463`,
    `BingX symbols loaded: ${barsBySymbol.size}; 15m candles: ${counts.prices.candles}; errors: ${priceErrors}`,
    `Output rows: ${JSON.stringify(counts)}`,
    `Finished: ${new Date().toISOString()}`,
  ].join("\n") + "\n");
  console.log(JSON.stringify({ started, counts, outputFiles: ["events.csv", "filters.csv", "cancels72h.csv", "stops.csv", "leaders.csv", "wyckoff_check.csv", "missing_metrics.csv", "summary.md", "run.txt"] }, null, 2));
}

main().catch((err) => {
  const message = err instanceof Error ? `${err.stack ?? err.message}` : String(err);
  appendFileSync(join(OUT, "run.txt"), `FATAL: ${message}\n`);
  console.error(message);
  process.exitCode = 1;
});
