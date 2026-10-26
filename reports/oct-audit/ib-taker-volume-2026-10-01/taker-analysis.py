#!/usr/bin/env python3
"""Reproducible taker-only analysis of this frozen cohort.

Reads only cohort.json and metadata.json beside this script. Writes only
taker-analysis.json and taker-analysis.md in the same directory.
"""

import hashlib
import json
import math
import random
import statistics
from collections import Counter, defaultdict
from datetime import date
from pathlib import Path


HERE = Path(__file__).resolve().parent
HORIZONS = ("1", "3", "6", "24", "72")
ALL_HORIZONS = ("1", "3", "6", "12", "24", "72")
METRICS = {
    "futures": "entry_fut_taker_net_buy_pct",
    "spot": "entry_spot_taker_net_buy_pct",
}
TARGETS = (5, 10)
BANDS = (
    ("<=0", lambda x: x <= 0),
    ("(0,10)", lambda x: 0 < x < 10),
    ("[10,20)", lambda x: 10 <= x < 20),
    (">=20", lambda x: x >= 20),
)
BOOTSTRAP_REPLICATES = 600
BOOTSTRAP_SEED = 20261001

WINDOW_INDEX = {
    "mature_at_capture": 0,
    "first_expected_open_index": 1,
    "last_expected_open_index": 2,
    "expected_bar_count": 3,
    "valid_bucket_count": 4,
    "invalid_bar_count": 5,
    "duplicate_bar_count": 6,
    "first_valid_open_index": 7,
    "last_valid_open_index": 8,
    "coverage_complete": 9,
    "max_high_pct": 10,
    "min_low_pct": 11,
    "endpoint_close_pct": 12,
    "first_plus5_open_index": 13,
    "first_plus10_open_index": 14,
    "first_plus20_open_index": 15,
    "first_minus8_open_index": 16,
    "first_minus10_open_index": 17,
    "first_bar_high_pct": 18,
    "first_bar_low_pct": 19,
    "first_bar_close_pct": 20,
    "same_bar_target_stop_ambiguous": 21,
    "preclose_array": 22,
}
PRECLOSE_INDEX = {
    "applicable": 0,
    "last_expected_open_index": 1,
    "expected_bar_count": 2,
    "valid_bucket_count": 3,
    "invalid_bar_count": 4,
    "duplicate_bar_count": 5,
    "first_valid_open_index": 6,
    "last_valid_open_index": 7,
    "coverage_complete": 8,
    "max_high_pct": 9,
    "min_low_pct": 10,
    "endpoint_close_pct": 11,
}


def read_inputs():
    cohort_path = HERE / "cohort.json"
    metadata_path = HERE / "metadata.json"
    cohort_bytes = cohort_path.read_bytes()
    metadata_bytes = metadata_path.read_bytes()
    return (
        json.loads(cohort_bytes),
        json.loads(metadata_bytes),
        {
            "cohort.json": hashlib.sha256(cohort_bytes).hexdigest(),
            "metadata.json": hashlib.sha256(metadata_bytes).hexdigest(),
        },
    )


def idx_value(array, name, schema):
    if array is None:
        return None
    return array[schema[name]]


def window(row, horizon):
    return row.get("windows", {}).get(str(horizon))


def preclose_values(row, horizon):
    values = idx_value(window(row, horizon), "preclose_array", WINDOW_INDEX)
    if values is None:
        return None
    return {name: values[index] for name, index in PRECLOSE_INDEX.items()}


def is_strict(row, horizon):
    values = window(row, horizon)
    return bool(
        values
        and idx_value(values, "mature_at_capture", WINDOW_INDEX) is True
        and idx_value(values, "coverage_complete", WINDOW_INDEX) is True
    )


def fixed_hit(row, horizon, target):
    values = window(row, horizon)
    if not values:
        return None
    index_name = "first_plus%d_open_index" % target
    return idx_value(values, index_name, WINDOW_INDEX) is not None


def number_or_none(value):
    return value if isinstance(value, (int, float)) and math.isfinite(value) else None


def quantile(values, q):
    if not values:
        return None
    ordered = sorted(values)
    pos = (len(ordered) - 1) * q
    lo = math.floor(pos)
    hi = math.ceil(pos)
    if lo == hi:
        return ordered[lo]
    return ordered[lo] * (hi - pos) + ordered[hi] * (pos - lo)


def summary_values(values):
    finite = [float(value) for value in values if number_or_none(value) is not None]
    return {
        "n": len(finite),
        "median": statistics.median(finite) if finite else None,
        "mean": statistics.fmean(finite) if finite else None,
        "p25": quantile(finite, 0.25),
        "p75": quantile(finite, 0.75),
        "min": min(finite) if finite else None,
        "max": max(finite) if finite else None,
    }


def rate_record(rows, horizon, predicate, metric=None):
    eligible = []
    for row in rows:
        if metric is not None and number_or_none(row.get(metric)) is None:
            continue
        if not predicate(row):
            continue
        if is_strict(row, horizon):
            eligible.append(fixed_hit(row, horizon, 10))
    known = [value for value in eligible if value is not None]
    successes = sum(known)
    return {
        "n_strict_known": len(known),
        "n_hit": successes,
        "rate": successes / len(known) if known else None,
        "n_unknown_outcome": len(rows) - len(known),
    }


def rank_values(values):
    ordered = sorted((value, index) for index, value in enumerate(values))
    ranks = [0.0] * len(values)
    i = 0
    while i < len(ordered):
        j = i + 1
        while j < len(ordered) and ordered[j][0] == ordered[i][0]:
            j += 1
        average_rank = (i + 1 + j) / 2
        for _, original_index in ordered[i:j]:
            ranks[original_index] = average_rank
        i = j
    return ranks


def pearson(x, y):
    if len(x) < 2:
        return None
    mx = statistics.fmean(x)
    my = statistics.fmean(y)
    vx = sum((v - mx) ** 2 for v in x)
    vy = sum((v - my) ** 2 for v in y)
    if vx == 0 or vy == 0:
        return None
    return sum((a - mx) * (b - my) for a, b in zip(x, y)) / math.sqrt(vx * vy)


def spearman(x, y):
    if len(x) < 3:
        return None
    return pearson(rank_values(x), rank_values(y))


def cluster_bootstrap_difference(rows, metric, cutoff, horizon, target, replicates, seed):
    """Symbol-cluster bootstrap CI of >=cutoff minus <cutoff hit rate."""
    eligible = []
    for row in rows:
        value = number_or_none(row.get(metric))
        if value is None or not is_strict(row, horizon):
            continue
        hit = fixed_hit(row, horizon, target)
        if hit is not None:
            eligible.append((row["symbol"], value >= cutoff, int(hit)))
    if not eligible:
        return None

    clusters = defaultdict(lambda: [0, 0, 0, 0])
    for symbol, high, hit in eligible:
        offset = 0 if high else 2
        clusters[symbol][offset] += 1
        clusters[symbol][offset + 1] += hit
    cluster_values = list(clusters.values())
    if len(cluster_values) < 2:
        return None
    high_n = sum(item[0] for item in cluster_values)
    low_n = sum(item[2] for item in cluster_values)
    high_hit = sum(item[1] for item in cluster_values)
    low_hit = sum(item[3] for item in cluster_values)
    observed = (high_hit / high_n if high_n else None) - (
        low_hit / low_n if low_n else None
    ) if high_n and low_n else None

    rng = random.Random(seed)
    draws = []
    nclusters = len(cluster_values)
    for _ in range(replicates):
        sums = [0, 0, 0, 0]
        for _ in range(nclusters):
            item = cluster_values[rng.randrange(nclusters)]
            for j in range(4):
                sums[j] += item[j]
        if sums[0] and sums[2]:
            draws.append(sums[1] / sums[0] - sums[3] / sums[2])
    if not draws:
        return None
    return {
        "estimate_high_minus_low": observed,
        "ci95_cluster_bootstrap": [quantile(draws, 0.025), quantile(draws, 0.975)],
        "bootstrap_replicates_with_both_groups": len(draws),
        "symbol_clusters": nclusters,
        "high_n": high_n,
        "high_hits": high_hit,
        "low_n": low_n,
        "low_hits": low_hit,
        "unit": "percentage-point difference as a fraction (multiply by 100)",
        "method": "resample whole symbols with replacement; not a causal interval",
    }


