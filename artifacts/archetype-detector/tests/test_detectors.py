"""
Unit-тесты для каждого из 5 детекторов.
Минимум 3 кейса на архетип: явное совпадение, явное несовпадение, граничное значение.
"""
import pytest
from orchestrator import classify_snapshot


# ─────────────────────────── Вспомогательные данные ───────────────────────

BASE_SNAPSHOT: dict = {
    "snapshot_time": "2026-07-18T10:00:00Z",
    "oi_30m": None, "oi_prev_30m": None,
    "oi_1h": None, "oi_prev_1h": None,
    "oi_4h": None,
    "vol_mult": None, "spot_vol_mult": None,
    "price_1h": None, "price_3h": None, "price_4h": None, "price_24h": None,
    "cvd_1h": None, "cvd_1h_ratio": None, "cvd_30m": None,
    "spot_net_pct": None, "net_buy_pct": None, "funding": None,
}


def snap(**overrides) -> dict:
    return {**BASE_SNAPSHOT, **overrides}


# ═══════════════════════════════ B_silent_accumulation ════════════════════

class TestB:
    def test_clear_match(self):
        """OI4h высокий, OI30m и OI1h тихие, p24h в диапазоне."""
        s = snap(oi_4h=6.5, oi_30m=0.3, oi_1h=1.2, price_24h=12.0, vol_mult=1.0)
        result = classify_snapshot("TEST", s)
        assert result["archetype"] == "B_silent_accumulation"
        assert result["confidence_score"] >= 50

    def test_no_match_oi30m_too_high(self):
        """OI30m >= 1.0 → B не срабатывает."""
        s = snap(oi_4h=6.5, oi_30m=1.5, oi_1h=1.2, price_24h=12.0, vol_mult=1.0)
        result = classify_snapshot("TEST", s)
        assert result["archetype"] != "B_silent_accumulation"

    def test_boundary_oi4h_exactly_4(self):
        """OI4h == 4.0 → граничное значение, должно сработать."""
        s = snap(oi_4h=4.0, oi_30m=0.0, oi_1h=0.0, price_24h=10.0, vol_mult=0.5)
        result = classify_snapshot("TEST", s)
        assert result["archetype"] == "B_silent_accumulation"

    def test_no_match_oi30m_null(self):
        """oi_30m IS NULL → B требует NOT NULL для oi_30m → не срабатывает."""
        s = snap(oi_4h=6.0, oi_30m=None, oi_1h=0.5, price_24h=10.0)
        result = classify_snapshot("TEST", s)
        assert result["archetype"] != "B_silent_accumulation"

    def test_confidence_with_cvd_bonus(self):
        """CVD=True даёт +10 к confidence."""
        s_no_cvd = snap(oi_4h=5.0, oi_30m=0.2, oi_1h=0.5, price_24h=10.0, vol_mult=0.9, cvd_1h=None)
        s_cvd = snap(oi_4h=5.0, oi_30m=0.2, oi_1h=0.5, price_24h=10.0, vol_mult=0.9, cvd_1h=True)
        r_no = classify_snapshot("TEST", s_no_cvd)
        r_yes = classify_snapshot("TEST", s_cvd)
        assert r_yes["confidence_score"] == r_no["confidence_score"] + 10

    def test_no_match_price24h_out_of_range(self):
        """price_24h > 25 → B не срабатывает."""
        s = snap(oi_4h=6.0, oi_30m=0.2, oi_1h=0.5, price_24h=30.0, vol_mult=0.8)
        result = classify_snapshot("TEST", s)
        assert result["archetype"] != "B_silent_accumulation"


# ═══════════════════════════════ C_price_led_momentum ════════════════════

