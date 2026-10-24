#!/usr/bin/env python3
"""
BTC research export (read-only). Collects BTC history for designing the BTC
signal bot: BingX BTC-USDT price candles + CoinGlass aggregated derivatives
flow, all at 15m, and writes plain CSV files to data/btc/.

Nothing is written to the database and no order/account endpoint is called.

Run (Replit shell, production secrets present):
    python3 scripts/btc_export.py            # 180 days
    python3 scripts/btc_export.py --days 90  # shorter

Output: data/btc/<dataset>.csv + data/btc/coverage.json (rows, first/last
timestamp and any error per dataset, so gaps are visible, never filled).
"""

import argparse
import csv
import json
import os
import sys
import time
from datetime import datetime, timezone

import requests

CG_BASE = "https://open-api-v4.coinglass.com"
BINGX_BASE = "https://open-api.bingx.com"
M15 = 15 * 60 * 1000
OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data", "btc")

# Same single secret the live scanner uses (coinglass_keys.ts).
CG_KEYS = [k.strip() for k in [os.environ.get("CoinGlassAPI")] if k and k.strip()]

FUTURES_EXCHANGES = (
    "ApeX Omni,Aster,Binance,BingX,Bitfinex,Bitget,Bitunix,Bybit,CME,Coinbase,"
    "Crypto.com,Deribit,Drift,EdgeX,Extended,Gate,HTX,Hyperliquid,Kraken,KuCoin,"
    "LBank,Lighter,MEXC,OKX,Paradex,WhiteBIT,dYdX,tradeXYZ"
)
SPOT_EXCHANGES = "Binance,Bitfinex,Bitget,Bybit,Coinbase,Crypto.com,Gate,Kraken,OKX,Upbit"

_key_index = 0
_calls = 0


def utc(ms):
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).isoformat()


def cg_get(path, params, retries=3):
    """One CoinGlass call. Rotates keys on 429; returns (data, error)."""
    global _key_index, _calls
    if not CG_KEYS:
        return None, "CoinGlassAPI secret missing"
    last_error = None
    for attempt in range(retries):
        key = CG_KEYS[_key_index % len(CG_KEYS)]
        try:
            r = requests.get(f"{CG_BASE}{path}", params=params,
                             headers={"CG-API-KEY": key, "Accept": "application/json"},
                             timeout=20)
            _calls += 1
            if r.status_code == 429:
                _key_index += 1
                time.sleep(5 * (attempt + 1))
                last_error = "HTTP 429"
                continue
            body = r.json()
            if str(body.get("code")) != "0":
                return None, f"code={body.get('code')} msg={body.get('msg')}"
            return body.get("data"), None
        except Exception as error:  # network / JSON
            last_error = f"{type(error).__name__}: {error}"
            time.sleep(3)
    return None, last_error


def page_backwards(fetch, start_ms, end_ms, limit=1000, pause=4.0):
    """Collect rows from end_ms back to start_ms using end_time paging."""
    rows, cursor, error = {}, end_ms, None
    while cursor > start_ms:
        data, error = fetch(max(start_ms, cursor - limit * M15), cursor, limit)
        if error:
            break
        if not data:
            break
        times = []
        for row in data:
            t = int(row.get("time") or row.get("t") or 0)
            if t and start_ms <= t <= end_ms:
                rows[t] = row
                times.append(t)
        if not times:
            break
        earliest = min(times)
        if earliest >= cursor:
            break
        cursor = earliest - 1
        time.sleep(pause)
    return [rows[t] for t in sorted(rows)], error


def cg_dataset(path, base_params):
    def fetch(start, end, limit):
        params = dict(base_params, interval="15m", limit=limit,
                      start_time=start, end_time=end)
        return cg_get(path, params)
    return fetch


