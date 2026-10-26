/**
 * Frozen-cohort, read-only Impulse Buy overhead-resistance replay.
 * Structure is reconstructed from closed, pre-entry BingX swap 1h OHLC.
 */
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const DIR = ".local/reports/ib-entry-structure-2026-10-01";
const COHORT_SOURCE = ".local/reports/ib-taker-volume-2026-10-01/cohort.json";
const META_SOURCE = ".local/reports/ib-taker-volume-2026-10-01/metadata.json";
const PRIOR_CACHE =
  ".local/reports/plm-september-ict-candle-acquisitions-2026-10-01.jsonl";
const FILES = {
  frozenCohort: `${DIR}/frozen-cohort-ib-entry-structure-2026-10-01.json`,
  frozenMeta: `${DIR}/frozen-metadata-ib-entry-structure-2026-10-01.json`,
  raw: `${DIR}/bingx-swap-1h-acquisitions-ib-entry-structure-2026-10-01.jsonl`,
  index: `${DIR}/bingx-swap-1h-acquisition-index-ib-entry-structure-2026-10-01.csv`,
  rows: `${DIR}/ib-entry-structure-rows-2026-10-01.csv`,
  json: `${DIR}/ib-entry-structure-report-2026-10-01.json`,
  markdown: `${DIR}/ib-entry-structure-report-2026-10-01.md`,
};
const HOUR = 3_600_000;
const LOOKBACK = 168;
const LEFT_CONTEXT = 2;
const HISTORY_BARS = LOOKBACK + LEFT_CONTEXT;
const REQUEST_LIMIT = 240;
const REQUEST_CAP = 187;
const PACE_MS = 400;
const STATUS_NAMES = [
  "stop_loss",
  "bu_stop",
  "profit",
  "cancelled",
  "expired",
  "reclassified",
  "active",
];
const CUTS = [3, 5, 10];
const CAPTURE = "2026-10-01T06:02:27.412957+00:00";
const LATE_CUTOFF = Date.parse("2026-09-20T00:00:00.000Z");

const abs = (path) => resolve(path);
const num = (value) => {
  if (value === null || value === undefined || value === "") return null;
  const valueNum = Number(value);
  return Number.isFinite(valueNum) ? valueNum : null;
};
const positive = (value) => {
  const valueNum = num(value);
  return valueNum !== null && valueNum > 0 ? valueNum : null;
};
const dateIso = (time) =>
  Number.isFinite(time) ? new Date(time).toISOString() : null;

function csvEscape(value) {
  if (value === null || value === undefined) return "";
  const text = typeof value === "object" ? JSON.stringify(value) : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function makeCsv(rows, columns) {
  return [
    columns.join(","),
    ...rows.map((row) => columns.map((key) => csvEscape(row[key])).join(",")),
  ].join("\n") + "\n";
}

async function optionalRead(path) {
  try {
    return await readFile(abs(path), "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function parseLines(text) {
  return text
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(`Invalid JSONL row ${index + 1}: ${error.message}`);
      }
    });
}

function keyFor(row) {
  return `${row.symbol}|${row.detected_at_utc.slice(0, 10)}`;
}

async function loadFrozen() {
  let cohortText = await optionalRead(FILES.frozenCohort);
  let metadataText = await optionalRead(FILES.frozenMeta);
  if (!cohortText || !metadataText) {
    cohortText = await readFile(abs(COHORT_SOURCE), "utf8");
    metadataText = await readFile(abs(META_SOURCE), "utf8");
    await writeFile(abs(FILES.frozenCohort), cohortText);
    await writeFile(abs(FILES.frozenMeta), metadataText);
  }
  const cohort = JSON.parse(cohortText);
  const metadata = JSON.parse(metadataText);
  if (
    !Array.isArray(cohort.rows) ||
    cohort.rows.length !== 188 ||
    metadata.cohort_rows !== 188 ||
    metadata.capture_asof_utc !== CAPTURE
  ) {
    throw new Error("The required frozen 188-row capture did not match.");
  }
  const ids = new Set();
  for (const row of cohort.rows) {
    if (ids.has(String(row.id))) throw new Error(`Duplicate tracker id ${row.id}`);
    ids.add(String(row.id));
    if (
      !row.symbol ||
      !row.detected_at_utc ||
      !STATUS_NAMES.includes(row.status)
    ) {
      throw new Error(`Invalid frozen row identity or status: ${row.id}`);
    }
  }
  return { cohort, metadata };
}

