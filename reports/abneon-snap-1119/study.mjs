#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");
const SOURCE = path.join(HERE, "source");
const CACHE = path.join(ROOT, "reports/.cache");
const H1 = 3_600_000;
const H4 = 4 * H1;
const M15 = 900_000;
const SLOT = 600_000;
const HORIZON = 96 * H1;
const EXPECTED_SLOTS = 432;
const WAIT_WINDOWS_H = [48, 96, 168];
const TRADE_HORIZONS_H = [96, 168];

if (process.env.STUDY_OFFLINE !== "1") {
  throw new Error("Refusing to run without STUDY_OFFLINE=1; this script never makes network requests.");
}

function readLines(file) {
  const p = path.join(SOURCE, file);
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}
function readJson(file) {
  const p = path.join(CACHE, file);
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; }
}
function num(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}
function firstNum(...values) {
  for (const value of values) {
    const n = num(value);
    if (n !== null) return n;
  }
  return null;
}
function timeMs(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") return value;
  const n = Number(value);
  if (Number.isFinite(n) && n > 1e11) return n;
  const d = new Date(value);
  return Number.isFinite(d.getTime()) ? d.getTime() : null;
}
function iso(t) { return t == null ? "" : new Date(t).toISOString(); }
function pct(a, b) { return a == null || b == null || b === 0 ? null : (a / b - 1) * 100; }
function valueAt(object, pathText) {
  return pathText.split(".").reduce((value, key) => value?.[key], object);
}
function cleanSymbol(value) { return String(value ?? "").trim().toUpperCase(); }
function jsonlFiles(prefix) {
  return fs.readdirSync(SOURCE)
    .filter((name) => name.startsWith(prefix) && name.endsWith(".jsonl"))
    .sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
}
function readParts(prefix) { return jsonlFiles(prefix).flatMap(readLines); }
function csvCell(value) {
  if (value === null || value === undefined) return "";
  const s = String(value);
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}
function writeCsv(file, rows, columns) {
  const lines = [columns.join(",")];
  for (const row of rows) lines.push(columns.map((column) => csvCell(row[column])).join(","));
  fs.writeFileSync(path.join(HERE, file), `${lines.join("\n")}\n`);
}
function medianFreeRange(values) {
  const present = values.filter((x) => x.value !== null && Number.isFinite(x.value));
  if (!present.length) return null;
  let min = present[0], max = present[0];
  for (const x of present) {
    if (x.value < min.value) min = x;
    if (x.value > max.value) max = x;
  }
  return { n: present.length, min, max, present };
}

