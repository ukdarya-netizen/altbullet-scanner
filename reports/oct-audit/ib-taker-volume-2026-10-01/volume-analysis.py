#!/usr/bin/env python3
"""Offline analysis of the frozen impulse-buy cohort export.

Reads only .local/reports/ib-taker-volume-2026-10-01/cohort.json and
metadata.json; writes volume-analysis.json and volume-analysis.md beside this
script. No database, network, or live application access is used.
"""

from __future__ import annotations

import json
import math
import random
import statistics
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parent
EXPORT_DIR = ROOT
COHORT_PATH = EXPORT_DIR / "cohort.json"
METADATA_PATH = EXPORT_DIR / "metadata.json"
JSON_OUTPUT = ROOT / "volume-analysis.json"
MARKDOWN_OUTPUT = ROOT / "volume-analysis.md"

HORIZONS = (1, 3, 6, 12, 24, 72)
PRIMARY_HORIZONS = (1, 3, 6, 24, 72)
TRIGGER_BANDS = (
    ("[1.5,2)", 1.5, 2.0),
    ("[2,3)", 2.0, 3.0),
    ("[3,5)", 3.0, 5.0),
    ("[5,+inf)", 5.0, None),
)
GENERIC_BANDS = (
    ("<1", None, 1.0),
    ("[1,2)", 1.0, 2.0),
    ("[2,3)", 2.0, 3.0),
    ("[3,5)", 3.0, 5.0),
    ("[5,+inf)", 5.0, None),
)
CUTS = (2.0, 3.0, 5.0)
TRIGGER_KEY = "trigger_candle_volume_mult"
GENERIC_KEY = "entry_fut_vol_mult"
TAKER_KEY = "entry_fut_taker_net_buy_pct"
EXTREME_KEY = "extreme_path_gt300pct"
BOOTSTRAP_REPLICATES = 1200
BOOTSTRAP_SEED = 20261001
ERA_BOUNDARY = datetime(2026, 9, 20, tzinfo=timezone.utc)