function requiredOpens(entryAt) {
  const latest = Math.floor(entryAt / HOUR) * HOUR - HOUR;
  const first = latest - (HISTORY_BARS - 1) * HOUR;
  return Array.from({ length: HISTORY_BARS }, (_, i) => first + i * HOUR);
}

function validBar(raw) {
  const time = num(raw?.time ?? raw?.openTime ?? raw?.open_time);
  const open = num(raw?.open);
  const high = num(raw?.high);
  const low = num(raw?.low);
  const close = num(raw?.close);
  return {
    time,
    open,
    high,
    low,
    close,
    valid:
      Number.isFinite(time) &&
      time % HOUR === 0 &&
      [open, high, low, close].every((v) => v !== null && v > 0) &&
      high >= Math.max(open, close) &&
      low <= Math.min(open, close) &&
      low <= high,
  };
}

function candleMap(rawCandles) {
  const map = new Map();
  const duplicates = new Set();
  for (const raw of Array.isArray(rawCandles) ? rawCandles : []) {
    const bar = validBar(raw);
    if (!Number.isFinite(bar.time)) continue;
    if (map.has(bar.time)) duplicates.add(bar.time);
    else map.set(bar.time, bar);
  }
  return { map, duplicates };
}

function checkHistory(rawCandles, entryAt) {
  const { map, duplicates } = candleMap(rawCandles);
  const opens = requiredOpens(entryAt);
  const bars = opens.map((time) => map.get(time));
  const missing = opens.filter((time) => !map.has(time)).length;
  const invalid = bars.filter((bar) => bar && !bar.valid).length;
  const duplicated = opens.filter((time) => duplicates.has(time)).length;
  const latestClose = bars.at(-1)?.time + HOUR;
  const ageMs = Number.isFinite(latestClose) ? entryAt - latestClose : null;
  const stale = ageMs === null || ageMs < 0 || ageMs >= HOUR;
  const available =
    missing === 0 && invalid === 0 && duplicated === 0 && !stale;
  return {
    available,
    reason: available
      ? "gap_free_168h_plus_left_context"
      : missing
        ? "insufficient_or_gapped_history"
        : invalid
          ? "invalid_ohlc"
          : duplicated
            ? "duplicate_candle"
            : "latest_closed_candle_stale_or_future",
    bars,
    expected: HISTORY_BARS,
    missing,
    invalid,
    duplicated,
    latestClose: Number.isFinite(latestClose) ? latestClose : null,
    ageMinutes: ageMs === null ? null : ageMs / 60_000,
    firstOpen: available ? bars[0].time : null,
    lastOpen: available ? bars.at(-1).time : null,
    noFuture: available && latestClose <= entryAt,
  };
}

