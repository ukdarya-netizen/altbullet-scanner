"""
BingX public klines API — для BingX-exclusive токенов (нет в CoinGlass/Binance).
Endpoint публичный, авторизация не требуется для price data.
"""
from __future__ import annotations
import time
import logging
import requests

logger = logging.getLogger(__name__)

_BASE = "https://open-api.bingx.com"
_SESSION = requests.Session()
_SESSION.headers["User-Agent"] = "AlphaScanner/2.0"


def get_klines(
    symbol: str,
    interval: str = "1h",
    start_ms: int | None = None,
    end_ms: int | None = None,
    limit: int = 1000,
) -> list[dict]:
    """
    Возвращает [{ts_ms, open, high, low, close, volume}] для BingX-exclusive символов.
    symbol format: LONGXIA-USDT (с дефисом, не LONGXIA_USDT)
    interval: 1h | 4h | 1d
    """
    params: dict = {"symbol": symbol, "interval": interval, "limit": limit}
    if start_ms:
        params["startTime"] = start_ms
    if end_ms:
        params["endTime"] = end_ms

    try:
        resp = _SESSION.get(
            f"{_BASE}/openApi/swap/v2/quote/klines",
            params=params,
            timeout=10,
        )
        resp.raise_for_status()
        data = resp.json()
    except Exception as exc:
        logger.warning("BingX klines %s failed: %s", symbol, exc)
        return []

    raw = data.get("data") or []
    result = []
    for bar in raw:
        try:
            if isinstance(bar, dict):
                ts  = int(bar.get("time", bar.get("ts", bar.get("t", 0))))
                o   = float(bar.get("open",   0))
                h   = float(bar.get("high",   0))
                l   = float(bar.get("low",    0))
                c   = float(bar.get("close",  0))
                vol = float(bar.get("volume", 0))
            else:
                ts  = int(bar[0]);  o = float(bar[1]); h = float(bar[2])
                l   = float(bar[3]); c = float(bar[4]); vol = float(bar[5]) if len(bar) > 5 else 0.0
            result.append({"ts_ms": ts, "open": o, "high": h, "low": l, "close": c, "volume": vol})
        except (IndexError, KeyError, ValueError, TypeError):
            continue
    return result


def get_klines_range(
    symbol: str,
    start_ms: int,
    end_ms: int,
    interval: str = "1h",
    max_bars_per_req: int = 1000,
) -> list[dict]:
    """
    Скачивает bars постранично (limit=1000 за запрос).
    """
    all_bars: list[dict] = []
    cur = start_ms
    interval_ms = {"1h": 3_600_000, "4h": 14_400_000, "1d": 86_400_000}.get(interval, 3_600_000)
    while cur < end_ms:
        chunk_end = min(cur + max_bars_per_req * interval_ms, end_ms)
        bars = get_klines(symbol, interval=interval, start_ms=cur, end_ms=chunk_end, limit=max_bars_per_req)
        if not bars:
            break
        all_bars.extend(bars)
        last_ts = bars[-1]["ts_ms"]
        if last_ts <= cur:
            break
        cur = last_ts + interval_ms
        time.sleep(0.15)
    return all_bars


# Список известных BingX-exclusive символов (нет данных в CoinGlass/Binance)
BINGX_EXCLUSIVE_SYMBOLS = [
    "LONGXIA-USDT",
    "BITLIGHT-USDT",
    "WHITEWHALE-USDT",
    "BLEND-USDT",
    "METEORA-USDT",
    "ANSEM-USDT",
    "NES-USDT",
    "OFC-USDT",
    "NOMINA-USDT",
    "EDGEX-USDT",
    "MIRANETWORK-USDT",
    "BUTTCOIN-USDT",
]