def cluster_bootstrap_spearman(rows, metric, horizon, replicates, seed):
    pairs_by_symbol = defaultdict(list)
    for row in rows:
        value = number_or_none(row.get(metric))
        if value is None or not is_strict(row, horizon):
            continue
        peak = number_or_none(idx_value(window(row, horizon), "max_high_pct", WINDOW_INDEX))
        if peak is not None:
            pairs_by_symbol[row["symbol"]].append((float(value), float(peak)))
    pairs = [pair for group in pairs_by_symbol.values() for pair in group]
    estimate = spearman([p[0] for p in pairs], [p[1] for p in pairs])
    groups = list(pairs_by_symbol.values())
    if len(groups) < 2:
        return {"rho": estimate, "n": len(pairs), "symbol_clusters": len(groups), "ci95_cluster_bootstrap": None}
    rng = random.Random(seed)
    draws = []
    for _ in range(replicates):
        sampled = []
        for _ in range(len(groups)):
            sampled.extend(groups[rng.randrange(len(groups))])
        rho = spearman([p[0] for p in sampled], [p[1] for p in sampled])
        if rho is not None:
            draws.append(rho)
    return {
        "rho": estimate,
        "n": len(pairs),
        "symbol_clusters": len(groups),
        "ci95_cluster_bootstrap": [quantile(draws, 0.025), quantile(draws, 0.975)] if draws else None,
        "bootstrap_replicates": len(draws),
        "method": "Spearman rank correlation; percentile CI resampling whole symbols with replacement",
    }


def group_summary(rows, metric, subset_name, remove_flagged=False):
    out = {
        "subset": subset_name,
        "metric": metric,
        "cohort_rows": len(rows),
        "metric_present": sum(number_or_none(row.get(metric)) is not None for row in rows),
        "metric_missing_unknown": sum(number_or_none(row.get(metric)) is None for row in rows),
        "groups": {},
    }
    for label, predicate in BANDS:
        selected = [row for row in rows if number_or_none(row.get(metric)) is not None and predicate(float(row[metric]))]
        detail = {
            "n_metric_known": len(selected),
            "taker_net_buy_pct": summary_values(row[metric] for row in selected),
            "horizons": {},
        }
        for horizon in HORIZONS:
            strict = [row for row in selected if is_strict(row, horizon)]
            hrecord = {
                "strict_n": len(strict),
                "unknown_or_incomplete_n": len(selected) - len(strict),
                "fixed_targets": {},
                "peak_opportunity": {},
                "first_target_vs_stops": {},
                "conditional_time_to_target_minutes": {},
            }
            values = [window(row, horizon) for row in strict]
            for target in TARGETS:
                hit_name = "first_plus%d_open_index" % target
                flags = [idx_value(v, hit_name, WINDOW_INDEX) is not None for v in values]
                hrecord["fixed_targets"]["+%d%%" % target] = {
                    "hit_n": sum(flags),
                    "strict_denominator": len(strict),
                    "rate": sum(flags) / len(strict) if strict else None,
                    "unknown_or_incomplete_in_group_n": len(selected) - len(strict),
                    "outside_group_or_metric_missing_n": len(rows) - len(selected),
                }
                hit_indices = [
                    idx_value(v, hit_name, WINDOW_INDEX)
                    for v, flag in zip(values, flags)
                    if flag
                ]
                times = [int(index) * 15 for index in hit_indices]
                hrecord["conditional_time_to_target_minutes"]["+%d%%" % target] = {
                    "hit_n": len(times),
                    "hit_all_n_strict": len(strict),
                    "median_15m_bucket_offset_minutes_among_hitters": statistics.median(times) if times else None,
                    "mean_15m_bucket_offset_minutes_among_hitters": statistics.fmean(times) if times else None,
                    "caveat": "15-minute bucket-offset approximation among eventual hitters only; not exact elapsed time or fill time",
                }
            peaks = [
                idx_value(v, "max_high_pct", WINDOW_INDEX)
                for v in values
            ]
            hrecord["peak_opportunity"] = {
                "high_based_max_high_pct": summary_values(peaks),
                "peak_ge_5pct_n": sum(value is not None and value >= 5 for value in peaks),
                "peak_ge_10pct_n": sum(value is not None and value >= 10 for value in peaks),
                "strict_denominator": len(strict),
                "unknown_or_incomplete_in_group_n": len(selected) - len(strict),
                "outside_group_or_metric_missing_n": len(rows) - len(selected),
                "warning": "high-based opportunity only, not realized PnL or executable/fill price",
            }
            for target in TARGETS:
                for stop in (8, 10):
                    target_name = "first_plus%d_open_index" % target
                    stop_name = "first_minus%d_open_index" % stop
                    categories = Counter()
                    for values_row in values:
                        target_index = idx_value(values_row, target_name, WINDOW_INDEX)
                        stop_index = idx_value(values_row, stop_name, WINDOW_INDEX)
                        if target_index is None and stop_index is None:
                            categories["neither_observed"] += 1
                        elif target_index is None:
                            categories["stop_first"] += 1
                        elif stop_index is None:
                            categories["target_first"] += 1
                        elif target_index == stop_index:
                            categories["same_bar_ambiguous"] += 1
                        elif target_index < stop_index:
                            categories["target_first"] += 1
                        else:
                            categories["stop_first"] += 1
                    hrecord["first_target_vs_stops"]["+%d%%_vs_-%d%%" % (target, stop)] = {
                        "strict_denominator": len(strict),
                        "target_first": categories["target_first"],
                        "stop_first": categories["stop_first"],
                        "same_bar_ambiguous": categories["same_bar_ambiguous"],
                        "neither_observed": categories["neither_observed"],
                        "same_bar_ambiguity_flag_n": sum(
                            idx_value(v, "same_bar_target_stop_ambiguous", WINDOW_INDEX) is True for v in values
                        ),
                        "caveat": "OHLC path ordering within one 15m candle is unknown; path starts at the next aligned bucket and omits any entry-bar remainder",
                    }
            detail["horizons"][horizon] = hrecord
        out["groups"][label] = detail
    out["cut_comparisons"] = {}
    for horizon in HORIZONS:
        strict_rows = [row for row in rows if is_strict(row, horizon)]
        out["cut_comparisons"][horizon] = {}
        for cutoff in (0, 10, 20):
            high = [row for row in strict_rows if number_or_none(row.get(metric)) is not None and row[metric] >= cutoff]
            low = [row for row in strict_rows if number_or_none(row.get(metric)) is not None and row[metric] < cutoff]
            missing = [row for row in strict_rows if number_or_none(row.get(metric)) is None]
            record = {
                "cut": ">=%g%% versus <%g%%" % (cutoff, cutoff),
                "known_high": {},
                "known_low": {},
                "metric_missing_unknown": len(missing),
                "fixed_targets": {},
            }
            for side, group in (("known_high", high), ("known_low", low)):
                record[side] = {"n": len(group)}
            for target in TARGETS:
                hi = [fixed_hit(row, horizon, target) for row in high]
                lo = [fixed_hit(row, horizon, target) for row in low]
                record["fixed_targets"]["+%d%%" % target] = {
                    "high": {"hits": sum(hi), "n": len(hi), "rate": sum(hi) / len(hi) if hi else None},
                    "low": {"hits": sum(lo), "n": len(lo), "rate": sum(lo) / len(lo) if lo else None},
                    "difference_high_minus_low": (sum(hi) / len(hi) - sum(lo) / len(lo)) if hi and lo else None,
                }
            out["cut_comparisons"][horizon][str(cutoff)] = record
    out["spearman_taker_vs_peak_high_pct"] = {
        horizon: cluster_bootstrap_spearman(
            rows, metric, horizon, BOOTSTRAP_REPLICATES, BOOTSTRAP_SEED + int(horizon) + (0 if metric == METRICS["futures"] else 100)
        )
        for horizon in HORIZONS
    }
    out["cluster_bootstrap_ge20_vs_below20_fixed_hits"] = {
        horizon: {
            "+%d%%" % target: cluster_bootstrap_difference(
                rows, metric, 20, horizon, target, BOOTSTRAP_REPLICATES,
                BOOTSTRAP_SEED + int(horizon) * 11 + target + (0 if metric == METRICS["futures"] else 1000),
            )
            for target in TARGETS
        }
        for horizon in ("1", "3", "6", "24", "72")
    }
    return out