function reconstruct(row, acquisition) {
  const entryAt = Date.parse(row.detected_at_utc);
  const entry = positive(row.original_entry_price) ??
    positive(row.current_entry_price);
  const history = checkHistory(acquisition?.candles, entryAt);
  const result = {
    feature_source: acquisition?.source ?? "not_acquired",
    acquisition_key: acquisition?.key ?? keyFor(row),
    acquisition_error: acquisition?.error ?? null,
    entry_basis: entry,
    entry_basis_provenance:
      positive(row.original_entry_price) === null
        ? "entry_price_fallback"
        : "original_entry_price",
    captured_structure_value: null,
    reconstructed_only: true,
    history_available: history.available,
    history_reason: history.reason,
    history_required_bars: history.expected,
    history_missing_bars: history.missing,
    history_invalid_bars: history.invalid,
    history_duplicate_bars: history.duplicated,
    history_latest_closed_at: dateIso(history.latestClose),
    history_age_minutes: history.ageMinutes,
    history_start_open_at: dateIso(history.firstOpen),
    history_end_open_at: dateIso(history.lastOpen),
    no_future_bars_verified: history.noFuture,
    pivot_ties_policy: "strict_high_only; ties_are_not_pivots",
    pivot_confirmation_policy:
      "usable_after_second_right_closed_bar; confirmation_at_or_before_detection",
    invalidation_policy:
      "subsequent_closed_hourly_close_strictly_above_pivot; wick_only_does_not_invalidate",
    pivots_found: 0,
    pivots_invalidated: 0,
    intact_overhead_levels: 0,
    resistance_category: "unknown",
    nearest_resistance_price: null,
    nearest_resistance_room_pct: null,
    nearest_pivot_at: null,
    nearest_confirmed_at: null,
    confirmation_before_entry: false,
    lookahead_check_passed: false,
  };
  if (!entry) {
    result.history_available = false;
    result.history_reason = "missing_positive_entry_basis";
    return result;
  }
  if (!history.available) return result;

  const bars = history.bars;
  const levels = [];
  for (let i = LEFT_CONTEXT; i <= bars.length - 3; i += 1) {
    const pivot = bars[i];
    if (
      !(
        pivot.high > bars[i - 1].high &&
        pivot.high > bars[i - 2].high &&
        pivot.high > bars[i + 1].high &&
        pivot.high > bars[i + 2].high
      )
    ) {
      continue;
    }
    const confirmedAt = bars[i + 2].time + HOUR;
    if (confirmedAt > entryAt) continue;
    result.pivots_found += 1;
    let invalidated = false;
    for (let j = i + 3; j < bars.length; j += 1) {
      if (bars[j].time + HOUR <= entryAt && bars[j].close > pivot.high) {
        invalidated = true;
        break;
      }
    }
    if (invalidated) {
      result.pivots_invalidated += 1;
      continue;
    }
    if (pivot.high > entry) {
      levels.push({
        price: pivot.high,
        room: ((pivot.high / entry) - 1) * 100,
        pivotAt: pivot.time,
        confirmedAt,
      });
    }
  }
  levels.sort((a, b) => a.price - b.price || a.pivotAt - b.pivotAt);
  const nearest = levels[0] ?? null;
  Object.assign(result, {
    intact_overhead_levels: levels.length,
    resistance_category: nearest ? "measured" : "no_known_resistance",
    nearest_resistance_price: nearest?.price ?? null,
    nearest_resistance_room_pct: nearest?.room ?? null,
    nearest_pivot_at: nearest ? dateIso(nearest.pivotAt) : null,
    nearest_confirmed_at: nearest ? dateIso(nearest.confirmedAt) : null,
    confirmation_before_entry: nearest
      ? nearest.confirmedAt <= entryAt
      : true,
    lookahead_check_passed:
      history.noFuture &&
      (!nearest || nearest.confirmedAt <= entryAt),
  });
  if (!result.lookahead_check_passed) {
    throw new Error(`Look-ahead validation failed for tracker ${row.id}`);
  }
  return result;
}

function pathWindow(row, hours) {
  const values = row.windows?.[String(hours)];
  const mature = Array.isArray(values) && values[0] === true;
  const gapFree = Array.isArray(values) && values[9] === true;
  const usable =
    mature && gapFree && num(values[10]) !== null;
  const plus5Index = usable ? num(values[13]) : null;
  const plus10Index = usable ? num(values[14]) : null;
  return {
    mature,
    gapFree,
    peak: usable ? num(values[10]) : null,
    plus5: usable ? plus5Index !== null : null,
    plus10: usable ? plus10Index !== null : null,
    plus5Index,
    plus10Index,
  };
}

function enrichRow(row, acquisition) {
  const entry = positive(row.original_entry_price) ??
    positive(row.current_entry_price);
  const frozenEntry = positive(row.basis_entry_price);
  if (
    entry !== null &&
    frozenEntry !== null &&
    Math.abs(entry - frozenEntry) > Math.max(1e-10, Math.abs(entry) * 1e-7)
  ) {
    throw new Error(`Frozen basis mismatch for tracker ${row.id}`);
  }
  const features = reconstruct(row, acquisition);
  const result = {
    tracker_id: row.id,
    symbol: row.symbol,
    status_as_captured: row.status,
    detected_at_utc: row.detected_at_utc,
    closed_at_utc: row.closed_at_utc ?? null,
    cancel_reason: row.cancel_reason ?? null,
    entry_policy_version: row.entry_policy_version ?? null,
    exit_policy_version: row.exit_policy_version ?? null,
    original_entry_price: positive(row.original_entry_price),
    current_entry_price: positive(row.current_entry_price),
    frozen_basis_entry_price: frozenEntry,
    basis_price_source: row.basis_price_source,
    peak_price_recorded: positive(row.peak_price),
    pnl_percent_recorded: num(row.pnl_percent),
    snapshot_source: row.snapshot_source,
    snapshot_is_legacy: row.snapshot_is_legacy,
    feature_captured_in_snapshot: false,
    reconstructed_structure_only: true,
    late_sept20_or_later:
      Date.parse(row.detected_at_utc) >= LATE_CUTOFF,
    single_entry_v1: row.entry_policy_version === "single_entry_v1",
    ...features,
  };
  for (const h of [1, 3, 6]) {
    const path = pathWindow(row, h);
    result[`h${h}_mature_flag_position0`] = path.mature;
    result[`h${h}_gap_free_flag_position9`] = path.gapFree;
    result[`h${h}_forward_peak_high_pct`] = path.peak;
    result[`h${h}_plus5_path_hit`] = path.plus5;
    result[`h${h}_plus10_path_hit`] = path.plus10;
    result[`h${h}_first_plus5_open_index`] = path.plus5Index;
    result[`h${h}_first_plus10_open_index`] = path.plus10Index;
  }
  for (const cut of CUTS) {
    result[`remove_if_room_lt_${cut}_pct`] =
      result.resistance_category === "measured" &&
      result.nearest_resistance_room_pct < cut;
  }
  return result;
}

