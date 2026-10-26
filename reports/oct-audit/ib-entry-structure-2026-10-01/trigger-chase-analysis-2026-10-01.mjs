/**
 * Read-only Impulse Buy trigger-delay / price-chase replay.
 *
 * Inputs are frozen cohort/status/path files plus read-only linked immutable
 * snapshot fields and exact pre-entry BingX 30m trigger bars. Missing feature
 * values fail open. This script makes no database or application changes.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const OUT_DIR = ".local/reports/ib-entry-structure-2026-10-01";
const INPUT_COHORT =
  `${OUT_DIR}/trigger-chase-frozen-cohort-2026-10-01.json`;
const INPUT_METADATA =
  `${OUT_DIR}/trigger-chase-frozen-metadata-2026-10-01.json`;
const INPUT_WINDOWS =
  `${OUT_DIR}/trigger-chase-frozen-horizon-windows-2026-10-01.csv`;
const INPUT_SNAPSHOT =
  `${OUT_DIR}/trigger-chase-retrieved-immutable-snapshot-metrics-2026-10-01.json`;
const INPUT_BARS =
  `${OUT_DIR}/trigger-chase-bingx-public-exact-30m-bars-2026-10-01.json`;
const OUTPUT_JSON =
  `${OUT_DIR}/trigger-chase-report-2026-10-01.json`;
const OUTPUT_MD =
  `${OUT_DIR}/trigger-chase-report-2026-10-01.md`;
const OUTPUT_ROWS =
  `${OUT_DIR}/trigger-chase-row-audit-2026-10-01.csv`;
const OUTPUT_CUTS =
  `${OUT_DIR}/trigger-chase-threshold-status-2026-10-01.csv`;
const OUTPUT_SENSITIVITY =
  `${OUT_DIR}/trigger-chase-period-policy-sensitivity-2026-10-01.csv`;

const EXPECTED_COHORT_ROWS = 188;
const CAPTURE_ASOF = "2026-10-01T06:02:27.412957+00:00";
const PERIOD_SPLIT_AT = "2026-09-20T00:00:00.000Z";
const WINDOW_HOURS = [1, 3, 6];
const STATUSES = [
  "stop_loss",
  "bu_stop",
  "profit",
  "cancelled",
  "expired",
  "reclassified",
  "active",
];
const FIXED_CUTS = [
  { feature: "trigger_delay_minutes", cut: 5, label: "delay_gt_5m" },
  { feature: "trigger_delay_minutes", cut: 15, label: "delay_gt_15m" },
  { feature: "trigger_delay_minutes", cut: 30, label: "delay_gt_30m" },
  { feature: "price_chase_pct", cut: 1, label: "chase_gt_1pct" },
  { feature: "price_chase_pct", cut: 2, label: "chase_gt_2pct" },
  { feature: "price_chase_pct", cut: 3, label: "chase_gt_3pct" },
];

function finiteNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function positiveNumber(value) {
  const number = finiteNumber(value);
  return number !== null && number > 0 ? number : null;
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      row.push(cell);
      cell = "";
    } else if (char === "\n") {
      row.push(cell.replace(/\r$/, ""));
      if (row.some((value) => value !== "")) rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }
  if (quoted) throw new Error("Unclosed quoted CSV value");
  if (cell !== "" || row.length > 0) {
    row.push(cell.replace(/\r$/, ""));
    if (row.some((value) => value !== "")) rows.push(row);
  }
  if (rows.length === 0) return [];
  const headers = rows[0];
  return rows.slice(1).map((values) =>
    Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""])),
  );
}

function csvCell(value) {
  if (value === null || value === undefined) return "";
  const text =
    typeof value === "object" ? JSON.stringify(value) : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function writeCsv(rows, columns) {
  return [
    columns.join(","),
    ...rows.map((row) => columns.map((key) => csvCell(row[key])).join(",")),
  ].join("\n") + "\n";
}

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function quantile(values, fraction) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = (sorted.length - 1) * fraction;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  return lower === upper
    ? sorted[lower]
    : sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

function distribution(values) {
  if (values.length === 0) {
    return {
      n: 0,
      min: null,
      p25: null,
      median: null,
      p75: null,
      max: null,
      mean: null,
    };
  }
  return {
    n: values.length,
    min: Math.min(...values),
    p25: quantile(values, 0.25),
    median: median(values),
    p75: quantile(values, 0.75),
    max: Math.max(...values),
    mean: values.reduce((sum, value) => sum + value, 0) / values.length,
  };
}

function countByStatus(rows) {
  const counts = Object.fromEntries(STATUSES.map((status) => [status, 0]));
  for (const row of rows) {
    if (Object.hasOwn(counts, row.status)) counts[row.status] += 1;
  }
  return counts;
}

function percent(count, denominator) {
  return denominator > 0 ? (count / denominator) * 100 : null;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function compareNumbers(left, right, label) {
  if (left === null || right === null) {
    assert(left === right, `${label}: one side is missing`);
    return;
  }
  assert(
    Math.abs(left - right) <= 0.00001,
    `${label}: ${left} differs from ${right}`,
  );
}

async function loadJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function makeWindowJoin(cohortRows, windowCsvRows) {
  const rowMap = new Map();
  for (const raw of windowCsvRows) {
    const key = `${raw.id}:${raw.horizon_hours}`;
    assert(!rowMap.has(key), `Duplicate frozen window row ${key}`);
    rowMap.set(key, raw);
  }
  const joined = new Map();
  for (const cohortRow of cohortRows) {
    const horizons = {};
    for (const hour of WINDOW_HOURS) {
      const array = cohortRow.windows?.[String(hour)];
      const csv = rowMap.get(`${cohortRow.id}:${hour}`);
      assert(Array.isArray(array), `Missing frozen JSON window ${cohortRow.id}/${hour}`);
      assert(csv, `Missing frozen CSV window ${cohortRow.id}/${hour}`);
      assert(csv.status === cohortRow.status, `Frozen status mismatch ${cohortRow.id}/${hour}`);
      assert(
        (csv.mature_at_capture === "true") === (array[0] === true),
        `Maturity flag index 0 mismatch ${cohortRow.id}/${hour}`,
      );
      assert(
        (csv.coverage_complete === "true") === (array[9] === true),
        `Coverage flag index 9 mismatch ${cohortRow.id}/${hour}`,
      );
      const strictCoverage = array[0] === true && array[9] === true;
      const peak = finiteNumber(csv.max_high_pct);
      compareNumbers(peak, finiteNumber(array[10]), `peak ${cohortRow.id}/${hour}`);
      const plus5 = array[13] !== null && array[13] !== undefined;
      const plus10 = array[14] !== null && array[14] !== undefined;
      assert(
        plus5 === Boolean(csv.first_plus5_open_at_utc),
        `+5 flag mismatch ${cohortRow.id}/${hour}`,
      );
      assert(
        plus10 === Boolean(csv.first_plus10_open_at_utc),
        `+10 flag mismatch ${cohortRow.id}/${hour}`,
      );
      horizons[hour] = {
        horizonHours: hour,
        matureAtCapture: array[0],
        coverageComplete: array[9],
        strictCoverage,
        peakMaxPct: peak,
        minLowPct: finiteNumber(csv.min_low_pct),
        endpointClosePct: finiteNumber(csv.endpoint_close_pct),
        firstPlus5OpenAtUtc: csv.first_plus5_open_at_utc || null,
        firstPlus5CloseAtUtc: csv.first_plus5_close_at_utc || null,
        firstPlus10OpenAtUtc: csv.first_plus10_open_at_utc || null,
        firstPlus10CloseAtUtc: csv.first_plus10_close_at_utc || null,
        plus5Observed: plus5,
        plus10Observed: plus10,
        sameBarTargetStopAmbiguous: csv.same_bar_target_stop_ambiguous === "true",
        expectedBars: finiteNumber(csv.expected_bar_count),
        validBuckets: finiteNumber(csv.valid_bucket_count),
        invalidBars: finiteNumber(csv.invalid_bar_count),
        duplicateBars: finiteNumber(csv.duplicate_bar_count),
      };
    }
    joined.set(cohortRow.id, horizons);
  }
  assert(
    rowMap.size === cohortRows.length * 6,
    `Expected ${cohortRows.length * 6} frozen all-horizon rows, found ${rowMap.size}`,
  );
  return joined;
}

function summarizePath(rows, windowsById) {
  return WINDOW_HOURS.map((hour) => {
    const covered = rows
      .map((row) => windowsById.get(row.id)[hour])
      .filter((window) => window.strictCoverage);
    const peaks = covered
      .map((window) => window.peakMaxPct)
      .filter((value) => value !== null);
    const plus5 = covered.filter((window) => window.plus5Observed).length;
    const plus10 = covered.filter((window) => window.plus10Observed).length;
    const n = covered.length;
    return {
      horizonHours: hour,
      cohortRows: rows.length,
      strictCoverageRows: n,
      notStrictlyCoveredRows: rows.length - n,
      peakObservedRows: peaks.length,
      peakMedianPct: median(peaks),
      peakMaxPct: peaks.length ? Math.max(...peaks) : null,
      plus5Rows: plus5,
      plus5RateStrictPct: percent(plus5, n),
      plus10Rows: plus10,
      plus10RateStrictPct: percent(plus10, n),
      sameBarAmbiguousRows: covered.filter(
        (window) => window.sameBarTargetStopAmbiguous,
      ).length,
    };
  });
}

function summarizePathByStatus(rows, windowsById) {
  return Object.fromEntries(
    STATUSES.map((status) => {
      const statusRows = rows.filter((row) => row.status === status);
      return [
        status,
        {
          status,
          rows: statusRows.length,
          byHorizon: summarizePath(statusRows, windowsById),
        },
      ];
    }),
  );
}

function cutOutcome(rows, feature, cut, windowsById) {
  const valueKey =
    feature === "trigger_delay_minutes" ? "triggerDelayMinutes" : "priceChasePct";
  const measured = rows.filter((row) => row[valueKey] !== null);
  const removed = measured.filter((row) => row[valueKey] > cut);
  const removedIds = new Set(removed.map((row) => row.id));
  const retained = rows.filter((row) => !removedIds.has(row.id));
  const fullStatus = countByStatus(rows);
  const measuredStatus = countByStatus(measured);
  const removedStatus = countByStatus(removed);
  const retainedStatus = countByStatus(retained);
  const byStatus = Object.fromEntries(
    STATUSES.map((status) => {
      const removedCount = removedStatus[status];
      const knownCount = measuredStatus[status];
      const fullCount = fullStatus[status];
      return [
        status,
        {
          fullStatusRows: fullCount,
          measuredStatusRows: knownCount,
          removedRows: removedCount,
          retainedRows: retainedStatus[status],
          removedOfMeasuredStatusPct: percent(removedCount, knownCount),
          removedOfFullStatusPct: percent(removedCount, fullCount),
          removedOfMeasuredCohortPct: percent(removedCount, measured.length),
          removedOfFullCohortPct: percent(removedCount, rows.length),
        },
      ];
    }),
  );
  return {
    feature,
    fixedCutStrictlyGreaterThan: cut,
    featureMeasuredRows: measured.length,
    featureUnknownRows: rows.length - measured.length,
    fullCohortRows: rows.length,
    removedRowsKnownOnly: removed.length,
    removedRowsAsFullCohort: removed.length,
    retainedRowsIncludingFailOpenUnknown: retained.length,
    failOpenUnknownsRetained: rows.length - measured.length,
    removedStatusCounts: removedStatus,
    retainedStatusCounts: retainedStatus,
    measuredStatusCounts: measuredStatus,
    statusRows: byStatus,
    removedRows: removed,
    retainedRows: retained,
    removedOutcomesByHorizon: summarizePath(removed, windowsById),
    retainedOutcomesByHorizon: summarizePath(retained, windowsById),
    removedOutcomesByStatus: summarizePathByStatus(removed, windowsById),
    retainedOutcomesByStatus: summarizePathByStatus(retained, windowsById),
  };
}

function statusOnlyCut(cut, periodName, rows, feature, windowsById) {
  const result = cutOutcome(rows, feature, cut, windowsById);
  return {
    periodOrPolicy: periodName,
    feature,
    cut,
    fullRows: rows.length,
    measuredRows: result.featureMeasuredRows,
    unknownFailOpenRows: result.featureUnknownRows,
    removedRows: result.removedRowsKnownOnly,
    retainedRows: result.retainedRowsIncludingFailOpenUnknown,
    removedStatusCounts: result.removedStatusCounts,
    retainedStatusCounts: result.retainedStatusCounts,
    retainedPathOutcomesByHorizon: result.retainedOutcomesByHorizon,
    removedPathOutcomesByStatus: result.removedOutcomesByStatus,
    retainedPathOutcomesByStatus: result.retainedOutcomesByStatus,
  };
}

function markdownTable(headers, rows) {
  return [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.map((value) => String(value ?? "—")).join(" | ")} |`),
  ].join("\n");
}

function pctCount(count, denominator) {
  return `${count}/${denominator}${denominator ? ` (${percent(count, denominator).toFixed(1)}%)` : ""}`;
}

function statusText(counts) {
  return STATUSES.map((status) => `${status} ${counts[status]}`).join("; ");
}

function pathText(path) {
  return path
    .map((item) => {
      const label = `${item.horizonHours}h`;
      return `${label}: peak median ${item.peakMedianPct === null ? "n/a" : `${item.peakMedianPct.toFixed(2)}%`}, +5 ${pctCount(item.plus5Rows, item.strictCoverageRows)}, +10 ${pctCount(item.plus10Rows, item.strictCoverageRows)}; strict n=${item.strictCoverageRows}`;
    })
    .join(" | ");
}

async function main() {
  const [frozen, frozenMetadata, snapshotPayload, barsPayload, windowsText] =
    await Promise.all([
      loadJson(INPUT_COHORT),
      loadJson(INPUT_METADATA),
      loadJson(INPUT_SNAPSHOT),
      loadJson(INPUT_BARS),
      readFile(INPUT_WINDOWS, "utf8"),
    ]);
  const rows = frozen.rows;
  assert(rows.length === EXPECTED_COHORT_ROWS, `Expected 188 rows, found ${rows.length}`);
  assert(
    frozenMetadata.capture_asof_utc === CAPTURE_ASOF,
    `Unexpected frozen cohort capture: ${frozenMetadata.capture_asof_utc}`,
  );
  assert(frozenMetadata.cohort_rows === EXPECTED_COHORT_ROWS, "Frozen metadata row count differs");
  assert(
    snapshotPayload.row_count === EXPECTED_COHORT_ROWS &&
      snapshotPayload.rows.length === EXPECTED_COHORT_ROWS,
    "Immutable snapshot lookup must match all 188 frozen ids",
  );
  assert(barsPayload.uses_private_endpoint === false, "Public-only BingX candle source required");

  const cohortById = new Map();
  for (const row of rows) {
    assert(!cohortById.has(row.id), `Duplicate frozen tracker id ${row.id}`);
    cohortById.set(row.id, row);
  }
  const snapshotById = new Map();
  for (const snapshot of snapshotPayload.rows) {
    assert(!snapshotById.has(snapshot.tracked_signal_id), `Duplicate DB snapshot for ${snapshot.tracked_signal_id}`);
    const frozenRow = cohortById.get(snapshot.tracked_signal_id);
    assert(frozenRow, `Snapshot references non-cohort tracker ${snapshot.tracked_signal_id}`);
    assert(
      snapshot.decision_snapshot_id === frozenRow.decision_snapshot_id &&
        snapshot.symbol === frozenRow.symbol,
      `Snapshot ID/symbol mismatch for tracker ${snapshot.tracked_signal_id}`,
    );
    assert(
      Date.parse(snapshot.decision_at_utc) === Date.parse(frozenRow.detected_at_utc),
      `Snapshot decision time mismatch for tracker ${snapshot.tracked_signal_id}`,
    );
    assert(
      (snapshot.trigger_candle_closed_at ?? null) ===
        (frozenRow.trigger_candle_closed_at ?? null),
      `Trigger timestamp in frozen export differs from immutable linked snapshot for ${snapshot.tracked_signal_id}`,
    );
    snapshotById.set(snapshot.tracked_signal_id, snapshot);
  }
  assert(snapshotById.size === EXPECTED_COHORT_ROWS, "Snapshot row count is not 188");

  const windowCsvRows = parseCsv(windowsText);
  const windowsById = makeWindowJoin(rows, windowCsvRows);
  const barsByKey = new Map();
  for (const result of barsPayload.results) {
    const key = `${result.symbol}|${Date.parse(result.closed_at_utc)}`;
    assert(!barsByKey.has(key), `Duplicate exact BingX bar request ${key}`);
    barsByKey.set(key, result);
  }

  const joinedRows = rows.map((row) => {
    const snapshot = snapshotById.get(row.id);
    const closedAtMs = row.trigger_candle_closed_at
      ? Date.parse(row.trigger_candle_closed_at)
      : null;
    const detectedAtMs = Date.parse(row.detected_at_utc);
    const delayKnown =
      closedAtMs !== null &&
      Number.isFinite(closedAtMs) &&
      Number.isFinite(detectedAtMs) &&
      snapshot.trigger_candle_closed_at === row.trigger_candle_closed_at;
    const triggerDelayMinutes = delayKnown
      ? (detectedAtMs - closedAtMs) / 60_000
      : null;
    if (delayKnown) {
      assert(triggerDelayMinutes >= 0, `Trigger close is after detection for ${row.id}`);
    }

    const barResult =
      closedAtMs === null ? null : barsByKey.get(`${row.symbol}|${closedAtMs}`);
    let triggerBar = null;
    let triggerBarExact = false;
    if (barResult && !barResult.error && barResult.http_status === 200) {
      assert(barResult.symbol === row.symbol, `BingX instrument mismatch for ${row.id}`);
      assert(barResult.interval === "30m", `BingX interval mismatch for ${row.id}`);
      assert(barResult.candles?.length === 1, `Expected exactly one bar for ${row.id}`);
      const raw = barResult.candles[0];
      const time = finiteNumber(raw.time);
      const open = positiveNumber(raw.open);
      const high = positiveNumber(raw.high);
      const low = positiveNumber(raw.low);
      const close = positiveNumber(raw.close);
      triggerBar = { time, open, high, low, close };
      triggerBarExact =
        time === closedAtMs - 30 * 60_000 &&
        time + 30 * 60_000 === closedAtMs &&
        open !== null &&
        high !== null &&
        low !== null &&
        close !== null &&
        high >= Math.max(open, close) &&
        low <= Math.min(open, close) &&
        low <= high;
      if (triggerBarExact) {
        assert(
          closedAtMs <= detectedAtMs,
          `Exact 30m anchor candle closes after detection for ${row.id}`,
        );
      }
    }

    const basisPrice = positiveNumber(row.basis_entry_price);
    const priceChasePct =
      delayKnown && triggerBarExact && basisPrice !== null
        ? ((basisPrice / triggerBar.close) - 1) * 100
        : null;
    const policyVersion = row.entry_policy_version ?? null;
    const detectedBeforeSplit = detectedAtMs < Date.parse(PERIOD_SPLIT_AT);
    return {
      ...row,
      entryBasisPrice: basisPrice,
      entryBasisSource: row.basis_price_source,
      triggerTimestampCaptured: delayKnown,
      triggerDelayMinutes,
      triggerCloseCapturedInSnapshot: false,
      triggerBarReconstructed: triggerBarExact,
      triggerBarSource: triggerBarExact ? "bingx_public_swap_historical_30m" : null,
      triggerBarOpenAtUtc: triggerBarExact ? new Date(triggerBar.time).toISOString() : null,
      triggerBarClosedAtUtc: triggerBarExact ? new Date(closedAtMs).toISOString() : null,
      triggerBarOpen: triggerBarExact ? triggerBar.open : null,
      triggerBarHigh: triggerBarExact ? triggerBar.high : null,
      triggerBarLow: triggerBarExact ? triggerBar.low : null,
      triggerClosePrice: triggerBarExact ? triggerBar.close : null,
      triggerBarIsPreEntryClosedBar:
        triggerBarExact && closedAtMs <= detectedAtMs,
      priceChasePct,
      priceChaseMeasured: priceChasePct !== null,
      triggerPriceBasisFormula:
        "((frozen_basis_entry_price / exact_trigger_candle_close) - 1) * 100",
      entryPriceSource: row.basis_price_source,
      entryPolicyVersion: policyVersion,
      policySensitivityGroup:
        policyVersion === "single_entry_v1" ? "single_entry_v1" : "not_single_entry_v1_or_unknown",
      dateSensitivityGroup: detectedBeforeSplit
        ? "before_2026-09-20_utc"
        : "on_or_after_2026-09-20_utc",
      snapshotCapture: snapshot.provenance_capture,
      snapshotDecisionMetricsCapture: snapshot.decision_metrics_capture,
      snapshotMetricLegacy: snapshot.legacy === "true",
      snapshotHasAnyRawCandleCloseCandidate:
        Object.keys(snapshot.top_level_close_candidates ?? {}).length > 0 ||
        Object.keys(snapshot.decision_metrics_close_candidates ?? {}).length > 0 ||
        Object.keys(snapshot.impulse_metrics_close_candidates ?? {}).length > 0,
      windows: windowsById.get(row.id),
    };
  });

  const allStatusCounts = countByStatus(joinedRows);
  assert(
    Object.values(allStatusCounts).reduce((sum, count) => sum + count, 0) ===
      EXPECTED_COHORT_ROWS,
    "Frozen final statuses do not sum to the full cohort",
  );
  const frozenStatusCounts = frozenMetadata.status_counts;
  for (const status of STATUSES) {
    assert(
      allStatusCounts[status] === frozenStatusCounts[status],
      `Frozen status count changed for ${status}`,
    );
  }

  const delayMeasured = joinedRows.filter(
    (row) => row.triggerDelayMinutes !== null,
  );
  const chaseMeasured = joinedRows.filter((row) => row.priceChasePct !== null);
  const originalBasisRows = joinedRows.filter(
    (row) => row.entryBasisSource === "original_entry_price",
  );
  const fallbackBasisRows = joinedRows.filter(
    (row) => row.entryBasisSource === "entry_price_fallback",
  );
  const noBasisRows = joinedRows.filter(
    (row) => row.entryBasisSource === "unavailable",
  );
  const snapshotCloseCapturedRows = joinedRows.filter(
    (row) => row.snapshotHasAnyRawCandleCloseCandidate,
  );
  const exactTimestampRows = joinedRows.filter(
    (row) => row.triggerTimestampCaptured,
  );
  const exactBars = joinedRows.filter((row) => row.triggerBarReconstructed);
  assert(delayMeasured.length === 61, `Expected 61 captured trigger times, found ${delayMeasured.length}`);
  assert(exactTimestampRows.length === 61, `Expected 61 immutable timestamp matches, found ${exactTimestampRows.length}`);
  assert(exactBars.length === 61, `Expected 61 exact BingX 30m bars, found ${exactBars.length}`);
  assert(chaseMeasured.length === 61, `Expected 61 exact price-chase measurements, found ${chaseMeasured.length}`);

  const featureDistribution = {
    triggerDelayMinutes: distribution(
      delayMeasured.map((row) => row.triggerDelayMinutes),
    ),
    priceChasePct: distribution(chaseMeasured.map((row) => row.priceChasePct)),
  };
  const delayCutCounts = Object.fromEntries(
    [5, 15, 30].map((cut) => [
      String(cut),
      delayMeasured.filter((row) => row.triggerDelayMinutes > cut).length,
    ]),
  );
  assert(delayCutCounts["5"] === 60, `Expected >5m delay count 60/61, got ${delayCutCounts["5"]}`);
  assert(delayCutCounts["15"] === 1, `Expected >15m delay count 1/61, got ${delayCutCounts["15"]}`);
  assert(delayCutCounts["30"] === 0, `Expected >30m delay count 0/61, got ${delayCutCounts["30"]}`);

  const cutResults = FIXED_CUTS.map((cut) =>
    cutOutcome(
      joinedRows,
      cut.feature,
      cut.cut,
      windowsById,
    ),
  );
  for (let index = 0; index < cutResults.length; index += 1) {
    cutResults[index].label = FIXED_CUTS[index].label;
  }
  const overallPath = summarizePath(joinedRows, windowsById);

  const preSplitRows = joinedRows.filter(
    (row) => row.dateSensitivityGroup === "before_2026-09-20_utc",
  );
  const postSplitRows = joinedRows.filter(
    (row) => row.dateSensitivityGroup === "on_or_after_2026-09-20_utc",
  );
  const periodSensitivity = [];
  for (const [periodName, periodRows] of [
    ["before_2026-09-20_utc", preSplitRows],
    ["on_or_after_2026-09-20_utc", postSplitRows],
  ]) {
    for (const cut of FIXED_CUTS) {
      periodSensitivity.push(
        statusOnlyCut(
          cut.cut,
          periodName,
          periodRows,
          cut.feature,
          windowsById,
        ),
      );
    }
  }

  const singleEntryRows = joinedRows.filter(
    (row) => row.entryPolicyVersion === "single_entry_v1",
  );
  const singleEntrySensitivity = FIXED_CUTS.map((cut) =>
    statusOnlyCut(
      cut.cut,
      "entry_policy_version_single_entry_v1",
      singleEntryRows,
      cut.feature,
      windowsById,
    ),
  );
  const entryPolicyVersionCounts = {};
  const exitPolicyVersionCounts = {};
  for (const row of joinedRows) {
    const entryVersion = row.entry_policy_version ?? "<NULL>";
    const exitVersion = row.exit_policy_version ?? "<NULL>";
    entryPolicyVersionCounts[entryVersion] =
      (entryPolicyVersionCounts[entryVersion] ?? 0) + 1;
    exitPolicyVersionCounts[exitVersion] =
      (exitPolicyVersionCounts[exitVersion] ?? 0) + 1;
  }

  const sensitivityCsvRows = [];
  for (const item of [...periodSensitivity, ...singleEntrySensitivity]) {
    for (const status of STATUSES) {
      sensitivityCsvRows.push({
        period_or_policy: item.periodOrPolicy,
        feature: item.feature,
        strict_cut: item.cut,
        full_rows: item.fullRows,
        measured_rows: item.measuredRows,
        unknown_fail_open_rows: item.unknownFailOpenRows,
        removed_rows: item.removedRows,
        retained_rows: item.retainedRows,
        status,
        removed_status_rows: item.removedStatusCounts[status],
        retained_status_rows: item.retainedStatusCounts[status],
        retained_1h_strict_n: item.retainedPathOutcomesByHorizon[0].strictCoverageRows,
        retained_1h_peak_median_pct: item.retainedPathOutcomesByHorizon[0].peakMedianPct,
        retained_1h_plus5_rows: item.retainedPathOutcomesByHorizon[0].plus5Rows,
        retained_1h_plus10_rows: item.retainedPathOutcomesByHorizon[0].plus10Rows,
        retained_3h_strict_n: item.retainedPathOutcomesByHorizon[1].strictCoverageRows,
        retained_3h_peak_median_pct: item.retainedPathOutcomesByHorizon[1].peakMedianPct,
        retained_3h_plus5_rows: item.retainedPathOutcomesByHorizon[1].plus5Rows,
        retained_3h_plus10_rows: item.retainedPathOutcomesByHorizon[1].plus10Rows,
        retained_6h_strict_n: item.retainedPathOutcomesByHorizon[2].strictCoverageRows,
        retained_6h_peak_median_pct: item.retainedPathOutcomesByHorizon[2].peakMedianPct,
        retained_6h_plus5_rows: item.retainedPathOutcomesByHorizon[2].plus5Rows,
        retained_6h_plus10_rows: item.retainedPathOutcomesByHorizon[2].plus10Rows,
        status_retained_1h_strict_n:
          item.retainedPathOutcomesByStatus[status].byHorizon[0].strictCoverageRows,
        status_retained_1h_peak_median_pct:
          item.retainedPathOutcomesByStatus[status].byHorizon[0].peakMedianPct,
        status_retained_1h_plus5_rows:
          item.retainedPathOutcomesByStatus[status].byHorizon[0].plus5Rows,
        status_retained_1h_plus10_rows:
          item.retainedPathOutcomesByStatus[status].byHorizon[0].plus10Rows,
        status_retained_3h_strict_n:
          item.retainedPathOutcomesByStatus[status].byHorizon[1].strictCoverageRows,
        status_retained_3h_peak_median_pct:
          item.retainedPathOutcomesByStatus[status].byHorizon[1].peakMedianPct,
        status_retained_3h_plus5_rows:
          item.retainedPathOutcomesByStatus[status].byHorizon[1].plus5Rows,
        status_retained_3h_plus10_rows:
          item.retainedPathOutcomesByStatus[status].byHorizon[1].plus10Rows,
        status_retained_6h_strict_n:
          item.retainedPathOutcomesByStatus[status].byHorizon[2].strictCoverageRows,
        status_retained_6h_peak_median_pct:
          item.retainedPathOutcomesByStatus[status].byHorizon[2].peakMedianPct,
        status_retained_6h_plus5_rows:
          item.retainedPathOutcomesByStatus[status].byHorizon[2].plus5Rows,
        status_retained_6h_plus10_rows:
          item.retainedPathOutcomesByStatus[status].byHorizon[2].plus10Rows,
      });
    }
  }

  const thresholdCsvRows = [];
  for (const result of cutResults) {
    for (const status of STATUSES) {
      const item = result.statusRows[status];
      thresholdCsvRows.push({
        cut_label: result.label,
        feature: result.feature,
        strictly_greater_than: result.fixedCutStrictlyGreaterThan,
        measured_n: result.featureMeasuredRows,
        full_cohort_n: result.fullCohortRows,
        unknown_fail_open_n: result.featureUnknownRows,
        removed_n: result.removedRowsKnownOnly,
        status,
        baseline_status_n_full: item.fullStatusRows,
        measured_status_n: item.measuredStatusRows,
        removed_status_n: item.removedRows,
        retained_status_n_full_fail_open: item.retainedRows,
        removed_of_measured_status_pct: item.removedOfMeasuredStatusPct,
        removed_of_full_status_pct: item.removedOfFullStatusPct,
        removed_share_of_measured_pct: item.removedOfMeasuredCohortPct,
        removed_share_of_full_cohort_pct: item.removedOfFullCohortPct,
        retained_1h_strict_n: result.retainedOutcomesByHorizon[0].strictCoverageRows,
        retained_1h_peak_median_pct: result.retainedOutcomesByHorizon[0].peakMedianPct,
        retained_1h_plus5_rows: result.retainedOutcomesByHorizon[0].plus5Rows,
        retained_1h_plus10_rows: result.retainedOutcomesByHorizon[0].plus10Rows,
        retained_3h_strict_n: result.retainedOutcomesByHorizon[1].strictCoverageRows,
        retained_3h_peak_median_pct: result.retainedOutcomesByHorizon[1].peakMedianPct,
        retained_3h_plus5_rows: result.retainedOutcomesByHorizon[1].plus5Rows,
        retained_3h_plus10_rows: result.retainedOutcomesByHorizon[1].plus10Rows,
        retained_6h_strict_n: result.retainedOutcomesByHorizon[2].strictCoverageRows,
        retained_6h_peak_median_pct: result.retainedOutcomesByHorizon[2].peakMedianPct,
        retained_6h_plus5_rows: result.retainedOutcomesByHorizon[2].plus5Rows,
        retained_6h_plus10_rows: result.retainedOutcomesByHorizon[2].plus10Rows,
        retained_status_1h_strict_n:
          result.retainedOutcomesByStatus[status].byHorizon[0].strictCoverageRows,
        retained_status_1h_peak_median_pct:
          result.retainedOutcomesByStatus[status].byHorizon[0].peakMedianPct,
        retained_status_1h_plus5_rows:
          result.retainedOutcomesByStatus[status].byHorizon[0].plus5Rows,
        retained_status_1h_plus10_rows:
          result.retainedOutcomesByStatus[status].byHorizon[0].plus10Rows,
        retained_status_3h_strict_n:
          result.retainedOutcomesByStatus[status].byHorizon[1].strictCoverageRows,
        retained_status_3h_peak_median_pct:
          result.retainedOutcomesByStatus[status].byHorizon[1].peakMedianPct,
        retained_status_3h_plus5_rows:
          result.retainedOutcomesByStatus[status].byHorizon[1].plus5Rows,
        retained_status_3h_plus10_rows:
          result.retainedOutcomesByStatus[status].byHorizon[1].plus10Rows,
        retained_status_6h_strict_n:
          result.retainedOutcomesByStatus[status].byHorizon[2].strictCoverageRows,
        retained_status_6h_peak_median_pct:
          result.retainedOutcomesByStatus[status].byHorizon[2].peakMedianPct,
        retained_status_6h_plus5_rows:
          result.retainedOutcomesByStatus[status].byHorizon[2].plus5Rows,
        retained_status_6h_plus10_rows:
          result.retainedOutcomesByStatus[status].byHorizon[2].plus10Rows,
      });
    }
  }

  const rowCsvRows = joinedRows.map((row) => {
    const output = {
      tracker_id: row.id,
      decision_snapshot_id: row.decision_snapshot_id,
      symbol: row.symbol,
      detected_at_utc: row.detected_at_utc,
      frozen_status: row.status,
      cancel_reason: row.cancel_reason,
      entry_policy_version: row.entryPolicyVersion,
      exit_policy_version: row.exit_policy_version,
      original_entry_price: row.original_entry_price,
      entry_price_fallback_value: row.entryBasisSource === "entry_price_fallback"
        ? row.current_entry_price
        : null,
      frozen_basis_entry_price: row.entryBasisPrice,
      basis_price_source: row.entryBasisSource,
      trigger_candle_closed_at_utc: row.trigger_candle_closed_at,
      trigger_timestamp_captured: row.triggerTimestampCaptured,
      trigger_delay_minutes: row.triggerDelayMinutes,
      trigger_close_captured_in_snapshot: row.triggerCloseCapturedInSnapshot,
      trigger_bar_source: row.triggerBarSource,
      trigger_bar_open_at_utc: row.triggerBarOpenAtUtc,
      trigger_bar_closed_at_utc: row.triggerBarClosedAtUtc,
      trigger_bar_open: row.triggerBarOpen,
      trigger_bar_high: row.triggerBarHigh,
      trigger_bar_low: row.triggerBarLow,
      exact_trigger_close: row.triggerClosePrice,
      price_chase_pct: row.priceChasePct,
      price_chase_measured: row.priceChaseMeasured,
      trigger_bar_is_pre_entry_closed_bar: row.triggerBarIsPreEntryClosedBar,
      snapshot_provenance_capture: row.snapshotCapture,
      snapshot_decision_metrics_capture: row.snapshotDecisionMetricsCapture,
      snapshot_metric_legacy: row.snapshotMetricLegacy,
      snapshot_has_any_raw_trigger_close_candidate: row.snapshotHasAnyRawCandleCloseCandidate,
      period_sensitivity_group: row.dateSensitivityGroup,
      single_entry_v1_sensitivity_group: row.policySensitivityGroup,
    };
    for (const hour of WINDOW_HOURS) {
      const window = row.windows[hour];
      output[`${hour}h_strict_covered`] = window.strictCoverage;
      output[`${hour}h_peak_max_pct`] = window.peakMaxPct;
      output[`${hour}h_plus5_open_at_utc`] = window.firstPlus5OpenAtUtc;
      output[`${hour}h_plus10_open_at_utc`] = window.firstPlus10OpenAtUtc;
    }
    return output;
  });

  const rowColumns = Object.keys(rowCsvRows[0]);
  const thresholdColumns = Object.keys(thresholdCsvRows[0]);
  const sensitivityColumns = Object.keys(sensitivityCsvRows[0]);

  const report = {
    title: "Impulse Buy trigger-close lateness and price-chase sensitivity",
    asOf: CAPTURE_ASOF,
    frozenCohort: {
      input: ".local/reports/ib-taker-volume-2026-10-01/cohort.json",
      metadataInput: ".local/reports/ib-taker-volume-2026-10-01/metadata.json",
      frozenCopiesInReportDirectory: [
        "trigger-chase-frozen-cohort-2026-10-01.json",
        "trigger-chase-frozen-metadata-2026-10-01.json",
        "trigger-chase-frozen-horizon-windows-2026-10-01.csv",
      ],
      captureAsOfUtc: frozenMetadata.capture_asof_utc,
      rows: rows.length,
      distinctTrackerIds: new Set(rows.map((row) => row.id)).size,
      distinctSnapshotIds: new Set(rows.map((row) => row.decision_snapshot_id)).size,
      statuses: allStatusCounts,
      priceBasisSourceCounts: {
        original_entry_price: originalBasisRows.length,
        entry_price_fallback: fallbackBasisRows.length,
        unavailable: noBasisRows.length,
      },
      statusAndBasisDataSource:
        "frozen cohort export only; no current status, cancellation, or entry value refreshed",
    },
    capturedVersusReconstructed: {
      capturedTriggerClosedAtRows: exactTimestampRows.length,
      capturedTriggerClosedAtUnknownRows: rows.length - exactTimestampRows.length,
      capturedCloseOhlcCandidateRowsInImmutableSnapshot:
        snapshotCloseCapturedRows.length,
      exactTriggerCloseBarsReconstructedFromBingX: exactBars.length,
      reconstructionSource: "public BingX swap historical kline endpoint; exact symbol and exact anchor time",
      rawBarInput:
        "trigger-chase-bingx-public-exact-30m-bars-2026-10-01.json",
      localCacheReview:
        "The existing local BingX acquisition artifacts in this report area are 1h bars; they cannot substitute for the exact 30m trigger candle and were not used for trigger-close reconstruction.",
      noPrivateEndpoint: true,
      entryPriceBasisSourceCountsAmongKnownPriceChaseRows: {
        original_entry_price: chaseMeasured.filter(
          (row) => row.entryBasisSource === "original_entry_price",
        ).length,
        entry_price_fallback: chaseMeasured.filter(
          (row) => row.entryBasisSource === "entry_price_fallback",
        ).length,
        unavailable: chaseMeasured.filter(
          (row) => row.entryBasisSource === "unavailable",
        ).length,
      },
      triggerCloseTimestampSemantics:
        "Code check: scanner.ts selects the latest 30m candle only when candle.time + 30 minutes <= scan time, then persists candleClosedAt = candle.time + 30 minutes (scanner.ts 7165-7168, 7585-7589). The saved timestamp is candle CLOSE time, not open time.",
      priceChaseDefinition:
        "((frozen_basis_entry_price / exact BingX 30m trigger candle close) - 1) * 100; original_entry_price is preferred, and frozen entry_price fallback is separately labeled",
      triggerDelayDefinition:
        "detected_at_utc - captured trigger_candle_closed_at, in minutes",
      unknownHandling:
        "No captured trigger identity means unknown; no latest-bar or favorable-bar inference. Unknown delay and price-chase rows fail open and remain in the full retained cohort.",
      noFutureBarsVerified:
        exactBars.every((row) => row.triggerBarIsPreEntryClosedBar),
      futurePivotConfirmations:
        "No pivots are computed or used in this delay/chase analysis; no future pivot confirmation enters either feature.",
      snapshotMetricsInput:
        "Read-only production SELECT by frozen decision_snapshot_id; status columns were not selected. Returned snapshot fields are cross-checked against the frozen cohort and identified as captured only from immutable snapshot provenance.",
    },
    metricsCoverage: {
      fullCohortRows: rows.length,
      delayMeasuredRows: delayMeasured.length,
      delayUnknownFailOpenRows: rows.length - delayMeasured.length,
      priceChaseMeasuredRows: chaseMeasured.length,
      priceChaseUnknownFailOpenRows: rows.length - chaseMeasured.length,
      exactTriggerTimestampCounts: {
        frozenTopLevelAndImmutableSnapshotMatch: exactTimestampRows.length,
        withoutExactTriggerIdentity: rows.length - exactTimestampRows.length,
      },
      exactBarFetchCounts: {
        triggerTimestampRows: barsPayload.trigger_timestamp_rows,
        uniqueRequests: barsPayload.unique_requests,
        exactValidRows: exactBars.length,
        missingOrInvalidBars: barsPayload.trigger_timestamp_rows - exactBars.length,
      },
      triggerTimestampVsDetectionDelayMinutes:
        featureDistribution.triggerDelayMinutes,
      triggerClosePriceChasePct: featureDistribution.priceChasePct,
      delayStrictlyGreaterThanCountsMeasuredDenominator: delayCutCounts,
      cutoffUnknownsAreNotTreatedAsPassOrFail:
        "Unknown telemetry is explicitly fail-open for all full-cohort removal counts.",
    },
    predeclaredCuts: {
      rule: "Strictly greater than only; no threshold is selected or tuned after observing outcomes.",
      delayMinutes: [5, 15, 30],
      priceChasePercent: [1, 2, 3],
      delayCaveat:
        "The fixed >5-minute delay cut is not a proposed helpful gate: almost every measured signal exceeds it because the scanner naturally runs after a 30m candle closes.",
    },
    frozenForwardOutcomes: {
      source: ".local/reports/ib-taker-volume-2026-10-01/horizon-windows.csv and matching rows/windows in cohort.json",
      sourceSemantics: frozenMetadata.path_notes,
      strictFlags: {
        matureAtCapture: "cohort.json windows[horizon][0] === true",
        completeCoverage: "cohort.json windows[horizon][9] === true",
        csvFlagsCrossChecked: true,
      },
      all188ByHorizon: overallPath,
    },
    fixedCutResults: cutResults.map((result) => ({
      label: result.label,
      feature: result.feature,
      strictCut: result.fixedCutStrictlyGreaterThan,
      measuredRows: result.featureMeasuredRows,
      unknownFailOpenRows: result.featureUnknownRows,
      fullCohortRows: result.fullCohortRows,
      removedRowsKnownOnly: result.removedRowsKnownOnly,
      retainedRowsIncludingUnknown: result.retainedRowsIncludingFailOpenUnknown,
      removedStatusCounts: result.removedStatusCounts,
      retainedStatusCounts: result.retainedStatusCounts,
      statusRows: result.statusRows,
      removedOutcomesByHorizon: result.removedOutcomesByHorizon,
      retainedOutcomesByHorizon: result.retainedOutcomesByHorizon,
      removedOutcomesByStatus: result.removedOutcomesByStatus,
      retainedOutcomesByStatus: result.retainedOutcomesByStatus,
    })),
    dateCutSensitivity: {
      boundaryUtc: PERIOD_SPLIT_AT,
      earlierRows: preSplitRows.length,
      atOrAfterRows: postSplitRows.length,
      groups: periodSensitivity,
      interpretation:
        "Fixed sensitivity split only: detected_at before 2026-09-20 00:00 UTC versus on/after. It does not redefine a selected cutoff.",
    },
    currentSingleEntrySensitivity: {
      policyField: "frozen cohort entry_policy_version",
      currentCodeVersion: "single_entry_v1",
      currentCodeReference:
        "artifacts/api-server/src/lib/watcher-config.ts:8,141-142; artifacts/api-server/src/lib/impulse-runner-policy.ts:2-3",
      policyVersionCounts: entryPolicyVersionCounts,
      exitPolicyVersionCountsReportedSeparately: exitPolicyVersionCounts,
      singleEntryV1Rows: singleEntryRows.length,
      singleEntryV1StatusCounts: countByStatus(singleEntryRows),
      fixedCutResults: singleEntrySensitivity,
      missingOrOtherPolicyRowsRemainDistinct:
        "Rows are not assigned to single_entry_v1 by date or by current code; only the frozen explicit entry_policy_version is used.",
    },
    rawInputs: [
      "trigger-chase-frozen-cohort-2026-10-01.json",
      "trigger-chase-frozen-metadata-2026-10-01.json",
      "trigger-chase-frozen-horizon-windows-2026-10-01.csv",
      "trigger-chase-retrieved-immutable-snapshot-metrics-2026-10-01.json",
      "trigger-chase-bingx-public-exact-30m-bars-2026-10-01.json",
      "trigger-chase-immutable-snapshot-select-2026-10-01.sql",
      "trigger-chase-analysis-2026-10-01.mjs",
    ],
    limitations: [
      "This retrospective fired cohort is not a live-gate test and does not estimate rejected counterfactuals.",
      "Final tracked statuses and OHLC observations do not prove exchange executions or prospective improvement.",
      "Trigger close OHLC is reconstructed from public historical BingX data after the event, not captured in the immutable snapshot.",
      "The snapshot entry_price fallback is not relabeled as original_entry_price or as a verified fill.",
      "An observed +5%/+10% candle high is an OHLC path hit, not an executed take-profit.",
      "No stop thresholds, volume/taker/Price24/BTC indicators, or pivots were re-audited or optimized here.",
    ],
  };

  const cutMarkdownRows = cutResults.map((result) => {
    const removed = result.removedStatusCounts;
    const retained = result.retainedStatusCounts;
    const removedPath = result.removedOutcomesByHorizon
      .map((item) => `${item.horizonHours}h +5 ${item.plus5Rows}/${item.strictCoverageRows}, +10 ${item.plus10Rows}/${item.strictCoverageRows}`)
      .join("; ");
    const retainedPath = result.retainedOutcomesByHorizon
      .map((item) => `${item.horizonHours}h peak p50 ${item.peakMedianPct === null ? "n/a" : item.peakMedianPct.toFixed(2)}%, +5 ${item.plus5Rows}/${item.strictCoverageRows}, +10 ${item.plus10Rows}/${item.strictCoverageRows}`)
      .join("; ");
    return [
      result.label,
      `${result.removedRowsKnownOnly}/${result.featureMeasuredRows} measured; ${result.removedRowsKnownOnly}/${result.fullCohortRows} full`,
      statusText(removed),
      statusText(retained),
      removedPath,
      retainedPath,
    ];
  });
  const statusRetainedOutcomeMarkdownRows = cutResults.flatMap((result) =>
    STATUSES.map((status) => {
      const byStatus = result.retainedOutcomesByStatus[status];
      const horizonText = byStatus.byHorizon
        .map((item) =>
          `${item.horizonHours}h: p50 ${item.peakMedianPct === null ? "n/a" : `${item.peakMedianPct.toFixed(2)}%`}; +5 ${item.plus5Rows}/${item.strictCoverageRows}; +10 ${item.plus10Rows}/${item.strictCoverageRows}`,
        )
        .join(" | ");
      return [
        result.label,
        status,
        result.removedStatusCounts[status],
        byStatus.rows,
        horizonText,
      ];
    }),
  );
  const overallPathMarkdown = overallPath.map((item) => [
    `${item.horizonHours}h`,
    `${item.strictCoverageRows}/${item.cohortRows}`,
    item.peakMedianPct === null ? "—" : `${item.peakMedianPct.toFixed(2)}%`,
    item.peakMaxPct === null ? "—" : `${item.peakMaxPct.toFixed(2)}%`,
    pctCount(item.plus5Rows, item.strictCoverageRows),
    pctCount(item.plus10Rows, item.strictCoverageRows),
    `${item.notStrictlyCoveredRows}`,
  ]);
  const periodMarkdown = periodSensitivity.map((item) => {
    const removed = item.removedStatusCounts;
    return [
      item.periodOrPolicy,
      item.feature,
      `>${item.cut}${item.feature === "trigger_delay_minutes" ? "m" : "%"}`,
      `${item.measuredRows}/${item.fullRows}`,
      `${item.unknownFailOpenRows}`,
      `${item.removedRows}/${item.fullRows}`,
      `SL ${removed.stop_loss}; BU ${removed.bu_stop}; profit ${removed.profit}; cancel ${removed.cancelled}; expired ${removed.expired}; reclass ${removed.reclassified}; active ${removed.active}`,
    ];
  });

  const md = [
    "# Impulse Buy trigger lateness and price chase",
    "",
    `Frozen cohort: **${rows.length} canonical fires**, capture ${frozenMetadata.capture_asof_utc}; input was not refreshed.`,
    "",
    "## What is measured",
    "",
    `- Captured exact 30m trigger-close timestamp: **${exactTimestampRows.length}/188**; remaining **${rows.length - exactTimestampRows.length}/188 are unknown and fail open**.`,
    `- Reconstructed exact trigger OHLC from **${exactBars.length}** public BingX USDT-perpetual 30m bars, keyed to the frozen symbol and trigger close timestamp; no other symbol or exchange was substituted. DB snapshot has a captured trigger close/OHLC candidate for **${snapshotCloseCapturedRows.length}/188**. Existing local BingX cache artifacts were 1h, not the required 30m anchor, so they were not substituted.`,
    `- Trigger close timestamp is a close time, not open time: scanner source picks a bar only after \`time + 30m <= now\`, then persists \`time + 30m\` (scanner.ts:7165-7168, 7585-7589). All reconstructed anchor bars closed by detection; no future bars were used. No pivot is part of these features.`,
    `- Delay = detected time minus captured trigger close. Price chase = **(frozen basis entry / exact trigger close − 1) × 100**. Price chase uses frozen \`original_entry_price\` where present, otherwise the separately labeled \`entry_price_fallback\`; it is neither Price24 nor candle body size.`,
    "",
    "## Frozen final status baseline (all 188; no status excluded)",
    "",
    markdownTable(
      ["Final status", "Rows / 188"],
      STATUSES.map((status) => [status, `${allStatusCounts[status]}/188`]),
    ),
    "",
    `Entry price basis provenance: **${originalBasisRows.length} original_entry_price**, **${fallbackBasisRows.length} entry_price_fallback**, **${noBasisRows.length} unavailable**. Among the 61 exact trigger-price rows: original ${chaseMeasured.filter((row) => row.entryBasisSource === "original_entry_price").length}, fallback ${chaseMeasured.filter((row) => row.entryBasisSource === "entry_price_fallback").length}, unavailable ${chaseMeasured.filter((row) => row.entryBasisSource === "unavailable").length}.`,
    "",
    "## Fixed cut sensitivity: removal by final status and retained outcomes",
    "",
    "All cuts were declared before counting results and use strict `>`: delay >5/>15/>30 minutes; price chase >1/>2/>3%. Missing values are not removed. The measured denominator is the feature-known subset; full denominator remains 188. Retained status counts include all fail-open unknowns.",
    "",
    markdownTable(
      ["Fixed cut", "Removed known / measured; full", "Removed final statuses (exact counts)", "Retained final statuses (exact counts)", "Removed strict-path +5/+10", "Retained strict-path peak median and +5/+10"],
      cutMarkdownRows,
    ),
    "",
    `Delay distribution over ${delayMeasured.length} known triggers: min ${featureDistribution.triggerDelayMinutes.min.toFixed(5)}m, median ${featureDistribution.triggerDelayMinutes.median.toFixed(2)}m, max ${featureDistribution.triggerDelayMinutes.max.toFixed(5)}m; >5m **${delayCutCounts["5"]}/61**, >15m **${delayCutCounts["15"]}/61**, >30m **${delayCutCounts["30"]}/61**. As a result, >5m is effectively a scanner scheduling delay proxy that would remove almost every measured fire; it is not evidence of a useful gate.`,
    "",
    `Price-chase distribution over ${chaseMeasured.length} exact comparisons: min ${featureDistribution.priceChasePct.min.toFixed(2)}%, median ${featureDistribution.priceChasePct.median.toFixed(2)}%, max ${featureDistribution.priceChasePct.max.toFixed(2)}%. Each cut's exact stop-loss, break-even-stop, profit, cancellation, expired, reclassified, and active counts are enumerated above and in the status CSV.`,
    "",
    "## Frozen forward OHLC paths: 1/3/6h",
    "",
    "Joined by frozen tracker ID and horizon from the cohort's captured windows. A row is counted only when frozen flags at array positions **0 (mature)** and **9 (complete coverage)** are both true; CSV flags were cross-checked against those positions.",
    "",
    markdownTable(
      ["Horizon", "Strict covered / 188", "Peak median", "Peak max", "+5 high hits / strict n", "+10 high hits / strict n", "Not strict"],
      overallPathMarkdown,
    ),
    "",
    "These are BingX 15m OHLC observations from the frozen report, not fills. They remain separate from the frozen tracked-status labels; a high crossing a target is not an exchange execution.",
    "",
    "### Retained forward outcomes by final status",
    "",
    "Per-cut, retained rows are grouped by each frozen status. Strict path denominator, peak median, and +5/+10 OHLC hits are reported by 1/3/6h; cells with `0/0` have no strictly covered rows for that status.",
    "",
    markdownTable(
      ["Fixed cut", "Final status", "Removed status rows", "Retained status rows", "Retained strict-path outcomes"],
      statusRetainedOutcomeMarkdownRows,
    ),
    "",
    "## Fixed temporal and single-entry sensitivities",
    "",
    `Date split is fixed at **${PERIOD_SPLIT_AT}**: before versus on/after 2026-09-20 00:00 UTC. This is descriptive sensitivity, not a selected cutoff.`,
    "",
    markdownTable(
      ["Period", "Feature", "Strict cut", "Measured / rows", "Unknown fail-open", "Removed / period rows", "Removed by frozen status"],
      periodMarkdown,
    ),
    "",
    `Explicit frozen \`entry_policy_version=single_entry_v1\` rows: **${singleEntryRows.length}**; statuses: ${statusText(countByStatus(singleEntryRows))}. Policy-version and threshold sensitivity (including denominators) is in the JSON/CSV. Missing or older policy versions are not reclassified by date.`,
    "",
    "## Provenance and limits",
    "",
    "- Statuses, entry values, cohort membership, and 15m forward-window summaries come only from the frozen 2026-10-01 06:02 UTC capture. No refresh was performed for statuses.",
    "- Trigger close timestamp is immutable scanner-decision telemetry on 61 rows. Raw exact trigger OHLC was not persisted in those immutable entry snapshots; the existing local cache artifacts are 1h rather than 30m, so these 30m values are explicitly reconstructed from the public BingX historical candle endpoint after the event.",
    "- The remaining 127 rows have no identifiable frozen trigger candle. Neither delay nor chase is guessed from a favorable or latest candle; they remain unknown and fail open in full-cohort retention counts.",
    "- A fallback \`entry_price\` is kept distinct from \`original_entry_price\`; neither is labeled a verified exchange fill.",
    "- No app code, live gate, schema, workflow, database state, or secret was changed. Production access was SELECT-only. This is retrospective sensitivity, not a claim of executable fills or prospective validated improvement.",
    "",
    "## Reproduction inputs",
    "",
    "- `trigger-chase-analysis-2026-10-01.mjs`",
    "- `trigger-chase-immutable-snapshot-select-2026-10-01.sql`",
    "- `trigger-chase-frozen-cohort-2026-10-01.json`",
    "- `trigger-chase-frozen-metadata-2026-10-01.json`",
    "- `trigger-chase-frozen-horizon-windows-2026-10-01.csv`",
    "- `trigger-chase-retrieved-immutable-snapshot-metrics-2026-10-01.json`",
    "- `trigger-chase-bingx-public-exact-30m-bars-2026-10-01.json`",
    "",
    "Run `node .local/reports/ib-entry-structure-2026-10-01/trigger-chase-analysis-2026-10-01.mjs` to regenerate the report outputs from those saved inputs. The script itself does not call a database or the network.",
    "",
  ].join("\n");

  await mkdir(OUT_DIR, { recursive: true });
  await Promise.all([
    writeFile(OUTPUT_JSON, `${JSON.stringify(report, null, 2)}\n`),
    writeFile(OUTPUT_MD, md),
    writeFile(
      OUTPUT_ROWS,
      writeCsv(rowCsvRows, rowColumns),
    ),
    writeFile(
      OUTPUT_CUTS,
      writeCsv(thresholdCsvRows, thresholdColumns),
    ),
    writeFile(
      OUTPUT_SENSITIVITY,
      writeCsv(sensitivityCsvRows, sensitivityColumns),
    ),
  ]);
  console.log(
    JSON.stringify(
      {
        cohortRows: rows.length,
        statuses: allStatusCounts,
        delayMeasured: delayMeasured.length,
        chaseMeasured: chaseMeasured.length,
        exactBars: exactBars.length,
        delayCuts: delayCutCounts,
        priceChaseCuts: Object.fromEntries(
          [1, 2, 3].map((cut) => [
            String(cut),
            chaseMeasured.filter((row) => row.priceChasePct > cut).length,
          ]),
        ),
        singleEntryRows: singleEntryRows.length,
        dateSplitRows: {
          before: preSplitRows.length,
          onOrAfter: postSplitRows.length,
        },
        outputs: [OUTPUT_JSON, OUTPUT_MD, OUTPUT_ROWS, OUTPUT_CUTS, OUTPUT_SENSITIVITY],
      },
      null,
      2,
    ),
  );
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? "")).href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}