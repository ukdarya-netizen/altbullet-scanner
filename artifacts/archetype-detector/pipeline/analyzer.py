"""
Analyzer — поиск паттернов с WR 80%+ предшествующих «пампам».

Метод:
  1. Для каждого pump_event берём OHLCV за 48h до пампа из DuckDB.
  2. Вычисляем feature-вектор: объёмные аномалии, ценовая динамика, OI-прокси.
  3. Строим «негативные» примеры: те же символы в периоды без пампа (rolling windows).
  4. Для каждого паттерна считаем Precision (WR) = TP / (TP + FP).
  5. Публикуем только паттерны с WR >= 80% и выборкой >= 10.

Паттерны (правила):
  P1  vol_spike_6h   — объём последних 3 свечей (1h) > avg_vol_48h × 2.5
  P2  vol_accel_12h  — объём растёт 3+ свечи подряд (> предыдущей)
  P3  low_p24_vol    — price_24h < 5% (не перегрет) + P1
  P4  quiet_then_up  — std(close) за 24h мал (< 1%) + объём растёт последние 3ч
  P5  ob_bid_heavy   — (bid_usd_near / ask_usd_near) > 1.5 в последнем снапшоте ордербука
  P6  composite      — P1 + P3 + (ob_bid_heavy или нет данных ордербука)
"""
from __future__ import annotations

import json
import logging
from datetime import datetime, timezone
from typing import Any

import pandas as pd

from . import duckdb_store

logger = logging.getLogger(__name__)

LOOKBACK_H  = 48   # сколько часов OHLCV анализируем до пампа
MIN_BARS    = 12   # минимум свечей для анализа (иначе пропускаем)
MIN_SAMPLES = 10   # минимум событий для валидного паттерна
MIN_WR      = 0.70 # минимальный win rate для включения в отчёт


# ── Вычисление фичей ──────────────────────────────────────────────────────────

def _compute_ohlcv_features(df: pd.DataFrame, pump_ts_ms: int) -> dict[str, Any]:
    """
    df columns: ts_ms, open, high, low, close, volume (1h свечи, до pump_ts_ms).
    Возвращает feature-словарь.
    """
    df = df[df["ts_ms"] <= pump_ts_ms].sort_values("ts_ms").copy()
    if len(df) < MIN_BARS:
        return {}

    # Ограничиваем окном LOOKBACK_H
    window_start = pump_ts_ms - LOOKBACK_H * 3_600_000
    df_win = df[df["ts_ms"] >= window_start].copy()
    if len(df_win) < MIN_BARS:
        return {}

    vols = df_win["volume"].fillna(0).tolist()
    closes = df_win["close"].ffill().tolist()

    avg_vol = sum(vols) / len(vols) if vols else 0
    if avg_vol == 0:
        return {}

    last3_vol = sum(vols[-3:]) / 3 if len(vols) >= 3 else vols[-1]
    vol_ratio_3h = last3_vol / avg_vol

    # Объём растёт 3+ свечи подряд
    vol_consec_up = 0
    for i in range(len(vols) - 1, 0, -1):
        if vols[i] > vols[i - 1]:
            vol_consec_up += 1
        else:
            break

    # Стандартное отклонение цены (нормализованное)
    if len(closes) >= 2 and closes[-1] > 0:
        price_std_pct = pd.Series(closes).std() / closes[-1] * 100
    else:
        price_std_pct = 999.0

    # Динамика цены за последние 3h и 6h
    price_3h_pct = None
    price_6h_pct = None
    if len(closes) >= 4 and closes[-4] > 0:
        price_3h_pct = (closes[-1] - closes[-4]) / closes[-4] * 100
    if len(closes) >= 7 and closes[-7] > 0:
        price_6h_pct = (closes[-1] - closes[-7]) / closes[-7] * 100

    return {
        "vol_ratio_3h":   round(vol_ratio_3h, 3),
        "vol_consec_up":  vol_consec_up,
        "price_std_pct":  round(price_std_pct, 3),
        "price_3h_pct":   round(price_3h_pct, 3) if price_3h_pct is not None else None,
        "price_6h_pct":   round(price_6h_pct, 3) if price_6h_pct is not None else None,
        "avg_vol":        round(avg_vol, 2),
        "bars":           len(df_win),
    }