async function loadOldCache() {
  const text = await optionalRead(PRIOR_CACHE);
  if (!text) return [];
  return parseLines(text).filter(
    (row) =>
      row.timeframe === "1h" &&
      typeof row.symbol === "string" &&
      Array.isArray(row.bars),
  );
}

function coversRows(cacheRow, rows) {
  const { map, duplicates } = candleMap(cacheRow.bars);
  return rows.every((row) =>
    requiredOpens(Date.parse(row.detected_at_utc)).every((time) => {
      const bar = map.get(time);
      return bar?.valid && !duplicates.has(time);
    }),
  );
}

async function fetchGroup(group) {
  const times = group.rows.map((row) => Date.parse(row.detected_at_utc));
  const url = new URL(
    "https://open-api.bingx.com/openApi/swap/v3/quote/klines",
  );
  url.searchParams.set("symbol", group.symbol);
  url.searchParams.set("interval", "1h");
  url.searchParams.set("limit", String(REQUEST_LIMIT));
  url.searchParams.set("startTime", String(Math.min(...times) - 8 * 24 * HOUR));
  url.searchParams.set("endTime", String(Math.max(...times)));
  const response = await fetch(url, {
    signal: AbortSignal.timeout(15_000),
  });
  const body = await response.json();
  if (
    response.status === 429 ||
    body?.code === 100410 ||
    body?.code === 100421
  ) {
    const error = new Error(
      `rate_limited: HTTP ${response.status}, BingX code ${body?.code}`,
    );
    error.rateLimited = true;
    throw error;
  }
  if (!response.ok || body?.code !== 0 || !Array.isArray(body?.data)) {
    throw new Error(
      `BingX swap klines failed: HTTP ${response.status}, code ${body?.code ?? "missing"}`,
    );
  }
  return {
    url,
    candles: body.data
      .map((bar) => ({
        time: Number(bar.time),
        open: Number(bar.open),
        high: Number(bar.high),
        low: Number(bar.low),
        close: Number(bar.close),
      }))
      .sort((a, b) => a.time - b.time),
    status: response.status,
  };
}