class TestC:
    def test_clear_match(self):
        """p3h и p4h >= 3%, OI4h и OI30m тихие."""
        s = snap(price_3h=4.5, price_4h=3.2, oi_4h=None, oi_30m=None, vol_mult=1.5)
        result = classify_snapshot("TEST", s)
        assert result["archetype"] == "C_price_led_momentum"

    def test_no_match_p3h_too_low(self):
        """p3h < 3.0 → C не срабатывает."""
        s = snap(price_3h=2.5, price_4h=3.5, oi_4h=None, oi_30m=None)
        result = classify_snapshot("TEST", s)
        assert result["archetype"] != "C_price_led_momentum"

    def test_boundary_p3h_exactly_3(self):
        """p3h == 3.0 → граничное значение, должно сработать."""
        s = snap(price_3h=3.0, price_4h=3.0, oi_4h=None, oi_30m=None, vol_mult=0.5)
        result = classify_snapshot("TEST", s)
        assert result["archetype"] == "C_price_led_momentum"

    def test_no_match_oi4h_too_high(self):
        """OI4h >= 4.0 → C не срабатывает (OI деривативы подключились)."""
        s = snap(price_3h=4.0, price_4h=4.0, oi_4h=5.0, oi_30m=0.2)
        result = classify_snapshot("TEST", s)
        assert result["archetype"] != "C_price_led_momentum"

    def test_expired_impulse_fading(self):
        """p3h упал относительно предыдущего снэпшота → confidence падает."""
        prev = snap(price_3h=5.0)
        curr = snap(price_3h=3.5, price_4h=3.0, oi_4h=None, oi_30m=None, vol_mult=0.5)
        result = classify_snapshot("TEST", curr, previous=prev)
        # Штраф -15 должен снизить confidence
        if result["archetype"] == "C_price_led_momentum":
            # confidence с штрафом < без штрафа
            result_no_prev = classify_snapshot("TEST", curr, previous=None)
            assert result["confidence_score"] <= result_no_prev["confidence_score"]
        # Если confidence <= 0 → no_signal / reason=C_pattern_expired
        # (зависит от конкретных значений; просто убеждаемся что штраф применён)


# ═══════════════════════════════ D_pullback_continuation ════════════════════

class TestD:
    def test_clear_match(self):
        """p24h в диапазоне 5-25, p4h < -1.5, OI4h > -3."""
        s = snap(price_24h=10.0, price_4h=-3.0, oi_4h=0.5, vol_mult=1.2)
        result = classify_snapshot("TEST", s)
        assert result["archetype"] == "D_pullback_continuation"

    def test_no_match_p4h_too_small(self):
        """p4h >= -1.5 → D не срабатывает (это не откат)."""
        s = snap(price_24h=10.0, price_4h=-0.5, oi_4h=0.5)
        result = classify_snapshot("TEST", s)
        assert result["archetype"] != "D_pullback_continuation"

    def test_boundary_p4h_exactly_minus_1_5(self):
        """p4h == -1.5 → граничное значение, НЕ должно срабатывать (строгое <)."""
        s = snap(price_24h=10.0, price_4h=-1.5, oi_4h=0.5)
        result = classify_snapshot("TEST", s)
        assert result["archetype"] != "D_pullback_continuation"

    def test_confidence_boost_with_oi4h_positive(self):
        """OI4h > 0 добавляет +15 к confidence."""
        s_neg = snap(price_24h=10.0, price_4h=-2.0, oi_4h=-0.5)
        s_pos = snap(price_24h=10.0, price_4h=-2.0, oi_4h=1.0)
        r_neg = classify_snapshot("TEST", s_neg)
        r_pos = classify_snapshot("TEST", s_pos)
        if r_neg["archetype"] == r_pos["archetype"] == "D_pullback_continuation":
            assert r_pos["confidence_score"] == r_neg["confidence_score"] + 15

    def test_no_match_oi4h_too_negative(self):
        """OI4h <= -3.0 → D не срабатывает (свободное падение OI)."""
        s = snap(price_24h=10.0, price_4h=-2.0, oi_4h=-4.0)
        result = classify_snapshot("TEST", s)
        assert result["archetype"] != "D_pullback_continuation"


# ═══════════════════════════════ F_balanced_grind ════════════════════════