def finite_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def percentile(values: list[float], p: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    position = (len(ordered) - 1) * p
    lower = math.floor(position)
    upper = math.ceil(position)
    if lower == upper:
        return ordered[lower]
    return ordered[lower] + (ordered[upper] - ordered[lower]) * (position - lower)


def rank_values(values: list[float]) -> list[float]:
    indexed = sorted(enumerate(values), key=lambda item: item[1])
    ranks = [0.0] * len(values)
    start = 0
    while start < len(indexed):
        end = start + 1
        while end < len(indexed) and indexed[end][1] == indexed[start][1]:
            end += 1
        rank = ((start + 1) + end) / 2.0
        for index in range(start, end):
            ranks[indexed[index][0]] = rank
        start = end
    return ranks


def pearson(x_values: list[float], y_values: list[float]) -> float | None:
    if len(x_values) != len(y_values) or len(x_values) < 2:
        return None
    mean_x = statistics.fmean(x_values)
    mean_y = statistics.fmean(y_values)
    dx = [value - mean_x for value in x_values]
    dy = [value - mean_y for value in y_values]
    sum_x = sum(value * value for value in dx)
    sum_y = sum(value * value for value in dy)
    if sum_x <= 0 or sum_y <= 0:
        return None
    return sum(a * b for a, b in zip(dx, dy)) / math.sqrt(sum_x * sum_y)


def spearman(x_values: list[float], y_values: list[float]) -> float | None:
    if len(x_values) < 2:
        return None
    return pearson(rank_values(x_values), rank_values(y_values))


def parse_datetime(value: Any) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed.astimezone(timezone.utc)
    except ValueError:
        return None


def window(row: dict[str, Any], horizon: int) -> list[Any] | None:
    windows = row.get("windows")
    value = windows.get(str(horizon)) if isinstance(windows, dict) else None
    return value if isinstance(value, list) and len(value) >= 23 else None


def is_strict_gapfree(row: dict[str, Any], horizon: int) -> bool:
    value = window(row, horizon)
    if value is None:
        return False
    try:
        return (
            value[0] is True
            and value[9] is True
            and value[4] == value[3]
            and value[5] == 0
            and value[6] == 0
        )
    except (IndexError, TypeError):
        return False


def path_rows(rows: list[dict[str, Any]], horizon: int) -> list[dict[str, Any]]:
    return [row for row in rows if is_strict_gapfree(row, horizon)]


def has_metric(row: dict[str, Any], key: str) -> bool:
    return finite_number(row.get(key))


def outcomes(rows: list[dict[str, Any]], horizon: int) -> dict[str, Any]:
    peaks: list[float] = []
    hit5 = hit10 = hit20 = 0
    for row in rows:
        value = window(row, horizon)
        if value is None:
            continue
        if finite_number(value[10]):
            peaks.append(float(value[10]))
        hit5 += value[13] is not None
        hit10 += value[14] is not None
        hit20 += value[15] is not None
    n = len(rows)
    return {
        "n": n,
        "median_peak_pct": statistics.median(peaks) if peaks else None,
        "hit_plus5_count": hit5,
        "hit_plus5_rate": hit5 / n if n else None,
        "hit_plus10_count": hit10,
        "hit_plus10_rate": hit10 / n if n else None,
        "hit_plus20_count": hit20,
        "hit_plus20_rate": hit20 / n if n else None,
    }


def metric_horizon_rows(
    rows: list[dict[str, Any]], key: str, horizon: int
) -> list[dict[str, Any]]:
    return [row for row in path_rows(rows, horizon) if has_metric(row, key)]


def cluster_bootstrap_ci(
    rows: list[dict[str, Any]],
    x_key: str,
    y_getter: Any,
    seed: int,
    replicates: int = BOOTSTRAP_REPLICATES,
) -> dict[str, Any]:
    usable = [
        row
        for row in rows
        if has_metric(row, x_key) and finite_number(y_getter(row))
    ]
    x_values = [float(row[x_key]) for row in usable]
    y_values = [float(y_getter(row)) for row in usable]
    rho = spearman(x_values, y_values)
    groups: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in usable:
        groups[str(row.get("symbol") or f"id:{row.get('id')}")].append(row)
    cluster_names = sorted(groups)
    boot_values: list[float] = []
    rng = random.Random(seed)
    if len(cluster_names) >= 2:
        for _ in range(replicates):
            sampled: list[dict[str, Any]] = []
            for _cluster in range(len(cluster_names)):
                sampled.extend(groups[rng.choice(cluster_names)])
            bx = [float(row[x_key]) for row in sampled]
            by = [float(y_getter(row)) for row in sampled]
            value = spearman(bx, by)
            if value is not None and math.isfinite(value):
                boot_values.append(value)
    return {
        "n": len(usable),
        "symbol_clusters": len(cluster_names),
        "spearman_rho": rho,
        "cluster_bootstrap_95ci": (
            [percentile(boot_values, 0.025), percentile(boot_values, 0.975)]
            if boot_values
            else None
        ),
        "bootstrap_replicates_requested": replicates,
        "bootstrap_replicates_valid": len(boot_values),
    }


def correlation_bundle(rows: list[dict[str, Any]], key: str, seed_offset: int) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for horizon in HORIZONS:
        complete = metric_horizon_rows(rows, key, horizon)
        result[str(horizon)] = {
            "forward_peak_pct": cluster_bootstrap_ci(
                complete,
                key,
                lambda row, h=horizon: window(row, h)[10],
                BOOTSTRAP_SEED + seed_offset + horizon * 101,
            ),
            "hit_plus5": cluster_bootstrap_ci(
                complete,
                key,
                lambda row, h=horizon: 1.0 if window(row, h)[13] is not None else 0.0,
                BOOTSTRAP_SEED + seed_offset + horizon * 101 + 1,
            ),
            "hit_plus10": cluster_bootstrap_ci(
                complete,
                key,
                lambda row, h=horizon: 1.0 if window(row, h)[14] is not None else 0.0,
                BOOTSTRAP_SEED + seed_offset + horizon * 101 + 2,
            ),
        }
    return result


def band_for(value: float, bands: tuple[tuple[str, float | None, float | None], ...]) -> str | None:
    for label, lower, upper in bands:
        if (lower is None or value >= lower) and (upper is None or value < upper):
            return label
    return None


def analyze_bands(
    rows: list[dict[str, Any]],
    key: str,
    bands: tuple[tuple[str, float | None, float | None], ...],
    exclude_exact_one: bool = False,
) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for horizon in HORIZONS:
        eligible = metric_horizon_rows(rows, key, horizon)
        if exclude_exact_one:
            eligible = [row for row in eligible if float(row[key]) != 1.0]
        horizon_result: dict[str, Any] = {}
        for label, _lower, _upper in bands:
            selected = [row for row in eligible if band_for(float(row[key]), bands) == label]
            horizon_result[label] = outcomes(selected, horizon)
        horizon_result["eligible_n"] = len(eligible)
        result[str(horizon)] = horizon_result
    return result


def analyze_cuts(rows: list[dict[str, Any]], key: str) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for horizon in HORIZONS:
        eligible = metric_horizon_rows(rows, key, horizon)
        horizon_result: dict[str, Any] = {}
        for cut in CUTS:
            high = [row for row in eligible if float(row[key]) >= cut]
            low = [row for row in eligible if float(row[key]) < cut]
            high_outcomes = outcomes(high, horizon)
            low_outcomes = outcomes(low, horizon)
            high_rate = high_outcomes["hit_plus10_rate"]
            low_rate = low_outcomes["hit_plus10_rate"]
            horizon_result[str(cut)] = {
                "high": high_outcomes,
                "below": low_outcomes,
                "plus10_rate_difference_high_minus_below": (
                    high_rate - low_rate
                    if high_rate is not None and low_rate is not None
                    else None
                ),
            }
        result[str(horizon)] = horizon_result
    return result


def indicator_summary(rows: list[dict[str, Any]], horizon: int) -> dict[str, Any]:
    return outcomes(rows, horizon)


def combined_metric_tests(rows: list[dict[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {"taker_strata": {}, "combined_conditions": {}}
    for horizon in HORIZONS:
        matched = [
            row
            for row in path_rows(rows, horizon)
            if has_metric(row, TRIGGER_KEY) and has_metric(row, TAKER_KEY)
        ]
        by_taker: dict[str, list[dict[str, Any]]] = {
            "positive_gt0": [row for row in matched if float(row[TAKER_KEY]) > 0],
            "negative_lt0": [row for row in matched if float(row[TAKER_KEY]) < 0],
            "zero": [row for row in matched if float(row[TAKER_KEY]) == 0],
        }
        stratum_result: dict[str, Any] = {"matched_metrics_n": len(matched), "strata": {}}
        for stratum, stratum_rows in by_taker.items():
            high = [row for row in stratum_rows if float(row[TRIGGER_KEY]) >= 3]
            low = [row for row in stratum_rows if float(row[TRIGGER_KEY]) < 3]
            high_stats = outcomes(high, horizon)
            low_stats = outcomes(low, horizon)
            high_rate = high_stats["hit_plus10_rate"]
            low_rate = low_stats["hit_plus10_rate"]
            stratum_result["strata"][stratum] = {
                "matched_n": len(stratum_rows),
                "closed_trigger_ge3": high_stats,
                "closed_trigger_below3": low_stats,
                "plus10_rate_difference_ge3_minus_below3": (
                    high_rate - low_rate
                    if high_rate is not None and low_rate is not None
                    else None
                ),
            }
        result["taker_strata"][str(horizon)] = stratum_result

        combination_result: dict[str, Any] = {"matched_metrics_n": len(matched), "conditions": {}}
        for label, taker_floor in (("closed_ge3_and_taker_ge0", 0.0), ("closed_ge3_and_taker_ge20", 20.0)):
            selected = [
                row
                for row in matched
                if float(row[TRIGGER_KEY]) >= 3 and float(row[TAKER_KEY]) >= taker_floor
            ]
            complement = [row for row in matched if row not in selected]
            combination_result["conditions"][label] = {
                "condition": f"{TRIGGER_KEY} >= 3 and {TAKER_KEY} >= {taker_floor:g}",
                "condition_group": outcomes(selected, horizon),
                "matched_complement": outcomes(complement, horizon),
            }
        result["combined_conditions"][str(horizon)] = combination_result
    return result


def gate_fail_open_analysis(rows: list[dict[str, Any]], cutoff: float = 3.0) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for horizon in (6, 24, 72):
        eligible = path_rows(rows, horizon)
        winners = [
            row
            for row in eligible
            if window(row, horizon)[14] is not None
        ]
        known_high = [row for row in winners if has_metric(row, TRIGGER_KEY) and float(row[TRIGGER_KEY]) >= cutoff]
        known_low = [row for row in winners if has_metric(row, TRIGGER_KEY) and float(row[TRIGGER_KEY]) < cutoff]
        missing = [row for row in winners if not has_metric(row, TRIGGER_KEY)]
        strict_lost = known_low + missing
        fail_open_lost = known_low
        dropped_nonwinners = [
            row
            for row in eligible
            if window(row, horizon)[14] is None
            and has_metric(row, TRIGGER_KEY)
            and float(row[TRIGGER_KEY]) < cutoff
        ]
        pnl_present = [row for row in dropped_nonwinners if finite_number(row.get("pnl_percent"))]
        negative_pnl = [row for row in pnl_present if float(row["pnl_percent"]) < 0]
        result[str(horizon)] = {
            "definition": f"high-profit winner = forward +10% high reached by {horizon}h; gate threshold closed trigger multiplier >= {cutoff:g}",
            "raw_mature_gapfree_denominator": len(eligible),
            "winner_plus10_denominator": len(winners),
            "trigger_metric_present_winners": len(known_high) + len(known_low),
            "trigger_metric_missing_winners": len(missing),
            "known_ge_cutoff_winners_retained": len(known_high),
            "known_below_cutoff_winners_lost": len(known_low),
            "missing_winners_retained_by_fail_open": len(missing),
            "strict_fail_closed_winners_lost_including_missing": len(strict_lost),
            "fail_open_winners_lost": len(fail_open_lost),
            "strict_retained_winner_rate": len(known_high) / len(winners) if winners else None,
            "fail_open_retained_winner_rate": (len(known_high) + len(missing)) / len(winners) if winners else None,
            "strict_lost_winner_peak_upside_pct_sum": sum(float(window(row, horizon)[10]) for row in strict_lost if finite_number(window(row, horizon)[10])),
            "strict_lost_winner_peak_upside_pct_median": statistics.median(
                [float(window(row, horizon)[10]) for row in strict_lost if finite_number(window(row, horizon)[10])]
            ) if strict_lost else None,
            "fail_open_lost_winner_peak_upside_pct_sum": sum(float(window(row, horizon)[10]) for row in fail_open_lost if finite_number(window(row, horizon)[10])),
            "fail_open_lost_winner_peak_upside_pct_median": statistics.median(
                [float(window(row, horizon)[10]) for row in fail_open_lost if finite_number(window(row, horizon)[10])]
            ) if fail_open_lost else None,
            "known_below_cutoff_nonwinners_dropped": len(dropped_nonwinners),
            "dropped_nonwinners_by_status": dict(Counter(str(row.get("status")) for row in dropped_nonwinners)),
            "secondary_snapshot_pnl_diagnostic_only": {
                "dropped_nonwinner_rows_with_pnl": len(pnl_present),
                "negative_pnl_rows": len(negative_pnl),
                "sum_negative_pnl_percent_points": sum(float(row["pnl_percent"]) for row in negative_pnl),
                "warning": "tracker PnL/status does not prove an executed fill; not used as a primary outcome",
            },
        }
    return result


def era_analysis(rows: list[dict[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for era, selected in (
        ("before_2026-09-20_utc", [row for row in rows if (parse_datetime(row.get("detected_at_utc")) or ERA_BOUNDARY) < ERA_BOUNDARY]),
        ("on_or_after_2026-09-20_utc", [row for row in rows if (parse_datetime(row.get("detected_at_utc")) or ERA_BOUNDARY) >= ERA_BOUNDARY]),
    ):
        metric_counts = {
            "closed_trigger_metric": sum(has_metric(row, TRIGGER_KEY) for row in selected),
            "generic_futures_volume_metric": sum(has_metric(row, GENERIC_KEY) for row in selected),
            "futures_taker_metric": sum(has_metric(row, TAKER_KEY) for row in selected),
            "all_three_matched": sum(
                has_metric(row, TRIGGER_KEY) and has_metric(row, GENERIC_KEY) and has_metric(row, TAKER_KEY)
                for row in selected
            ),
        }
        horizons: dict[str, Any] = {}
        for horizon in HORIZONS:
            strict = path_rows(selected, horizon)
            exact = [row for row in strict if has_metric(row, TRIGGER_KEY)]
            generic = [row for row in strict if has_metric(row, GENERIC_KEY)]
            horizons[str(horizon)] = {
                "mature_gapfree_n": len(strict),
                "closed_trigger": outcomes(exact, horizon),
                "generic_futures": outcomes(generic, horizon),
            }
        result[era] = {
            "n": len(selected),
            "status_counts": dict(Counter(str(row.get("status")) for row in selected)),
            "entry_policy_version_counts": dict(Counter(str(row.get("entry_policy_version")) for row in selected)),
            "metric_presence_counts": metric_counts,
            "horizons": horizons,
        }
    return result


def preclose_analysis(rows: list[dict[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    applicable_statuses: Counter[str] = Counter()
    for row in rows:
        for horizon in HORIZONS:
            value = window(row, horizon)
            pre = value[22] if value is not None else None
            if isinstance(pre, list) and len(pre) >= 12 and pre[0] is True:
                applicable_statuses[str(row.get("status"))] += 1
                break
    for horizon in HORIZONS:
        matched: list[dict[str, Any]] = []
        preclose_rows: list[dict[str, Any]] = []
        for row in rows:
            if not is_strict_gapfree(row, horizon):
                continue
            forward = window(row, horizon)
            pre = forward[22]
            if (
                isinstance(pre, list)
                and len(pre) >= 12
                and pre[0] is True
                and pre[8] is True
                and pre[3] == pre[2]
                and pre[4] == 0
                and pre[5] == 0
            ):
                matched.append(row)
                preclose_rows.append({
                    "_analysis_horizon": horizon,
                    "_preclose_peak": pre[9],
                    "_preclose_hit5": pre[9] is not None and finite_number(pre[9]) and float(pre[9]) >= 5,
                    "_preclose_hit10": pre[9] is not None and finite_number(pre[9]) and float(pre[9]) >= 10,
                    "_forward": forward,
                })
        peaks = [float(item["_preclose_peak"]) for item in preclose_rows if finite_number(item["_preclose_peak"])]
        pre5 = sum(bool(item["_preclose_hit5"]) for item in preclose_rows)
        pre10 = sum(bool(item["_preclose_hit10"]) for item in preclose_rows)
        forward5 = sum(item["_forward"][13] is not None for item in preclose_rows)
        forward10 = sum(item["_forward"][14] is not None for item in preclose_rows)
        n = len(preclose_rows)
        result[str(horizon)] = {
            "noncancelled_closed_applicable_status_counts_cohortwide": dict(applicable_statuses),
            "mature_gapfree_forward_rows_with_applicable_gapfree_preclose_path": n,
            "preclose_median_peak_pct": statistics.median(peaks) if peaks else None,
            "preclose_plus5_count": pre5,
            "preclose_plus5_rate": pre5 / n if n else None,
            "preclose_plus10_count": pre10,
            "preclose_plus10_rate": pre10 / n if n else None,
            "same_matched_rows_full_forward_plus5_count": forward5,
            "same_matched_rows_full_forward_plus5_rate": forward5 / n if n else None,
            "same_matched_rows_full_forward_plus10_count": forward10,
            "same_matched_rows_full_forward_plus10_rate": forward10 / n if n else None,
            "selection_warning": "The supplemental preclose exporter applies only to applicable non-cancelled closed rows. It is not a sample of all entries or verified fills and is not used in the primary symmetric forward-path analysis.",
        }
    return result


def metric_presence(rows: list[dict[str, Any]], key: str) -> dict[str, Any]:
    values = [float(row[key]) for row in rows if has_metric(row, key)]
    return {
        "n": len(values),
        "missing_n": len(rows) - len(values),
        "min": min(values) if values else None,
        "p25": percentile(values, 0.25),
        "median": statistics.median(values) if values else None,
        "p75": percentile(values, 0.75),
        "max": max(values) if values else None,
        "exact_one_n": sum(value == 1.0 for value in values),
        "below_1_5_n": sum(value < 1.5 for value in values),
        "ge_1_5_n": sum(value >= 1.5 for value in values),
        "ge_2_n": sum(value >= 2 for value in values),
        "ge_3_n": sum(value >= 3 for value in values),
        "ge_5_n": sum(value >= 5 for value in values),
    }


def main() -> None:
    metadata = json.loads(METADATA_PATH.read_text(encoding="utf-8"))
    cohort_data = json.loads(COHORT_PATH.read_text(encoding="utf-8"))
    rows = cohort_data.get("rows", [])
    if not isinstance(rows, list):
        raise ValueError("cohort.json rows must be a list")

    ids = [row.get("id") for row in rows]
    duplicate_ids = sorted(identifier for identifier, count in Counter(ids).items() if count > 1)
    if len(rows) != metadata.get("cohort_rows") or len(set(ids)) != len(rows) or duplicate_ids:
        raise ValueError(
            f"Cohort integrity failure: rows={len(rows)}, metadata={metadata.get('cohort_rows')}, "
            f"unique IDs={len(set(ids))}, duplicates={duplicate_ids}"
        )
    if len(set(ids)) != metadata.get("distinct_tracker_ids"):
        raise ValueError("Cohort unique ID count does not match metadata distinct_tracker_ids")

    for row in rows:
        for horizon in HORIZONS:
            if window(row, horizon) is None:
                raise ValueError(f"Row {row.get('id')} lacks expected {horizon}h window array")

    coverage: dict[str, Any] = {}
    for horizon in HORIZONS:
        value_rows = [window(row, horizon) for row in rows]
        mature = sum(value[0] is True for value in value_rows if value is not None)
        complete = sum(value[9] is True for value in value_rows if value is not None)
        strict = path_rows(rows, horizon)
        declared = metadata.get("horizon_coverage", {}).get(str(horizon), {})
        coverage[str(horizon)] = {
            "cohort_rows": len(rows),
            "mature_at_capture_rows": mature,
            "coverage_complete_rows": complete,
            "strict_mature_gapfree_rows": len(strict),
            "metadata_mature_rows": declared.get("mature_rows"),
            "metadata_mature_gapfree_rows": declared.get("mature_gap_free_rows"),
            "matches_metadata_mature_count": mature == declared.get("mature_rows"),
            "matches_metadata_gapfree_count": len(strict) == declared.get("mature_gap_free_rows"),
            "available_metric_rows": {
                "closed_trigger_volume": sum(has_metric(row, TRIGGER_KEY) for row in strict),
                "generic_futures_volume": sum(has_metric(row, GENERIC_KEY) for row in strict),
                "futures_taker": sum(has_metric(row, TAKER_KEY) for row in strict),
            },
        }

    flags = metadata.get("rows_with_path_or_first_candle_gt300pct", [])
    flagged_ids = {item.get("id") for item in flags}
    flagged_rows = [row for row in rows if row.get(EXTREME_KEY) is True or row.get("id") in flagged_ids]
    unflagged_rows = [row for row in rows if row not in flagged_rows]

    trigger_values = [float(row[TRIGGER_KEY]) for row in rows if has_metric(row, TRIGGER_KEY)]
    generic_values = [float(row[GENERIC_KEY]) for row in rows if has_metric(row, GENERIC_KEY)]
    paired = [row for row in rows if has_metric(row, TRIGGER_KEY) and has_metric(row, GENERIC_KEY)]
    paired_deltas = [float(row[GENERIC_KEY]) - float(row[TRIGGER_KEY]) for row in paired]
    paired_equal = sum(abs(delta) <= 0.01 for delta in paired_deltas)
    paired_corr = spearman(
        [float(row[TRIGGER_KEY]) for row in paired],
        [float(row[GENERIC_KEY]) for row in paired],
    )

    horizons_summary: dict[str, Any] = {}
    for horizon in HORIZONS:
        strict = path_rows(rows, horizon)
        horizons_summary[str(horizon)] = {
            "full_cohort_forward_paths": outcomes(strict, horizon),
            "closed_trigger_metric_available": outcomes([row for row in strict if has_metric(row, TRIGGER_KEY)], horizon),
            "generic_futures_metric_available": outcomes([row for row in strict if has_metric(row, GENERIC_KEY)], horizon),
            "both_volume_metrics_available": outcomes(
                [row for row in strict if has_metric(row, TRIGGER_KEY) and has_metric(row, GENERIC_KEY)],
                horizon,
            ),
        }

    trigger_correlations = correlation_bundle(rows, TRIGGER_KEY, 10_000)
    generic_correlations = correlation_bundle(rows, GENERIC_KEY, 20_000)
    generic_without_one_correlations: dict[str, Any] = {}
    generic_without_one_summary: dict[str, Any] = {}
    for horizon in HORIZONS:
        complete = [
            row for row in metric_horizon_rows(rows, GENERIC_KEY, horizon)
            if float(row[GENERIC_KEY]) != 1.0
        ]
        generic_without_one_correlations[str(horizon)] = {
            "forward_peak_pct": cluster_bootstrap_ci(
                complete, GENERIC_KEY, lambda row, h=horizon: window(row, h)[10],
                BOOTSTRAP_SEED + 30_000 + horizon * 101,
            ),
            "hit_plus5": cluster_bootstrap_ci(
                complete, GENERIC_KEY, lambda row, h=horizon: 1.0 if window(row, h)[13] is not None else 0.0,
                BOOTSTRAP_SEED + 30_001 + horizon * 101,
            ),
            "hit_plus10": cluster_bootstrap_ci(
                complete, GENERIC_KEY, lambda row, h=horizon: 1.0 if window(row, h)[14] is not None else 0.0,
                BOOTSTRAP_SEED + 30_002 + horizon * 101,
            ),
        }
        generic_without_one_summary[str(horizon)] = outcomes(complete, horizon)

    outlier_sensitivity: dict[str, Any] = {}
    for horizon in HORIZONS:
        strict = path_rows(rows, horizon)
        unflagged_strict = [row for row in strict if row not in flagged_rows]
        outlier_sensitivity[str(horizon)] = {
            "strict_forward_cohort": outcomes(strict, horizon),
            "strict_forward_excluding_three_flagged_path_extremes": outcomes(unflagged_strict, horizon),
            "flagged_path_extreme_rows_in_strict_horizon": outcomes(
                [row for row in strict if row in flagged_rows], horizon
            ),
            "closed_trigger_peak_rho_all": cluster_bootstrap_ci(
                metric_horizon_rows(rows, TRIGGER_KEY, horizon), TRIGGER_KEY,
                lambda row, h=horizon: window(row, h)[10],
                BOOTSTRAP_SEED + 40_000 + horizon,
            ),
            "closed_trigger_peak_rho_excluding_flagged": cluster_bootstrap_ci(
                metric_horizon_rows(unflagged_rows, TRIGGER_KEY, horizon), TRIGGER_KEY,
                lambda row, h=horizon: window(row, h)[10],
                BOOTSTRAP_SEED + 41_000 + horizon,
            ),
            "generic_peak_rho_all": cluster_bootstrap_ci(
                metric_horizon_rows(rows, GENERIC_KEY, horizon), GENERIC_KEY,
                lambda row, h=horizon: window(row, h)[10],
                BOOTSTRAP_SEED + 42_000 + horizon,
            ),
            "generic_peak_rho_excluding_flagged": cluster_bootstrap_ci(
                metric_horizon_rows(unflagged_rows, GENERIC_KEY, horizon), GENERIC_KEY,
                lambda row, h=horizon: window(row, h)[10],
                BOOTSTRAP_SEED + 43_000 + horizon,
            ),
        }

    volume_metric_mismatch = {
        "paired_rows": len(paired),
        "rows_equal_within_0_01x": paired_equal,
        "rows_not_equal_within_0_01x": len(paired) - paired_equal,
        "median_generic_minus_closed_trigger_x": statistics.median(paired_deltas) if paired_deltas else None,
        "median_absolute_difference_x": statistics.median([abs(value) for value in paired_deltas]) if paired_deltas else None,
        "spearman_between_distinct_metrics": paired_corr,
    }

    # The exported preclose arrays apply only to the exporter's applicable subset;
    # never merge them into the symmetric primary forward cohort.
    result = {
        "title": "Frozen ImpulseBuy futures-volume observational analysis",
        "created_from_frozen_export_asof_utc": metadata.get("capture_asof_utc"),
        "inputs": [str(COHORT_PATH.relative_to(ROOT)), str(METADATA_PATH.relative_to(ROOT))],
        "input_policy": "All analytic values derive only from cohort.json and metadata.json. No DB, network, live edits, or auxiliary price files were used.",
        "cohort_integrity": {
            "row_count": len(rows),
            "unique_tracker_id_count": len(set(ids)),
            "duplicate_tracker_ids": duplicate_ids,
            "metadata_expected_rows": metadata.get("cohort_rows"),
            "metadata_expected_distinct_ids": metadata.get("distinct_tracker_ids"),
            "all_rows_and_statuses_included": True,
            "status_counts": dict(Counter(str(row.get("status")) for row in rows)),
            "legacy_rows": sum(row.get("snapshot_is_legacy") is True for row in rows),
            "first_detected_at_utc": metadata.get("first_detected_at_utc"),
            "last_detected_at_utc": metadata.get("last_detected_at_utc"),
            "entry_policy_version_counts": dict(Counter(str(row.get("entry_policy_version")) for row in rows)),
            "entry_gate_version_field_present": any("entry_gate_version" in row for row in rows),
            "reclassified_rows": sum(row.get("status") == "reclassified" for row in rows),
            "assertion": "188 input rows are 188 unique tracker IDs; this verifies export identity, not fills or independently verified production executions.",
        },
        "definitions_and_method": {
            "primary_predictor": "trigger_candle_volume_mult: recorded closed 30-minute impulse trigger-candle quote-volume divided by the baseline of the previous 20 closed 30-minute candles; the frozen export has no absolute trigger/baseline USD values.",
            "secondary_predictor": "entry_fut_vol_mult: separate generic persisted futures-volume multiplier; do not substitute it for the exact closed trigger metric. Current scanner source computes its generic multiplier from current-volume/average-volume and may apply cross-exchange confirmation; the current bar can be forming, and the export does not identify each row's historical branch.",
            "outcome": "Entry-basis-anchored maximum high and first +5/+10/+20% high threshold hits in frozen 15-minute BingX forward windows.",
            "primary_path_sample": "Per horizon require mature_at_capture=true, coverage_complete=true, valid buckets equal expected, zero invalid bars, and zero duplicate bars. All 188 statuses, including cancelled and reclassified rows, remain eligible.",
            "spearman_ci": f"Spearman rank correlations with percentile 95% intervals from {BOOTSTRAP_REPLICATES} deterministic symbol-cluster bootstrap replicates; symbols are sampled as clusters so repeated token events stay together.",
            "selection_and_cutoffs": "The exact closed trigger metric has a 1.5x evaluator gate; the fired cohort is selected at or above that threshold, so results cannot identify performance below 1.5x or validate that threshold against rejected candidates.",
            "peaks_are_not_fills": "Observed highs are path excursions, not executed trades, fill prices, or PnL.",
            "horizon_semantics": metadata.get("path_notes"),
        },
        "metric_presence_and_distributions": {
            "closed_trigger_volume": metric_presence(rows, TRIGGER_KEY),
            "generic_futures_volume": metric_presence(rows, GENERIC_KEY),
            "futures_taker_net_buy_pct": metric_presence(rows, TAKER_KEY),
            "trigger_absolute_volume_usd_rows": sum(has_metric(row, "trigger_candle_volume_usd") for row in rows),
            "trigger_baseline_volume_usd_rows": sum(has_metric(row, "trigger_baseline_volume_usd") for row in rows),
            "closed_trigger_volume_multiplier_recorded_rows": len(trigger_values),
            "generic_futures_volume_multiplier_recorded_rows": len(generic_values),
            "exactly_one_generic_multiplier_rows": sum(value == 1.0 for value in generic_values),
            "distinct_metric_pair_comparison": volume_metric_mismatch,
        },
        "coverage": coverage,
        "primary_horizon_summary": horizons_summary,
        "closed_trigger_predeclared_bands": {
            "definition": ["[1.5,2)", "[2,3)", "[3,5)", ">=5"],
            "by_horizon": analyze_bands(rows, TRIGGER_KEY, TRIGGER_BANDS),
        },
        "generic_futures_secondary_bands": {
            "definition": ["<1", "[1,2)", "[2,3)", "[3,5)", ">=5"],
            "by_horizon_including_exact_one": analyze_bands(rows, GENERIC_KEY, GENERIC_BANDS),
            "exactly_one_rows_cohortwide": sum(value == 1.0 for value in generic_values),
            "by_horizon_excluding_exact_one_sensitivity": analyze_bands(rows, GENERIC_KEY, GENERIC_BANDS, True),
            "correlations_including_exact_one": generic_correlations,
            "correlations_excluding_exact_one_sensitivity": generic_without_one_correlations,
            "volume_only_summary_excluding_exact_one": generic_without_one_summary,
        },
        "predeclared_threshold_cuts": {
            "closed_trigger_ge_2_3_5": analyze_cuts(rows, TRIGGER_KEY),
            "generic_futures_ge_2_3_5": analyze_cuts(rows, GENERIC_KEY),
            "generic_futures_excluding_exact_one_sensitivity": {
                str(horizon): analyze_cuts(
                    [row for row in rows if not (has_metric(row, GENERIC_KEY) and float(row[GENERIC_KEY]) == 1.0)],
                    GENERIC_KEY,
                )[str(horizon)]
                for horizon in HORIZONS
            },
        },
        "ranked_associations": {
            "closed_trigger": trigger_correlations,
            "generic_futures_secondary": generic_correlations,
            "generic_futures_excluding_exact_one_sensitivity": generic_without_one_correlations,
        },
        "outlier_flag_sensitivity": {
            "metadata_flagged_extremes": flags,
            "flagged_row_count": len(flagged_rows),
            "flagged_ids": sorted(row.get("id") for row in flagged_rows),
            "warning": "The three flagged large forward paths are retained in primary results. An extreme reached later within a horizon is not automatically invalid for that horizon; exclusion is a sensitivity only.",
            "by_horizon": outlier_sensitivity,
        },
        "futures_volume_within_futures_taker_strata": combined_metric_tests(rows),
        "fail_open_missingness_at_closed_trigger_ge3": gate_fail_open_analysis(rows, 3.0),
        "eras_utc_split_at_2026_09_20": era_analysis(rows),
        "supplemental_preclose_paths": preclose_analysis(rows),
        "secondary_status_and_pnl_warning": "Tracker status and pnl_percent are descriptive snapshot fields; they are not used as primary criteria and do not establish a fill or realized trade PnL.",
        "limitations": [
            "This is a fired-only retrospective cohort with a closed-trigger-volume selection floor of 1.5x; no below-floor control cohort is present.",
            "Forward path data are observations, not fills, and maximum highs can substantially overstate attainable outcomes.",
            "No trigger or baseline absolute USD volume is exported, and no absolute futures 24-hour volume is available.",
            "The generic futures multiplier is not interchangeable with the exact closed trigger-candle multiplier; a secondary source-code inspection indicates its scanner path uses current volume versus history and can include cross-exchange confirmation/adjustment. It can reflect a forming 30m bar and is not asserted to be pure BingX for every row.",
            "The exact volume metric, futures-taker metric, and strict horizon coverage are missing for different subsets; every statistic has its own raw matched denominator.",
            "The legacy records carry incomplete entry metrics; null remains missing and was never backfilled.",
            "Correlations and threshold splits are exploratory associations, not causal effects; estimates are small-cohort, symbol-cluster bootstraps and may be unstable.",
            "The preclose export is selected to applicable non-cancelled closed rows; it is supplementary only and cannot represent all candidates or verified entered trades.",
            "No threshold recommendation, gate change, or multiple-threshold search is made.",
        ],
    }

    JSON_OUTPUT.write_text(json.dumps(result, indent=2, allow_nan=False) + "\n", encoding="utf-8")
    MARKDOWN_OUTPUT.write_text(render_markdown(result), encoding="utf-8")


def fmt(value: Any, digits: int = 2) -> str:
    if value is None:
        return "—"
    if isinstance(value, float):
        return f"{value:.{digits}f}"
    return str(value)


def pct(value: Any) -> str:
    return "—" if value is None else f"{float(value) * 100:.1f}%"


def rho_cell(value: dict[str, Any]) -> str:
    rho = value.get("spearman_rho")
    ci = value.get("cluster_bootstrap_95ci")
    if rho is None or not ci:
        return "—"
    return f"{rho:.2f} [{ci[0]:.2f}, {ci[1]:.2f}] (n={value['n']})"


def render_markdown(data: dict[str, Any]) -> str:
    integrity = data["cohort_integrity"]
    presence = data["metric_presence_and_distributions"]
    coverage = data["coverage"]
    lines = [
        "# Frozen ImpulseBuy volume analysis",
        "",
        f"**Frozen as of:** {data['created_from_frozen_export_asof_utc']}  ",
        "**Scope:** offline analysis of the frozen `cohort.json` and `metadata.json` only; no database/network/live changes.",
        "",
        "## Executive readout",
        "",
        f"- Identity check: **{integrity['row_count']} rows / {integrity['unique_tracker_id_count']} unique IDs**, including every exported status; this is not evidence of {integrity['row_count']} fills.",
        f"- Exact closed-trigger volume: **{presence['closed_trigger_volume_multiplier_recorded_rows']}/{integrity['row_count']}** recorded; generic `entry_fut_vol_mult`: **{presence['generic_futures_volume_multiplier_recorded_rows']}/{integrity['row_count']}**. Their paired count is **{presence['distinct_metric_pair_comparison']['paired_rows']}**; only **{presence['distinct_metric_pair_comparison']['rows_equal_within_0_01x']}** paired values agree within 0.01x. They are not interchangeable.",
        f"- Absolute closed-trigger and baseline USD volumes are both unavailable (**{presence['trigger_absolute_volume_usd_rows']}** rows each); absolute futures 24h volume is not in this export.",
        "- Outcome priority is frozen 15-minute forward maximum-high / +5% / +10% path hits on strict mature, gap-free windows—not PnL and not fills.",
        "- The exact trigger is selected by a 1.5x fire gate: below-1.5 behavior is unidentifiable from fired rows. No causal claim or gate recommendation follows.",
        "- Across all strict paths, median peak rose from **2.12% at 1h** to **4.80% at 6h**, **6.65% at 24h**, and **10.22% at 72h** (the longer maximum-high window naturally has more time to rise).",
        "- Generic-volume ranked association is positive at 1/3/6h (Spearman **0.31/0.38/0.33**, symbol-cluster 95% intervals exclude zero); the exact closed trigger is essentially uncorrelated with peak over those windows (**0.01/-0.01/-0.01**, intervals cross zero). This is not a same-metric comparison and the generic series is secondary/semantically mixed.",
        "- A predeclared exact-trigger >=3x split did not improve the observed +10% hit rate: **14.3% vs 19.6% by 6h (n=14 vs 46)** and **28.6% vs 61.5% by 72h (n=14 vs 39)**. Small bins and fired-cohort selection prevent threshold claims.",
        "- At 6h, trigger >=3x also failed to improve +10 rates inside either available futures-taker sign stratum: **20.0% vs 21.7% for taker >0 (n=5 vs 23)** and **11.1% vs 18.2% for taker <0 (n=9 vs 22)**. The >=3x plus taker>=0 combination is only **n=5**; the >=20% net-buy combination has **n=0** in the strict matched data.",
        "",
        "## Export integrity and coverage",
        "",
        f"- Export window: {integrity['first_detected_at_utc']} to {integrity['last_detected_at_utc']}. Legacy rows: {integrity['legacy_rows']}; reclassified status rows: {integrity['reclassified_rows']}. All statuses: `{json.dumps(integrity['status_counts'], sort_keys=True)}`.",
        "- Every horizon below uses an independent strict denominator. No assumption is made that all 188 paths are mature or gap-free.",
        "",
        "| Horizon | Mature at capture | Strict mature + gap-free | Exact trigger metric | Generic futures metric | Futures taker |",
        "|---:|---:|---:|---:|---:|---:|",
    ]
    for horizon in HORIZONS:
        cov = coverage[str(horizon)]
        avail = cov["available_metric_rows"]
        lines.append(
            f"| {horizon}h | {cov['mature_at_capture_rows']}/{cov['cohort_rows']} | "
            f"{cov['strict_mature_gapfree_rows']}/{cov['cohort_rows']} | "
            f"{avail['closed_trigger_volume']} | {avail['generic_futures_volume']} | {avail['futures_taker']} |"
        )

    lines += [
        "",
        "## Horizon outcomes (primary exact trigger, generic metric secondary)",
        "",
        "Each metric column has its own strict-window-and-metric-present denominator. +5/+10 denote forward high reached.",
        "",
        "| Horizon | Strict cohort peak median / +5 / +10 | Closed trigger peak median / +5 / +10 | Generic futures peak median / +5 / +10 |",
        "|---:|---|---|---|",
    ]
    for horizon in PRIMARY_HORIZONS:
        item = data["primary_horizon_summary"][str(horizon)]
        def outcome_cell(stats: dict[str, Any]) -> str:
            return (
                f"{fmt(stats['median_peak_pct'])}% / {stats['hit_plus5_count']}/{stats['n']} "
                f"({pct(stats['hit_plus5_rate'])}) / {stats['hit_plus10_count']}/{stats['n']} "
                f"({pct(stats['hit_plus10_rate'])})"
            )
        lines.append(
            f"| {horizon}h | {outcome_cell(item['full_cohort_forward_paths'])} | "
            f"{outcome_cell(item['closed_trigger_metric_available'])} | "
            f"{outcome_cell(item['generic_futures_metric_available'])} |"
        )
    lines += [
        "",
        "### Spearman rank correlations with forward peak",
        "",
        "Cell is Spearman rho [symbol-cluster bootstrap 95% CI] (n). Binary +5/+10 correlations and CIs are included in JSON.",
        "",
        "| Horizon | Closed trigger | Generic futures secondary | Generic excluding exact 1 |",
        "|---:|---:|---:|---:|",
    ]
    for horizon in PRIMARY_HORIZONS:
        lines.append(
            f"| {horizon}h | {rho_cell(data['ranked_associations']['closed_trigger'][str(horizon)]['forward_peak_pct'])} | "
            f"{rho_cell(data['ranked_associations']['generic_futures_secondary'][str(horizon)]['forward_peak_pct'])} | "
            f"{rho_cell(data['ranked_associations']['generic_futures_excluding_exact_one_sensitivity'][str(horizon)]['forward_peak_pct'])} |"
        )

    lines += [
        "",
        "## Predeclared volume bands",
        "",
        "Cells are n / median forward peak / +5 count / +10 count. Bands are fixed in advance; fired-cohort trigger bands start at 1.5x by construction.",
        "",
        "### Exact closed-trigger volume bands",
        "",
        "| Horizon | Band | n | Median peak % | +5 hits | +10 hits |",
        "|---:|---|---:|---:|---:|---:|",
    ]
    trigger_bands = data["closed_trigger_predeclared_bands"]["by_horizon"]
    for horizon in PRIMARY_HORIZONS:
        for label, _lower, _upper in TRIGGER_BANDS:
            cell = trigger_bands[str(horizon)][label]
            lines.append(f"| {horizon}h | {label}x | {cell['n']} | {fmt(cell['median_peak_pct'])} | {cell['hit_plus5_count']} | {cell['hit_plus10_count']} |")
    lines += [
        "",
        "### Generic futures-volume bands (secondary)",
        "",
        "| Horizon | Band | n | Median peak % | +5 hits | +10 hits |",
        "|---:|---|---:|---:|---:|---:|",
    ]
    generic_bands = data["generic_futures_secondary_bands"]["by_horizon_including_exact_one"]
    for horizon in PRIMARY_HORIZONS:
        for label, _lower, _upper in GENERIC_BANDS:
            cell = generic_bands[str(horizon)][label]
            lines.append(f"| {horizon}h | {label}x | {cell['n']} | {fmt(cell['median_peak_pct'])} | {cell['hit_plus5_count']} | {cell['hit_plus10_count']} |")
    exact_one_n = data["generic_futures_secondary_bands"]["exactly_one_rows_cohortwide"]
    lines += [
        "",
        f"Generic multiplier has **{exact_one_n} exact-1.0x rows**; treat this point cautiously as a possible default/placeholder. JSON gives full band and threshold results both with and without exact 1.0x.",
        "",
        "## Predeclared threshold splits",
        "",
        "These are unadjusted observational comparisons of +10% path-hit rates. Raw high/below denominators and complete hit/peak summaries for every horizon are in JSON.",
        "",
        "| Metric | Horizon | Cut | >= cut +10 | Below cut +10 | Difference (pp) |",
        "|---|---:|---:|---:|---:|---:|",
    ]
    for metric_label, key in (("Closed trigger", "closed_trigger_ge_2_3_5"), ("Generic futures", "generic_futures_ge_2_3_5")):
        cuts = data["predeclared_threshold_cuts"][key]
        for horizon in PRIMARY_HORIZONS:
            for cut in ("2.0", "3.0", "5.0"):
                item = cuts[str(horizon)][cut]
                hi = item["high"]
                lo = item["below"]
                diff = item["plus10_rate_difference_high_minus_below"]
                lines.append(
                    f"| {metric_label} | {horizon}h | {cut}x | {hi['hit_plus10_count']}/{hi['n']} ({pct(hi['hit_plus10_rate'])}) | "
                    f"{lo['hit_plus10_count']}/{lo['n']} ({pct(lo['hit_plus10_rate'])}) | {fmt(diff * 100 if diff is not None else None, 1)} |"
                )

    lines += [
        "",
        "## Closed-trigger volume within futures-taker strata",
        "",
        "Both exact metrics must be present, and each horizon must pass strict path coverage. Futures taker values are net-buy percentages, not buy shares.",
        "",
        "| Horizon | Taker stratum | Closed >=3: +10 / n | Closed <3: +10 / n | Rate difference (pp) |",
        "|---:|---|---:|---:|---:|",
    ]
    strata = data["futures_volume_within_futures_taker_strata"]["taker_strata"]
    for horizon in PRIMARY_HORIZONS:
        for label in ("positive_gt0", "negative_lt0", "zero"):
            item = strata[str(horizon)]["strata"][label]
            high = item["closed_trigger_ge3"]
            low = item["closed_trigger_below3"]
            diff = item["plus10_rate_difference_ge3_minus_below3"]
            lines.append(
                f"| {horizon}h | {label} | {high['hit_plus10_count']}/{high['n']} ({pct(high['hit_plus10_rate'])}) | "
                f"{low['hit_plus10_count']}/{low['n']} ({pct(low['hit_plus10_rate'])}) | "
                f"{fmt(diff * 100 if diff is not None else None, 1)} |"
            )
    lines += [
        "",
        "### Combined closed-volume and taker splits",
        "",
        "| Horizon | Condition | Condition group n; +10 rate | Matched complement n; +10 rate |",
        "|---:|---|---:|---:|",
    ]
    combos = data["futures_volume_within_futures_taker_strata"]["combined_conditions"]
    for horizon in PRIMARY_HORIZONS:
        for condition in ("closed_ge3_and_taker_ge0", "closed_ge3_and_taker_ge20"):
            item = combos[str(horizon)]["conditions"][condition]
            yes = item["condition_group"]
            no = item["matched_complement"]
            lines.append(
                f"| {horizon}h | {condition} | {yes['n']}; {yes['hit_plus10_count']}/{yes['n']} ({pct(yes['hit_plus10_rate'])}) | "
                f"{no['n']}; {no['hit_plus10_count']}/{no['n']} ({pct(no['hit_plus10_rate'])}) |"
            )

    lines += [
        "",
        "## Missing-metric fail-open cost at closed-trigger >=3x",
        "",
        "Winner means a strict forward +10% high by the stated horizon. Fail-open retains rows when the exact volume metric is missing; the second case below is strict fail-closed. “Upside” is a path-peak percentage-point proxy, not realized return or dollars.",
        "",
        "| Horizon | Strict denominator | +10 winners | Missing-metric winners | Fail-open retained winners | Fail-open lost winners | Strict fail-closed lost winners | Fail-open lost-winner peak-upside sum (pp) |",
        "|---:|---:|---:|---:|---:|---:|---:|---:|",
    ]
    for horizon in (6, 24, 72):
        item = data["fail_open_missingness_at_closed_trigger_ge3"][str(horizon)]
        lines.append(
            f"| {horizon}h | {item['raw_mature_gapfree_denominator']} | {item['winner_plus10_denominator']} | "
            f"{item['trigger_metric_missing_winners']} | {item['known_ge_cutoff_winners_retained'] + item['missing_winners_retained_by_fail_open']} | "
            f"{item['fail_open_winners_lost']} | {item['strict_fail_closed_winners_lost_including_missing']} | "
            f"{fmt(item['fail_open_lost_winner_peak_upside_pct_sum'])} |"
        )
    lines += [
        "",
        "Secondary cost audit: metric-known below-cutoff non-winners numbered **37 / 22 / 15** at 6/24/72h; among rows with tracker PnL, negative-PnL counts were **21 / 16 / 11** and summed to **-108.1 / -85.3 / -69.8 percentage points**. These are status/PnL snapshot diagnostics—not verified fills, realized gate savings, or primary outcomes.",
        "",
        "## Early vs late era (late begins 2026-09-20 00:00 UTC)",
        "",
        "Entry policy is descriptive only—not a gate-version stratifier. The cohort has no entry-gate-version field.",
        "",
        "| Era | Rows | Exact trigger metric | Generic volume metric | All three metrics | 6h strict n | 6h exact +10 | 24h strict n | 24h exact +10 | 72h strict n | 72h exact +10 |",
        "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    ]
    eras = data["eras_utc_split_at_2026_09_20"]
    for era, label in (("before_2026-09-20_utc", "Before Sep 20"), ("on_or_after_2026-09-20_utc", "Sep 20 onward")):
        item = eras[era]
        cells = []
        for horizon in (6, 24, 72):
            stats = item["horizons"][str(horizon)]
            exact = stats["closed_trigger"]
            cells.extend([str(stats["mature_gapfree_n"]), f"{exact['hit_plus10_count']}/{exact['n']}"])
        lines.append(
            f"| {label} | {item['n']} | {item['metric_presence_counts']['closed_trigger_metric']} | "
            f"{item['metric_presence_counts']['generic_futures_volume_metric']} | {item['metric_presence_counts']['all_three_matched']} | "
            + " | ".join(cells)
            + " |"
        )
    lines += [
        "",
        "Full six-horizon era outcomes, status counts, and entry-policy-version counts are in JSON. Small late-era counts are descriptive; not a policy comparison.",
        "",
        "## Outlier-flag sensitivity and preclose separation",
        "",
        f"- Metadata identifies {data['outlier_flag_sensitivity']['flagged_row_count']} large-path flagged rows: `{', '.join(str(value) for value in data['outlier_flag_sensitivity']['flagged_ids'])}`. They remain in the primary analysis. A later extreme occurring inside a 6h window is not automatically classified as erroneous.",
        "- JSON gives the strict forward path and Spearman/cluster-CI sensitivity with those flagged rows omitted, for both volume metrics and every horizon.",
        "- Preclose is strictly supplemental and comes only from applicable, complete, **non-cancelled closed-row** windows. The exporter excludes every `cancelled` status, not merely cancellations known to have no entry; this subset is not all actual entries. It is compared with full forward paths on its own matched subset and is never substituted for the primary symmetric cohort.",
        "",
        "| Horizon | Applicable preclose rows also strict forward | Preclose +5 / +10 | Same rows full-forward +5 / +10 |",
        "|---:|---:|---|---|",
    ]
    preclose = data["supplemental_preclose_paths"]
    for horizon in PRIMARY_HORIZONS:
        item = preclose[str(horizon)]
        n = item["mature_gapfree_forward_rows_with_applicable_gapfree_preclose_path"]
        lines.append(
            f"| {horizon}h | {n} | {item['preclose_plus5_count']}/{n} ({pct(item['preclose_plus5_rate'])}) / "
            f"{item['preclose_plus10_count']}/{n} ({pct(item['preclose_plus10_rate'])}) | "
            f"{item['same_matched_rows_full_forward_plus5_count']}/{n} ({pct(item['same_matched_rows_full_forward_plus5_rate'])}) / "
            f"{item['same_matched_rows_full_forward_plus10_count']}/{n} ({pct(item['same_matched_rows_full_forward_plus10_rate'])}) |"
        )
    lines += [
        "",
        "## Metric semantics, caveats, and decision boundary",
        "",
        "- **Exact trigger volume is primary.** In the source inspection, the impulse path selects the last closed 30m candle, divides its quote-volume estimate by the mean quote volume of the 20 previous closed 30m candles, and requires >=1.5x. The frozen cohort recorded this multiplier for only 61/188; its absolute trigger/baseline USD fields are empty for all rows.",
        "- **Generic `entry_fut_vol_mult` is secondary only.** The inspected scanner path persists a separate generic multiplier from current volume versus its historical average; that current 30m bar may still be forming, and code around the futures-volume calculation can apply cross-exchange confirmation/adjustment. This is not asserted to be a pure BingX observation for every historical row, and it is not identical to the closed 30m trigger ratio.",
        "- Futures taker is net-buy percentage: `(buy - sell)/(buy + sell) * 100`; a value of 0 is neutral, not a 50% buy share.",
        "- The source inspection explains metric semantics only; all calculations here come from the two frozen exports. The current source cannot establish every historical row's runtime branch.",
        "- The analysis is exploratory, fired-only, coverage-conditioned, small-sample, non-causal, and does not justify a live gate edit. No threshold was selected by searching many cutoffs.",
        "",
        "## Reproducibility",
        "",
        "Run python3 .local/reports/ib-taker-volume-2026-10-01/volume-analysis.py. It reads only the two frozen JSON inputs beside the script and rewrites volume-analysis.json and volume-analysis.md there. Bootstrap seed is fixed at 20261001.",
    ]
    return "\n".join(lines) + "\n"


if __name__ == "__main__":
    main()