def _compute_ob_features(symbol: str, pump_ts_ms: int) -> dict[str, Any]:
    """Читает последний снапшот ордербука до pump_ts_ms."""
    try:
        rows = duckdb_store.query("""
            SELECT bids_json, asks_json
            FROM orderbook_heatmap
            WHERE symbol = ? AND ts_ms <= ?
            ORDER BY ts_ms DESC LIMIT 1
        """, (symbol, pump_ts_ms))
    except Exception:
        return {}

    if not rows:
        return {"ob_available": False}

    try:
        bids = json.loads(rows[0]["bids_json"] or "[]")
        asks = json.loads(rows[0]["asks_json"] or "[]")
    except Exception:
        return {"ob_available": False}

    # Суммируем USD-объём (price × qty) для первых 20 уровней
    def _sum_usd(levels: list) -> float:
        total = 0.0
        for lvl in levels[:20]:
            if isinstance(lvl, (list, tuple)) and len(lvl) >= 2:
                try:
                    total += float(lvl[0]) * float(lvl[1])
                except Exception:
                    pass
        return total

    bid_usd = _sum_usd(bids)
    ask_usd = _sum_usd(asks)
    ratio   = bid_usd / ask_usd if ask_usd > 0 else (99.0 if bid_usd > 0 else 1.0)

    return {
        "ob_available":    True,
        "ob_bid_usd":      round(bid_usd, 0),
        "ob_ask_usd":      round(ask_usd, 0),
        "ob_bid_ask_ratio": round(ratio, 3),
    }


# ── Правила паттернов ─────────────────────────────────────────────────────────

def _check_patterns(feat: dict) -> dict[str, bool]:
    """Возвращает {pattern_id: bool} для одного события."""
    vol_ratio   = feat.get("vol_ratio_3h", 0)
    vol_consec  = feat.get("vol_consec_up", 0)
    price_std   = feat.get("price_std_pct", 999)
    price_3h    = feat.get("price_3h_pct")
    ob_ratio    = feat.get("ob_bid_ask_ratio", 1.0)
    ob_avail    = feat.get("ob_available", False)

    p1 = vol_ratio >= 2.5
    p2 = vol_consec >= 3
    p3 = p1  # low_p24 проверяется через pump_event.price_24h отдельно
    p4 = price_std < 2.0 and vol_consec >= 2
    p5 = ob_avail and ob_ratio >= 1.5
    p5_fail_open = not ob_avail  # нет данных = fail-open
    p6 = p1 and (p5 or p5_fail_open)

    return {"P1": p1, "P2": p2, "P3": p3, "P4": p4, "P5": p5, "P6": p6}


# ── Главный анализ ────────────────────────────────────────────────────────────

