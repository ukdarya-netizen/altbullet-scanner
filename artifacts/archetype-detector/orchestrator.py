"""
Оркестратор детекции торговых сигналов по архетипам роста.

Архетипы (приоритет B → C → D → F → E):
  B_silent_accumulation    — тихая аккумуляция, OI4h растёт, короткие окна тихие
  C_price_led_momentum     — цена без OI
  D_pullback_continuation  — откат внутри тренда
  F_balanced_grind         — умеренный широкий рост
  E_stealth_invisible      — всё плоское → watchlist; E_stealth_breakout — резкий сдвиг

НЕ реализован: Explosive Ignition — исключён по решению заказчика.
Архетип "Explosive Ignition" не присутствует ни в коде, ни в константах.
"""
from __future__ import annotations
import logging
from typing import Optional

from scoring import score_B, score_C, score_D, score_F

logger = logging.getLogger(__name__)

# Рекомендации по риску из раздела 3 ТЗ
RISK_RECOMMENDATIONS: dict[str, str] = {
    "B_silent_accumulation": (
        "ранний вход, полный размер позиции допустима, "
        "стоп — по возврату oi_4h ниже 0 на следующем снэпшоте"
    ),
    "C_price_led_momentum": (
        "не полноразмерный вход; держать как pending_confirmation — "
        "повторно оценить на следующем снэпшоте: "
        "если oi_4h начал расти — усилить; если price_3h падает два снэпшота — expired"
    ),
    "D_pullback_continuation": (
        "сигнал = watch_for_reversal, не немедленный вход; "
        "триггер на вход: oi_4h пересёк 0 снизу вверх ИЛИ price_4h перестал уменьшаться"
    ),
    "F_balanced_grind": (
        "стандартный вход с уменьшенным размером позиции (×0.6–0.7 от полного); "
        "самая крупная группа, наименее сфокусированная"
    ),
    "E_stealth_breakout": (
        "поздний вход, движение могло уже начаться; "
        "уменьшенный размер, стоп −5%"
    ),
}


def _safe(d: dict, key: str, default):
    """Возвращает d[key] если не None, иначе default."""
    v = d.get(key)
    return default if v is None else v


def _in_range(x, lo: float, hi: float) -> bool:
    """True если x не None и lo <= x <= hi."""
    return x is not None and lo <= x <= hi


def _is_stealth_flat(s: dict) -> bool:
    """Проверка условий архетипа E (все метрики плоские)."""
    return (
        _safe(s, "oi_4h", 999) < 2.0
        and _safe(s, "oi_30m", 999) < 0.5
        and _safe(s, "price_3h", 999) < 2.0
        and _safe(s, "vol_mult", 999) < 1.2
    )