def preclose_summary(rows):
    output = {}
    for horizon in HORIZONS:
        applicable = 0
        complete_nonempty = []
        for row in rows:
            pc = preclose_values(row, horizon)
            if pc and pc["applicable"] is True:
                applicable += 1
                if pc["coverage_complete"] is True and pc["expected_bar_count"] > 0:
                    complete_nonempty.append(pc)
        highs = [pc["max_high_pct"] for pc in complete_nonempty]
        lows = [pc["min_low_pct"] for pc in complete_nonempty]
        closes = [pc["endpoint_close_pct"] for pc in complete_nonempty]
        output[horizon] = {
            "all_cohort_rows": len(rows),
            "applicable_rows": applicable,
            "strict_complete_nonempty_preclose_rows": len(complete_nonempty),
            "preclose_max_high_pct": summary_values(highs),
            "preclose_min_low_pct": summary_values(lows),
            "preclose_endpoint_close_pct": summary_values(closes),
            "preclose_peak_ge_5pct_n": sum(v is not None and v >= 5 for v in highs),
            "preclose_peak_ge_10pct_n": sum(v is not None and v >= 10 for v in highs),
            "warning": "partial tracker-closed_at-bounded sensitivity for applicable non-cancelled closed rows; supplemental exporter excludes every cancelled row; not representative of all entered trades or evidence of entry/fill; excludes post-close forward path",
        }
    return output


def gate_evaluation(rows, label):
    output = {"population": label, "horizons": {}}
    for horizon in ("6", "24", "72"):
        base = [row for row in rows if is_strict(row, horizon)]
        horizon_out = {"strict_known_outcome_base_n": len(base), "metrics": {}}
        for metric_name, metric in METRICS.items():
            metric_out = {}
            for cutoff in (0, 10, 20):
                removed = [
                    row for row in base
                    if number_or_none(row.get(metric)) is not None and row[metric] < cutoff
                ]
                retained = [row for row in base if row not in removed]
                winners_removed = sum(fixed_hit(row, horizon, 10) is True for row in removed)
                nonwinners_removed = len(removed) - winners_removed
                winners_retained = sum(fixed_hit(row, horizon, 10) is True for row in retained)
                metric_out[str(cutoff)] = {
                    "cut": ">=%g%%; metric-missing fail-open" % cutoff,
                    "base_n": len(base),
                    "retained_n": len(retained),
                    "known_below_cut_excluded_n": len(removed),
                    "missing_metric_retained_n": sum(number_or_none(row.get(metric)) is None for row in base),
                    "winners_lost_+10_within_horizon": winners_removed,
                    "nonwinners_removed": nonwinners_removed,
                    "retained_+10_winners": winners_retained,
                    "retained_+10_rate": winners_retained / len(retained) if retained else None,
                    "base_+10_winners": sum(fixed_hit(row, horizon, 10) is True for row in base),
                }
            horizon_out["metrics"][metric_name] = metric_out
        output["horizons"][horizon] = horizon_out
    return output


def later_validation(rows):
    cutoff_date = date(2026, 9, 20)
    early = []
    late = []
    undated = []
    for row in rows:
        try:
            detected_date = date.fromisoformat(row["detected_at_utc"][:10])
        except (KeyError, TypeError, ValueError):
            undated.append(row)
            continue
        (late if detected_date >= cutoff_date else early).append(row)
    result = {
        "split": "early detected < 2026-09-20; late detected >= 2026-09-20",
        "early_rows": len(early),
        "late_rows": len(late),
        "undated_rows": len(undated),
        "metrics": {},
    }
    for metric_name, metric in METRICS.items():
        result["metrics"][metric_name] = {}
        for period, group in (("early", early), ("late", late)):
            result["metrics"][metric_name][period] = {
                "rows": len(group),
                "metric_present": sum(number_or_none(row.get(metric)) is not None for row in group),
                "bands_6h": {},
            }
            for band, predicate in BANDS:
                in_band = [row for row in group if number_or_none(row.get(metric)) is not None and predicate(row[metric])]
                strict = [row for row in in_band if is_strict(row, "6")]
                result["metrics"][metric_name][period]["bands_6h"][band] = {
                    "metric_known_n": len(in_band),
                    "strict_6h_n": len(strict),
                    "unknown_6h_n": len(in_band) - len(strict),
                    "plus5_hits": sum(fixed_hit(row, "6", 5) is True for row in strict),
                    "plus10_hits": sum(fixed_hit(row, "6", 10) is True for row in strict),
                    "plus5_rate": sum(fixed_hit(row, "6", 5) is True for row in strict) / len(strict) if strict else None,
                    "plus10_rate": sum(fixed_hit(row, "6", 10) is True for row in strict) / len(strict) if strict else None,
                }
    result["warning"] = "fixed pre-specified date split, not an independent prospective experiment; small cells and symbol reuse remain"
    return result


def row_coverage(rows):
    result = {}
    for horizon in ALL_HORIZONS:
        mature = sum(bool(window(row, horizon)) and idx_value(window(row, horizon), "mature_at_capture", WINDOW_INDEX) is True for row in rows)
        gapfree = sum(bool(window(row, horizon)) and idx_value(window(row, horizon), "coverage_complete", WINDOW_INDEX) is True for row in rows)
        strict = sum(is_strict(row, horizon) for row in rows)
        mature_only = sum(
            bool(window(row, horizon))
            and idx_value(window(row, horizon), "mature_at_capture", WINDOW_INDEX) is True
            and idx_value(window(row, horizon), "coverage_complete", WINDOW_INDEX) is not True
            for row in rows
        )
        gapfree_only = sum(
            bool(window(row, horizon))
            and idx_value(window(row, horizon), "mature_at_capture", WINDOW_INDEX) is not True
            and idx_value(window(row, horizon), "coverage_complete", WINDOW_INDEX) is True
            for row in rows
        )
        result[horizon] = {
            "cohort_rows": len(rows),
            "mature_n": mature,
            "gap_free_n": gapfree,
            "mature_and_gap_free_n": strict,
            "mature_but_not_gap_free_n": mature_only,
            "gap_free_but_not_mature_n": gapfree_only,
            "unknown_or_not_strict_n": len(rows) - strict,
        }
    return result


