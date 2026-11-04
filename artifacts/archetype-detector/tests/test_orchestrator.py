"""
Интеграционные тесты оркестратора.
Ключевой тест: приоритет правил — снэпшот, подходящий под 2+ архетипа,
должен получить БОЛЕЕ ПРИОРИТЕТНЫЙ архетип.
"""
import pytest
from orchestrator import classify_snapshot


def snap(**overrides) -> dict:
    base = {
        "snapshot_time": "2026-07-18T12:00:00Z",
        "oi_30m": None, "oi_prev_30m": None,
        "oi_1h": None, "oi_prev_1h": None,
        "oi_4h": None,
        "vol_mult": None, "spot_vol_mult": None,
        "price_1h": None, "price_3h": None, "price_4h": None, "price_24h": None,
        "cvd_1h": None, "cvd_1h_ratio": None, "cvd_30m": None,
        "spot_net_pct": None, "net_buy_pct": None, "funding": None,
    }
    return {**base, **overrides}


class TestPriority:
    def test_B_wins_over_F(self):
        """
        B требует: oi_4h ≥ 4, oi_30m < 1, oi_1h < 2, price_24h 3-25.
        F требует: oi_30m 0.3-3, oi_1h 0.5-4, oi_4h 2-8, price_3h 0.5-5.

        Конструируем снэпшот где оба потенциально совпадают:
          oi_4h=5.0 (≥4 для B, 2-8 для F)
          oi_30m=0.5 (<1 для B, 0.3-3 для F)
          oi_1h=1.0 (<2 для B, 0.5-4 для F)
          price_3h=2.0 (0.5-5 для F)
          price_24h=10.0 (3-25 для B)
        B должен победить (приоритет 1 > приоритет 4).
        """
        s = snap(
            oi_4h=5.0, oi_30m=0.5, oi_1h=1.0,
            price_24h=10.0, price_3h=2.0, vol_mult=1.0,
        )
        result = classify_snapshot("TEST", s)
        assert result["archetype"] == "B_silent_accumulation", (
            f"Ожидался B_silent_accumulation, получен {result['archetype']}"
        )

    def test_B_wins_over_D(self):
        """
        D требует: price_24h 5-25, price_4h < -1.5.
        Добавляем условия B: oi_4h≥4, oi_30m<1, oi_1h<2, price_24h 3-25.
        Технически B проверяется раньше D, должен победить.
        """
        s = snap(
            oi_4h=5.0, oi_30m=0.3, oi_1h=0.8,
            price_24h=10.0, price_4h=-2.0, vol_mult=0.8,
        )
        result = classify_snapshot("TEST", s)
        assert result["archetype"] == "B_silent_accumulation"

    def test_C_wins_over_D(self):
        """
        C требует: price_3h≥3, price_4h≥3, oi_4h<4, oi_30m<1.
        D требует: price_24h 5-25, price_4h<-1.5 — price_4h≥3 исключает D.
        Если price_4h=4.0: C срабатывает, D нет (price_4h не < -1.5).
        """
        s = snap(
            price_3h=4.0, price_4h=4.0,
            oi_4h=None, oi_30m=None,
            price_24h=12.0, vol_mult=0.5,
        )
        result = classify_snapshot("TEST", s)
        assert result["archetype"] == "C_price_led_momentum"

    def test_C_wins_over_F_when_oi4h_null(self):
        """
        C: price_3h≥3, price_4h≥3, oi_4h IS NULL (< 4.0 через safe), oi_30m=None.
        F: требует oi_30m IN 0.3-3, oi_1h IN 0.5-4, oi_4h IN 2-8 — все null → F не сработает.
        C должен победить.
        """
        s = snap(
            price_3h=3.5, price_4h=3.5,
            oi_4h=None, oi_30m=None, oi_1h=None,
            vol_mult=1.3,
        )
        result = classify_snapshot("TEST", s)
        assert result["archetype"] == "C_price_led_momentum"

    def test_F_wins_over_E(self):
        """
        F срабатывает если все OI и price_3h в диапазонах.
        E срабатывает только если всё плоское (oi_4h<2, oi_30m<0.5, price_3h<2, vol_mult<1.2).
        F условия НЕ плоские → E не попадёт. F должен победить.
        """
        s = snap(
            oi_30m=1.5, oi_1h=2.0, oi_4h=4.0,
            price_3h=2.0, vol_mult=1.0,
        )
        result = classify_snapshot("TEST", s)
        assert result["archetype"] == "F_balanced_grind"

    def test_no_signal_no_conditions_met(self):
        """Все метрики null / нулевые → no_signal."""
        s = snap()
        result = classify_snapshot("TEST", s)
        # null oi_4h → B: нет; null price_3h → C: нет; null price_24h → D: нет
        # null oi_30m/oi_1h/oi_4h → F: нет; null всё → E: плоское → watchlist_stealth
        assert result["archetype"] in ("no_signal", "watchlist_stealth")

    def test_explosive_ignition_not_implemented(self):
        """
        Архетип Explosive Ignition исключён. Никакой результат не должен
        возвращать archetype == 'Explosive_Ignition' или содержать это слово.
        """
        # Создаём снэпшот с резкими OI30m+OI1h+vol (потенциальные условия Explosive Ignition)
        s = snap(oi_30m=8.0, oi_1h=5.0, oi_4h=7.0, vol_mult=3.0, price_24h=15.0, price_3h=4.0)
        result = classify_snapshot("TEST", s)
        assert "explosive" not in result.get("archetype", "").lower()
        assert "explosive" not in result.get("risk_recommendation", "").lower()