def classify_snapshot(
    symbol: str,
    current: dict,
    previous: Optional[dict] = None,
) -> dict:
    """
    Классифицирует снэпшот. Возвращает dict с полями сигнала.

    Args:
        symbol:   тикер
        current:  dict с метриками текущего снэпшота
        previous: dict с метриками предыдущего снэпшота (None если первый)

    Returns:
        dict-сигнал по контракту раздела 7 ТЗ, либо {"archetype": "no_signal"} / watchlist
    """

    def _build(archetype: str, confidence: int, trigger: dict, note: str = "") -> dict:
        sig: dict = {
            "symbol": symbol,
            "snapshot_time": current.get("snapshot_time"),
            "archetype": archetype,
            "confidence_score": confidence,
            "trigger_metrics": {k: v for k, v in trigger.items() if v is not None},
            "risk_recommendation": RISK_RECOMMENDATIONS.get(archetype, ""),
            "status": "active",
        }
        if note:
            sig["note"] = note
        logger.info(
            "archetype=%s symbol=%s confidence=%s snapshot=%s",
            archetype, symbol, confidence, current.get("snapshot_time"),
        )
        return sig

    oi4h = current.get("oi_4h")
    oi30m = current.get("oi_30m")
    oi1h = current.get("oi_1h")
    p24h = current.get("price_24h")
    p3h = current.get("price_3h")
    p4h = current.get("price_4h")
    vol = current.get("vol_mult")

    # ── Приоритет 1: B_silent_accumulation ─────────────────────────────────
    # oi_4h IS NOT NULL AND oi_4h >= 4.0
    # oi_30m IS NOT NULL AND oi_30m < 1.0
    # oi_1h  IS NOT NULL AND oi_1h  < 2.0
    # price_24h IS NOT NULL AND price_24h BETWEEN 3 AND 25
    # vol_mult IS NULL OR vol_mult >= 0.5
    if (
        oi4h is not None and oi4h >= 4.0
        and oi30m is not None and oi30m < 1.0
        and oi1h is not None and oi1h < 2.0
        and p24h is not None and 3 <= p24h <= 25
        and (vol is None or vol >= 0.5)
    ):
        return _build(
            "B_silent_accumulation",
            score_B(current),
            {"oi_4h": oi4h, "oi_30m": oi30m, "oi_1h": oi1h, "price_24h": p24h, "vol_mult": vol},
        )

    # ── Приоритет 2: C_price_led_momentum ─────────────────────────────────
    # price_3h IS NOT NULL AND price_3h >= 3.0
    # price_4h IS NOT NULL AND price_4h >= 3.0
    # oi_4h IS NULL OR oi_4h < 4.0
    # oi_30m IS NULL OR oi_30m < 1.0
    if (
        p3h is not None and p3h >= 3.0
        and p4h is not None and p4h >= 3.0
        and _safe(current, "oi_4h", -999) < 4.0
        and _safe(current, "oi_30m", -999) < 1.0
    ):
        conf = score_C(current, previous)
        if conf <= 0:
            logger.info(
                "archetype=no_signal symbol=%s reason=C_pattern_expired snapshot=%s",
                symbol, current.get("snapshot_time"),
            )
            return {
                "archetype": "no_signal",
                "reason": "C_pattern_expired",
                "symbol": symbol,
                "snapshot_time": current.get("snapshot_time"),
            }
        return _build(
            "C_price_led_momentum",
            conf,
            {"price_3h": p3h, "price_4h": p4h, "oi_4h": oi4h, "oi_30m": oi30m, "vol_mult": vol},
        )

    # ── Приоритет 3: D_pullback_continuation ─────────────────────────────
    # price_24h IS NOT NULL AND price_24h BETWEEN 5 AND 25
    # price_4h  IS NOT NULL AND price_4h < -1.5
    # oi_4h IS NULL OR oi_4h > -3.0
    if (
        p24h is not None and 5 <= p24h <= 25
        and p4h is not None and p4h < -1.5
        and _safe(current, "oi_4h", 999) > -3.0
    ):
        return _build(
            "D_pullback_continuation",
            score_D(current, previous),
            {"price_24h": p24h, "price_4h": p4h, "oi_4h": oi4h, "vol_mult": vol},
        )

    # ── Приоритет 4: F_balanced_grind ─────────────────────────────────────
    # oi_30m BETWEEN 0.3 AND 3.0
    # oi_1h  BETWEEN 0.5 AND 4.0
    # oi_4h  BETWEEN 2.0 AND 8.0
    # price_3h BETWEEN 0.5 AND 5.0
    # vol_mult IS NULL OR vol_mult >= 0.8
    if (
        _in_range(oi30m, 0.3, 3.0)
        and _in_range(oi1h, 0.5, 4.0)
        and _in_range(oi4h, 2.0, 8.0)
        and _in_range(p3h, 0.5, 5.0)
        and (vol is None or vol >= 0.8)
    ):
        return _build(
            "F_balanced_grind",
            score_F(current),
            {"oi_30m": oi30m, "oi_1h": oi1h, "oi_4h": oi4h, "price_3h": p3h, "vol_mult": vol},
        )

    # ── Приоритет 5: E_stealth_invisible / E_stealth_breakout ─────────────
    if _is_stealth_flat(current):
        if previous is not None:
            prev_oi4h = previous.get("oi_4h")
            prev_vol = previous.get("vol_mult")
            d_oi4h = (oi4h - prev_oi4h) if (oi4h is not None and prev_oi4h is not None) else None
            d_vol = (vol - prev_vol) if (vol is not None and prev_vol is not None) else None
            if (d_oi4h is not None and d_oi4h > 3.0) or (d_vol is not None and d_vol > 0.5):
                return _build(
                    "E_stealth_breakout",
                    55,
                    {
                        "oi_4h": oi4h, "vol_mult": vol,
                        "delta_oi_4h": d_oi4h, "delta_vol_mult": d_vol,
                    },
                    note="поздний вход, движение могло уже начаться",
                )
        logger.info(
            "archetype=watchlist_stealth symbol=%s snapshot=%s",
            symbol, current.get("snapshot_time"),
        )
        return {
            "archetype": "watchlist_stealth",
            "symbol": symbol,
            "snapshot_time": current.get("snapshot_time"),
        }

    # ── no_signal ─────────────────────────────────────────────────────────
    logger.info(
        "archetype=no_signal symbol=%s snapshot=%s",
        symbol, current.get("snapshot_time"),
    )
    return {
        "archetype": "no_signal",
        "symbol": symbol,
        "snapshot_time": current.get("snapshot_time"),
    }