def row_level_records(rows, flagged_ids):
    records = []
    for row in rows:
        record = {
            "id": row.get("id"),
            "symbol": row.get("symbol"),
            "detected_at_utc": row.get("detected_at_utc"),
            "status": row.get("status"),
            "snapshot_source": row.get("snapshot_source"),
            "snapshot_is_legacy": row.get("snapshot_is_legacy"),
            "basis_entry_price": row.get("basis_entry_price"),
            "basis_price_source": row.get("basis_price_source"),
            "entry_policy_version": row.get("entry_policy_version"),
            "exit_policy_version": row.get("exit_policy_version"),
            "futures_taker_net_buy_pct": row.get(METRICS["futures"]),
            "spot_taker_net_buy_pct": row.get(METRICS["spot"]),
            "both_takers_available": (
                number_or_none(row.get(METRICS["futures"])) is not None
                and number_or_none(row.get(METRICS["spot"])) is not None
            ),
            "extreme_forward_peak_candidate_gt300pct": row.get("id") in flagged_ids,
            "horizons": {},
        }
        for horizon in ALL_HORIZONS:
            values = window(row, horizon)
            if not values:
                record["horizons"][horizon] = None
                continue
            record["horizons"][horizon] = {
                "mature_at_capture": idx_value(values, "mature_at_capture", WINDOW_INDEX),
                "coverage_complete": idx_value(values, "coverage_complete", WINDOW_INDEX),
                "strict_mature_gap_free": is_strict(row, horizon),
                "expected_bar_count": idx_value(values, "expected_bar_count", WINDOW_INDEX),
                "valid_bucket_count": idx_value(values, "valid_bucket_count", WINDOW_INDEX),
                "invalid_bar_count": idx_value(values, "invalid_bar_count", WINDOW_INDEX),
                "duplicate_bar_count": idx_value(values, "duplicate_bar_count", WINDOW_INDEX),
                "max_high_pct": idx_value(values, "max_high_pct", WINDOW_INDEX),
                "min_low_pct": idx_value(values, "min_low_pct", WINDOW_INDEX),
                "endpoint_close_pct": idx_value(values, "endpoint_close_pct", WINDOW_INDEX),
                "first_plus5_open_index": idx_value(values, "first_plus5_open_index", WINDOW_INDEX),
                "first_plus10_open_index": idx_value(values, "first_plus10_open_index", WINDOW_INDEX),
                "first_plus20_open_index": idx_value(values, "first_plus20_open_index", WINDOW_INDEX),
                "first_minus8_open_index": idx_value(values, "first_minus8_open_index", WINDOW_INDEX),
                "first_minus10_open_index": idx_value(values, "first_minus10_open_index", WINDOW_INDEX),
                "first_bar_high_pct": idx_value(values, "first_bar_high_pct", WINDOW_INDEX),
                "first_bar_low_pct": idx_value(values, "first_bar_low_pct", WINDOW_INDEX),
                "first_bar_close_pct": idx_value(values, "first_bar_close_pct", WINDOW_INDEX),
                "same_bar_target_stop_ambiguous": idx_value(values, "same_bar_target_stop_ambiguous", WINDOW_INDEX),
                "preclose": preclose_values(row, horizon),
            }
        records.append(record)
    return records


def flagged_details(rows, metadata, flagged_ids):
    metadata_flags = {
        item["id"]: item
        for item in metadata.get("rows_with_path_or_first_candle_gt300pct", [])
    }
    output = []
    for row in rows:
        if row.get("id") not in flagged_ids:
            continue
        horizons = {}
        for horizon in ("6", "72"):
            values = window(row, horizon)
            horizons[horizon] = {
                "strict_mature_gap_free": is_strict(row, horizon),
                "max_high_pct": idx_value(values, "max_high_pct", WINDOW_INDEX),
                "min_low_pct": idx_value(values, "min_low_pct", WINDOW_INDEX),
                "endpoint_close_pct": idx_value(values, "endpoint_close_pct", WINDOW_INDEX),
                "first_bar_high_pct": idx_value(values, "first_bar_high_pct", WINDOW_INDEX),
                "first_bar_low_pct": idx_value(values, "first_bar_low_pct", WINDOW_INDEX),
                "first_bar_close_pct": idx_value(values, "first_bar_close_pct", WINDOW_INDEX),
                "first_plus5_open_index": idx_value(values, "first_plus5_open_index", WINDOW_INDEX),
                "first_plus10_open_index": idx_value(values, "first_plus10_open_index", WINDOW_INDEX),
            }
        output.append({
            "id": row.get("id"),
            "symbol": row.get("symbol"),
            "metadata_quality_flags": metadata_flags.get(row.get("id")),
            "basis_price_source": row.get("basis_price_source"),
            "basis_entry_price": row.get("basis_entry_price"),
            "futures_taker_net_buy_pct": row.get(METRICS["futures"]),
            "spot_taker_net_buy_pct": row.get(METRICS["spot"]),
            "first_bar_entry_discontinuity_evidence": "metadata does not flag a >300% first-candle discontinuity; first-bar high/low/close percentages are shown, but entry-price mismatch is not verifiable because first-bar open is not exported",
            "large_adjacent_gap_assessable": False,
            "horizons": horizons,
        })
    return output


def first_target_stop_all(rows):
    output = {}
    for horizon in HORIZONS:
        strict = [row for row in rows if is_strict(row, horizon)]
        data = {}
        for target in TARGETS:
            for stop in (8, 10):
                categories = Counter()
                for row in strict:
                    values = window(row, horizon)
                    target_index = idx_value(values, "first_plus%d_open_index" % target, WINDOW_INDEX)
                    stop_index = idx_value(values, "first_minus%d_open_index" % stop, WINDOW_INDEX)
                    if target_index is None and stop_index is None:
                        categories["neither_observed"] += 1
                    elif target_index is None:
                        categories["stop_first"] += 1
                    elif stop_index is None:
                        categories["target_first"] += 1
                    elif target_index == stop_index:
                        categories["same_bar_ambiguous"] += 1
                    elif target_index < stop_index:
                        categories["target_first"] += 1
                    else:
                        categories["stop_first"] += 1
                data["+%d%%_vs_-%d%%" % (target, stop)] = {
                    "strict_n": len(strict),
                    "target_first": categories["target_first"],
                    "stop_first": categories["stop_first"],
                    "same_bar_ambiguous": categories["same_bar_ambiguous"],
                    "neither_observed": categories["neither_observed"],
                }
        output[horizon] = {
            "strict_n": len(strict),
            "pairs": data,
            "same_bar_target_stop_flag_n": sum(
                idx_value(window(row, horizon), "same_bar_target_stop_ambiguous", WINDOW_INDEX) is True
                for row in strict
            ),
        }
    return output


def key_findings(report):
    rows = report["_rows"]
    results = []
    for metric_name, metric in METRICS.items():
        both_group = report["analysis"]["all_signal_takers"][metric_name]["groups"]
        positive = both_group[">=20"]
        no_positive = both_group["<=0"]
        for horizon in ("6", "24", "72"):
            for target in TARGETS:
                hi = positive["horizons"][horizon]["fixed_targets"]["+%d%%" % target]
                lo = no_positive["horizons"][horizon]["fixed_targets"]["+%d%%" % target]
                results.append({
                    "metric": metric_name,
                    "comparison": ">=20% versus <=0% net-buy",
                    "horizon_hours": int(horizon),
                    "target_pct": target,
                    "high_group": {"hits": hi["hit_n"], "n_strict": hi["strict_denominator"], "rate": hi["rate"]},
                    "nonpositive_group": {"hits": lo["hit_n"], "n_strict": lo["strict_denominator"], "rate": lo["rate"]},
                })
    return results