def bingx_klines(start, end, limit):
    try:
        r = requests.get(f"{BINGX_BASE}/openApi/swap/v3/quote/klines", params={
            "symbol": "BTC-USDT", "interval": "15m",
            "startTime": start, "endTime": end, "limit": min(limit, 1440),
        }, timeout=20)
        body = r.json()
        if body.get("code") != 0:
            return None, f"code={body.get('code')} msg={body.get('msg')}"
        rows = []
        for k in body.get("data") or []:
            rows.append({"time": int(k["time"]), "open": k["open"], "high": k["high"],
                         "low": k["low"], "close": k["close"], "volume": k["volume"]})
        return rows, None
    except Exception as error:
        return None, f"{type(error).__name__}: {error}"


DATASETS = {
    # BingX execution venue price (what signals are traded on).
    "price_bingx_15m": bingx_klines,
    "oi_aggregated_15m": cg_dataset(
        "/api/futures/open-interest/aggregated-history",
        {"symbol": "BTC"}),
    "liquidation_aggregated_15m": cg_dataset(
        "/api/futures/liquidation/aggregated-history",
        {"symbol": "BTC", "exchange_list": FUTURES_EXCHANGES}),
    "futures_taker_aggregated_15m": cg_dataset(
        "/api/futures/aggregated-taker-buy-sell-volume/history",
        {"symbol": "BTC", "exchange_list": FUTURES_EXCHANGES}),
    "spot_taker_aggregated_15m": cg_dataset(
        "/api/spot/aggregated-taker-buy-sell-volume/history",
        {"symbol": "BTC", "exchange_list": SPOT_EXCHANGES}),
    "spot_cvd_aggregated_15m": cg_dataset(
        "/api/spot/aggregated-cvd/history",
        {"symbol": "BTC", "exchange_list": SPOT_EXCHANGES}),
    "funding_oi_weighted_15m": cg_dataset(
        "/api/futures/funding-rate/oi-weight-history",
        {"symbol": "BTC"}),
    "global_long_short_binance_15m": cg_dataset(
        "/api/futures/global-long-short-account-ratio/history",
        {"exchange": "Binance", "symbol": "BTCUSDT"}),
    "orderbook_aggregated_1pct_15m": cg_dataset(
        "/api/futures/orderbook/aggregated-ask-bids-history",
        {"symbol": "BTC", "exchange_list": FUTURES_EXCHANGES, "range": "1"}),
}


def write_csv(name, rows):
    path = os.path.join(OUT_DIR, f"{name}.csv")
    keys = []
    for row in rows:
        for key in row:
            if key not in keys:
                keys.append(key)
    with open(path, "w", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=keys)
        writer.writeheader()
        for row in rows:
            writer.writerow({k: row.get(k) for k in keys})
    return path


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--days", type=int, default=180)
    parser.add_argument("--only", default="", help="comma list of dataset names")
    args = parser.parse_args()
    os.makedirs(OUT_DIR, exist_ok=True)
    end = (int(time.time() * 1000) // M15) * M15 - 1
    start = end - args.days * 24 * 60 * 60 * 1000
    wanted = [n for n in DATASETS if not args.only or n in args.only.split(",")]
    coverage = {"generatedAt": utc(int(time.time() * 1000)),
                "requestedStart": utc(start), "requestedEnd": utc(end), "datasets": {}}
    for name in wanted:
        limit = 1440 if name == "price_bingx_15m" else 1000
        # ~15 CoinGlass calls/min so the live scanner keeps its request budget.
        pause = 0.3 if name == "price_bingx_15m" else 4.0
        rows, error = page_backwards(DATASETS[name], start, end, limit=limit, pause=pause)
        write_csv(name, rows)
        times = [int(r.get("time") or 0) for r in rows]
        expected = (end - start) // M15
        coverage["datasets"][name] = {
            "rows": len(rows),
            "expectedRows": expected,
            "first": utc(min(times)) if times else None,
            "last": utc(max(times)) if times else None,
            "error": error,
        }
        print(f"{name}: {len(rows)}/{expected} rows"
              + (f" (stopped: {error})" if error else ""), flush=True)
    coverage["coinglassCalls"] = _calls
    with open(os.path.join(OUT_DIR, "coverage.json"), "w") as handle:
        json.dump(coverage, handle, indent=2)
    print(json.dumps(coverage, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