const cacheMemo = new Map();
function cached(symbol, suffix) {
  const key = `${symbol}${suffix}`;
  if (!cacheMemo.has(key)) cacheMemo.set(key, readJson(key));
  return cacheMemo.get(key);
}
function candleBars(symbol, tf) {
  const raw = cached(symbol, `_${tf}.json`);
  if (!raw || !Array.isArray(raw.items)) return [];
  const bars = raw.items.map((item) => {
    if (Array.isArray(item)) return {
      time: num(item[0]), open: num(item[1]), high: num(item[2]),
      low: num(item[3]), close: num(item[4]), volume: num(item[5]),
    };
    return {
      time: num(item.time), open: num(item.open), high: num(item.high),
      low: num(item.low), close: num(item.close), volume: num(item.volume),
    };
  }).filter((bar) => bar.time !== null && bar.close !== null)
    .sort((a, b) => a.time - b.time);
  return bars;
}
function cgBars(symbol, tf, market) {
  const suffix = tf === "15m" ? `_cg15m_agg${market}.json` : `_cg_agg${market}.json`;
  const raw = cached(symbol, suffix);
  if (!raw || !Array.isArray(raw.items)) return [];
  return raw.items.map((x) => ({
    time: num(x.time), buy: num(x.buy), sell: num(x.sell),
  })).filter((x) => x.time !== null && x.buy !== null && x.sell !== null)
    .sort((a, b) => a.time - b.time);
}
function volumeSeries(symbol, tf) {
  const futBars = cgBars(symbol, tf, "fut");
  const spotBars = cgBars(symbol, tf, "spot");
  const fut = new Map(futBars.map((x) => [x.time, x.buy + x.sell]));
  const spot = new Map(spotBars.map((x) => [x.time, x.buy + x.sell]));
  if (tf !== "4h") return { fut, spot, futCount: fut.size, spotCount: spot.size };
  const sumFour = (map) => {
    const hourMap = new Map();
    for (const [time, value] of map) {
      const bucket = Math.floor(time / H4) * H4;
      if (!hourMap.has(bucket)) hourMap.set(bucket, []);
      hourMap.get(bucket).push([time, value]);
    }
    const out = new Map();
    for (const [bucket, values] of hourMap) {
      values.sort((a, b) => a[0] - b[0]);
      if (values.length === 4 && values.every((x, i) => x[0] === bucket + i * H1)) {
        out.set(bucket, values.reduce((s, x) => s + x[1], 0));
      }
    }
    return out;
  };
  const f4 = sumFour(fut);
  const s4 = sumFour(spot);
  return { fut: f4, spot: s4, futCount: f4.size, spotCount: s4.size };
}
function intervalMs(tf) {
  return tf === "15m" ? M15 : tf === "1h" ? H1 : tf === "4h" ? H4 : 24 * H1;
}
function closedBarAt(bars, tf, at) {
  if (!bars.length || at == null) return null;
  const interval = intervalMs(tf);
  let lo = 0, hi = bars.length - 1, found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid].time + interval <= at + 1000) { found = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  return found < 0 ? null : { ...bars[found], index: found };
}
function closeAt(bars, tf, at) { return closedBarAt(bars, tf, at)?.close ?? null; }
function changeAt(bars, tf, at, duration) {
  const now = closeAt(bars, tf, at);
  const before = closeAt(bars, tf, at - duration);
  return pct(now, before);
}
function candleShape(bar) {
  if (!bar || !(bar.open > 0)) return {};
  const range = bar.high - bar.low;
  return {
    body_pct: (bar.close - bar.open) / bar.open * 100,
    range_pct: range / bar.open * 100,
    upper_wick_pct: (bar.high - Math.max(bar.open, bar.close)) / bar.open * 100,
    lower_wick_pct: (Math.min(bar.open, bar.close) - bar.low) / bar.open * 100,
    close_position: range > 0 ? (bar.close - bar.low) / range : null,
  };
}
function rsi14(bars, index) {
  if (index < 14) return null;
  let gain = 0, loss = 0;
  for (let i = 1; i <= 14; i++) {
    const delta = bars[i].close - bars[i - 1].close;
    gain += Math.max(0, delta); loss += Math.max(0, -delta);
  }
  gain /= 14; loss /= 14;
  for (let i = 15; i <= index; i++) {
    const delta = bars[i].close - bars[i - 1].close;
    gain = (gain * 13 + Math.max(0, delta)) / 14;
    loss = (loss * 13 + Math.max(0, -delta)) / 14;
  }
  return loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
}
function mfi14(bars, volumes, index) {
  if (index < 14) return null;
  let positive = 0, negative = 0;
  for (let i = index - 13; i <= index; i++) {
    const volume = volumes.get(bars[i].time);
    if (volume == null || !Number.isFinite(volume)) return null;
    const typical = (bars[i].high + bars[i].low + bars[i].close) / 3;
    const previous = (bars[i - 1].high + bars[i - 1].low + bars[i - 1].close) / 3;
    const flow = typical * volume;
    if (typical > previous) positive += flow;
    else if (typical < previous) negative += flow;
  }
  return negative === 0 ? 100 : 100 - 100 / (1 + positive / negative);
}
function cmf20(bars, volumes, index) {
  if (index < 19) return null;
  let flow = 0, total = 0;
  for (let i = index - 19; i <= index; i++) {
    const volume = volumes.get(bars[i].time);
    if (volume == null || !Number.isFinite(volume)) return null;
    const range = bars[i].high - bars[i].low;
    if (!(range > 0)) return null;
    flow += (((bars[i].close - bars[i].low) - (bars[i].high - bars[i].close)) / range) * volume;
    total += volume;
  }
  return total > 0 ? flow / total : null;
}
function highDistance(bars, tf, at, entry, days) {
  const interval = intervalMs(tf);
  const from = at - days * 24 * H1;
  let high = null;
  for (const bar of bars) {
    if (bar.time < from || bar.time + interval > at + 1000) continue;
    if (high === null || bar.high > high) high = bar.high;
  }
  return high && entry ? (entry / high - 1) * 100 : null;
}
function emaRelation(bars, tf, at, period, entry) {
  const interval = intervalMs(tf);
  const closed = bars.filter((bar) => bar.time + interval <= at + 1000);
  if (closed.length < period || !(entry > 0)) return { ema: null, above: null, reason: `need_${period}_closed_${tf}_bars` };
  const alpha = 2 / (period + 1);
  let ema = closed[0].close;
  for (let i = 1; i < closed.length; i++) ema = closed[i].close * alpha + ema * (1 - alpha);
  return { ema, above: entry > ema, reason: "" };
}
function welkinColor(values, i) {
  if (i < 19) return null;
  const window = values.slice(i - 19, i + 1);
  if (window.some((x) => x == null || !Number.isFinite(x))) return null;
  const avg = window.reduce((a, b) => a + b, 0) / 20;
  const sd = Math.sqrt(window.reduce((s, x) => s + (x - avg) ** 2, 0) / 20);
  const v = values[i];
  if (v > avg + 4 * sd) return "W";
  if (v > avg + 3 * sd) return "M";
  if (v > avg + 2 * sd) return "O";
  if (v > avg) return "A";
  if (i > 0 && values[i - 1] > 0 && v / values[i - 1] >= 1.25) return "Y";
  return "N";
}
function lucyColor(values, i) {
  if (i < 119) return null;
  const long = values.slice(i - 119, i + 1);
  if (long.some((x) => x == null || !Number.isFinite(x))) return null;
  const avg120 = long.reduce((a, b) => a + b, 0) / 120;
  if (values[i] < avg120) return "N";
  return welkinColor(values, i);
}
function candleColorAt(candles, tf, volumes, at) {
  const bar = closedBarAt(candles, tf, at);
  if (!bar || !volumes.length) return { lucy: null, welkin: null, reason: "closed_candle_or_volume_missing" };
  const map = new Map(volumes.map((x) => [x.time, x.total]));
  const vals = candles.map((x) => map.has(x.time) ? map.get(x.time) : null);
  const lucy = lucyColor(vals, bar.index);
  const welkin = welkinColor(vals, bar.index);
  const reason = lucy === null ? `need_120_complete_${tf}_volume_bars` : "";
  return { lucy, welkin, reason, bar: bar };
}
function aggregateVolumeContext(symbol, at) {
  const h1 = candleBars(symbol, "1h");
  const h4 = candleBars(symbol, "4h");
  const v1 = volumeSeries(symbol, "1h");
  const v4 = volumeSeries(symbol, "4h");
  const fut1 = v1.fut, spot1 = v1.spot, fut4 = v4.fut, spot4 = v4.spot;
  const hourBar = closedBarAt(h1, "1h", at);
  const fourBar = closedBarAt(h4, "4h", at);
  function ratio(map, index, bar) {
    if (!bar || index < 19) return null;
    const vals = h1.slice(index - 19, index + 1).map((x) => map.get(x.time));
    if (vals.some((x) => x == null)) return null;
    const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
    const current = map.get(bar.time);
    return avg > 0 && current != null ? current / avg : null;
  }
  const combined1h = h1.map((bar) => {
    if (!fut1.has(bar.time) || !spot1.has(bar.time)) return null;
    return fut1.get(bar.time) + spot1.get(bar.time);
  });
  const combined4h = h4.map((bar) => {
    if (!fut4.has(bar.time) || !spot4.has(bar.time)) return null;
    return fut4.get(bar.time) + spot4.get(bar.time);
  });
  const h1Total = new Map(h1.map((bar, i) => [bar.time, combined1h[i]]));
  const h4Total = new Map(h4.map((bar, i) => [bar.time, combined4h[i]]));
  const h1Vol = h1.map((bar) => ({ time: bar.time, total: h1Total.get(bar.time) }));
  const h4Vol = h4.map((bar) => ({ time: bar.time, total: h4Total.get(bar.time) }));
  const h1Color = hourBar ? candleColorAt(h1, "1h", h1Vol, hourBar.time + H1) : null;
  const h4Color = fourBar ? candleColorAt(h4, "4h", h4Vol, fourBar.time + H4) : null;
  const spotMissing = !spot1.size || !spot4.size;
  return {
    h1FutRatio20: hourBar ? ratio(fut1, hourBar.index, hourBar) : null,
    h1SpotRatio20: hourBar ? ratio(spot1, hourBar.index, hourBar) : null,
    h1Lucy: h1Color?.lucy ?? null, h1Welkin: h1Color?.welkin ?? null,
    h1LucyReason: spotMissing ? "spot_aggregate_cache_missing; no zero substitution" : (h1Color?.reason ?? ""),
    h4Lucy: h4Color?.lucy ?? null, h4Welkin: h4Color?.welkin ?? null,
    h4LucyReason: spotMissing ? "spot_aggregate_cache_missing; no zero substitution" : (h4Color?.reason ?? ""),
    h1Bar: hourBar, h4Bar: fourBar, h1, h4, fut1, spot1, fut4, spot4,
  };
}
function technicalCandleMetrics(event, cutoffAt, hasEntry) {
  const symbol = event.symbol;
  const h1 = candleBars(symbol, "1h"), h4 = candleBars(symbol, "4h");
  const v1 = volumeSeries(symbol, "1h"), v4 = volumeSeries(symbol, "4h");
  const top = num(event.zone_top), bottom = num(event.zone_bottom);
  const armAt = timeMs(event.arm_at) ?? timeMs(event.event_at);
  const touchBar1h = top && armAt !== null
    ? h1.find((bar) => bar.time >= armAt && cutoffAt !== null && bar.time < cutoffAt && bar.low <= top * 1.002)
    : null;
  const touchIndex4h = touchBar1h ? h4.findIndex((bar) => bar.time <= touchBar1h.time && bar.time + H4 > touchBar1h.time) : -1;
  const combined = (tfBars, fut, spot) => tfBars.map((bar) => {
    const f = fut.get(bar.time), s = spot.get(bar.time);
    return { time: bar.time, total: f !== undefined && s !== undefined ? f + s : null };
  });
  const agg1 = combined(h1, v1.fut, v1.spot), agg4 = combined(h4, v4.fut, v4.spot);
  const bingx1 = h1.map((bar) => ({ time: bar.time, total: bar.volume != null ? bar.volume * (bar.high + bar.low + bar.close) / 3 : null }));
  const bingx4 = h4.map((bar) => ({ time: bar.time, total: bar.volume != null ? bar.volume * (bar.high + bar.low + bar.close) / 3 : null }));
  const candleDetail = (bars, tf, volumes, bingx, index) => {
    if (index < 0 || index >= bars.length) return null;
    const bar = bars[index];
    if (cutoffAt !== null && bar.time + intervalMs(tf) > cutoffAt + 1000) return null;
    const values = volumes.map((x) => x.total);
    const bvalues = bingx.map((x) => x.total);
    const ratio = (series, window) => {
      if (index < window - 1) return null;
      const valuesInWindow = series.slice(index - window + 1, index + 1);
      if (valuesInWindow.some((x) => x == null || !Number.isFinite(x))) return null;
      const avg = valuesInWindow.reduce((a, b) => a + b, 0) / window;
      return avg > 0 ? valuesInWindow.at(-1) / avg : null;
    };
    const color = (series, kind) => kind === "agg"
      ? { lucy: lucyColor(series, index), welkin: welkinColor(series, index) }
      : { lucy: null, welkin: welkinColor(series, index) };
    const aggColor = color(values, "agg"), bxColor = color(bvalues, "bingx");
    return {
      candle_open_utc: iso(bar.time), ...candleShape(bar),
      lucy_aggregated_usd: aggColor.lucy,
      welkin_aggregated_usd: aggColor.welkin,
      welkin_bingx_turnover_proxy: bxColor.welkin,
      aggregated_to_avg20: ratio(values, 20),
      aggregated_to_avg120: ratio(values, 120),
      bingx_turnover_proxy_to_avg20: ratio(bvalues, 20),
      bingx_turnover_proxy_to_avg120: ratio(bvalues, 120),
      aggregated_volume_missing: values[index] == null,
    };
  };
  const result = {
    zone_touch_1h_at: touchBar1h ? iso(touchBar1h.time) : "",
    zone_touch_4h_at: touchIndex4h >= 0 ? iso(h4[touchIndex4h].time) : "",
    zone_age_hours_at_entry: hasEntry && armAt !== null && cutoffAt !== null ? (cutoffAt - armAt) / H1 : null,
    setup_age_hours_to_observation: !hasEntry && armAt !== null && cutoffAt !== null ? (cutoffAt - armAt) / H1 : null,
    zone_touch_1h_count_until_entry: touchBar1h && cutoffAt !== null
      ? h1.filter((bar) => bar.time >= armAt && bar.time < cutoffAt && bar.low <= (top ?? Infinity) * 1.002).length : null,
    zone_support_pivot_count: num(event.shadow_evidence?.detectorEvidence?.supportPivotCount ?? event.raw?.volume_evidence?.detectorEvidence?.supportPivotCount),
    zone_next_resistance_distance_pct: null,
    zone_next_resistance_reason: "next-zone history not present in production export/cache",
    auto_range_position_pct: null,
    auto_range_reason: "Auto Range levels not present in production export/cache",
    zone_breakout_bos_before_entry: null,
    zone_breakout_bos_reason: "entry/touch candles unavailable",
    touch_4h_candles: [],
    touch_1h_candle: null,
    test_low_1h_candle: null,
    entry_1h_candle: null,
    touch_depth_below_zone_pct: null,
  };
  const h1Closed = cutoffAt !== null ? closedBarAt(h1, "1h", cutoffAt) : null;
  const h4Closed = cutoffAt !== null ? closedBarAt(h4, "4h", cutoffAt) : null;
  result.rsi_1h_14 = h1Closed ? rsi14(h1, h1Closed.index) : null;
  result.rsi_4h_14 = h4Closed ? rsi14(h4, h4Closed.index) : null;
  result.mfi_aggregated_1h_14 = h1Closed ? mfi14(h1, v1.fut, h1Closed.index) : null;
  result.cmf_aggregated_1h_20 = h1Closed ? cmf20(h1, v1.fut, h1Closed.index) : null;
  result.mfi_aggregated_4h_14 = h4Closed ? mfi14(h4, v4.fut, h4Closed.index) : null;
  result.cmf_aggregated_4h_20 = h4Closed ? cmf20(h4, v4.fut, h4Closed.index) : null;
  result.wyckoff_phase = event.raw?.wyckoff_metrics?.phase ?? event.raw?.wyckoff_metrics?.metrics?.phase ?? null;
  result.wyckoff_phase_reason = result.wyckoff_phase ? "stored entry-time wyckoff metrics" : "not present in source row";
  if (touchBar1h && touchIndex4h >= 0) {
    result.touch_4h_candles = [-3,-2,-1,0,1,2].map((offset) => ({
      relative_to_touch: offset,
      ...(candleDetail(h4, "4h", agg4, bingx4, touchIndex4h + offset) ?? { unavailable: "outside_cached_candles" }),
    }));
    result.touch_1h_candle = candleDetail(h1, "1h", agg1, bingx1, h1.indexOf(touchBar1h));
    const replayTestAt = timeMs(event.r8_replay?.testLowAt);
    const testBar = replayTestAt !== null ? closedBarAt(h1, "1h", replayTestAt) : null;
    const entryBar = hasEntry && cutoffAt !== null ? closedBarAt(h1, "1h", cutoffAt) : null;
    result.test_low_1h_candle = testBar ? candleDetail(h1, "1h", agg1, bingx1, testBar.index) : null;
    result.entry_1h_candle = entryBar ? candleDetail(h1, "1h", agg1, bingx1, entryBar.index) : null;
    const observedBar = entryBar ?? (cutoffAt !== null ? closedBarAt(h1, "1h", cutoffAt) : null);
    if (observedBar && testBar && bottom) {
      const start = testBar.index, end = observedBar.index;
      const lows = h1.slice(start, end + 1).map((bar) => bar.low);
      result.touch_depth_below_zone_pct = lows.length ? (Math.min(...lows) / bottom - 1) * 100 : null;
      result.zone_breakout_bos_before_entry = false;
      for (let i = Math.max(3, start); i < end; i++) {
        const prevHigh = Math.max(h1[i - 1].high, h1[i - 2].high, h1[i - 3].high);
        if (h1[i].close > prevHigh) { result.zone_breakout_bos_before_entry = true; break; }
      }
      result.zone_breakout_bos_reason = "checked 1H close above prior three highs from test through pre-entry";
    } else {
      result.zone_breakout_bos_reason = "test or entry candle unavailable";
    }
  } else {
    result.zone_touch_1h_count_until_entry = top && armAt !== null && cutoffAt !== null
      ? h1.filter((bar) => bar.time >= armAt && bar.time < cutoffAt && bar.low <= top * 1.002).length : null;
  }
  result.zone_level_age_source = "shadow arm time when matched; otherwise event-time proxy";
  return result;
}
function priceWindow(bars, at, entry, tf, horizonHours = 96) {
  if (!(entry > 0) || at == null) return { outcome: "unavailable", reason: "no_entry_time_or_price" };
  const interval = intervalMs(tf);
  const end = at + horizonHours * H1;
  const path = bars.filter((bar) => bar.time >= at && bar.time < end);
  if (!path.length) return { outcome: "unavailable", reason: `no_${tf}_bars_after_entry` };
  let peak = -Infinity, worst = Infinity, peakAt = null, worstAt = null;
  let firstGood = null, firstBad = null, ambiguousAt = null;
  for (const bar of path) {
    const up = pct(bar.high, entry), down = pct(bar.low, entry);
    if (up > peak) { peak = up; peakAt = bar.time; }
    if (down < worst) { worst = down; worstAt = bar.time; }
    const good = up >= 10, bad = down <= -6;
    if (good && bad) { ambiguousAt = bar.time; break; }
    if (good && firstGood === null) firstGood = bar.time;
    if (bad && firstBad === null) firstBad = bar.time;
    if (firstGood !== null || firstBad !== null) break;
  }
  const coveredUntil = path.at(-1).time + interval;
  const expectedBars = Math.max(0, Math.floor((end - Math.max(at, path[0].time)) / interval));
  const coverage = expectedBars ? Math.min(1, path.length / expectedBars) : 0;
  const complete = coveredUntil >= end && coverage >= 0.95;
  let outcome = complete ? "open" : "censored";
  if (ambiguousAt !== null) outcome = "ambiguous_same_candle";
  else if (firstGood !== null && firstBad === null) outcome = "good";
  else if (firstBad !== null && firstGood === null) outcome = "bad";
  else if (firstGood !== null && firstBad !== null) outcome = firstGood < firstBad ? "good" : firstBad < firstGood ? "bad" : "ambiguous_same_candle";
  return {
    outcome, peak_pct: Number.isFinite(peak) ? peak : null, worst_pct: Number.isFinite(worst) ? worst : null,
    hours_to_peak: peakAt === null ? null : (peakAt - at) / H1,
    hours_to_worst: worstAt === null ? null : (worstAt - at) / H1,
    hours_to_plus10: firstGood === null ? null : (firstGood - at) / H1,
    hours_to_minus6: firstBad === null ? null : (firstBad - at) / H1,
    ambiguous_at: iso(ambiguousAt), covered_until: iso(coveredUntil), coverage_pct: coverage * 100,
    horizon_complete: complete, bars_in_window: path.length, reason: complete ? "" : `cache_or_time_coverage_${coverage.toFixed(3)}`,
  };
}