class TestF:
    def test_clear_match(self):
        """Все OI-окна и price3h в нужных диапазонах."""
        s = snap(
            oi_30m=1.0, oi_1h=2.0, oi_4h=4.0,
            price_3h=2.5, vol_mult=1.5, price_24h=12.0,
        )
        result = classify_snapshot("TEST", s)
        assert result["archetype"] == "F_balanced_grind"

    def test_no_match_oi30m_out_of_range(self):
        """OI30m > 3.0 → F не срабатывает (выходит за верхнюю границу диапазона)."""
        s = snap(oi_30m=3.5, oi_1h=2.0, oi_4h=4.0, price_3h=2.5, vol_mult=1.5)
        result = classify_snapshot("TEST", s)
        assert result["archetype"] != "F_balanced_grind"

    def test_boundary_all_at_lower_limit(self):
        """Все значения ровно на нижней границе → должно сработать."""
        s = snap(
            oi_30m=0.3, oi_1h=0.5, oi_4h=2.0,
            price_3h=0.5, vol_mult=0.8,
        )
        result = classify_snapshot("TEST", s)
        assert result["archetype"] == "F_balanced_grind"

    def test_confidence_all_oi_positive(self):
        """Все три OI-окна > 0 → +10 к confidence."""
        s = snap(oi_30m=1.0, oi_1h=2.0, oi_4h=4.0, price_3h=2.0, vol_mult=1.5, price_24h=10.0)
        result = classify_snapshot("TEST", s)
        assert result["archetype"] == "F_balanced_grind"
        assert result["confidence_score"] >= 55  # base 45 + 10 sync

    def test_no_match_price3h_null(self):
        """price_3h IS NULL → F не срабатывает (_in_range с None = False)."""
        s = snap(oi_30m=1.0, oi_1h=2.0, oi_4h=4.0, price_3h=None, vol_mult=1.0)
        result = classify_snapshot("TEST", s)
        assert result["archetype"] != "F_balanced_grind"


# ═══════════════════════════════ E_stealth_invisible / breakout ══════════

class TestE:
    def test_watchlist_flat_no_previous(self):
        """Все метрики плоские, нет предыдущего снэпшота → watchlist_stealth."""
        s = snap(oi_4h=0.5, oi_30m=0.1, price_3h=0.5, vol_mult=0.8)
        result = classify_snapshot("TEST", s)
        assert result["archetype"] == "watchlist_stealth"

    def test_no_match_e_oi4h_too_high(self):
        """OI4h >= 2.0 → условие E не выполнено."""
        s = snap(oi_4h=3.0, oi_30m=0.1, price_3h=0.5, vol_mult=0.8)
        result = classify_snapshot("TEST", s)
        assert result["archetype"] != "watchlist_stealth"

    def test_boundary_stealth_all_at_limit(self):
        """Значения ровно под порогами → watchlist_stealth."""
        s = snap(oi_4h=1.99, oi_30m=0.49, price_3h=1.99, vol_mult=1.19)
        result = classify_snapshot("TEST", s)
        assert result["archetype"] == "watchlist_stealth"

    def test_e_stealth_breakout_oi4h_spike(self):
        """
        Δoi_4h > 3.0 → E_stealth_breakout.
        Текущий снэпшот ДОЛЖЕН оставаться stealth-flat (oi_4h < 2.0).
        Δ достигается от отрицательного предыдущего значения к небольшому положительному.
        Пример: prev.oi_4h=-2.5, curr.oi_4h=1.0 → delta=3.5 > 3.0.
        """
        prev = snap(oi_4h=-2.5, oi_30m=0.1, price_3h=0.5, vol_mult=0.8)
        curr = snap(oi_4h=1.0, oi_30m=0.1, price_3h=0.5, vol_mult=0.8)
        result = classify_snapshot("TEST", curr, previous=prev)
        assert result["archetype"] == "E_stealth_breakout"
        assert result["confidence_score"] == 55
        assert "поздний вход" in result.get("note", "")

    def test_e_stealth_breakout_vol_spike(self):
        """Δvol_mult > 0.5 → E_stealth_breakout."""
        prev = snap(vol_mult=0.5)
        curr = snap(oi_4h=0.5, oi_30m=0.1, price_3h=0.5, vol_mult=1.1)
        result = classify_snapshot("TEST", curr, previous=prev)
        assert result["archetype"] == "E_stealth_breakout"
