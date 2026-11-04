"""
Coinalyze API client — исторические данные OI (30m бары).

Symbol format: BTC-USDT → BTCUSDT_PERP.A
Endpoint: GET https://api.coinalyze.net/v1/open-interest-history
Response: [{symbol, history: [{t, o, h, l, c}]}]  — c = close OI в USD
Rate limit: 100 req/day per key × 5 keys = 500 req/day.
"""
from __future__ import annotations
import os, time, requests, logging
from typing import Any

logger = logging.getLogger(__name__)

_KEY_NAMES = [
    "COINALYZE_API_KEY",
    "COINALYZE_API_KEY_2",
    "COINALYZE_API_KEY_3",
    "COINALYZE_API_KEY_4",
    "COINALYZE_API_KEY_5",
]
_keys = [v for k in _KEY_NAMES if (v := os.environ.get(k))]
_key_idx = 0


def _next_key() -> str | None:
    global _key_idx
    if not _keys:
        return None
    k = _keys[_key_idx % len(_keys)]
    _key_idx += 1
    return k


def to_coinalyze_symbol(bingx_symbol: str) -> str:
    """BTC-USDT → BTCUSDT_PERP.A"""
    base = bingx_symbol.replace("-USDT", "")
    return f"{base}USDT_PERP.A"


def get_oi_history(
    symbols: list[str],
    from_s: int,
    to_s: int,
    interval: str = "30min",
    retries: int = 3,
) -> dict[str, list[dict]]:
    """
    Запрашивает OI историю для нескольких символов.
    symbols: list of Coinalyze format (BTCUSDT_PERP.A, ...)
    from_s / to_s: unix seconds
    Возвращает {symbol_without_suffix: [{"t": unix_s, "c": oi_usd}, ...]}
    """
    key = _next_key()
    if not key:
        logger.error("Нет Coinalyze API ключей")
        return {}

    url = "https://api.coinalyze.net/v1/open-interest-history"
    params = {
        "symbols": ",".join(symbols),
        "interval": interval,
        "from": from_s,
        "to": to_s,
        "api_key": key,
    }

    for attempt in range(retries):
        try:
            resp = requests.get(url, params=params, timeout=15)
        except requests.RequestException as exc:
            wait = 2 ** attempt
            logger.warning("Coinalyze error %s — retry %d/%d sleep %ds", exc, attempt+1, retries, wait)
            time.sleep(wait)
            continue

        if resp.status_code == 429:
            logger.warning("Coinalyze 429 — sleep 60s")
            time.sleep(60)
            key = _next_key()
            params["api_key"] = key
            continue

        if not resp.ok:
            logger.warning("Coinalyze HTTP %d", resp.status_code)
            time.sleep(1)
            continue

        try:
            data = resp.json()
        except Exception:
            return {}

        result: dict[str, list[dict]] = {}
        for entry in (data if isinstance(data, list) else []):
            sym_full = entry.get("symbol", "")
            sym_base = sym_full.replace(".A", "")
            history = entry.get("history", [])
            result[sym_base] = [{"t": h["t"], "c": h["c"]} for h in history if "t" in h and "c" in h]

        return result

    return {}