function indicatorValue(telemetry, matcher) {
  if (!telemetry || typeof telemetry !== "object") return null;
  const found = [];
  const visit = (obj, parent = "") => {
    if (!obj || typeof obj !== "object") return;
    for (const [key, value] of Object.entries(obj)) {
      const label = `${parent}.${key}`.toLowerCase();
      if (matcher.test(label) && num(value) !== null) found.push(num(value));
      else if (value && typeof value === "object") visit(value, label);
    }
  };
  visit(telemetry);
  return found.length ? found[0] : null;
}
function numericEntryMetrics(row, context) {
  const dm = row.decision_metrics ?? {};
  const flow = row.fired_flow_snapshot ?? dm.flowSnapshot ?? {};
  const mf = row.money_flow ?? {};
  const vsa = row.vsa_metrics ?? {};
  const vsaEntry = vsa.entryCandle ?? {};
  const candle = row.fired_candle_real_volume ?? dm.candleRealVolume ?? {};
  const neon = row.fired_neon_level ?? dm.neonLevel ?? {};
  const agf1 = mf.aggfut_1h ?? {}, agf4 = mf.aggfut_4h ?? {};
  const ags1 = mf.aggspot_1h ?? {}, ags4 = mf.aggspot_4h ?? {};
  const price = context.price;
  const entry = num(row.entry_price);
  const top = num(neon.top), bottom = num(neon.bottom);
  const features = {
    price_change_1h_pct: price.change1h,
    price_change_4h_pct: price.change4h,
    price_change_24h_pct: price.change24h,
    price_change_72h_pct: price.change72h,
    distance_high_7d_pct: price.high7d,
    distance_high_30d_pct: price.high30d,
    btc_change_1h_pct: context.btc.change1h,
    btc_change_4h_pct: context.btc.change4h,
    btc_change_24h_pct: context.btc.change24h,
    eth_change_1h_pct: context.eth.change1h,
    eth_change_4h_pct: context.eth.change4h,
    eth_change_24h_pct: context.eth.change24h,
    zone_width_pct: top != null && bottom != null && top !== 0 ? (top / bottom - 1) * 100 : null,
    entry_above_zone_top_pct: top ? pct(entry, top) : null,
    entry_vs_zone_bottom_pct: bottom ? pct(entry, bottom) : null,
    oi15m_pct: firstNum(row.entry_oi_15m, flow.oi15m, dm.oi15mPct),
    oi30m_pct: firstNum(row.entry_oi_30m, flow.oi30m),
    oi1h_pct: firstNum(row.entry_oi_1h, flow.oi1h),
    oi4h_pct: firstNum(row.entry_oi_4h, flow.oi4h),
    oi24h_pct: firstNum(row.entry_oi_24h, flow.oi24h),
    futures_taker_net_buy_entry_pct: firstNum(row.entry_fut_taker_net_buy, flow.netBuyPct),
    spot_taker_net_buy_entry_pct: firstNum(row.entry_spot_net_buy_1h, row.entry_spot_taker_net_buy, flow.spotTakerNetBuy),
    spot_cvd_1h: firstNum(row.entry_cvd_1h, flow.cvd1h),
    spot_cvd_4h: firstNum(row.entry_cvd_4h, flow.cvd4h),
    funding_rate: firstNum(row.entry_funding_rate, flow.fundingRate),
    long_liq_1h: num(row.entry_liq_long1h),
    long_liq_24h: num(row.entry_liq_long24h),
    rsi_1h: firstNum(row.entry_rsi_1h, indicatorValue(row.entry_indicator_telemetry, /rsi.*1h|1h.*rsi/)),
    rsi_4h: indicatorValue(row.entry_indicator_telemetry, /rsi.*4h|4h.*rsi/),
    mfi_futures_1h: num(agf1.mfi14),
    mfi_futures_4h: num(agf4.mfi14),
    mfi_spot_1h: num(ags1.mfi14),
    mfi_spot_4h: num(ags4.mfi14),
    cmf_futures_1h: num(agf1.cmf20),
    cmf_futures_4h: num(agf4.cmf20),
    cmf_spot_1h: num(ags1.cmf20),
    cmf_spot_4h: num(ags4.cmf20),
    cho_futures_1h: num(agf1.cho),
    cho_futures_4h: num(agf4.cho),
    cho_spot_1h: num(ags1.cho),
    cho_spot_4h: num(ags4.cho),
    vsa_entry_volume_ratio: num(vsaEntry.volumeRatio),
    vsa_prev1_volume_ratio: num(vsa.prev1?.volumeRatio),
    vsa_prev2_volume_ratio: num(vsa.prev2?.volumeRatio),
    candle_futures_volume_ratio: num(candle.futuresRatio),
    candle_spot_volume_ratio: num(candle.spotRatio),
    entry_candle_body_pct: num(candle.bodyPct),
    spot_volume_usd_1h: firstNum(mf.spotVolumeUsd1h, flow.spotVol1h),
    futures_volume_mult: firstNum(row.entry_fut_vol_mult, flow.futVolMult),
    spot_volume_mult: firstNum(row.entry_spot_vol_mult, flow.spotVolMult),
    whale_index: firstNum(row.entry_whale_index, flow.whaleIndex),
    btc_24h_entry_field: num(row.entry_btc_24h),
  };
  return Object.fromEntries(Object.entries(features).map(([k, v]) => [k, num(v)]));
}
function cachedPriceFeatures(symbol, at, entry) {
  const h1 = candleBars(symbol, "1h"), d1 = candleBars(symbol, "1d"), h4 = candleBars(symbol, "4h");
  const closeAtTime = closeAt(h1, "1h", at);
  const p = entry ?? closeAtTime;
  const ret = (duration) => changeAt(h1, "1h", at, duration);
  const e50d = emaRelation(d1, "1d", at, 50, p);
  const e200d = emaRelation(d1, "1d", at, 200, p);
  const e50h4 = emaRelation(h4, "4h", at, 50, p);
  const e200h4 = emaRelation(h4, "4h", at, 200, p);
  return {
    change1h: ret(H1), change4h: ret(4 * H1), change24h: ret(24 * H1), change72h: ret(72 * H1),
    high7d: highDistance(h1, "1h", at, p, 7), high30d: highDistance(h1, "1h", at, p, 30),
    priceAtEvent: closeAtTime,
    ema50d_pct: e50d.ema ? pct(p, e50d.ema) : null, ema50d_above: e50d.above,
    ema200d_pct: e200d.ema ? pct(p, e200d.ema) : null, ema200d_above: e200d.above,
    ema50h4_pct: e50h4.ema ? pct(p, e50h4.ema) : null, ema50h4_above: e50h4.above,
    ema200h4_pct: e200h4.ema ? pct(p, e200h4.ema) : null, ema200h4_above: e200h4.above,
    ema50d_reason: e50d.reason, ema200d_reason: e200d.reason,
  };
}
function benchmarkFeatures(symbol, at) {
  const h1 = candleBars(symbol, "1h");
  return {
    change1h: changeAt(h1, "1h", at, H1),
    change4h: changeAt(h1, "1h", at, 4 * H1),
    change24h: changeAt(h1, "1h", at, 24 * H1),
  };
}
function priceSide(symbol, at) {
  const h1 = candleBars(symbol, "1h");
  const h4 = candleBars(symbol, "4h");
  const c15 = candleBars(symbol, "15m");
  const vsa = aggregateVolumeContext(symbol, at);
  const c1 = closedBarAt(h1, "1h", at);
  const c4 = closedBarAt(h4, "4h", at);
  const c15m = closedBarAt(c15, "15m", at);
  const volume1h = vsa.h1;
  const volume4h = vsa.h4;
  const color1 = c1 ? candleColorAt(h1, "1h",
    h1.map((bar) => ({ time: bar.time, total: (vsa.fut1.get(bar.time) ?? null) !== null && (vsa.spot1.get(bar.time) ?? null) !== null ? vsa.fut1.get(bar.time) + vsa.spot1.get(bar.time) : null })),
    c1.time + H1) : null;
  const color4 = c4 ? candleColorAt(h4, "4h",
    h4.map((bar) => ({ time: bar.time, total: (vsa.fut4.get(bar.time) ?? null) !== null && (vsa.spot4.get(bar.time) ?? null) !== null ? vsa.fut4.get(bar.time) + vsa.spot4.get(bar.time) : null })),
    c4.time + H4) : null;
  const combined = {
    ...candleShape(c1), ...Object.fromEntries(Object.entries(candleShape(c1)).map(([k, v]) => [`1h_${k}`, v])),
  };
  const shape4 = candleShape(c4);
  for (const [k, v] of Object.entries(shape4)) combined[`4h_${k}`] = v;
  combined["15m_body_pct"] = candleShape(c15m).body_pct ?? null;
  combined["1h_lucy_color"] = color1?.lucy ?? null;
  combined["1h_welkin_aggregated_color"] = color1?.welkin ?? null;
  combined["4h_lucy_color"] = color4?.lucy ?? null;
  combined["4h_welkin_aggregated_color"] = color4?.welkin ?? null;
  combined["1h_agg_futures_ratio20"] = c1 && vsa.fut1.size ? (() => {
    const vals = h1.slice(Math.max(0, c1.index - 19), c1.index + 1).map((bar) => vsa.fut1.get(bar.time));
    return vals.length === 20 && vals.every((x) => x != null) ? vals.at(-1) / (vals.reduce((a, b) => a + b, 0) / 20) : null;
  })() : null;
  combined["1h_agg_spot_ratio20"] = c1 && vsa.spot1.size ? (() => {
    const vals = h1.slice(Math.max(0, c1.index - 19), c1.index + 1).map((bar) => vsa.spot1.get(bar.time));
    return vals.length === 20 && vals.every((x) => x != null) ? vals.at(-1) / (vals.reduce((a, b) => a + b, 0) / 20) : null;
  })() : null;
  combined["1h_agg_welkin_futures_color"] = c1 ? (() => {
    const vals = h1.map((bar) => vsa.fut1.get(bar.time) ?? null);
    return welkinColor(vals, c1.index);
  })() : null;
  combined["1h_bingx_turnover_welkin_color"] = c1 ? (() => {
    const vals = h1.map((bar) => bar.volume != null ? bar.volume * (bar.high + bar.low + bar.close) / 3 : null);
    return welkinColor(vals, c1.index);
  })() : null;
  combined["4h_lucy_reason"] = (vsa.fut4.size === 0 || vsa.spot4.size === 0) ? "aggregated_futures_or_spot_missing; no zero substitution" : (color4?.reason ?? "");
  return {
    features: combined, h1, h4, c15, volume1h, volume4h,
    errors: [
      ...(!c15.length ? ["15m_price_cache_missing"] : []),
      ...(!h1.length ? ["1h_price_cache_missing"] : []),
      ...(!h4.length ? ["4h_price_cache_missing"] : []),
      ...(!vsa.fut1.size ? ["1h_aggregated_futures_cache_missing"] : []),
      ...(!vsa.spot1.size ? ["1h_aggregated_spot_cache_missing"] : []),
      ...(!vsa.fut4.size ? ["4h_aggregated_futures_cache_missing"] : []),
      ...(!vsa.spot4.size ? ["4h_aggregated_spot_cache_missing"] : []),
    ],
    volumeData: vsa,
  };
}

