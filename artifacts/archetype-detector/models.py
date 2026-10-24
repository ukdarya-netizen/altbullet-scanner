"""
Pydantic-модели для оркестратора архетипов роста.
"""
from __future__ import annotations
from typing import Optional, Any
from datetime import datetime
from pydantic import BaseModel, field_validator


class SnapshotInput(BaseModel):
    """Входной снэпшот метрик — единый контракт POST /classify."""
    symbol: str
    snapshot_time: datetime

    # OI-поля (% изменение за окно)
    oi_30m: Optional[float] = None
    oi_prev_30m: Optional[float] = None
    oi_1h: Optional[float] = None
    oi_prev_1h: Optional[float] = None
    oi_4h: Optional[float] = None

    # Объём
    vol_mult: Optional[float] = None
    spot_vol_mult: Optional[float] = None

    # Цена
    price_1h: Optional[float] = None
    price_3h: Optional[float] = None
    price_4h: Optional[float] = None
    price_24h: Optional[float] = None

    # CVD (опциональные усилители confidence — NOT обязательные условия входа)
    cvd_1h: Optional[bool] = None
    cvd_1h_ratio: Optional[float] = None
    cvd_30m: Optional[bool] = None

    # Дополнительные (опциональные усилители)
    spot_net_pct: Optional[float] = None
    net_buy_pct: Optional[float] = None
    funding: Optional[float] = None


class SignalOutput(BaseModel):
    """Выходной сигнал — единый контракт ответа API."""
    symbol: str
    snapshot_time: Optional[datetime] = None
    archetype: str
    confidence_score: Optional[int] = None
    trigger_metrics: Optional[dict[str, Any]] = None
    risk_recommendation: Optional[str] = None
    status: str = "active"
    note: Optional[str] = None
    reason: Optional[str] = None


class WatchlistEntry(BaseModel):
    symbol: str
    added_at: Optional[datetime] = None
    last_snapshot_time: Optional[datetime] = None
    last_metrics: Optional[dict[str, Any]] = None