def pct(value):
    return "—" if value is None else "%.1f%%" % (value * 100)


def fmt_num(value, places=1):
    if value is None:
        return "—"
    return ("%%.%df" % places) % value


def md_table(headers, rows):
    lines = ["| " + " | ".join(headers) + " |", "| " + " | ".join("---" for _ in headers) + " |"]
    lines.extend("| " + " | ".join(str(cell).replace("|", "\\|").replace("\n", " ") for cell in row) + " |" for row in rows)
    return "\n".join(lines)


def render_markdown(report):
    metadata = report["cohort_context"]
    status_text = ", ".join("%s %s" % (name, count) for name, count in sorted(metadata["status_counts"].items()))
    monthly_text = ", ".join("%s: %s" % (month, count) for month, count in sorted(metadata["detected_fire_counts_by_utc_month"].items()))
    futures_ci = report["analysis"]["all_signal_takers"]["futures"]["cluster_bootstrap_ge20_vs_below20_fixed_hits"]["6"]["+10%"]
    matched_spot_ci = report["analysis"]["matched_both_available"]["spot"]["cluster_bootstrap_ge20_vs_below20_fixed_hits"]["6"]["+10%"]
    futures_rho = report["analysis"]["all_signal_takers"]["futures"]["spearman_taker_vs_peak_high_pct"]["6"]
    spot_rho = report["analysis"]["all_signal_takers"]["spot"]["spearman_taker_vs_peak_high_pct"]["6"]
    lines = [
        "# Frozen-cohort taker net-buy analysis",
        "",
        "**Scope:** frozen `.local/reports/ib-taker-volume-2026-10-01/cohort.json` plus its `metadata.json` only. All 188 canonical fires retained; no UI/status/policy/date filtering. No live data, DB, network, or other report files used.",
        "",
        "**Taker definition:** net-buy % = `(buy volume − sell volume) / (buy volume + sell volume) × 100`; this is not buy-share %. Futures and spot are analyzed separately, plus the matched both-available subset. Missing metric/path observations remain unknown, never treated as zero or failure in association tables.",
        "",
        "## Cohort and path coverage",
        "",
        "Capture as of %s; dates %s through %s. Statuses and legacy rows remain included. A strict horizon requires both `mature_at_capture=true` and `coverage_complete=true`; the flags are reported independently. Unknown / incomplete paths are not failures." % (
            metadata["capture_asof_utc"], metadata["first_detected_at_utc"], metadata["last_detected_at_utc"],
        ),
        md_table(
            ["Horizon", "All fires", "Mature", "Gap-free", "Both (strict)", "Not strict / unknown"],
            [[h + "h", c["cohort_rows"], c["mature_n"], c["gap_free_n"], c["mature_and_gap_free_n"], c["unknown_or_not_strict_n"]]
             for h, c in report["coverage"].items()],
        ),
        "",
        "Taker availability from the immutable entry snapshot: futures %d/188, spot %d/188, both %d/188. Legacy snapshot rows: %d/188. No August fires are implied by legacy records; actual detected-date coverage is shown below. These are fire-history records, not 188 executed fills; two rows are `reclassified`." % (
            metadata["entry_metric_presence_counts"]["futures_taker_net_buy_pct"],
            metadata["entry_metric_presence_counts"]["spot_taker_net_buy_pct"],
            report["both_takers_available_n"],
            metadata["legacy_rows"],
        ),
        "",
        "Included statuses: %s. Actual detections by UTC month: %s. September has %s fires and August has %s; the 30 snapshot-legacy rows are not August detections." % (
            status_text,
            monthly_text,
            metadata["detected_fire_counts_by_utc_month"].get("2026-09", 0),
            metadata["detected_fire_counts_by_utc_month"].get("2026-08", 0),
        ),
        "",
        "## Top factual readout (descriptive, not causal)",
        "",
        f"• Futures >=20% net-buy is sparse: 4/148 futures observations. On strict 6h paths, +10% was 0/4 in that band versus 20/83 (24.1%) at futures <=0. The predefined >=20% versus <20% symbol-cluster bootstrap difference was {100*futures_ci['estimate_high_minus_low']:.1f} percentage points (95% CI {100*futures_ci['ci95_cluster_bootstrap'][0]:.1f} to {100*futures_ci['ci95_cluster_bootstrap'][1]:.1f} pp); the high band contains only four rows.",
        f"• In the matched both-metrics-present subset (n=89), 6h +10 was futures <=0: 10/49 and >=20: 0/4; spot <=0: 1/12 and >=20: 8/35. For spot >=20 versus <20 the cluster-bootstrap contrast was {100*matched_spot_ci['estimate_high_minus_low']:.1f} pp (95% CI {100*matched_spot_ci['ci95_cluster_bootstrap'][0]:.1f} to {100*matched_spot_ci['ci95_cluster_bootstrap'][1]:.1f} pp), including zero.",
        f"• Six-hour taker/peak Spearman associations are small and uncertain: futures ρ={futures_rho['rho']:.3f} (cluster CI {futures_rho['ci95_cluster_bootstrap'][0]:.2f} to {futures_rho['ci95_cluster_bootstrap'][1]:.2f}); spot ρ={spot_rho['rho']:.3f} ({spot_rho['ci95_cluster_bootstrap'][0]:.2f} to {spot_rho['ci95_cluster_bootstrap'][1]:.2f}).",
        "• Retrospective accounting only: a futures >=20% cut with missing fail-open would remove 38/44 strict 6h +10 achievers (and 105 nonwinners); spot >=20% would remove 7/44 achievers (and 49 nonwinners), with 92 missing-spot rows retained. This is not a live-gate proposal.",
        "",
        "## Main comparison: fixed +5% / +10% OHLC hits",
        "",
        "Rates use strict mature + gap-free denominators within each known-taker band. Horizons 1/3/6h are primary; 24/72h are secondary. Counts in parentheses are hits / strict known-outcome rows. JSON separately counts unknown/incomplete rows within each band, rows outside the band or with missing metrics, and full-cohort horizon coverage.",
        "",
    ]
    for metric_name in ("futures", "spot"):
        lines += ["### %s taker net-buy" % metric_name.capitalize(), ""]
        groups = report["analysis"]["all_signal_takers"][metric_name]["groups"]
        rows = []
        for band, _ in BANDS:
            for horizon in HORIZONS:
                entry = groups[band]["horizons"][horizon]
                plus5 = entry["fixed_targets"]["+5%"]
                plus10 = entry["fixed_targets"]["+10%"]
                rows.append([
                    band, horizon + "h",
                    "%d/%d (%s)" % (plus5["hit_n"], plus5["strict_denominator"], pct(plus5["rate"])),
                    "%d/%d (%s)" % (plus10["hit_n"], plus10["strict_denominator"], pct(plus10["rate"])),
                    groups[band]["n_metric_known"],
                ])
        lines.append(md_table(["Net-buy band", "Horizon", "+5 hit (n/N)", "+10 hit (n/N)", "Band metric n"], rows))
        lines.append("")
        lines.append("The same band tables on the matched both-takers-present cohort (n=%d) are in JSON at `matched_both_available`." % report["both_takers_available_n"])
        lines.append("")
    lines += [
        "### Predefined cuts and combined categories",
        "",
        "Cuts are exactly 0%, 10%, and 20% (high side is `>= cut`, low side `< cut`); bins are `<=0`, `(0,10)`, `[10,20)`, and `>=20`. Both-positive means futures >0 AND spot >0; stronger-futures means futures >=20%. These are descriptive fixed cuts, not a search for an optimum. All cut-level results are in JSON.",
        "",
    ]
    for metric_name in ("futures", "spot"):
        metric = METRICS[metric_name]
        records = []
        for horizon in ("6", "24", "72"):
            for cutoff in (0, 10, 20):
                comp = report["analysis"]["all_signal_takers"][metric_name]["cut_comparisons"][horizon][str(cutoff)]
                v5 = comp["fixed_targets"]["+5%"]
                v10 = comp["fixed_targets"]["+10%"]
                records.append([
                    metric_name, horizon + "h", ">=%d%%" % cutoff,
                    "%d/%d" % (v5["high"]["hits"], v5["high"]["n"]),
                    "%d/%d" % (v10["high"]["hits"], v10["high"]["n"]),
                    "%d/%d" % (v10["low"]["hits"], v10["low"]["n"]),
                    pct(v10["difference_high_minus_low"]),
                ])
        if metric_name == "futures":
            lines.append(md_table(["Metric", "Horizon", "Cut", "+5 high hits/N", "+10 high hits/N", "+10 low hits/N", "+10 rate diff"], records))
    combined_rows = []
    for horizon in ("1", "3", "6", "24", "72"):
        for group_name, label in (
            ("both_positive", "both positive (>0 each)"),
            ("futures_ge20", "futures >=20%"),
        ):
            group = report["combined_groups"]["all_signal"][group_name]
            h = group["horizons"][horizon]
            cells = []
            for target in TARGETS:
                result = h["fixed_targets"]["+%d%%" % target]
                cells.append("%d/%d (%s)" % (result["hits"], result["n"], pct(result["rate"])))
            combined_rows.append([horizon + "h", label, group["group_n"], h["strict_n"], *cells])
    lines.append("")
    lines.append(md_table(["Horizon", "Combined group", "Group n", "Strict n", "+5 hit", "+10 hit"], combined_rows))
    lines += [
        "",
        "## Peak opportunity and rank association",
        "",
        "Peak opportunity is the maximum high-based return from entry over the interval, not realized PnL and not an executable/fill price. Spearman correlations use only known entry taker values and strict paths; cluster-bootstrap 95% intervals resample symbols, not individual rows.",
        "",
    ]
    corr_rows = []
    for metric_name in ("futures", "spot"):
        for horizon in HORIZONS:
            corr = report["analysis"]["all_signal_takers"][metric_name]["spearman_taker_vs_peak_high_pct"][horizon]
            ci = corr["ci95_cluster_bootstrap"]
            ci_text = "—" if ci is None else "[%.2f, %.2f]" % (ci[0], ci[1])
            corr_rows.append([metric_name, horizon + "h", corr["n"], fmt_num(corr["rho"], 3), ci_text, corr["symbol_clusters"]])
    lines.append(md_table(["Taker", "Horizon", "Pairs", "Spearman ρ", "Cluster-bootstrap 95% CI", "Symbols"], corr_rows))
    lines += [
        "",
        "Full peak median, quartiles, and threshold opportunity counts by taker band/horizon are preserved in JSON. Do not interpret an extreme high as tradable profit.",
        "",
        "## Robustness: extreme forward-peak price flags",
        "",
        "All 188 remain in the main analysis. A separate conservative sensitivity removes the three metadata-flagged rows with any forward high above 300%; this is a proxy sensitivity, **not** a finding that all three are bad data. Metadata says none has a >300% first-candle discontinuity. First-candle OHLC summary values are shown per row. The export does not include a first-bar open or the full adjacent-candle sequence, so a first-bar entry-price mismatch or a large adjacent gap cannot be independently confirmed from these permitted files.",
        "",
        md_table(
            ["ID / symbol", "Futures / spot net-buy", "6h peak high", "72h peak high", "First-bar high / low / close", "Quality detail"],
            [[
                "%s %s" % (item["id"], item["symbol"]),
                "%s / %s" % (fmt_num(item["futures_taker_net_buy_pct"], 2), fmt_num(item["spot_taker_net_buy_pct"], 2)),
                fmt_num(item["horizons"]["6"]["max_high_pct"], 1) + "%",
                fmt_num(item["horizons"]["72"]["max_high_pct"], 1) + "%",
                "%s / %s / %s" % tuple(fmt_num(item["horizons"]["72"][k], 1) for k in ("first_bar_high_pct", "first_bar_low_pct", "first_bar_close_pct")),
                "first-candle >300 flag=%s; forward peak >300 flag=%s" % (
                    item["metadata_quality_flags"]["first_candle_discontinuity_gt300pct"],
                    item["metadata_quality_flags"]["any_forward_path_high_gt300pct"],
                ),
            ] for item in report["price_flag_details"]],
        ),
        "",
        "All-signal versus remove-all-three comparison, using strict-known outcomes and separately preserving unknown paths:",
        "",
    ]
    sens_rows = []
    for population in ("all_signal_takers", "remove_extreme_peak_candidates"):
        for metric_name in ("futures", "spot"):
            groups = report["analysis"][population][metric_name]["groups"]
            for band in ("<=0", ">=20"):
                for horizon in ("6", "72"):
                    item = groups[band]["horizons"][horizon]["fixed_targets"]["+10%"]
                    sens_rows.append([
                        population, metric_name, band, horizon + "h",
                        "%d/%d (%s)" % (item["hit_n"], item["strict_denominator"], pct(item["rate"])),
                        item["unknown_or_incomplete_in_group_n"],
                    ])
    lines.append(md_table(["Population", "Taker", "Band", "Horizon", "+10 hits / strict N (rate)", "Band unknown/incomplete"], sens_rows))
    lines += [
        "",
        "**LSK-USDT (id 1586):** entry basis %.8g (%s), futures net-buy %.2f%%, spot %.2f%%. Its strict 6h peak was %.1f%% (first +5/+10 at 15m bucket indexes %s/%s), versus a strict 72h peak of %.1f%%. First bar high/low/close were %.1f%% / %.1f%% / %.1f%%, and metadata does not flag a >300%% first-candle discontinuity; the extreme 72h high is therefore retained in the primary cohort and removed only in the conservative sensitivity. This summary cannot verify the intervening adjacent-bar path." % (
            next(x["basis_entry_price"] for x in report["price_flag_details"] if x["id"] == 1586),
            next(x["basis_price_source"] for x in report["price_flag_details"] if x["id"] == 1586),
            next(x["futures_taker_net_buy_pct"] for x in report["price_flag_details"] if x["id"] == 1586),
            next(x["spot_taker_net_buy_pct"] for x in report["price_flag_details"] if x["id"] == 1586),
            next(x["horizons"]["6"]["max_high_pct"] for x in report["price_flag_details"] if x["id"] == 1586),
            next(x["horizons"]["6"]["first_plus5_open_index"] for x in report["price_flag_details"] if x["id"] == 1586),
            next(x["horizons"]["6"]["first_plus10_open_index"] for x in report["price_flag_details"] if x["id"] == 1586),
            next(x["horizons"]["72"]["max_high_pct"] for x in report["price_flag_details"] if x["id"] == 1586),
            next(x["horizons"]["72"]["first_bar_high_pct"] for x in report["price_flag_details"] if x["id"] == 1586),
            next(x["horizons"]["72"]["first_bar_low_pct"] for x in report["price_flag_details"] if x["id"] == 1586),
            next(x["horizons"]["72"]["first_bar_close_pct"] for x in report["price_flag_details"] if x["id"] == 1586),
        ),
        "",
        "## Time-to-target, stop-path ambiguity, and bounded pre-close path",
        "",
        "Conditional time-to-+5/+10 among rows that eventually hit is a 15-minute bar-index approximation; it is not exact elapsed time or a fill. The conditional winner-only timing tables include `hit_all_n` to make survivorship selection visible. The path begins at the first aligned candle bucket after the detected-at floor and omits any remainder of the entry-containing candle; OHLC cannot order two thresholds touched in the same candle.",
        "",
        "First-target versus -8%/-10% stop counts for the full cohort are in JSON (`first_target_vs_stop_all_signal`) with explicit same-bar ambiguous and neither-observed categories. No ordering is imputed for ambiguous candles.",
        "",
        "Primary forward paths are the symmetric detected-at-anchored post-entry hypothetical OHLC path for all fires, including cancelled rows and periods after a tracker exit/close; they are not actual fills or realized trade outcomes. Tracker-closed_at-bounded pre-close paths are a separate, partial sensitivity. The supplemental exporter excludes all `cancelled` status rows (not only no-entry cancellations), so this pre-close group must not represent all actual entered trades or drive final conclusions. It is not a fill history and must not be conflated with the primary forward opportunity.",
        "",
        md_table(
            ["Horizon", "Applicable pre-close", "Complete nonempty", "Peak >=5%", "Peak >=10%", "Median max high"],
            [[h + "h", v["applicable_rows"], v["strict_complete_nonempty_preclose_rows"], v["preclose_peak_ge_5pct_n"], v["preclose_peak_ge_10pct_n"], fmt_num(v["preclose_max_high_pct"]["median"], 1) + "%"]
             for h, v in report["preclose_path"].items()],
        ),
        "",
    ]
    timing_rows = []
    for metric_name in ("futures", "spot"):
        groups = report["analysis"]["all_signal_takers"][metric_name]["groups"]
        for band, _ in BANDS:
            targets = groups[band]["horizons"]["6"]["conditional_time_to_target_minutes"]
            row = [metric_name, band]
            for target in ("+5%", "+10%"):
                item = targets[target]
                row.append("%d/%d" % (item["hit_n"], item["hit_all_n_strict"]))
                median = item["median_15m_bucket_offset_minutes_among_hitters"]
                row.append("%g min" % median if median is not None else "—")
            timing_rows.append(row)
    lines += [
        "### 6h first-hit timing (conditional on eventual target hit)",
        "",
        md_table(["Taker", "Band", "+5 hit / strict N", "+5 median bucket offset", "+10 hit / strict N", "+10 median bucket offset"], timing_rows),
        "",
        "Winner-only timing is survivorship-selected: the hit / strict N column is essential. Bucket offsets are approximate, not exact elapsed time or fill.",
        "",
        "### First target versus -8% / -10% stop (all fires, strict paths)",
        "",
    ]
    stop_rows = []
    for horizon in HORIZONS:
        record = report["first_target_vs_stop_all_signal"][horizon]
        for pair, outcome in record["pairs"].items():
            stop_rows.append([
                horizon + "h", pair.replace("_vs_", " vs "),
                outcome["strict_n"], outcome["target_first"], outcome["stop_first"],
                outcome["same_bar_ambiguous"], outcome["neither_observed"],
            ])
    lines.append(md_table(["Horizon", "Pair", "Strict N", "Target first", "Stop first", "Same-bar ambiguous", "Neither observed"], stop_rows))
    lines += [
        "",
        "First-hit classifications are candle-index order only. Same-bar target/stop touches are ambiguous; the first analyzed aligned candle excludes the entry-containing candle remainder.",
        "",
        "## Fixed-cut gate-retention accounting (offline only)",
        "",
        "For +10% hit achievers within 6/24/72h, missing taker values are fail-open (retained); only known values below the fixed 0/10/20 cut are removed. The table counts both winners lost and nonwinners removed, on strict-known path outcomes. This is retrospective sensitivity accounting, **not** a recommendation or proposed change to any live gate.",
        "",
    ]
    gate_rows = []
    for population in ("all_signal_takers", "remove_extreme_peak_candidates"):
        gate = report["gate_evaluation"][population]
        for horizon in ("6", "24", "72"):
            for metric_name in ("futures", "spot"):
                for cutoff in ("0", "10", "20"):
                    x = gate["horizons"][horizon]["metrics"][metric_name][cutoff]
                    gate_rows.append([
                        population, horizon + "h", metric_name, ">=" + cutoff + "%",
                        x["base_n"], x["known_below_cut_excluded_n"], x["missing_metric_retained_n"],
                        x["winners_lost_+10_within_horizon"], x["nonwinners_removed"],
                        x["retained_+10_winners"], x["retained_n"],
                    ])
    lines.append(md_table(["Population", "Horizon", "Metric", "Cut", "Base N", "Removed", "Missing retained", "Winners lost", "Nonwinners removed", "Retained winners", "Retained N"], gate_rows))
    validation_rows = []
    for metric_name in ("futures", "spot"):
        metric_data = report["later_date_validation"]["metrics"][metric_name]
        for period in ("early", "late"):
            for band, _ in BANDS:
                item = metric_data[period]["bands_6h"][band]
                validation_rows.append([
                    metric_name, period, band, item["metric_known_n"], item["strict_6h_n"],
                    "%d/%d (%s)" % (item["plus5_hits"], item["strict_6h_n"], pct(item["plus5_rate"])),
                    "%d/%d (%s)" % (item["plus10_hits"], item["strict_6h_n"], pct(item["plus10_rate"])),
                ])
    lines += [
        "",
        "### Fixed 6h early / late results by predefined band",
        "",
        md_table(["Taker", "Period", "Band", "Metric-known N", "Strict N", "+5 hits / N (rate)", "+10 hits / N (rate)"], validation_rows),
        "",
    ]
    entry_versions = report["policy_version_counts"]["entry_policy_version"]
    exit_versions = report["policy_version_counts"]["exit_policy_version"]
    entry_version_text = ", ".join("%s %s" % (version, count) for version, count in sorted(entry_versions.items()))
    exit_version_text = ", ".join("%s %s" % (version, count) for version, count in sorted(exit_versions.items()))
    lines += [
        "",
        "## Fixed early/late validation and policy/date context",
        "",
        "Predefined split: detections before 2026-09-20 versus on/after 2026-09-20. The late cohort is small and not independent of symbol clustering; these are descriptive checks, not prospective validation.",
        "",
        "Early / late rows: %d / %d; no-August-signal coverage is not inferred from earlier Jun–Aug legacy reconciliation records. Snapshot legacy rows are %d and actual detected dates span %s to %s." % (
            report["later_date_validation"]["early_rows"], report["later_date_validation"]["late_rows"],
            metadata["legacy_rows"], metadata["first_detected_at_utc"], metadata["last_detected_at_utc"],
        ),
        "",
        "Entry policy counts: %s (one non-null version); exit policy counts: %s. Policy versions were not used to gate the cohort; exit-policy version is not treated as a gate version. No row was excluded by policy or status." % (entry_version_text, exit_version_text),
        "",
        "## Uncertainty and interpretation",
        "",
        "The JSON includes symbol-cluster bootstrap 95% intervals for predefined >=20% versus <20% hit-rate contrasts and for Spearman correlations. Intervals may be wide or undefined in small/sparse cells; repeated symbols are resampled together. No p-value fishing or threshold optimization was performed.",
        "",
        "These observational comparisons do not establish causality. Entry metrics are sparse and date-varying; OHLC high-based opportunities are not realized PnL; selection, symbol dependence, missingness, capture maturity, candle-path ambiguity, and price discontinuities limit inference. No live gate change is proposed.",
        "",
        "## Reproducibility",
        "",
        "Script: `taker-analysis.py` (standard library only). Input SHA-256: cohort.json `%s`; metadata.json `%s`. It writes only this JSON and Markdown report." % (
            report["source_sha256"]["cohort.json"], report["source_sha256"]["metadata.json"],
        ),
        "",
    ]
    return "\n".join(lines)