function asJson(value) { return JSON.stringify(value ?? null); }
function outcomeFor(symbol, at, entry) {
  const bars = candleBars(symbol, "15m");
  return priceWindow(bars, at, entry, "15m", 96);
}
function firstTouch(h1, start, end, zoneTop, tolerance = 1.002) {
  if (!(zoneTop > 0)) return null;
  for (const bar of h1) {
    if (bar.time < start || bar.time >= end) continue;
    if (bar.low <= zoneTop * tolerance) return bar;
  }
  return null;
}
function firstBrightLucy(symbol, tf, touchAt, endAt) {
  if (touchAt == null || endAt == null) return { time: "", hours: null, reason: "touch_or_end_time_missing" };
  const bars = candleBars(symbol, tf);
  const volumes = volumeSeries(symbol, tf);
  const fut = volumes.fut, spot = volumes.spot;
  const totals = bars.map((bar) => {
    const f = fut.get(bar.time), s = spot.get(bar.time);
    return f !== undefined && s !== undefined ? f + s : null;
  });
  let missing = false;
  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];
    const interval = intervalMs(tf);
    const afterTouch = tf === "4h" ? bar.time + interval > touchAt : bar.time >= touchAt;
    if (!afterTouch || bar.time + interval > endAt + 1000) continue;
    const color = lucyColor(totals, i);
    if (color === null) { missing = true; continue; }
    if (color !== "N") return { time: iso(bar.time + interval), hours: (bar.time + interval - touchAt) / H1, color, reason: "" };
  }
  return { time: "", hours: null, reason: missing ? "aggregated_history_incomplete_or_under_120_bars" : "no_non_grey_lucy_candle_in_window" };
}
function longUnderZoneCheck(symbol, startAt, cutoffAt, zoneBottom) {
  const h4 = candleBars(symbol, "4h"), v4 = volumeSeries(symbol, "4h");
  if (!(zoneBottom > 0) || startAt == null || cutoffAt == null || !h4.length) {
    return { first_break_at: "", one_day: "unknown", two_days: "unknown", three_days: "unknown", reason: "missing_zone_time_or_4h_cache" };
  }
  const totals = h4.map((bar) => {
    const f = v4.fut.get(bar.time), s = v4.spot.get(bar.time);
    return f !== undefined && s !== undefined ? f + s : null;
  });
  const statuses = { 24: null, 48: null, 72: null };
  let firstBreak = null;
  for (let i = 0; i < h4.length; i++) {
    const breach = h4[i];
    if (breach.time < startAt || breach.time + H4 > cutoffAt || breach.close >= zoneBottom) continue;
    if (firstBreak === null) firstBreak = breach.time + H4;
    for (const hours of [24, 48, 72]) {
      const barsNeeded = hours / 4;
      let ok = true, unknown = false, lastTime = breach.time;
      for (let j = i + 1; j <= i + barsNeeded; j++) {
        const bar = h4[j];
        if (!bar || bar.time + H4 > cutoffAt + 1000) { unknown = true; ok = false; break; }
        if (bar.time !== lastTime + H4 || bar.high >= zoneBottom) { ok = false; break; }
        const color = lucyColor(totals, j);
        if (color === null) { unknown = true; ok = false; break; }
        if (color !== "N") { ok = false; break; }
        lastTime = bar.time;
      }
      if (ok) statuses[hours] = { qualifies: true, from: iso(breach.time + H4), through: iso(h4[i + barsNeeded].time + H4) };
      else if (unknown && statuses[hours] === null) statuses[hours] = "unknown";
      else if (statuses[hours] === null) statuses[hours] = false;
    }
    if ([24,48,72].every((h) => statuses[h] && typeof statuses[h] === "object")) break;
  }
  return {
    first_break_at: iso(firstBreak),
    one_day: statuses[24] ?? false,
    two_days: statuses[48] ?? false,
    three_days: statuses[72] ?? false,
    reason: "after first closed 4H close below zone: subsequent full 4H bars must have high below zone and Lucy color N; missing aggregates are unknown",
  };
}
function nearestZoneEvidence(event) {
  const ev = event.volume_evidence ?? {};
  const detector = ev.detectorEvidence ?? {};
  const top = firstNum(detector.supportTop, detector.zoneTop, ev.zoneTop);
  const bottom = firstNum(detector.supportBottom, detector.zoneBottom, ev.zoneBottom);
  return { detector, top, bottom };
}
function colorAt4hIndex(h4, volumeData, index) {
  if (index < 119 || index >= h4.length) return { color: null, reason: "need_120_closed_4h_bars" };
  const series = [];
  for (let j = index - 119; j <= index; j++) {
    const bar = h4[j];
    const fut = volumeData.fut.get(bar.time), spot = volumeData.spot.get(bar.time);
    if (fut == null || spot == null) return { color: null, reason: `aggregated_volume_missing_${iso(bar.time)}` };
    series.push(fut + spot);
  }
  return { color: lucyColor(series, series.length - 1), reason: "" };
}
function touchVolumeCheck(h1, h4, volumeData, armAt, touchAt, asOf, zoneBottom) {
  let touchBar = null;
  for (const bar of h1) {
    if (bar.time < armAt || bar.time > asOf) continue;
    if (bar.low <= zoneBottom * 1.002) { touchBar = bar; break; }
  }
  if (!touchBar) return { status: "unknown", reason: "touch_candle_not_found" };
  let i0 = -1;
  for (let i = 0; i < h4.length; i++) if (h4[i].time <= touchBar.time) i0 = i;
  if (i0 < 0) return { status: "unknown", reason: "4h_touch_candle_not_found" };
  const colors = [];
  let buying = false;
  for (let i = i0; i <= Math.min(i0 + 2, h4.length - 1); i++) {
    const bar = h4[i];
    if (bar.time + H4 > asOf) break;
    const col = colorAt4hIndex(h4, volumeData, i);
    if (col.color == null) return { status: "unknown", reason: col.reason, colors };
    colors.push(col.color);
    if (col.color !== "N" && bar.high > bar.low && (bar.close - bar.low) / (bar.high - bar.low) > 0.5) buying = true;
  }
  if (!colors.length) return { status: "unknown", reason: "touch_4h_bar_not_closed", colors };
  if (!colors.some((c) => c !== "N")) return { status: "blocked", reason: `touch_volume_grey_${colors.join("")}`, colors };
  if (!buying) return { status: "blocked", reason: `touch_volume_no_buying_${colors.join("")}`, colors };
  return { status: "pass", reason: "touch_volume_buying", colors };
}
function replayR8(symbol, startAt, zoneTop, zoneBottom, waitHours = 48) {
  const h1 = candleBars(symbol, "1h"), h4 = candleBars(symbol, "4h");
  const v = volumeSeries(symbol, "4h");
  if (!h1.length || !h4.length) return { status: "unknown", reason: "price_cache_missing" };
  if (!(zoneTop > 0) || !(zoneBottom > 0)) return { status: "unknown", reason: "zone_top_or_bottom_missing" };
  const h4ByClose = new Map(h4.map((bar) => [bar.time + H4, bar]));
  const endAt = startAt + waitHours * H1;
  let touched = false, testLow = Infinity, testLowAt = null;
  for (const bar of h1) {
    const closeAt = bar.time + H1;
    if (bar.time < startAt || closeAt > endAt) continue;
    const h4Close = h4ByClose.get(closeAt);
    if (h4Close && h4Close.close < zoneBottom) return { status: "blocked", reason: "closed_4h_under_zone", eventAt: closeAt, entryPrice: h4Close.close };
    if (!touched && bar.low <= zoneTop * 1.02) touched = true;
    if (!touched) continue;
    if (bar.low < testLow) { testLow = bar.low; testLowAt = closeAt; }
    if (!(bar.close > bar.open && bar.close >= zoneBottom)) continue;
    if (testLowAt == null || closeAt - testLowAt > 8 * H1) continue;
    const volume = touchVolumeCheck(h1, h4, v, startAt, bar.time, closeAt, zoneBottom);
    if (volume.status === "pass") return { status: "pass", reason: "r8_price_and_lucy_pass", eventAt: closeAt, entryPrice: bar.close, testLowAt, colors: volume.colors };
    if (volume.status === "unknown") return { status: "unknown", reason: volume.reason, eventAt: closeAt, entryPrice: bar.close, colors: volume.colors };
    // A later green 1H bar may qualify after the three 4H bars close, so continue.
  }
  return {
    status: "blocked", reason: touched ? "no_eligible_green_1h_entry_in_8h" : `no_zone_touch_in_${waitHours}h`,
    testLowAt, testLow: Number.isFinite(testLow) ? testLow : null,
  };
}
function priceOnlyVariants(symbol, startAt, zoneTop, zoneBottom, waitHours = 48) {
  const h1 = candleBars(symbol, "1h"), h4 = candleBars(symbol, "4h");
  if (!h1.length || !h4.length || !(zoneTop > 0) || !(zoneBottom > 0)) {
    return { touchAt: null, h4: null, bos: null, reason: "price_or_zone_cache_missing" };
  }
  const endAt = startAt + waitHours * H1;
  const touch = firstTouch(h1, startAt, endAt, zoneTop, 1.002);
  if (!touch) return { touchAt: null, h4: null, bos: null, reason: `no_touch_within_${waitHours}h` };
  const h4Entry = h4.find((bar) => bar.time + H4 > touch.time && bar.time + H4 <= endAt && bar.close > zoneTop);
  let bos = null;
  for (let i = 3; i < h1.length; i++) {
    const bar = h1[i];
    if (bar.time < touch.time || bar.time + H1 > endAt || bar.close < zoneBottom) continue;
    const priorHigh = Math.max(h1[i - 1].high, h1[i - 2].high, h1[i - 3].high);
    if (bar.close > priorHigh) { bos = { time: bar.time + H1, price: bar.close }; break; }
  }
  return {
    touchAt: touch.time,
    h4: h4Entry ? { time: h4Entry.time + H4, price: h4Entry.close } : null,
    bos,
    reason: "",
  };
}
function simulateExit(symbol, entryAt, entry, zoneBottom, stopMode, horizonHours = 96) {
  const c15 = candleBars(symbol, "15m"), h4 = candleBars(symbol, "4h");
  if (!(entry > 0) || entryAt == null || !c15.length) return { result: null, reason: "missing_entry_or_15m_cache" };
  const h4ByClose = new Map(h4.map((bar) => [bar.time + H4, bar]));
  const endAt = entryAt + horizonHours * H1;
  const path = c15.filter((x) => x.time >= entryAt && x.time < endAt);
  if (!path.length) return { result: null, reason: "no_15m_after_entry" };
  const zoneStop = zoneBottom && zoneBottom > 0 ? zoneBottom * 0.999 : null; // explicitly 0.1% below zone bottom
  const stopPrice = stopMode === "under_zone" ? zoneStop : entry * 0.94;
  if (!(stopPrice > 0)) return { result: null, reason: "stop_level_missing" };
  let remaining = 1, realizedPricePct = 0, partial = false, be = false, trailActive = false;
  let peakPct = 0, trailStopPrice = null, exitReason = "", exitPrice = null, exitAt = null, ambiguous = false;
  for (const bar of path) {
    const currentStop = trailActive ? Math.max(stopPrice, trailStopPrice ?? stopPrice) : (be ? Math.max(stopPrice, entry) : stopPrice);
    if (bar.low <= currentStop) {
      if (bar.high >= entry * 1.08 && !partial) ambiguous = true;
      exitPrice = currentStop;
      exitAt = bar.time;
      exitReason = trailActive ? "trailing_stop" : be ? "breakeven_stop" : stopMode === "under_zone" ? "under_zone_stop" : "stop_-6";
      realizedPricePct += remaining * pct(exitPrice, entry);
      remaining = 0;
      break;
    }
    if (!partial && bar.high >= entry * 1.08) {
      realizedPricePct += 0.20 * 8;
      remaining -= 0.20;
      partial = true;
    }
    if (bar.high >= entry * 1.10) be = true;
    const barPeakPct = pct(bar.high, entry);
    if (barPeakPct > peakPct) peakPct = barPeakPct;
    if (peakPct >= 20) {
      trailActive = true;
      trailStopPrice = entry * (1 + (peakPct - 20) / 100);
    }
    // Conservative bar ordering: a stop that becomes active inside this 15m bar is only actionable next bar.
    const h4close = h4ByClose.get(bar.time + M15);
    if (h4close && zoneBottom && h4close.close < zoneBottom) {
      if (bar.high >= entry * 1.08 || bar.high >= entry * 1.10 || bar.high >= entry * 1.20) ambiguous = true;
      exitPrice = h4close.close;
      exitAt = bar.time + M15;
      exitReason = "4h_close_under_zone";
      realizedPricePct += remaining * pct(exitPrice, entry);
      remaining = 0;
      break;
    }
  }
  if (remaining > 0) {
    const last = path.at(-1);
    exitPrice = last.close;
    exitAt = Math.min(endAt, last.time + M15);
    exitReason = exitAt >= endAt ? `${horizonHours}h_close` : "censored_at_cache_end";
    realizedPricePct += remaining * pct(exitPrice, entry);
  }
  const lastCoverage = path.at(-1).time + M15;
  const complete = lastCoverage >= endAt;
  const marginPct = realizedPricePct * 10;
  return {
    result: realizedPricePct,
    margin_pct: marginPct,
    pnl_usd_per_100_margin: marginPct,
    partial_taken: partial,
    exit_reason: exitReason,
    exit_price: exitPrice,
    exit_at: iso(exitAt),
    peak_pct: peakPct,
    coverage_complete: complete,
    ambiguous_same_bar: ambiguous,
    reason: complete ? "" : `censored_before_${horizonHours}h; last=${iso(lastCoverage)}`,
    stop_level: stopPrice,
    horizon_hours: horizonHours,
  };
}