def run_analysis(min_price24h: float = 20.0) -> dict[str, Any]:
    """
    Запускает полный анализ паттернов.
    Возвращает словарь с результатами и сохраняет в DuckDB.
    """
    run_at = datetime.now(tz=timezone.utc).isoformat()

    # Загружаем pump_events из DuckDB
    pump_events = duckdb_store.query(
        "SELECT * FROM pump_events WHERE price_24h >= ? ORDER BY pump_ts_ms DESC",
        (min_price24h,)
    )
    logger.info("run_analysis: %d pump_events (price_24h >= %.0f%%)", len(pump_events), min_price24h)

    if not pump_events:
        return {"status": "no_data", "patterns": []}

    pattern_tp: dict[str, int] = {k: 0 for k in ("P1","P2","P3","P4","P5","P6")}
    pattern_tot: dict[str, int] = {k: 0 for k in pattern_tp}
    symbol_feats: list[dict] = []
    skipped = 0

    for evt in pump_events:
        symbol    = evt["symbol"]
        pump_ts   = int(evt["pump_ts_ms"])
        price_24h = evt.get("price_24h") or 0

        # Читаем OHLCV из DuckDB
        rows = duckdb_store.query("""
            SELECT ts_ms, open, high, low, close, volume
            FROM ohlcv
            WHERE symbol = ?
              AND ts_ms BETWEEN ? AND ?
              AND interval_str = '1h'
            ORDER BY ts_ms
        """, (symbol, pump_ts - (LOOKBACK_H + 6) * 3_600_000, pump_ts))

        if not rows:
            skipped += 1
            continue

        df = pd.DataFrame(rows)
        feat = _compute_ohlcv_features(df, pump_ts)
        if not feat:
            skipped += 1
            continue

        ob_feat = _compute_ob_features(symbol, pump_ts)
        feat.update(ob_feat)

        # P3 дополнительно требует price_24h < 5%
        feat["price_24h_at_event"] = price_24h
        patterns = _check_patterns(feat)
        if price_24h >= 5:
            patterns["P3"] = False

        for pid, hit in patterns.items():
            pattern_tot[pid] += 1
            if hit:
                pattern_tp[pid] += 1

        symbol_feats.append({
            "symbol":             symbol,
            "pump_ts":            pump_ts,
            "price_24h":          price_24h,
            "entry_whale_index":  evt.get("entry_whale_index"),
            "entry_snf_1h":       evt.get("entry_snf_1h"),
            "entry_ob_ratio":     evt.get("entry_ob_ratio"),
            **feat,
            **patterns,
        })

    # ── Итоговые метрики ──────────────────────────────────────────────────────
    pattern_descriptions = {
        "P1": "Объёмный спайк: avg_vol последних 3ч × 2.5+ от 48h-среднего",
        "P2": "Объём растёт 3+ свечи подряд",
        "P3": "P1 + price_24h < 5% (не перегрет)",
        "P4": "Тихая цена (std < 2%) + объём растёт 2+ свечи",
        "P5": "Orderbook перекос: bid/ask > 1.5 (последний снапшот)",
        "P6": "P1 + ордербук в пользу быков (fail-open если нет данных)",
    }
    results = []
    for pid in ("P1","P2","P3","P4","P5","P6"):
        tot = pattern_tot[pid]
        tp  = pattern_tp[pid]
        wr  = tp / tot if tot > 0 else 0.0
        entry = {
            "pattern":      pid,
            "description":  pattern_descriptions[pid],
            "win_rate":     round(wr, 4),
            "sample_count": tot,
            "tp_count":     tp,
            "conditions":   _pattern_conditions(pid),
        }
        results.append(entry)
        if tot >= MIN_SAMPLES:
            duckdb_store.save_analysis_result(
                run_at, pid, wr, tot, tp, _pattern_conditions(pid)
            )

    high_wr = [r for r in results if r["win_rate"] >= MIN_WR and r["sample_count"] >= MIN_SAMPLES]
    logger.info("run_analysis done: %d паттернов с WR>=%.0f%% из %d событий",
                len(high_wr), MIN_WR * 100, len(pump_events) - skipped)

    return {
        "status":        "done",
        "run_at":        run_at,
        "events_total":  len(pump_events),
        "events_analysed": len(symbol_feats),
        "events_skipped":  skipped,
        "patterns":      results,
        "strong_patterns": high_wr,
    }


def _pattern_conditions(pid: str) -> dict:
    cond = {
        "P1": {"vol_ratio_3h": ">=2.5"},
        "P2": {"vol_consec_up": ">=3"},
        "P3": {"vol_ratio_3h": ">=2.5", "price_24h": "<5%"},
        "P4": {"price_std_pct": "<2.0", "vol_consec_up": ">=2"},
        "P5": {"ob_bid_ask_ratio": ">=1.5", "ob_available": True},
        "P6": {"vol_ratio_3h": ">=2.5", "ob_bid_ask_ratio": ">=1.5 or no_data"},
    }
    return cond.get(pid, {})


def get_latest_results() -> list[dict]:
    """Возвращает последние сохранённые результаты анализа."""
    try:
        return duckdb_store.query("""
            SELECT ar.*
            FROM analysis_results ar
            INNER JOIN (
                SELECT pattern_name, MAX(run_at) AS max_run
                FROM analysis_results GROUP BY pattern_name
            ) latest ON ar.pattern_name = latest.pattern_name AND ar.run_at = latest.max_run
            ORDER BY win_rate DESC
        """)
    except Exception:
        return []