async function acquire(rows, fetchMissing) {
  const groups = new Map();
  for (const row of rows) {
    const key = keyFor(row);
    const group = groups.get(key) ?? {
      key,
      symbol: row.symbol,
      date: row.detected_at_utc.slice(0, 10),
      rows: [],
    };
    group.rows.push(row);
    groups.set(key, group);
  }
  const priorText = await optionalRead(FILES.raw);
  const records = priorText ? parseLines(priorText) : [];
  const byKey = new Map(
    records.filter((row) => row.key && row.interval === "1h")
      .map((row) => [row.key, row]),
  );
  let localReused = Array.from(byKey.values()).filter(
    (record) => record.source === "local_cached_bingx_swap_1h",
  ).length;
  const localCache = await loadOldCache();
  for (const group of groups.values()) {
    if (byKey.has(group.key)) continue;
    const local = localCache.find(
      (row) => row.symbol === group.symbol && coversRows(row, group.rows),
    );
    if (!local) continue;
    const record = {
      key: group.key,
      symbol: group.symbol,
      date_utc: group.date,
      interval: "1h",
      source: "local_cached_bingx_swap_1h",
      provenance: {
        file: PRIOR_CACHE,
        prior_key: local.key ?? `${local.trackerId ?? "unknown"}|1h`,
        prior_source: local.source ?? "prior local audit snapshot",
        exact_symbol_match: true,
        exact_timeframe_match: true,
      },
      error: null,
      request: null,
      candles: local.bars.map((bar) => ({
        time: Number(bar.time),
        open: Number(bar.open),
        high: Number(bar.high),
        low: Number(bar.low),
        close: Number(bar.close),
      })),
    };
    byKey.set(group.key, record);
    localReused += 1;
    await appendFile(abs(FILES.raw), `${JSON.stringify(record)}\n`);
  }

  let attempted = 0;
  let haltedReason = null;
  for (const group of groups.values()) {
    if (byKey.has(group.key) || !fetchMissing || haltedReason) continue;
    if (attempted >= REQUEST_CAP) continue;
    if (attempted) await new Promise((r) => setTimeout(r, PACE_MS));
    attempted += 1;
    let record;
    try {
      const result = await fetchGroup(group);
      record = {
        key: group.key,
        symbol: group.symbol,
        date_utc: group.date,
        interval: "1h",
        source: "bingx_public_swap_klines",
        provenance: {
          endpoint: result.url.origin + result.url.pathname,
          exact_symbol_match: true,
          interval: "1h",
          public_endpoint_only: true,
          private_endpoint: false,
        },
        error: null,
        request: {
          endpoint: result.url.origin + result.url.pathname,
          symbol: group.symbol,
          interval: "1h",
          limit: REQUEST_LIMIT,
          start_time_utc: dateIso(
            Number(result.url.searchParams.get("startTime")),
          ),
          end_time_utc: dateIso(
            Number(result.url.searchParams.get("endTime")),
          ),
          http_status: result.status,
          bingx_code: 0,
        },
        candles: result.candles,
      };
    } catch (error) {
      record = {
        key: group.key,
        symbol: group.symbol,
        date_utc: group.date,
        interval: "1h",
        source: "bingx_public_swap_klines",
        provenance: {
          endpoint: "https://open-api.bingx.com/openApi/swap/v3/quote/klines",
          exact_symbol_match: true,
          interval: "1h",
          public_endpoint_only: true,
          private_endpoint: false,
        },
        error: String(error.message),
        request: null,
        candles: [],
      };
      if (error.rateLimited) haltedReason = String(error.message);
    }
    byKey.set(group.key, record);
    await appendFile(abs(FILES.raw), `${JSON.stringify(record)}\n`);
  }

  const rowAcquisitions = new Map();
  const indexRows = [];
  let publicSuccess = 0;
  let failedGroups = 0;
  let notAttempted = 0;
  for (const group of groups.values()) {
    const record = byKey.get(group.key);
    if (!record) {
      notAttempted += 1;
      indexRows.push({
        key: group.key,
        symbol: group.symbol,
        date_utc: group.date,
        fire_rows: group.rows.length,
        source: "not_acquired",
        state: "not_attempted_or_safe_halt",
        raw_bars: 0,
        complete_rows: 0,
        incomplete_rows: group.rows.length,
        bingx_error: haltedReason ?? "not fetched; run with --fetch",
      });
      for (const row of group.rows) {
        rowAcquisitions.set(String(row.id), {
          key: group.key,
          source: "not_acquired",
          error: haltedReason ?? "raw_acquisition_missing",
          candles: [],
        });
      }
      continue;
    }
    let complete = 0;
    for (const row of group.rows) {
      const entryAt = Date.parse(row.detected_at_utc);
      const candles = (record.candles ?? []).filter((bar) => {
        const candle = validBar(bar);
        return Number.isFinite(candle.time) &&
          candle.time + HOUR <= entryAt;
      });
      if (checkHistory(candles, entryAt).available) complete += 1;
      rowAcquisitions.set(String(row.id), {
        ...record,
        candles,
      });
    }
    if (record.error) failedGroups += 1;
    else if (record.source === "bingx_public_swap_klines") publicSuccess += 1;
    indexRows.push({
      key: group.key,
      symbol: group.symbol,
      date_utc: group.date,
      fire_rows: group.rows.length,
      source: record.source,
      state: record.error
        ? "request_failed_or_unsupported"
        : complete === group.rows.length
          ? "all_rows_gap_free"
          : "raw_present_but_history_incomplete",
      raw_bars: record.candles?.length ?? 0,
      complete_rows: complete,
      incomplete_rows: group.rows.length - complete,
      bingx_error: record.error ?? "",
    });
  }
  const indexColumns = [
    "key",
    "symbol",
    "date_utc",
    "fire_rows",
    "source",
    "state",
    "raw_bars",
    "complete_rows",
    "incomplete_rows",
    "bingx_error",
  ];
  await writeFile(abs(FILES.index), makeCsv(indexRows, indexColumns));
  return {
    groups,
    rowAcquisitions,
    summary: {
      symbolDateGroups: groups.size,
      localCachedGroupsReused: localReused,
      publicRequestsAttempted: Array.from(byKey.values()).filter(
        (record) => record.source === "bingx_public_swap_klines",
      ).length,
      publicRequestCap: REQUEST_CAP,
      publicFetchSuccesses: publicSuccess,
      failedGroups,
      notAttemptedGroups: notAttempted,
      haltedReason,
      requestPaceMs: PACE_MS,
      endpoint: "https://open-api.bingx.com/openApi/swap/v3/quote/klines",
      instrumentRule:
        "frozen BingX swap symbol is used exactly; no venue/instrument substitution",
    },
  };
}