function sourceReference(ref) {
  const r = ref.source_row ?? {};
  const entryAt = timeMs(r.entry_utc ?? r.time_utc ?? r.signal_utc ?? r.detected_at);
  const entryPrice = firstNum(r.entry, r.entry_price);
  const bottom = firstNum(r.zone_bottom, r.level);
  const explicitTop = num(r.zone_top);
  const above = num(r.entry_above_top_pct);
  const top = explicitTop ?? (entryPrice && above !== null ? entryPrice / (1 + above / 100) : null);
  const tfMatch = String(ref.source_file).match(/(?:_|-)(Z4|Z1B|Z1L)(?:[._-]|$)/i);
  return {
    cohort: "C_reference", event_key: `C:${ref.symbol}:${iso(entryAt)}`,
    id: "", signal_id: "", symbol: cleanSymbol(ref.symbol), source_file: ref.source_file,
    event_at: iso(entryAt), reference_at: iso(entryAt), entry_price: entryPrice,
    price_basis: "historical_report_entry", status: "reference",
    blocked_reason: "", actual_pnl_pct: num(r.result_pct), actual_exit: r.how ?? "",
    actual_peak_pct: firstNum(r.peak_4d_pct, r.max_up_4d_pct),
    zone_tf: tfMatch ? tfMatch[1].toUpperCase() : "source_report",
    zone_top: top, zone_bottom: bottom,
    source_features: r,
  };
}
function eventFromSignal(row) {
  const at = timeMs(row.detected_at);
  const dm = row.decision_metrics ?? {};
  const neon = row.fired_neon_level ?? dm.neonLevel ?? {};
  const entry = num(row.entry_price);
  return {
    cohort: "A_signal", event_key: `A:${row.id}:${row.symbol}`,
    id: row.id, signal_id: row.signal_id, symbol: cleanSymbol(row.symbol),
    source_file: "production:tracked_signals",
    event_at: iso(at), reference_at: iso(at), entry_price: entry,
    price_basis: "production_entry_price",
    status: row.status, actual_pnl_pct: num(row.pnl_percent),
    actual_exit: row.cancel_reason ?? row.status,
    actual_peak_pct: entry && num(row.peak_price) ? pct(num(row.peak_price), entry) : null,
    actual_exit_price: num(row.exit_price), actual_close_at: iso(timeMs(row.closed_at)),
    zone_tf: at >= Date.parse("2026-11-14T00:00:00Z") ? "1D_from_2026-11-14 (day-boundary proxy)" : "4H",
    zone_top: num(neon.top), zone_bottom: num(neon.bottom),
    raw: row,
  };
}
function eventFromCandidate(row) {
  const e = nearestZoneEvidence(row);
  const armedAt = timeMs(row.armed_at);
  const triggerAt = timeMs(row.trigger_candle_at);
  // trigger_candle_at stores the 1H candle open; an entry is only available at its close.
  const referenceAt = triggerAt !== null ? triggerAt + H1 : armedAt;
  const refBar = e.detector.latestClosed1hCandle ?? e.detector.armCandle;
  const proxyPrice = firstNum(refBar?.close);
  return {
    cohort: "B_blocked", event_key: `B:shadow:${row.id}:${row.symbol}`,
    id: row.id, signal_id: "", symbol: cleanSymbol(row.symbol),
    source_file: "production:stealth_abneon_shadow_candidates",
    event_at: iso(armedAt), reference_at: iso(referenceAt),
    entry_price: null, context_price: proxyPrice,
    price_basis: triggerAt ? "hypothetical_trigger_candle_close" : "no_entry_pending_or_no_trigger",
    status: row.status, blocked_reason: row.terminal_reason ?? "pending_no_terminal_reason",
    actual_pnl_pct: null, actual_exit: "", actual_peak_pct: null,
    zone_tf: armedAt >= Date.parse("2026-11-14T00:00:00Z") ? "1D_from_2026-11-14 (day-boundary proxy)" : "4H",
    zone_top: e.top, zone_bottom: e.bottom ?? num(row.frozen_level),
    raw: row,
  };
}
function dedupeOi(rows) {
  const map = new Map();
  for (const row of rows) {
    const m = row.entry_metrics ?? {};
    const t = timeMs(m.triggerCandleTime);
    const key = `${cleanSymbol(row.symbol)}|${num(m.frozenLevel)?.toPrecision(10) ?? ""}|${t ?? ""}`;
    const old = map.get(key);
    if (old) {
      old.raw_decision_count += 1;
      old.decision_ids.push(row.id);
      continue;
    }
    map.set(key, {
      cohort: "B_blocked", event_key: `B:oi:${key}`,
      id: row.id, signal_id: "", symbol: cleanSymbol(row.symbol),
      source_file: "production:pattern_decision_snapshots",
       event_at: iso(timeMs(row.decision_at)), reference_at: iso(t !== null ? t + H1 : timeMs(row.decision_at)),
       entry_price: num(row.entry_price), price_basis: "hypothetical_rejected_entry_price",
      status: "rejected", blocked_reason: row.decision_reason,
      actual_pnl_pct: null, actual_exit: "", actual_peak_pct: null,
      zone_tf: timeMs(row.decision_at) >= Date.parse("2026-11-14T00:00:00Z") ? "1D_from_2026-11-14 (day-boundary proxy)" : "4H",
      zone_top: null, zone_bottom: num(m.frozenLevel),
      raw_decision_count: 1, decision_ids: [row.id], raw: row,
    });
  }
  return [...map.values()];
}
function enrichEvent(event, bench) {
  const at = timeMs(event.reference_at);
  let entry = num(event.entry_price);
  if (event.cohort === "B_blocked" && !event.raw?.entry_metrics && timeMs(event.raw?.trigger_candle_at) !== null) {
    entry = closeAt(candleBars(event.symbol, "1h"), "1h", at);
    event.entry_price = entry;
    if (entry !== null) event.price_basis = "hypothetical_trigger_candle_closed_1h_price";
  }
  const anchor = entry ?? num(event.context_price);
  if (at == null || anchor == null || !(anchor > 0)) {
    event.metrics = {};
    event.price_outcome_96h = "not_applicable_no_entry";
    event.price_outcome_reason = "no_reference_time_or_price";
    event.cache_errors = ["no_reference_time_or_price"];
    return event;
  }
  const price = cachedPriceFeatures(event.symbol, at, anchor);
  const side = priceSide(event.symbol, at);
  const a = event.raw ?? {};
  let metrics = {};
  if (event.cohort === "A_signal") metrics = numericEntryMetrics(a, { price, btc: benchmarkFeatures("BTC-USDT", at), eth: benchmarkFeatures("ETH-USDT", at) });
  else if (event.cohort === "B_blocked" && a.entry_metrics) {
    const em = a.entry_metrics;
    const flow = em.flowSnapshot ?? {};
    metrics = {
      oi15m_pct: num(em.oi15mPct), oi30m_pct: firstNum(em.oi30m, flow.oi30m),
      oi1h_pct: num(flow.oi1h), oi4h_pct: num(flow.oi4h), oi24h_pct: num(flow.oi24h),
      price_change_1h_pct: price.change1h, price_change_4h_pct: price.change4h,
      price_change_24h_pct: price.change24h, price_change_72h_pct: price.change72h,
      distance_high_7d_pct: price.high7d, distance_high_30d_pct: price.high30d,
      futures_taker_net_buy_entry_pct: firstNum(flow.netBuyPct, flow.spotTakerNetBuy),
      spot_cvd_1h: num(flow.cvd1h), spot_cvd_4h: num(flow.cvd4h),
      funding_rate: num(flow.fundingRate), whale_index: num(flow.whaleIndex),
      frozen_level: num(em.frozenLevel),
    };
  } else if (event.cohort === "B_blocked") {
    const raw = a.volume_evidence ?? {};
    const d = raw.detectorEvidence ?? {};
    metrics = {
      price_change_1h_pct: price.change1h, price_change_4h_pct: price.change4h,
      price_change_24h_pct: price.change24h, price_change_72h_pct: price.change72h,
      distance_high_7d_pct: price.high7d, distance_high_30d_pct: price.high30d,
      zone_width_pct: event.zone_top && event.zone_bottom ? (event.zone_top / event.zone_bottom - 1) * 100 : null,
      support_pivot_count: num(d.supportPivotCount),
      frozen_level: num(a.frozen_level),
      arm_candle_body_pct: d.armCandle?.open ? pct(d.armCandle.close, d.armCandle.open) : null,
    };
  } else {
    const r = event.source_features ?? {};
    metrics = {
      price_change_1h_pct: price.change1h, price_change_4h_pct: price.change4h,
      price_change_24h_pct: firstNum(r.chg24h_pct, price.change24h),
      price_change_72h_pct: price.change72h,
      distance_high_7d_pct: price.high7d, distance_high_30d_pct: firstNum(r.from_30d_high_pct, price.high30d),
      zone_width_pct: num(r.zone_width_pct), entry_above_zone_top_pct: num(r.entry_above_top_pct),
      room_next_zone_pct: num(r.room_next_zone_pct), zone_count: num(r.zone_count),
      oi4h_pct: num(r.oi_chg4h), oi24h_pct: num(r.oi_chg24h),
      futures_vsa_touch4h: num(r.fut_touch4h_welkin120),
      futures_vsa_touch1h: num(r.fut_touch1h_welkin120),
      spot_vsa_touch4h: num(r.spot_touch4h_welkin120),
      spot_vsa_touch1h: num(r.spot_touch1h_welkin120),
      btc_change_24h_pct: firstNum(r.btc_chg24h_pct, bench.btc.change24h),
      btc_change_7d_pct: num(r.btc_chg7d_pct),
    };
  }
  Object.assign(metrics, side.features);
  const path = entry !== null
    ? outcomeFor(event.symbol, at, entry)
    : { outcome: "not_applicable_no_entry", reason: "no_fired_entry; reference price is context only" };
  Object.assign(event, {
    price_outcome_96h: path.outcome,
    price_outcome_reason: path.reason ?? "",
    price_peak_96h_pct: path.peak_pct ?? null,
    price_worst_96h_pct: path.worst_pct ?? null,
    hours_to_peak_96h: path.hours_to_peak ?? null,
    hours_to_worst_96h: path.hours_to_worst ?? null,
    hours_to_plus10: path.hours_to_plus10 ?? null,
    hours_to_minus6: path.hours_to_minus6 ?? null,
    horizon_complete: path.horizon_complete ?? false,
    price_cache_covered_until: path.covered_until ?? "",
    cache_errors: [...new Set([
      ...(path.reason ? [path.reason] : []),
      ...side.errors,
      ...(!price.ema50d_reason ? [] : [`ema50d:${price.ema50d_reason}`]),
      ...(!price.ema200d_reason ? [] : [`ema200d:${price.ema200d_reason}`]),
    ])],
    metrics,
    price_ema50d_pct: price.ema50d_pct,
    price_ema50d_above: price.ema50d_above,
    price_ema200d_pct: price.ema200d_pct,
    price_ema200d_above: price.ema200d_above,
    price_entry_1h_body_pct: side.features["1h_body_pct"],
    price_entry_1h_range_pct: side.features["1h_range_pct"],
    price_entry_1h_lower_wick_pct: side.features["1h_lower_wick_pct"],
    price_entry_4h_body_pct: side.features["4h_body_pct"],
    price_entry_4h_range_pct: side.features["4h_range_pct"],
    lucy_1h_entry: side.features["1h_lucy_color"],
    lucy_4h_entry: side.features["4h_lucy_color"],
    lucy_4h_cache_reason: side.features["4h_lucy_reason"],
  });
  return event;
}