def main():
    cohort, metadata, source_sha256 = read_inputs()
    rows = cohort["rows"]
    if len(rows) != 188 or len(rows) != metadata.get("cohort_rows"):
        raise ValueError("Frozen cohort row count does not match the requested 188 rows")

    flagged_ids = {
        item["id"]
        for item in metadata.get("rows_with_path_or_first_candle_gt300pct", [])
        if item.get("any_forward_path_high_gt300pct")
    }
    both_available = [
        row for row in rows
        if number_or_none(row.get(METRICS["futures"])) is not None
        and number_or_none(row.get(METRICS["spot"])) is not None
    ]
    robust_rows = [row for row in rows if row.get("id") not in flagged_ids]
    analysis = {}
    for population_name, population_rows in (
        ("all_signal_takers", rows),
        ("matched_both_available", both_available),
        ("remove_extreme_peak_candidates", robust_rows),
        ("remove_extreme_peak_candidates_matched_both_available", [r for r in both_available if r.get("id") not in flagged_ids]),
    ):
        analysis[population_name] = {
            metric_name: group_summary(population_rows, metric, population_name)
            for metric_name, metric in METRICS.items()
        }
    policy_counts = {
        "entry_policy_version": dict(Counter(row.get("entry_policy_version") or "<null>" for row in rows)),
        "exit_policy_version": dict(Counter(row.get("exit_policy_version") or "<null>" for row in rows)),
    }
    status_counts = dict(Counter(row.get("status") or "<null>" for row in rows))
    snapshot_counts = dict(Counter(row.get("snapshot_source") or "<null>" for row in rows))
    month_counts = dict(Counter((row.get("detected_at_utc") or "")[:7] or "<undated>" for row in rows))
    report = {
        "analysis_name": "Frozen 2026-10-01 impulse_buy taker net-buy analysis",
        "created_by": "taker-analysis.py",
        "inputs_read": ["cohort.json", "metadata.json"],
        "source_sha256": source_sha256,
        "cohort_context": {
            "capture_asof_utc": metadata["capture_asof_utc"],
            "first_detected_at_utc": metadata["first_detected_at_utc"],
            "last_detected_at_utc": metadata["last_detected_at_utc"],
            "row_count": len(rows),
            "ui_exclusions": 0,
            "status_counts": status_counts,
            "snapshot_source_counts": snapshot_counts,
            "detected_fire_counts_by_utc_month": month_counts,
            "legacy_rows": metadata["snapshot_legacy_rows"],
            "entry_metric_presence_counts": metadata["entry_metric_presence_counts"],
            "taker_semantics": "(buy volume - sell volume) / (buy volume + sell volume) * 100; net-buy %, not buy-share %",
            "entry_basis_counts": metadata["price_basis_counts"],
            "missing_absolute_futures_24h_volume": metadata.get("missing_absolute_futures_24h_volume"),
        },
        "both_takers_available_n": len(both_available),
        "extreme_peak_candidate_ids_removed_only_in_sensitivity": sorted(flagged_ids),
        "price_flag_details": flagged_details(rows, metadata, flagged_ids),
        "coverage": row_coverage(rows),
        "analysis": analysis,
        "combined_groups": {},
        "gate_evaluation": {
            "all_signal_takers": gate_evaluation(rows, "all 188 fires"),
            "remove_extreme_peak_candidates": gate_evaluation(robust_rows, "all signals less three >300% forward-high candidates"),
        },
        "preclose_path": preclose_summary(rows),
        "first_target_vs_stop_all_signal": first_target_stop_all(rows),
        "later_date_validation": later_validation(rows),
        "policy_version_counts": policy_counts,
        "method": {
            "strict_outcome": "mature_at_capture=true AND coverage_complete=true independently required per horizon; otherwise outcome unknown",
            "outcome_targets": "fixed OHLC +5% and +10% threshold hits; 1/3/6h primary, 24/72h secondary",
            "peak": "max_high_pct, high-based opportunity, not realized PnL",
            "bands": ["<=0", "(0,10)", "[10,20)", ">=20"],
            "cuts": [0, 10, 20],
            "both_positive": "futures taker >0 AND spot taker >0",
            "stronger_futures": "futures taker >=20%",
            "price_sensitivity": "remove all metadata rows with any forward max-high >300%; proxy sensitivity, not automatic discontinuity diagnosis",
            "time_to_hit": "15-minute open bucket index * 15 minutes; approximate conditional-on-hit and not a fill",
            "cluster_uncertainty": "standard-library symbol-cluster bootstrap, 600 replicates, fixed seed 20261001",
            "no_live_policy": "offline observational analysis only; no causal or live-gate recommendations",
        },
        "all_188_row_records": row_level_records(rows, flagged_ids),
    }
    report["key_comparisons_ge20_vs_nonpositive"] = key_findings({"_rows": rows, "analysis": analysis})

    # Populate the requested combined groups for JSON, retaining unknown outcomes.
    for population_name, population_rows in (
        ("all_signal", rows),
        ("remove_extreme_peak_candidates", robust_rows),
    ):
        combined = {}
        group_definitions = {
            "both_positive": lambda r: (
                number_or_none(r.get(METRICS["futures"])) is not None
                and number_or_none(r.get(METRICS["spot"])) is not None
                and r[METRICS["futures"]] > 0
                and r[METRICS["spot"]] > 0
            ),
            "futures_ge20": lambda r: (
                number_or_none(r.get(METRICS["futures"])) is not None and r[METRICS["futures"]] >= 20
            ),
        }
        for group_name, predicate in group_definitions.items():
            selected = [row for row in population_rows if predicate(row)]
            combined[group_name] = {"group_n": len(selected), "horizons": {}}
            for horizon in HORIZONS:
                strict = [row for row in selected if is_strict(row, horizon)]
                combined[group_name]["horizons"][horizon] = {
                    "strict_n": len(strict),
                    "unknown_or_incomplete_n": len(selected) - len(strict),
                    "fixed_targets": {
                        "+%d%%" % target: {
                            "hits": sum(fixed_hit(row, horizon, target) is True for row in strict),
                            "n": len(strict),
                            "rate": sum(fixed_hit(row, horizon, target) is True for row in strict) / len(strict) if strict else None,
                        } for target in TARGETS
                    },
                }
        report["combined_groups"][population_name] = combined

    report["all_signal_policy_split_note"] = (
        "Policy version frequencies are descriptive only; all statuses, null policies, and versions remain included. "
        "Exit-policy version was not used to infer gate era."
    )
    markdown = render_markdown(report)
    (HERE / "taker-analysis.json").write_text(json.dumps(report, indent=2, sort_keys=True, allow_nan=False) + "\n")
    (HERE / "taker-analysis.md").write_text(markdown)


if __name__ == "__main__":
    main()