function countsByStatus(rows) {
  const counts = Object.fromEntries(STATUS_NAMES.map((name) => [name, 0]));
  for (const row of rows) {
    counts[row.status_as_captured] =
      (counts[row.status_as_captured] ?? 0) + 1;
  }
  return counts;
}

function pathCounts(rows, hours) {
  const prefix = `h${hours}_`;
  const usable = rows.filter(
    (row) =>
      row[`${prefix}mature_flag_position0`] === true &&
      row[`${prefix}gap_free_flag_position9`] === true &&
      row[`${prefix}forward_peak_high_pct`] !== null,
  );
  return {
    mature_and_gap_free: usable.length,
    cohort_rows: rows.length,
    peak_high_at_least_5: usable.filter(
      (row) => row[`${prefix}forward_peak_high_pct`] >= 5,
    ).length,
    peak_high_at_least_10: usable.filter(
      (row) => row[`${prefix}forward_peak_high_pct`] >= 10,
    ).length,
    plus5_path_hits: usable.filter(
      (row) => row[`${prefix}plus5_path_hit`] === true,
    ).length,
    plus10_path_hits: usable.filter(
      (row) => row[`${prefix}plus10_path_hit`] === true,
    ).length,
  };
}

function summarize(rows) {
  const measured = rows.filter((r) => r.resistance_category === "measured");
  const unknown = rows.filter((r) => r.resistance_category === "unknown");
  const noKnown = rows.filter(
    (r) => r.resistance_category === "no_known_resistance",
  );
  const thresholds = {};
  for (const cut of CUTS) {
    const removed = rows.filter(
      (r) =>
        r.resistance_category === "measured" &&
        r.nearest_resistance_room_pct < cut,
    );
    const removedIds = new Set(removed.map((r) => String(r.tracker_id)));
    const retained = rows.filter((r) => !removedIds.has(String(r.tracker_id)));
    thresholds[String(cut)] = {
      fixed_rule: `remove measured room < ${cut}%`,
      removed_rows: removed.length,
      removed_measured_denominator: measured.length,
      removed_measured_rate_pct:
        measured.length ? (removed.length / measured.length) * 100 : null,
      removed_full_group_denominator: rows.length,
      removed_full_group_rate_pct:
        rows.length ? (removed.length / rows.length) * 100 : null,
      removed_status_counts: countsByStatus(removed),
      retained_rows: retained.length,
      retained_status_counts: countsByStatus(retained),
      retained_path_outcomes: Object.fromEntries(
        [1, 3, 6].map((h) => [String(h), pathCounts(retained, h)]),
      ),
      unknown_fail_open_rows: unknown.length,
      no_known_resistance_fail_open_rows: noKnown.length,
      measured_rows_retained_at_or_above_cut: rows.filter(
        (r) =>
          r.resistance_category === "measured" &&
          r.nearest_resistance_room_pct >= cut,
      ).length,
    };
  }
  return {
    fires: rows.length,
    frozen_status_counts: countsByStatus(rows),
    structure_coverage: {
      measured_room_rows: measured.length,
      no_known_resistance_rows: noKnown.length,
      unknown_fail_open_rows: unknown.length,
      valid_gap_free_histories: rows.filter((r) => r.history_available).length,
      captured_structure_rows: rows.filter(
        (r) => r.feature_captured_in_snapshot,
      ).length,
      historical_reconstruction_rows: rows.filter(
        (r) => r.history_available,
      ).length,
      reconstruction_unknown_rows: unknown.length,
      measured_denominator: measured.length,
      full_denominator: rows.length,
    },
    forward_windows: Object.fromEntries(
      [1, 3, 6].map((h) => [String(h), pathCounts(rows, h)]),
    ),
    thresholds,
  };
}

function summariesByPeriod(rows) {
  const groups = {
    full_188: rows,
    early_before_2026_09_20_utc: rows.filter(
      (r) => Date.parse(r.detected_at_utc) < LATE_CUTOFF,
    ),
    late_from_2026_09_20_utc: rows.filter(
      (r) => Date.parse(r.detected_at_utc) >= LATE_CUTOFF,
    ),
    single_entry_v1: rows.filter((r) => r.single_entry_v1),
  };
  return Object.fromEntries(
    Object.entries(groups).map(([name, subset]) => [name, summarize(subset)]),
  );
}