function bestThreshold(good, bad, key) {
  const rows = [...good, ...bad].filter((x) => num(x.metrics?.[key]) !== null);
  const g = rows.filter((x) => x.price_outcome_96h === "good");
  const b = rows.filter((x) => x.price_outcome_96h === "bad");
  if (g.length < 3 || b.length < 3) return { key, n: rows.length, good: g.length, bad: b.length, result: "insufficient_n" };
  const values = [...new Set(rows.map((x) => num(x.metrics[key])))].sort((a, b) => a - b);
  if (values.length < 2) return { key, n: rows.length, good: g.length, bad: b.length, result: "constant_metric" };
  let best = null;
  for (let i = 0; i < values.length - 1; i++) {
    const threshold = (values[i] + values[i + 1]) / 2;
    for (const direction of ["ge_good", "le_good"]) {
      const predictsGood = (x) => direction === "ge_good" ? num(x.metrics[key]) >= threshold : num(x.metrics[key]) <= threshold;
      const tp = g.filter(predictsGood).length, tn = b.filter((x) => !predictsGood(x)).length;
      const tpr = tp / g.length, tnr = tn / b.length;
      const balanced = (tpr + tnr) / 2;
      const accuracy = (tp + tn) / rows.length;
      const candidate = { threshold, direction, balanced, accuracy, tp, fn: g.length - tp, fp: b.length - tn, tn };
      if (!best || candidate.balanced > best.balanced || (candidate.balanced === best.balanced && candidate.accuracy > best.accuracy)) best = candidate;
    }
  }
  const keep = (x) => best.direction === "ge_good" ? num(x.metrics[key]) >= best.threshold : num(x.metrics[key]) <= best.threshold;
  return {
    key, n: rows.length, good: g.length, bad: b.length, ...best,
    good_kept: g.filter(keep).map((x) => `${x.symbol}#${x.id}`),
    good_cut: g.filter((x) => !keep(x)).map((x) => `${x.symbol}#${x.id}`),
    bad_kept: b.filter(keep).map((x) => `${x.symbol}#${x.id}`),
    bad_cut: b.filter((x) => !keep(x)).map((x) => `${x.symbol}#${x.id}`),
  };
}
function countBy(rows, getter) {
  const out = {};
  for (const row of rows) {
    const value = getter(row) ?? "(blank)";
    out[value] = (out[value] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(out).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
}
function lineForRange(cohort, group, key, rows) {
  const values = rows.map((row) => ({ value: num(row.metrics?.[key]), name: `${row.symbol}#${row.id || row.event_key}` }));
  const range = medianFreeRange(values);
  if (!range) return `- ${cohort} / ${group} / \`${key}\`: данных нет (n=0).`;
  const all = range.present.map((x) => `${x.name}=${x.value}`).join("; ");
  return `- ${cohort} / ${group} / \`${key}\` (n=${range.n}): min ${range.min.value} [${range.min.name}], max ${range.max.value} [${range.max.name}]; значения по именам: ${all}`;
}
function statsFor(rows) {
  return {
    n: rows.length,
    outcomes: countBy(rows, (x) => x.price_outcome_96h),
    coverage: countBy(rows, (x) => x.horizon_complete ? "96h_complete" : "censored_or_missing"),
  };
}
function simSummary(rows, strategyKey) {
  const selected = rows.filter((x) => x[`variant_${strategyKey}_time`] && num(x[`variant_${strategyKey}_price`]) > 0);
  const exits = selected.map((x) => x[`sim_${strategyKey}_stop6`]).filter((x) => x && num(x.pnl_usd_per_100_margin) !== null);
  const under = selected.map((x) => x[`sim_${strategyKey}_under_zone`]).filter((x) => x && num(x.pnl_usd_per_100_margin) !== null);
  const total = (values) => {
    const pnl = values.reduce((s, x) => s + x.pnl_usd_per_100_margin, 0);
    return { n: values.length, pnl_usd: pnl, account_pct_of_1000: pnl / 10, wins: values.filter((x) => x.pnl_usd_per_100_margin > 0).length, losses: values.filter((x) => x.pnl_usd_per_100_margin < 0).length };
  };
  return { selected: selected.length, stop6: total(exits), under_zone: total(under) };
}
function appendSection(lines, title, content) {
  lines.push(`\n## ${title}\n`, content || "_Нет данных._", "");
}

const signals = readParts("signals_");
const candidates = readParts("candidates_");
const oiRows = readLines("oi_rejections.jsonl");
const firedCandidates = readLines("fired_candidates.jsonl");
const references = readLines("references.jsonl").map(sourceReference);
if (signals.length !== 145) throw new Error(`expected 145 A rows; source has ${signals.length}`);
if (candidates.length !== 3799) throw new Error(`expected 3799 non-fired candidates; source has ${candidates.length}`);
if (oiRows.length !== 99) throw new Error(`expected 99 OI decision rows; source has ${oiRows.length}`);
if (references.length !== 8) throw new Error(`expected 8 C references; source has ${references.length}`);

const events = [
  ...signals.map(eventFromSignal),
  ...candidates.map(eventFromCandidate),
  ...dedupeOi(oiRows),
  ...references,
];
const bench = {
  btc: benchmarkFeatures("BTC-USDT", Date.now()),
  eth: benchmarkFeatures("ETH-USDT", Date.now()),
};
const bySymbol = new Map();
for (const event of events) {
  if (!bySymbol.has(event.symbol)) bySymbol.set(event.symbol, []);
  bySymbol.get(event.symbol).push(event);
}
const errors = new Map();
function noteErrors(symbol, reasons) {
  if (!reasons?.length) return;
  if (!errors.has(symbol)) errors.set(symbol, new Set());
  for (const reason of reasons) errors.get(symbol).add(reason);
}
const entryVariantRows = [];
const disqualificationRows = [];
const volumeTimingRows = [];
const managementRows = [];

// Process one symbol at a time so the large price cache is not retained for every token.
for (const [symbol, rows] of bySymbol) {
  cacheMemo.clear();
  for (const event of rows) {
    const at = timeMs(event.reference_at);
    const localBench = at == null ? bench : {
      btc: benchmarkFeatures("BTC-USDT", at),
      eth: benchmarkFeatures("ETH-USDT", at),
    };
    enrichEvent(event, localBench);
    noteErrors(symbol, event.cache_errors);
    const zoneTop = num(event.zone_top), zoneBottom = num(event.zone_bottom);
    let startAt = timeMs(event.event_at);
    if (event.cohort === "A_signal") {
      const candidatesForSignal = firedCandidates.filter((x) => cleanSymbol(x.symbol) === symbol && timeMs(x.armed_at) != null);
      const nearest = candidatesForSignal
        .map((x) => ({ row: x, distance: Math.abs((timeMs(x.trigger_candle_at) ?? timeMs(x.armed_at)) - (at ?? 0)) }))
        .sort((a, b) => a.distance - b.distance)[0];
      if (nearest && nearest.distance <= 12 * H1) {
        event.matched_shadow_id = nearest.row.id;
        event.arm_at = iso(timeMs(nearest.row.armed_at));
        event.shadow_evidence = nearest.row.volume_evidence;
        startAt = timeMs(nearest.row.armed_at);
      } else if (at != null) {
        event.matched_shadow_id = "";
        startAt = at - 48 * H1;
        event.arm_at = iso(startAt);
        event.arm_time_proxy = "detected_at_minus_48h";
      }
    } else if (event.cohort === "B_blocked") {
      event.arm_at = event.raw?.armed_at ?? "";
      startAt = timeMs(event.raw?.armed_at) ?? at;
      if (event.raw?.entry_metrics?.triggerCandleTime) startAt = timeMs(event.raw.entry_metrics.triggerCandleTime) - 48 * H1;
    } else {
      event.arm_at = at == null ? "" : iso(at - 48 * H1);
      startAt = at == null ? null : at - 48 * H1;
      event.arm_time_proxy = "reference_entry_minus_48h";
    }
    event.wait_variants = {};
    if (startAt != null && zoneTop && zoneBottom) {
      for (const waitHours of WAIT_WINDOWS_H) {
        event.wait_variants[waitHours] = {
          r8: replayR8(symbol, startAt, zoneTop, zoneBottom, waitHours),
          price: priceOnlyVariants(symbol, startAt, zoneTop, zoneBottom, waitHours),
        };
      }
      event.r8_replay = event.wait_variants[48].r8;
      event.price_variants = event.wait_variants[48].price;
    } else {
      event.r8_replay = { status: "unknown", reason: "arm_time_or_zone_missing" };
      event.price_variants = { reason: "arm_time_or_zone_missing" };
      for (const waitHours of WAIT_WINDOWS_H) event.wait_variants[waitHours] = {
        r8: { status: "unknown", reason: "arm_time_or_zone_missing" },
        price: { reason: "arm_time_or_zone_missing" },
      };
    }
    const variants = event.price_variants ?? {};
    if (event.cohort === "A_signal") {
      event.variant_r8_time = event.event_at;
      event.variant_r8_price = event.entry_price;
    } else if (event.r8_replay?.status === "pass") {
      event.variant_r8_time = iso(event.r8_replay.eventAt);
      event.variant_r8_price = event.r8_replay.entryPrice;
    }
    if (variants.h4) {
      event.variant_h4_time = iso(variants.h4.time);
      event.variant_h4_price = variants.h4.price;
    }
    if (variants.bos) {
      event.variant_bos_time = iso(variants.bos.time);
      event.variant_bos_price = variants.bos.price;
    }
    // Snapshot-derived trigger cannot be inferred when production has no neon_snapshots table.
    event.variant_trigger_time = "";
    event.variant_trigger_price = null;
    for (const [key, timeKey, priceKey] of [
      ["r8", "variant_r8_time", "variant_r8_price"],
      ["h4", "variant_h4_time", "variant_h4_price"],
      ["bos", "variant_bos_time", "variant_bos_price"],
    ]) {
      const vt = timeMs(event[timeKey]);
      const vp = num(event[priceKey]);
      event[`sim_${key}_stop6`] = vt != null && vp ? simulateExit(symbol, vt, vp, zoneBottom, "stop6") : null;
      event[`sim_${key}_under_zone`] = vt != null && vp ? simulateExit(symbol, vt, vp, zoneBottom, "under_zone") : null;
    }
    event.metrics ??= {};
    const sourceFeatures = event.source_features;
    if (sourceFeatures) {
      for (const [key, value] of Object.entries(sourceFeatures)) {
        const n = num(value);
        if (n !== null && event.metrics[key] == null) event.metrics[key] = n;
      }
    }
    const hasEntry = num(event.entry_price) !== null && num(event.entry_price) > 0;
    const technicalCutoff = hasEntry ? at : timeMs(event.raw?.updated_at);
    Object.assign(event.metrics, technicalCandleMetrics(event, technicalCutoff, hasEntry));
    const waitVariantsForRows = [];
    for (const waitHours of WAIT_WINDOWS_H) {
      const wv = event.wait_variants[waitHours];
      const entries = {
        r8: wv.r8?.status === "pass" ? { time: wv.r8.eventAt, price: wv.r8.entryPrice, reason: wv.r8.reason } : null,
        h4: wv.price?.h4 ? { time: iso(wv.price.h4.time), price: wv.price.h4.price, reason: "4h_close_above_zone_after_touch" } : null,
        bos: wv.price?.bos ? { time: iso(wv.price.bos.time), price: wv.price.bos.price, reason: "1h_close_above_prior_three_highs" } : null,
      };
      waitVariantsForRows.push({ wait_hours: waitHours, r8: wv.r8, h4: wv.price?.h4 ?? null, bos: wv.price?.bos ?? null, reason: wv.price?.reason ?? "" });
      for (const [strategy, entry] of Object.entries(entries)) {
        if (!entry) {
          entryVariantRows.push({
            cohort: event.cohort, event_key: event.event_key, id: event.id, symbol, wait_hours: waitHours,
            strategy, entry_status: strategy === "r8" ? wv.r8?.status ?? "unknown" : "no_entry",
            entry_reason: strategy === "r8" ? wv.r8?.reason ?? "" : wv.price?.reason ?? "variant_not_found",
            entry_at: "", entry_price: "", outcome_96h: "not_entered",
            price_peak_96h_pct: "", price_worst_96h_pct: "", hours_to_plus10: "", hours_to_minus6: "",
            hold_hours: "", stop_mode: "", simulated_pnl_usd: "", sim_exit_reason: "", sim_exit_at: "",
            coverage_complete: "", sim_reason: "",
          });
          continue;
        }
        const entryAt = timeMs(entry.time), entryPrice = num(entry.price);
        const result96 = priceWindow(candleBars(symbol, "15m"), entryAt, entryPrice, "15m", 96);
        for (const holdHours of TRADE_HORIZONS_H) for (const stopMode of ["stop6", "under_zone"]) {
          const sim = simulateExit(symbol, entryAt, entryPrice, zoneBottom, stopMode, holdHours);
          entryVariantRows.push({
            cohort: event.cohort, event_key: event.event_key, id: event.id, symbol, wait_hours: waitHours,
            strategy, entry_status: "entered", entry_reason: entry.reason,
            entry_at: iso(entryAt), entry_price: entryPrice, outcome_96h: result96.outcome,
            price_peak_96h_pct: result96.peak_pct ?? "", price_worst_96h_pct: result96.worst_pct ?? "",
            hours_to_plus10: result96.hours_to_plus10 ?? "", hours_to_minus6: result96.hours_to_minus6 ?? "",
            hold_hours: holdHours, stop_mode: stopMode,
            simulated_pnl_usd: sim.pnl_usd_per_100_margin ?? "", sim_exit_reason: sim.exit_reason ?? "",
            sim_exit_at: sim.exit_at ?? "", coverage_complete: sim.coverage_complete ?? "",
            sim_reason: sim.reason ?? "",
          });
        }
      }
    }
    event.wait_variants_summary = waitVariantsForRows;
    event.disqualification = longUnderZoneCheck(symbol, startAt, technicalCutoff, zoneBottom);
    disqualificationRows.push({
      cohort: event.cohort, event_key: event.event_key, id: event.id, symbol,
      outcome_96h: event.price_outcome_96h, blocked_reason: event.blocked_reason ?? "",
      current_4h_close_under_zone: event.wait_variants[48]?.r8?.reason === "closed_4h_under_zone",
      current_4h_close_under_zone_at: event.wait_variants[48]?.r8?.reason === "closed_4h_under_zone" ? event.wait_variants[48].r8.eventAt : "",
      ...event.disqualification,
    });
    if (event.price_outcome_96h === "good" || event.cohort === "C_reference") {
      const touchAt = timeMs(event.metrics.zone_touch_1h_at);
      const endAt = touchAt === null ? null : touchAt + 7 * 24 * H1;
      for (const tf of ["1h", "4h"]) {
        const first = firstBrightLucy(symbol, tf, touchAt, endAt);
        volumeTimingRows.push({
          cohort: event.cohort, event_key: event.event_key, id: event.id, symbol, outcome_96h: event.price_outcome_96h,
          zone_touch_at: event.metrics.zone_touch_1h_at ?? "", timeframe: tf,
          first_bright_lucy_at: first.time, hours_from_touch_to_bright: first.hours, first_bright_color: first.color ?? "",
          t0_at: "", hours_from_touch_to_t0: "", t0_reason: "production_neon_snapshots_table_absent",
          search_ends_at: endAt === null ? "" : iso(endAt), reason: first.reason,
        });
      }
    }
    if (event.cohort === "A_signal" && hasEntry) {
      for (const holdHours of TRADE_HORIZONS_H) for (const stopMode of ["stop6", "under_zone"]) {
        const sim = simulateExit(symbol, at, num(event.entry_price), zoneBottom, stopMode, holdHours);
        managementRows.push({
          id: event.id, signal_id: event.signal_id, symbol, detected_at: event.event_at,
          actual_status: event.status, actual_pnl_pct: event.actual_pnl_pct, price_outcome_96h: event.price_outcome_96h,
          hold_hours: holdHours, stop_mode: stopMode, simulated_pnl_usd_per_100_margin: sim.pnl_usd_per_100_margin ?? "",
          exit_reason: sim.exit_reason ?? "", exit_price: sim.exit_price ?? "", exit_at: sim.exit_at ?? "",
          peak_pct: sim.peak_pct ?? "", coverage_complete: sim.coverage_complete ?? "", reason: sim.reason ?? "",
          post_72h_from_entry_uses_price_candles: holdHours === 168,
          neon_snapshot_source: "unavailable_public.neon_snapshots_absent",
        });
      }
    }
  }
}

const now = Date.now();
const snapshots = signals.map((row) => {
  const event = events.find((x) => x.cohort === "A_signal" && x.id === row.id);
  const at = timeMs(row.detected_at);
  const elapsed = at == null ? 0 : Math.max(0, Math.floor((now - at) / SLOT) + 1);
  const expectedElapsed = Math.min(EXPECTED_SLOTS, elapsed);
  return {
    tracked_id: row.id, symbol: row.symbol, detected_at: row.detected_at,
    outcome_96h: event?.price_outcome_96h ?? "",
    recorded_slots: 0, expected_elapsed_slots: expectedElapsed,
    missing_elapsed_slots: expectedElapsed,
    not_yet_elapsed_slots: EXPECTED_SLOTS - expectedElapsed,
    planned_slots_72h: EXPECTED_SLOTS,
    t0_slot: "", t0_at: "", t0_reason: "production_neon_snapshots_table_absent",
    oiChange30m: "", oiChange1h: "", oiChange4h: "", oiChange24h: "",
    futuresTakerNetBuyPct15m: "", futuresTakerHistory15m: "",
    spotCvd15m: "", spotCvd1h: "", spotCvd4h: "", spotCvdStrength1h: "",
    spotVolumeUsd1h: "", spotNetBuyPct1h: "",
    futuresVolumeUsd15m: "", futuresVolumeUsd1h: "", futuresVolumeUsd4h: "",
    delta_T0_minus_60m: "", delta_T0_minus_30m: "", delta_T0_plus_30m: "",
  };
});

const statusCounts = countBy(signals, (x) => x.status);
const reasonCounts = countBy(candidates, (x) => x.terminal_reason ?? (x.status === "armed" ? "pending_no_terminal_reason" : "blank_reason"));
const oiRawCounts = countBy(oiRows, (x) => x.decision_reason);
const byCohort = {
  A_signal: events.filter((x) => x.cohort === "A_signal"),
  B_blocked: events.filter((x) => x.cohort === "B_blocked"),
  C_reference: events.filter((x) => x.cohort === "C_reference"),
};
const featureKeys = [...new Set(Object.values(byCohort).flatMap((group) => group.flatMap((x) => Object.keys(x.metrics ?? {}))))].sort();
const summaries = Object.fromEntries(Object.entries(byCohort).map(([key, rows]) => [key, statsFor(rows)]));
const groups = ["good", "bad", "open"];
const metricLines = [];
for (const [cohort, rows] of Object.entries(byCohort)) {
  for (const group of groups) {
    const selected = rows.filter((x) => x.price_outcome_96h === group);
    if (!selected.length) continue;
    metricLines.push(`\n### ${cohort} — ${group} (${selected.length})`);
    for (const key of featureKeys) {
      const line = lineForRange(cohort, group, key, selected);
      if (!line.endsWith("(n=0).")) metricLines.push(line);
    }
  }
}
const goodA = byCohort.A_signal.filter((x) => x.price_outcome_96h === "good");
const badA = byCohort.A_signal.filter((x) => x.price_outcome_96h === "bad");
const thresholds = featureKeys.map((key) => bestThreshold(goodA, badA, key));
const blockedChampions = byCohort.B_blocked.filter((x) => x.price_outcome_96h === "good");
const waitVariantSummary = [];
for (const waitHours of WAIT_WINDOWS_H) for (const strategy of ["r8","h4","bos"]) {
  const selected = entryVariantRows.filter((row) => Number(row.wait_hours) === waitHours && row.strategy === strategy &&
    (row.entry_status !== "entered" || (Number(row.hold_hours) === 96 && row.stop_mode === "stop6")));
  const entered = selected.filter((row) => row.entry_status === "entered");
  waitVariantSummary.push({
    wait_hours: waitHours, strategy, selected: entered.length,
    outcomes: countBy(entered, (row) => row.outcome_96h),
    good_names: entered.filter((row) => row.outcome_96h === "good").map((row) => `${row.symbol}#${row.id}`),
    bad_names: entered.filter((row) => row.outcome_96h === "bad").map((row) => `${row.symbol}#${row.id}`),
    open_names: entered.filter((row) => row.outcome_96h === "open").map((row) => `${row.symbol}#${row.id}`),
  });
}
const disqualificationSummary = [];
for (const cohort of ["A_signal","B_blocked","C_reference"]) {
  const rows = disqualificationRows.filter((row) => row.cohort === cohort);
  for (const [key, title] of [
    ["current_4h_close_under_zone","current_4H_close_under_zone"],
    ["one_day","below_zone_1d_no_return_no_bright_Lucy_4H"],
    ["two_days","below_zone_2d_no_return_no_bright_Lucy_4H"],
    ["three_days","below_zone_3d_no_return_no_bright_Lucy_4H"],
  ]) {
    const removed = rows.filter((row) => key === "current_4h_close_under_zone"
      ? row[key] === true
      : row[key] && typeof row[key] === "object" && row[key].qualifies === true);
    disqualificationSummary.push({
      cohort, scenario: title,
      by_outcome: countBy(removed, (row) => row.outcome_96h),
      names: removed.map((row) => `${row.symbol}#${row.id}(${row.outcome_96h})`),
    });
  }
}
const managementSummary = [];
for (const holdHours of TRADE_HORIZONS_H) for (const stopMode of ["stop6","under_zone"]) {
  const rows = managementRows.filter((row) => Number(row.hold_hours) === holdHours && row.stop_mode === stopMode);
  const completeRows = rows.filter((row) => row.coverage_complete === true && num(row.simulated_pnl_usd_per_100_margin) !== null);
  const known = rows.filter((row) => num(row.simulated_pnl_usd_per_100_margin) !== null);
  managementSummary.push({
    hold_hours: holdHours, stop_mode: stopMode, signals: rows.length, simulated: known.length, complete: completeRows.length,
    total_pnl_usd_per_100_margin: completeRows.reduce((sum,row)=>sum + num(row.simulated_pnl_usd_per_100_margin),0),
    outcomes: countBy(completeRows, (row) => row.exit_reason),
    censored: rows.length - completeRows.length,
  });
}
const cTable = byCohort.C_reference.map((x) => ({
  symbol: x.symbol, date: x.event_at, source: x.source_file,
  zone_top: x.zone_top, zone_bottom: x.zone_bottom,
  r8: x.r8_replay?.status === "pass" ? `${x.r8_replay.reason}@${iso(x.r8_replay.eventAt)}` : `${x.r8_replay?.status}:${x.r8_replay?.reason}`,
  h4: x.variant_h4_time ? `${x.variant_h4_time}@${x.variant_h4_price}` : `miss:${x.price_variants?.reason ?? "no_h4_close_above_zone"}`,
  bos: x.variant_bos_time ? `${x.variant_bos_time}@${x.variant_bos_price}` : `miss:${x.price_variants?.reason ?? "no_1h_bos"}`,
  outcome: x.price_outcome_96h, peak: x.price_peak_96h_pct, worst: x.price_worst_96h_pct,
}));

const allEventColumns = [
  "cohort","event_key","id","signal_id","symbol","event_at","reference_at","entry_price","price_basis",
  "context_price",
  "status","blocked_reason","actual_pnl_pct","actual_exit","actual_exit_price","actual_close_at","actual_peak_pct",
  "zone_tf","zone_top","zone_bottom","matched_shadow_id","arm_at","arm_time_proxy",
  "price_outcome_96h","price_outcome_reason","price_peak_96h_pct","price_worst_96h_pct",
  "hours_to_peak_96h","hours_to_worst_96h","hours_to_plus10","hours_to_minus6","horizon_complete","price_cache_covered_until",
  "price_entry_1h_body_pct","price_entry_1h_range_pct","price_entry_1h_lower_wick_pct",
  "price_entry_4h_body_pct","price_entry_4h_range_pct","lucy_1h_entry","lucy_4h_entry","lucy_4h_cache_reason",
  "price_ema50d_pct","price_ema50d_above","price_ema200d_pct","price_ema200d_above",
  "variant_r8_time","variant_r8_price","variant_trigger_time","variant_trigger_price",
  "variant_h4_time","variant_h4_price","variant_bos_time","variant_bos_price",
  "r8_replay","price_variants","sim_r8_stop6","sim_r8_under_zone",
   "sim_h4_stop6","sim_h4_under_zone","sim_bos_stop6","sim_bos_under_zone",
   "wait_variants_summary","disqualification",
  "raw_decision_count","decision_ids","source_file","cache_errors","metrics","source_features",
];
const csvRows = events.map((event) => {
  const row = { ...event };
  for (const key of ["r8_replay","price_variants","sim_r8_stop6","sim_r8_under_zone","sim_h4_stop6","sim_h4_under_zone","sim_bos_stop6","sim_bos_under_zone","wait_variants_summary","disqualification","decision_ids","cache_errors","metrics","source_features"]) {
    if (row[key] !== undefined) row[key] = asJson(row[key]);
  }
  return row;
});
writeCsv("events.csv", csvRows, allEventColumns);
writeCsv("snapshots_t0.csv", snapshots, Object.keys(snapshots[0] ?? {}));
writeCsv("entry-variants.csv", entryVariantRows, Object.keys(entryVariantRows[0] ?? {}));
const disqualificationCsvRows = disqualificationRows.map((row) => ({
  ...row,
  one_day: asJson(row.one_day), two_days: asJson(row.two_days), three_days: asJson(row.three_days),
}));
writeCsv("disqualification.csv", disqualificationCsvRows, Object.keys(disqualificationCsvRows[0] ?? {}));
writeCsv("volume-timing.csv", volumeTimingRows, Object.keys(volumeTimingRows[0] ?? {}));
writeCsv("management-horizon.csv", managementRows, Object.keys(managementRows[0] ?? {}));

const sqlSource = fs.readFileSync(path.join(SOURCE, "sql_used.txt"), "utf8");
const logLines = [];
const log = (line) => { logLines.push(line); console.log(line); };
log("ABNEON_SNAP_STUDY offline=1; no external requests; 96h price thresholds +10% / -6%; same 15m candle both-hit => ambiguous.");
log(`SOURCE_ROWS A=${signals.length} B_shadow_non_fired=${candidates.length} B_OI_decisions=${oiRows.length} B_OI_unique=${dedupeOi(oiRows).length} C_references=${references.length}`);
log(`A_OUTCOMES ${JSON.stringify(summaries.A_signal.outcomes)}`);
log(`B_OUTCOMES ${JSON.stringify(summaries.B_blocked.outcomes)}`);
log(`C_OUTCOMES ${JSON.stringify(summaries.C_reference.outcomes)}`);
log(`A_STATUS ${JSON.stringify(statusCounts)}`);
log(`B_REASONS ${JSON.stringify(reasonCounts)}`);
log(`OI_GATE_RAW_REJECTIONS ${JSON.stringify(oiRawCounts)}`);
log(`SNAPSHOTS table=public.neon_snapshots present=false recorded=0 expected=432 per signal; T0=unavailable; no interpolation or reconstruction.`);
for (const row of waitVariantSummary) log(`WAIT_VARIANT ${row.wait_hours}h ${row.strategy} entered=${row.selected} outcomes=${JSON.stringify(row.outcomes)}`);
for (const row of disqualificationSummary) log(`DISQUALIFICATION ${row.cohort} ${row.scenario} removed=${row.names.length} outcomes=${JSON.stringify(row.by_outcome)}`);
for (const row of managementSummary) log(`MANAGEMENT_HORIZON ${row.hold_hours}h ${row.stop_mode} simulated=${row.simulated}/${row.signals} pnl=${row.total_pnl_usd_per_100_margin} exits=${JSON.stringify(row.outcomes)} censored=${row.censored}`);
log(`VOLUME_TIMING_ROWS=${volumeTimingRows.length} (good A signals + all C references); T0=blank because production neon_snapshots is absent.`);
log(`CACHE errors_by_symbol_count=${errors.size}`);
log(`BLOCKED_PRICE_CHAMPIONS=${blockedChampions.length}`);
for (const x of blockedChampions.slice(0,200)) log(`BLOCKED_GOOD ${x.symbol}#${x.id} reason=${x.blocked_reason ?? ""} at=${x.reference_at} peak=${x.price_peak_96h_pct} worst=${x.price_worst_96h_pct}`);
for (const [key, rows] of Object.entries(byCohort)) {
  for (const strategy of ["r8","h4","bos"]) {
    const s = simSummary(rows, strategy);
    log(`SIM ${key} ${strategy} entered=${s.selected} stop6=${JSON.stringify(s.stop6)} under_zone=${JSON.stringify(s.under_zone)}`);
  }
}
log(`VARIANT_TRIGGER unavailable_missing_neon_snapshots_table; snapshots-derived trigger not inferred.`);
log(`EVENT_FILE_ROWS=${events.length} SNAPSHOT_FILE_ROWS=${snapshots.length}`);
fs.writeFileSync(path.join(HERE, "errors.json"), `${JSON.stringify(Object.fromEntries([...errors.entries()].map(([k,v]) => [k,[...v]])), null, 2)}\n`);

const report = [];
report.push("# ABNeon R8: вход, отказы и исходы с 12 ноября 2026");
report.push("");
report.push("## Метод и ограничения");
report.push(`- Источники: production SELECT-only выгрузки из \`source/\`; кэш только из \`reports/.cache\`; режим \`STUDY_OFFLINE=1\`. Скрипт не содержит сетевого клиента.`);
report.push("- Период A/B: от 2026-11-12 00:00 UTC до выгрузки 2026-11-19 07:28 UTC. Символ, дата UTC, ID сохранены в events.csv.");
report.push("- A: все 145 tracked_signals без фильтра по статусу. C: 8 исторических эталонов из старых reports/abneon-*; исходный файл записан в events.csv.");
report.push("- B включает все 3 799 shadow-кандидатов со status <> fired и 99 сырых отказов OI15m; OI-решения дедуплицируются по symbol+frozenLevel+triggerCandleTime, сырой счётчик и ID остаются в events.csv.");
report.push("- Good = +10% раньше −6%; bad = −6% раньше +10%; open = оба порога не достигнуты в полных 96ч. Если 96ч не покрыты кэшем/временем — censored; пересечение обоих порогов одной 15m свечой — ambiguous_same_candle.");
report.push("- При отсутствии агрегированной spot-истории объёмная цветовая метрика остаётся пустой; ноль не подставлялся. BingX OHLCV использован только как ценовой ряд и отдельно помеченный proxy turnover.");
report.push("- Результат торговли из tracked_signals не смешивается с ценовым исходом 96ч; фактические status, PnL, exit price, closed_at и cancel_reason есть в events.csv.");
report.push("- Для non-fired кандидатов без trigger-candle закрытие последней доступной свечи — только context_price для метрик; entry_price и 96h outcome оставлены пустыми/not_applicable. Они не считаются сделками.");
report.push("- Для кандидатов с trigger-candle используется закрытие 1H-свечи как гипотетический вход; отклонённые OI-записи используют записанную цену и время решения. Это разные и явно отмеченные ценовые основания.");
report.push("");
report.push("## Production SQL и размеры выборок");
report.push("См. полный, исполняемый текст SELECT-запросов в source/sql_used.txt. Результаты: A=145; B1=3 799 non-fired / 3 942 всего (143 fired); B2=99 OI-решений (98 oi15m_no_new_money, 1 oi15m_unknown).");
report.push("Проверка таблиц production показала только stealth_hourly_snapshots; public.neon_snapshots отсутствует. Это другая таблица и вместо неё не использовалась.");
report.push("");
report.push("## A: фактические сигналы и статусы");
report.push(`Всего ${signals.length}. Раскладка статусов: ${Object.entries(statusCounts).map(([k,v]) => `${k}=${v}`).join(", ")}.`);
report.push(`Ценовые исходы 96ч: ${JSON.stringify(summaries.A_signal.outcomes)}; покрытие: ${JSON.stringify(summaries.A_signal.coverage)}.`);
report.push("Режим сопровождения для ценовой симуляции: стоп −6%; частичная фиксация 20% позиции на +8% (нижняя граница указанного в коде диапазона 20–25%); Б/У на +10%; трейлинг с +20%, отступ 20 процентных пунктов; отмена при закрытии 4H ниже низа зоны; горизонт 96ч. Без комиссий, funding и проскальзывания.");
report.push("");
report.push("## B: причины отсутствия сигнала");
report.push(`Все non-fired кандидаты по status/terminal_reason: ${JSON.stringify(reasonCounts)}.`);
report.push(`Сырые OI-отказы: ${JSON.stringify(oiRawCounts)}. Уникальные OI-кандидаты: ${dedupeOi(oiRows).length}; исходы гипотетического входа с цены/времени rejected decision вынесены отдельно в events.csv и не считаются фактическими сигналами.`);
report.push(`Гипотетические кандидаты, где кэш после reference price пересёк +10% раньше −6%: ${blockedChampions.length}; полный список имя#ID, причина, пик и худшая точка — в events.csv и run.log.`);
report.push("");
report.push("### Где формируются причины отказа");
report.push("- `artifacts/api-server/src/lib/abneon-rule-entry.ts:59-78`: 48h arm timeout; closed 4H close below zone at :60-63; touch/test and green 1H reaction within 8h at :64-75; waiting states at :77-78.");
report.push("- `artifacts/api-server/src/lib/scanner.ts:6870-6894, 6961-6979`: invokes R8 and writes `rule_entry_passed`, `rule_<void reason>`, or `rule_waiting_<reason>` into shadow candidates.");
report.push("- `artifacts/api-server/src/lib/abneon-volume-gate.ts:137-176`: Lucy touch-volume check, 120-bar history, missing aggregate data, grey bars and buying/close-above-middle condition. Scanner feeds it at `scanner.ts:6876-6894`.");
report.push("- `artifacts/api-server/src/lib/stealth-abneon-shadow-store.ts:448-469`: qualified-but-not-fired offered events are terminalized as `neon_not_entered_at_detection`.");
report.push("- `artifacts/api-server/src/lib/abneon-oi15m-gate.ts:8-16` defines strict OI15m >0.18%; `scanner.ts:13672-13692` writes `oi15m_no_new_money` / `oi15m_unknown` to scan rejects.");
report.push("- `artifacts/api-server/src/lib/abneon-volume-gate.ts:192-224` calculates the 30-day volume gate and its `no_aggregated_volume` / `month_volume_low` outcomes.");
report.push("- `artifacts/api-server/src/lib/scanner.ts:8792-8805` marks already-open duplicate ABNeon positions as `qualified_duplicate_active_position`.");
report.push("");
report.push("## C: эталоны и старые файлы");
report.push("| Монета | Дата UTC | Источник | Zone top | Zone bottom/level | 96ч исход | пик | худшее | R8 replay | 4H reclaim | 1H BOS |");
report.push("|---|---|---|---:|---:|---|---:|---:|---|---|---|");
for (const x of cTable) report.push(`| ${x.symbol} | ${x.date} | ${x.source} | ${x.zone_top ?? ""} | ${x.zone_bottom ?? ""} | ${x.outcome} | ${x.peak ?? ""} | ${x.worst ?? ""} | ${x.r8} | ${x.h4} | ${x.bos} |`);
report.push("");
report.push("## Снапшоты и T0");
report.push(`Production не содержит public.neon_snapshots, поэтому записано 0 из 432 слотов для каждого из ${signals.length} сигналов. В snapshots_t0.csv отдельно указаны elapsed missing и ещё не наступившие слоты. T0, точки T0−60/−30/+30, история snapshot-тейкеров и snapshot-метрики оставлены пустыми с причиной \`production_neon_snapshots_table_absent\`; они не восстановлены по цене или другому паттерну.`);
report.push("Без T0 нельзя доказательно найти предвестник роста по части 2. Поэтому snapshot-derived trigger variant не симулировался и не объявлялся найденным.");
report.push("");
report.push("## Сравнение входов и депозитная симуляция");
report.push("R8 replay — по кэшированным 1H/4H, 48ч, зона +2%, первая зелёная закрытая 1H не ниже низа зоны в течение 8ч от минимума, Lucy VSA на touch 4H и двух следующих закрытых барах; отсутствующая агрегированная история даёт unknown. Price-only варианты: 4H close выше zone top после касания; 1H close выше максимумов предыдущих 3 закрытых 1H после касания. Эти два варианта — описательная replay-проверка, не подтверждённый предвестник из отсутствующих T0-снапшотов.");
report.push("Стоп под зоной смоделирован как 0,1% ниже zone bottom (явный технический proxy, поскольку точный зазор не задан). Стоповой/частичной логике присвоен консервативный порядок: уже активный стоп проверяется до новых целей внутри одной 15m свечи; конфликт high/low одной свечи отмечается ambiguous_same_bar.");
report.push("Нормировка из ответа пользователя: депозит $1 000, фиксированная маржа $100 на сделку, плечо 10×, без реинвестирования; PnL каждой сделки прибавляется к исходному депозиту, сделки идут по времени. Сводка стратегий также записана в run.log и JSON-полях событий.");
report.push("Для R8, 4H reclaim и 1H BOS каждое событие пересчитано с окнами ожидания 48ч, 96ч и 168ч от arm. `entry-variants.csv` содержит все имена, вошедшие/не вошедшие, исход +10%/-6%/open за следующие 96ч и симуляции с обоими стопами и сроком 4/7 дней.");
report.push("");
report.push("### Срок ожидания и входные варианты");
for (const row of waitVariantSummary) report.push(`- ${row.wait_hours}ч / ${row.strategy}: входов ${row.selected}; outcomes=${JSON.stringify(row.outcomes)}. Полные имена по группам — в entry-variants.csv.`);
report.push("");
report.push("### Снятие сетапа после ухода ниже зоны");
report.push("Текущий критерий — любой закрытый 4H close ниже zone bottom в окне R8. Новые варианты требуют после первого такого close 6/12/18 последующих закрытых 4H свечей с high строго ниже зоны и Lucy=grey (N) на каждой; missing volume = unknown, не pass.");
for (const row of disqualificationSummary) report.push(`- ${row.cohort} / ${row.scenario}: снято ${row.names.length}, исходы ${JSON.stringify(row.by_outcome)}. Полный список символ#ID и их good/bad/open — в disqualification.csv.`);
report.push("");
report.push("### Время до яркого Lucy-объёма");
report.push("Для всех good A/B и всех 8 reference entries `volume-timing.csv` содержит первое не-серое Lucy 1H/4H после первого касания зоны, часы от касания и цвет; T0 и часы до T0 оставлены пустыми из-за отсутствующей production neon_snapshots.");
for (const row of volumeTimingRows) report.push(`- ${row.symbol}#${row.id} ${row.timeframe}: touch=${row.zone_touch_at || "missing"} bright=${row.first_bright_lucy_at || "missing"} hours=${row.hours_from_touch_to_bright ?? "n/a"} color=${row.first_bright_color || "n/a"}; T0=unavailable.`);
report.push("");
report.push("### Сопровождение 4 против 7 дней");
report.push("`management-horizon.csv` содержит по каждой из 145 A-сделок фактический статус/PnL и модель 4/7 дней для стопов −6% и под зоной. После 72ч используется только кэш 15m/4H; снимков позиции нет. Эти строки — пересчёт торговой политики по цене, не фактическое продление закрытой сделки.");
for (const row of managementSummary) report.push(`- ${row.hold_hours}ч / ${row.stop_mode}: полный ценовой горизонт ${row.complete}/${row.signals}; PnL суммы только для полностью покрытых строк ${row.total_pnl_usd_per_100_margin.toFixed(2)} USD на фиксированной марже $100, выходы ${JSON.stringify(row.outcomes)}, цензурировано ${row.censored}.`);
report.push("");
for (const [key, rows] of Object.entries(byCohort)) {
  report.push(`\n### ${key}`);
  for (const strategy of ["r8","h4","bos"]) {
    const s = simSummary(rows, strategy);
    report.push(`- ${strategy}: входы=${s.selected}; stop −6%: ${JSON.stringify(s.stop6)}; stop под зоной: ${JSON.stringify(s.under_zone)}.`);
  }
}
report.push("");
report.push("## Полный разброс метрик по good / bad / open");
report.push("Для каждой cohort и каждой доступной числовой метрики приведены min/max и все значения с именами/ID. Это намеренно не медианы.");
report.push(metricLines.join("\n") || "_Нет групп с измеримыми исходами._");
report.push("");
report.push("## Попарный поиск порога good против bad (A)");
report.push("Порог выбирается только как внутривыборочный split, максимизирующий balanced accuracy; минимум 3 good и 3 bad. Это не out-of-sample и не готовый live-фильтр.");
for (const row of thresholds) {
  if (row.result) {
    report.push(`- ${row.key}: ${row.result} (good=${row.good}, bad=${row.bad}, n=${row.n}).`);
    continue;
  }
  report.push(`- ${row.key}: ${row.direction === "ge_good" ? "≥" : "≤"} ${row.threshold}; balanced accuracy=${row.balanced.toFixed(3)}, accuracy=${row.accuracy.toFixed(3)}, good kept=${row.tp}/${row.good}, good cut=${row.fn}, bad kept=${row.fp}/${row.bad}, bad cut=${row.tn}; good cut names: ${row.good_cut.join(", ") || "—"}; bad passed names: ${row.bad_kept.join(", ") || "—"}.`);
}
report.push("");
report.push("## Выводы, ограниченные наблюдаемыми данными");
report.push("- Полный список живых сигналов и их индивидуальные ценовые траектории — events.csv; результаты по 96ч не подменяют фактические закрытия бота.");
report.push("- Для OI 15m показываются все отказы, значения и последующие ценовые результаты только там, где кэш покрывает путь. Отказные решения повторялись по циклам, поэтому raw decision count не равен числу уникальных сетапов.");
report.push("- По отсутствующим таблицам/кэшам вывод не делается. Отклонение порога по одному периоду является ретроспективным, а не доказательством причинности.");
report.push("");
report.push("## Созданные файлы");
report.push("- events.csv — 4 когорты: A actual, B non-fired shadow, B OI rejects, C references; полный набор доступных признаков и cache/errors.");
report.push("- snapshots_t0.csv — 145 строк с отсутствием снимков без реконструкции.");
report.push("- entry-variants.csv, disqualification.csv, volume-timing.csv, management-horizon.csv — окна ожидания, дисквалификация, задержка Lucy и 4/7-дневное сопровождение.");
report.push("- source/ — production SELECT выгрузки и источники 8 эталонов; source/sql_used.txt содержит SQL.");
report.push("- study.mjs, run.log, errors.json.");
fs.writeFileSync(path.join(HERE, "summary.md"), `${report.join("\n")}\n`);

log(`SUMMARY_WRITTEN events=${events.length} snapshots=${snapshots.length} metric_keys=${featureKeys.length} threshold_rows=${thresholds.length}`);
for (const [symbol, reasons] of [...errors.entries()].sort((a,b)=>a[0].localeCompare(b[0]))) {
  log(`CACHE_GAP ${symbol}: ${[...reasons].join("|")}`);
}
log(`FINAL_COUNTS ${JSON.stringify({ cohorts: Object.fromEntries(Object.entries(summaries).map(([k,v])=>[k,v.outcomes])), aStatus: statusCounts, bReasons: reasonCounts, oiReasons: oiRawCounts, waitVariants: waitVariantSummary.map(({wait_hours,strategy,selected,outcomes})=>({wait_hours,strategy,selected,outcomes})), disqualifications: disqualificationSummary.map(({cohort,scenario,names,by_outcome})=>({cohort,scenario,removed:names.length,by_outcome})), management: managementSummary, cacheGapSymbols: errors.size })}`);
fs.writeFileSync(path.join(HERE, "run.log"), `${logLines.join("\n")}\n`);
