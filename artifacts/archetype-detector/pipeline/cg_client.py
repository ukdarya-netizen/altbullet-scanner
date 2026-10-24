"""
CoinGlass API v4 — клиент с ротацией ключей и retry.

Логика:
  • 5 ключей (COINGLASS_API_KEY … COINGLASS_API_KEY_5) — round-robin.
  • 429 → пробуем следующий ключ, sleep 0.5 s; исчерпали все → sleep 60 s.
  • Сетевая ошибка / 5xx → до 3 попыток с экспоненциальным backoff.
  • Возвращает data-поле из JSON или None при неустранимой ошибке.
"""
from __future__ import annotations

import os
import time
import threading
import logging
import requests
from typing import Any

logger = logging.getLogger(__name__)

BASE_URL = "https://open-api-v4.coinglass.com"
TIMEOUT  = 12  # сек

_keys: list[str] = [v for k in (
    "COINGLASS_API_KEY",
    "COINGLASS_API_KEY_2",
    "COINGLASS_API_KEY_3",
    "COINGLASS_API_KEY_4",
    "COINGLASS_API_KEY_5",
) if (v := os.environ.get(k))]

_idx_lock = threading.Lock()
_key_idx  = 0


def _next_key() -> str | None:
    global _key_idx
    if not _keys:
        return None
    with _idx_lock:
        k = _keys[_key_idx % len(_keys)]
        _key_idx += 1
    return k


def cg_get(endpoint: str, params: dict[str, Any] | None = None, *, retries: int = 3) -> Any:
    """
    GET {BASE_URL}{endpoint}.
    Возвращает data-поле ответа или None.
    """
    url = BASE_URL + endpoint
    all_keys = list(_keys)
    if not all_keys:
        logger.error("cg_get: нет CoinGlass API ключей")
        return None

    for attempt in range(retries):
        key = _next_key()
        if key is None:
            return None
        headers = {"CG-API-KEY": key, "Accept": "application/json"}
        try:
            resp = requests.get(url, headers=headers, params=params, timeout=TIMEOUT)
        except requests.RequestException as exc:
            wait = 2 ** attempt
            logger.warning("cg_get %s: сетевая ошибка %s — retry %d/%d, sleep %ds",
                           endpoint, exc, attempt + 1, retries, wait)
            time.sleep(wait)
            continue

        if resp.status_code == 429:
            logger.warning("cg_get %s: 429 (ключ …%s) — пробуем след. ключ", endpoint, key[-4:])
            time.sleep(0.5)
            if attempt + 1 == retries:
                logger.error("cg_get %s: все попытки исчерпаны на 429, sleep 60s", endpoint)
                time.sleep(60)
            continue

        if not resp.ok:
            logger.debug("cg_get %s: HTTP %d — retry %d/%d", endpoint, resp.status_code, attempt + 1, retries)
            time.sleep(1)
            continue

        try:
            body = resp.json()
        except Exception:
            logger.warning("cg_get %s: невалидный JSON", endpoint)
            return None

        if str(body.get("code")) != "0":
            logger.debug("cg_get %s: code=%s msg=%s", endpoint, body.get("code"), body.get("msg"))
            return None

        return body.get("data")

    return None


def to_cg_symbol(bingx_symbol: str) -> str:
    """Конвертирует 'BTC-USDT' → 'BTCUSDT' для CoinGlass."""
    return bingx_symbol.replace("-", "")