function renderMarkdown(report) {
  const full = report.groups.full_188;
  const lines = [
    "# Impulse Buy overhead-resistance analysis — 2026-10-01",
    "",
    `Frozen cohort: ${report.cohort.rows} canonical fires; captured ${report.cohort.capture_asof_utc}. Frozen status values were used; no cohort refresh.`,
    "",
    `Structure coverage: measured room ${full.structure_coverage.measured_room_rows}/${full.fires}; no known overhead resistance ${full.structure_coverage.no_known_resistance_rows}; unknown/fail-open ${full.structure_coverage.unknown_fail_open_rows}; gap-free sufficient histories ${full.structure_coverage.valid_gap_free_histories}. Captured structure values ${report.provenance.captured_structure_rows}; all measurable structure is historical reconstruction.`,
    "",
    `Frozen statuses: ${Object.entries(full.frozen_status_counts).map(([s, n]) => `${s}=${n}`).join("; ")}.`,
    "",
    `Entry basis provenance: original_entry_price ${report.entry_basis.original_entry_price_rows}; entry_price fallback ${report.entry_basis.entry_price_fallback_rows}; unavailable ${report.entry_basis.unavailable_rows}.`,
    "",
    "## Fixed room cuts and exact frozen statuses",
    "",
    "Removal requires a measured nearest intact overhead level with room strictly below the stated cut. Unknown histories and the distinct no-known-resistance category fail open. Denominators show measured feature rows and the full segment. Exact statuses are frozen labels, not inferred executions.",
    "",
    "| Segment | N | Measured | Cut | Removed / measured | Removed / full | stop_loss | bu_stop | profit | cancelled | expired | reclassified | active | Retained stop_loss / bu_stop / profit / cancelled / expired / reclassified / active |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|",
  ];
  for (const [name, group] of Object.entries(report.groups)) {
    for (const cut of CUTS) {
      const result = group.thresholds[String(cut)];
      const removed = result.removed_status_counts;
      const retained = result.retained_status_counts;
      lines.push(
        `| ${name} | ${group.fires} | ${group.structure_coverage.measured_room_rows} | <${cut}% | ${result.removed_rows}/${result.removed_measured_denominator} | ${result.removed_rows}/${result.removed_full_group_denominator} | ${removed.stop_loss} | ${removed.bu_stop} | ${removed.profit} | ${removed.cancelled} | ${removed.expired} | ${removed.reclassified} | ${removed.active} | ${retained.stop_loss}/${retained.bu_stop}/${retained.profit}/${retained.cancelled}/${retained.expired}/${retained.reclassified}/${retained.active} |`,
      );
    }
  }
  lines.push(
    "",
    "## Frozen +5/+10 path outcomes by horizon",
    "",
    "Windows are counted only when frozen mature flag position 0 and gap-free coverage flag position 9 are both true. Peak highs and strict first-hit +5/+10 flags describe observed candle paths, not realized wins or executions.",
    "",
    "| Horizon | Complete rows / 188 | Peak high ≥+5 | Peak high ≥+10 | Strict +5 flags | Strict +10 flags |",
    "|---:|---:|---:|---:|---:|---:|",
  );
  for (const h of [1, 3, 6]) {
    const x = full.forward_windows[String(h)];
    lines.push(
      `| ${h}h | ${x.mature_and_gap_free}/${x.cohort_rows} | ${x.peak_high_at_least_5} | ${x.peak_high_at_least_10} | ${x.plus5_path_hits} | ${x.plus10_path_hits} |`,
    );
  }
  lines.push(
    "",
    "## Definition, coverage, and evidence boundary",
    "",
    "Structure uses the last 168 closed 1h bars before detected_at, plus two older closed bars for left pivot context; all 170 required bars must be valid and gap-free. Swing highs must be strictly greater than each of two highs to the left and two to the right; ties are not pivots. The pivot is usable only after the second right bar closes. A later closed 1h close strictly above the pivot invalidates it; a wick alone does not. Select the nearest intact pivot strictly above original_entry_price, otherwise the frozen entry_price fallback. Room is ((level / basis) - 1) × 100. Valid history without an intact overhead pivot is no-known-resistance, not infinite upside.",
    "",
    "No captured live overhead-room value exists in the frozen input. All structure feature values are historical reconstructions from exact-symbol BingX swap 1h OHLC. Every used candle close and pivot confirmation is checked at or before detected_at; future bars, tracker peaks, and forward bars are not feature inputs. No instrument or exchange substitution is permitted; missing, delisted, or gapped history is unknown and fails open.",
    "",
    `Acquisition: ${report.acquisition.symbolDateGroups} unique BingX symbol/UTC-date groups; ${report.acquisition.localCachedGroupsReused} usable exact-symbol local 1h cache group(s); ${report.acquisition.publicRequestsAttempted} public request attempts; ${report.acquisition.publicFetchSuccesses} successful; ${report.acquisition.failedGroups} failed; ${report.acquisition.notAttemptedGroups} not attempted.`,
    "",
    "No thresholds were tuned. This is an observational fixed-cohort sensitivity, not evidence of exchange execution, prospective validated improvement, or an optimal gate. Early/late date split is pre-2026-09-20 UTC versus inclusive 2026-09-20 UTC onward. single_entry_v1 is a separate exact policy-version sensitivity.",
    "",
    "## Reproducibility files",
    "",
    ...Object.values(FILES).map((path) => `- ${path}`),
    `- ${DIR}/ib-entry-structure-analysis-2026-10-01.mjs`,
    "",
  );
  return `${lines.join("\n")}\n`;
}

