"""
Функции расчёта confidence score для каждого архетипа.
Формулы строго по ТЗ раздел 3.
"""
from __future__ import annotations
from typing import Optional


def score_B(current: dict) -> int:
    """
    B_silent_accumulation confidence (0–100).
    base = 50
    + min(20, (oi_4h - 4) * 1.5)
    + 10 если price_24h BETWEEN 5 AND 18
    + 10 если vol_mult >= 0.8
    + 10 если cvd_1h == True (бонус, если не null)
    """
    oi4h = current.get("oi_4h") or 0.0
    p24h = current.get("price_24h")
    vol = current.get("vol_mult")
    cvd = current.get("cvd_1h")

    score = 50
    score += min(20, (oi4h - 4.0) * 1.5)
    if p24h is not None and 5 <= p24h <= 18:
        score += 10
    if vol is not None and vol >= 0.8:
        score += 10
    if cvd is True:
        score += 10
    return min(100, int(score))


def score_C(current: dict, previous: Optional[dict]) -> int:
    """
    C_price_led_momentum confidence (0–100, floor 0).
    base = 35
    + min(15, (price_3h - 3) * 2)
    + 15 если vol_mult >= 1.2
    - 15 если price_3h < previous.price_3h (импульс гаснет)
    """
    p3h = current.get("price_3h") or 0.0
    vol = current.get("vol_mult")

    score = 35
    score += min(15, (p3h - 3.0) * 2)
    if vol is not None and vol >= 1.2:
        score += 15

    if previous is not None:
        prev_p3h = previous.get("price_3h")
        if prev_p3h is not None and p3h < prev_p3h:
            score -= 15

    return max(0, min(100, int(score)))


def score_D(current: dict, previous: Optional[dict]) -> int:
    """
    D_pullback_continuation confidence (0–100).
    base = 40
    + 15 если oi_4h > 0 (уже начал восстанавливаться)
    + 15 если previous.price_4h > 0 (откат только начался)
    + 10 если vol_mult >= 0.9
    """
    oi4h = current.get("oi_4h")
    vol = current.get("vol_mult")

    score = 40
    if oi4h is not None and oi4h > 0:
        score += 15

    if previous is not None:
        prev_p4h = previous.get("price_4h")
        if prev_p4h is not None and prev_p4h > 0:
            score += 15

    if vol is not None and vol >= 0.9:
        score += 10

    return min(100, int(score))


def score_F(current: dict) -> int:
    """
    F_balanced_grind confidence (0–100).
    base = 45
    + 10 если все 3 OI-окна (30m, 1h, 4h) положительны одновременно
    + 10 если vol_mult BETWEEN 1.0 AND 2.0
    + 10 если price_24h BETWEEN 5 AND 20
    """
    oi30m = current.get("oi_30m")
    oi1h = current.get("oi_1h")
    oi4h = current.get("oi_4h")
    vol = current.get("vol_mult")
    p24h = current.get("price_24h")

    score = 45
    if (oi30m is not None and oi30m > 0
            and oi1h is not None and oi1h > 0
            and oi4h is not None and oi4h > 0):
        score += 10
    if vol is not None and 1.0 <= vol <= 2.0:
        score += 10
    if p24h is not None and 5 <= p24h <= 20:
        score += 10

    return min(100, int(score))