export async function run({ fetchMissing = false } = {}) {
  await mkdir(abs(DIR), { recursive: true });
  const { cohort, metadata } = await loadFrozen();
  const acquisitions = await acquire(cohort.rows, fetchMissing);
  const rows = cohort.rows.map((row) =>
    enrichRow(
      row,
      acquisitions.rowAcquisitions.get(String(row.id)),
    ),
  );
  const currentStatusCounts = countsByStatus(rows);
  for (const [status, count] of Object.entries(metadata.status_counts)) {
    if (currentStatusCounts[status] !== count) {
      throw new Error(`Frozen status check failed for ${status}`);
    }
  }
  const groups = summariesByPeriod(rows);
  const report = {
    report: "Impulse Buy overhead-resistance analysis",
    date_utc: "2026-10-01",
    read_only: true,
    cohort: {
      source: COHORT_SOURCE,
      metadata_source: META_SOURCE,
      rows: rows.length,
      capture_asof_utc: metadata.capture_asof_utc,
      environment: metadata.environment,
      frozen_status_counts: metadata.status_counts,
      cohort_refreshed: false,
    },
    entry_basis: {
      original_entry_price_rows: rows.filter(
        (r) => r.entry_basis_provenance === "original_entry_price",
      ).length,
      entry_price_fallback_rows: rows.filter(
        (r) => r.entry_basis_provenance === "entry_price_fallback",
      ).length,
      unavailable_rows: rows.filter((r) => r.entry_basis === null).length,
    },
    provenance: {
      feature: "nearest intact overhead swing high room at frozen entry basis",
      captured_structure_rows: 0,
      reconstructed_rows: rows.filter((r) => r.history_available).length,
      reconstruction_unknown_rows: rows.filter(
        (r) => r.resistance_category === "unknown",
      ).length,
      reconstruction_source: "pre-entry public BingX swap 1h candles, exact frozen symbol",
      cuts_pct: CUTS,
      late_cutoff_utc: "2026-09-20T00:00:00.000Z",
      thresholds_tuned: false,
      missing_histories_fail_open: true,
    },
    acquisition: acquisitions.summary,
    groups,
    rows,
    caveats: [
      "Frozen statuses are from the 2026-10-01 capture; none were refreshed.",
      "Structure values are reconstructed and were not recorded live entry values.",
      "No exchange execution or prospective validated improvement is claimed.",
      "Forward peak and threshold-hit metrics are price paths, not realized outcomes.",
      "No known overhead level is distinct from unknown and is not guaranteed upside.",
    ],
  };
  const columns = Object.keys(rows[0]);
  await writeFile(abs(FILES.rows), makeCsv(rows, columns));
  await writeFile(abs(FILES.json), `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(abs(FILES.markdown), renderMarkdown(report));
  console.log(
    JSON.stringify(
      {
        cohort_rows: rows.length,
        status_counts: groups.full_188.frozen_status_counts,
        structure_coverage: groups.full_188.structure_coverage,
        cuts: groups.full_188.thresholds,
        period_segments: Object.fromEntries(
          Object.entries(groups).map(([name, group]) => [
            name,
            {
              fires: group.fires,
              measured: group.structure_coverage.measured_room_rows,
              unknown: group.structure_coverage.unknown_fail_open_rows,
              no_known_resistance:
                group.structure_coverage.no_known_resistance_rows,
            },
          ]),
        ),
        acquisition: acquisitions.summary,
        files: FILES,
      },
      null,
      2,
    ),
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  run({ fetchMissing: process.argv.includes("--fetch") }).catch((error) => {
    console.error(error.stack ?? error.message);
    process.exitCode = 1;
  });
}