"""
Data collection v2 — 90-day window, bars stored, RSI + sideways + per-pattern labels.

Использует точно те же API-паттерны что и collect_pilot_data.py, но добавляет:
  - 90-дневное окно (расширение с 30d → больше тригов для trend_accum)
  - Сохранение баров в price_bars_1h для per-pattern label computation
  - rsi_1h, price_vol_14d для check_patterns_v2 gate'ов
  - label_8pct_24h, label_10pct_12h, label_10pct_24h для per-pattern EV
  - BingX-exclusive символы через BingX API

Запуск:
  python3 collect_v2.py --mode update_pumps        # Ставит label=1 на confirmed_pump
  python3 collect_v2.py --mode scan --start-idx 0  # Сбор full_scan [0..19]
  python3 collect_v2.py --mode bingx               # Сбор BingX-exclusive
  python3 collect_v2.py --mode scan --start-idx 20 # Следующий батч
"""
from __future__ import annotations

import argparse
import logging
import math
import os
import sys
import time

import psycopg2

sys.path.insert(0, str(__import__("pathlib").Path(__file__).parent))
from pipeline import duckdb_store as duck
from pipeline import coinalyze_client as cal_client
from pipeline.bingx_client import get_klines_range, BINGX_EXCLUSIVE_SYMBOLS

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s", datefmt="%H:%M:%S")
logger = logging.getLogger("collect_v2")

DB_URL      = os.environ["DATABASE_URL"]
DAYS_BACK   = 90
MS_PER_H    = 3_600_000
MS_PER_DAY  = 86_400_000
SNAP_STEP_MS = 4 * MS_PER_H       # снапшот каждые 4h
WIN_8_PCT   = 8.0
WIN_10_PCT  = 10.0
WIN_12_MS   = 12 * MS_PER_H
WIN_24_MS   = 24 * MS_PER_H


# ── Утилиты ──────────────────────────────────────────────────────────────────

def calc_pct(new: float | None, old: float | None) -> float | None:
    if new is None or old is None or old == 0:
        return None
    return (new - old) / old * 100.0


def bingx_to_cz_symbol(bingx_sym: str) -> str:
    """BTC-USDT → BTCUSDT_PERP.A"""
    base = bingx_sym.replace("-USDT", "").replace("_USDT", "")
    return f"{base}USDT_PERP.A"


# ── Загрузка OHLCV (идентично collect_pilot_data.py) ─────────────────────────

def download_ohlcv_for_symbol(
    symbol: str, from_ms: int, to_ms: int, exchange: str = "Binance"
) -> list[dict]:
    """
    Скачивает 1h OHLCV через CoinGlass /api/futures/price/history.
    Возвращает [{ts_ms, open, high, low, close, volume}].
    """
    all_bars: list[dict] = []
    limit    = 900
    step_ms  = limit * MS_PER_H

    cur_to = to_ms
    while cur_to > from_ms:
        cur_from = max(from_ms, cur_to - step_ms)
        bars = cg_client.cg_get("/api/futures/price/history", {
            "exchange": exchange,
            "symbol":   symbol,
            "interval": "1h",
            "from":     cur_from // 1000,
            "to":       cur_to   // 1000,
            "limit":    limit,
        })
        if isinstance(bars, list) and bars:
            all_bars.extend(bars)
        cur_to = cur_from
        time.sleep(0.25)

    seen: set[int] = set()
    result: list[dict] = []
    for b in all_bars:
        ts = None
        if isinstance(b, list):
            if len(b) >= 5:
                ts = int(b[0])
                o = float(b[1]); h = float(b[2]); l = float(b[3]); c = float(b[4])
                vol = float(b[5]) if len(b) >= 6 else 0.0
        elif isinstance(b, dict):
            ts_raw = b.get("t") or b.get("time") or b.get("ts")
            if ts_raw is None:
                continue
            ts = int(ts_raw)
            if ts < 1e12:
                ts *= 1000
            o   = float(b.get("o") or b.get("open",   0))
            h   = float(b.get("h") or b.get("high",   0))
            l   = float(b.get("l") or b.get("low",    0))
            c   = float(b.get("c") or b.get("close",  0))
            vol = float(b.get("v") or b.get("volume") or 0)
        else:
            continue
        if ts and ts not in seen:
            seen.add(ts)
            result.append({"ts_ms": ts, "open": o, "high": h, "low": l, "close": c, "volume": vol})

    result.sort(key=lambda x: x["ts_ms"])
    return result


# ── OI (Coinalyze) ───────────────────────────────────────────────────────────

def download_oi_batch(symbols: list[str], from_s: int, to_s: int) -> dict[str, list[dict]]:
    """
    symbols: список BingX-символов (BTC-USDT).
    Возвращает {cz_base: sorted_bars}.
    """
    cz_syms = [bingx_to_cz_symbol(s) for s in symbols]
    data = cal_client.get_oi_history(cz_syms, from_s, to_s, interval="30min")
    return {base: sorted(bars, key=lambda x: x["t"]) for base, bars in data.items()}


def compute_oi_features(oi_bars: list[dict], snap_ts_s: int) -> dict:
    """snap_ts_s = unix SECONDS."""
    idx = None
    for i, b in enumerate(oi_bars):
        if b["t"] <= snap_ts_s + 900:
            idx = i

    def oi_at(n: int):
        if idx is None or (idx - n) < 0:
            return None
        return oi_bars[idx - n]["c"]

    c0 = oi_at(0); c1 = oi_at(1); c2 = oi_at(2)
    c4 = oi_at(4); c8 = oi_at(8)
    return {
        "oi_30m":      calc_pct(c0, c1),
        "oi_prev_30m": calc_pct(c1, c2),
        "oi_1h":       calc_pct(c0, c2),
        "oi_prev_1h":  calc_pct(c2, c4),
        "oi_4h":       calc_pct(c0, c8),
    }


# ── Ценовые метрики ───────────────────────────────────────────────────────────

def compute_price_features(bars: list[dict], snap_ts_ms: int) -> dict | None:
    idx = None
    for i, b in enumerate(bars):
        if b["ts_ms"] <= snap_ts_ms:
            idx = i
    if idx is None or bars[idx]["close"] == 0:
        return None

    price_now = bars[idx]["close"]
    vol_now   = bars[idx]["volume"]

    def price_at(h_back: int) -> float | None:
        target = snap_ts_ms - h_back * MS_PER_H
        for b in reversed(bars[:idx + 1]):
            if b["ts_ms"] <= target + 1_800_000:
                return b["close"] if b["close"] != 0 else None
        return None

    def avg_vol(h_window: int, h_back_start: int = 0) -> float | None:
        t_end   = snap_ts_ms - h_back_start * MS_PER_H
        t_start = t_end - h_window * MS_PER_H
        vols = [b["volume"] for b in bars if t_start <= b["ts_ms"] <= t_end and b["volume"] > 0]
        return sum(vols) / len(vols) if vols else None

    p1h  = price_at(1);  p3h = price_at(3)
    p4h  = price_at(4);  p24h = price_at(24)
    avg_v = avg_vol(24, h_back_start=48)

    return {
        "price_1h":  calc_pct(price_now, p1h),
        "price_3h":  calc_pct(price_now, p3h),
        "price_4h":  calc_pct(price_now, p4h),
        "price_24h": calc_pct(price_now, p24h),
        "vol_mult":  (vol_now / avg_v) if (avg_v and avg_v > 0 and vol_now > 0) else None,
        "_close":    price_now,
    }


# ── RSI + технические индикаторы ──────────────────────────────────────────────

def compute_rsi(bars: list[dict], snap_ts_ms: int, period: int = 14) -> float | None:
    closes = [b["close"] for b in bars if b["ts_ms"] <= snap_ts_ms and b["close"] > 0]
    if len(closes) < period + 1:
        return None
    subset = closes[-(period + 1):]
    gains  = [max(subset[i] - subset[i-1], 0) for i in range(1, period + 1)]
    losses = [max(subset[i-1] - subset[i], 0) for i in range(1, period + 1)]
    avg_g  = sum(gains)  / period
    avg_l  = sum(losses) / period
    if avg_l == 0:
        return 100.0
    return 100 - 100 / (1 + avg_g / avg_l)


def compute_price_vol_14d(bars: list[dict], snap_ts_ms: int) -> float | None:
    """(max_high − min_low) / avg_close за 14 дней до snap_ts_ms."""
    start_14d = snap_ts_ms - 14 * MS_PER_DAY
    subset = [b for b in bars if start_14d <= b["ts_ms"] < snap_ts_ms and b["high"] > 0]
    if len(subset) < 48:
        return None
    highs  = [b["high"]  for b in subset]
    lows   = [b["low"]   for b in subset if b.get("low", 0) > 0]
    closes = [b["close"] for b in subset if b["close"] > 0]
    if not highs or not lows or not closes:
        return None
    avg_c = sum(closes) / len(closes)
    if avg_c == 0:
        return None
    return (max(highs) - min(lows)) / avg_c * 100.0


# ── Labels ────────────────────────────────────────────────────────────────────

def compute_labels_v2(bars: list[dict], snap_ts_ms: int, snap_close: float) -> dict:
    """Forward-looking labels из баров ПОСЛЕ snap_ts_ms."""
    if not snap_close or snap_close == 0:
        return {"label_8pct_24h": 0, "label_10pct_12h": 0, "label_10pct_24h": 0, "label_win": 0}

    future_12h = [b["high"] for b in bars if snap_ts_ms < b["ts_ms"] <= snap_ts_ms + WIN_12_MS and b["high"] > 0]
    future_24h = [b["high"] for b in bars if snap_ts_ms < b["ts_ms"] <= snap_ts_ms + WIN_24_MS and b["high"] > 0]

    max_12h = max(future_12h) if future_12h else 0.0
    max_24h = max(future_24h) if future_24h else 0.0

    return {
        "label_8pct_24h":  1 if max_24h >= snap_close * (1 + WIN_8_PCT  / 100) else 0,
        "label_10pct_12h": 1 if max_12h >= snap_close * (1 + WIN_10_PCT / 100) else 0,
        "label_10pct_24h": 1 if max_24h >= snap_close * (1 + WIN_10_PCT / 100) else 0,
        "label_win":       1 if max_12h >= snap_close * 1.20 else 0,  # legacy
    }


# ── Confirmed pump — обновление label колонок ─────────────────────────────────

def update_confirmed_pump_labels():
    """Ставит новые label=1 на все confirmed_pump строки (они confirmed wins по определению)."""
    con = duck.get_conn()
    con.execute("""
        UPDATE market_snapshots
        SET label_8pct_24h     = 1,
            label_10pct_12h    = 1,
            label_10pct_24h    = 1,
            rsi_1h             = NULL,
            price_vol_14d      = NULL,
            is_bingx_exclusive = FALSE
        WHERE source = 'confirmed_pump'
    """)
    n = con.execute("SELECT COUNT(*) FROM market_snapshots WHERE source='confirmed_pump'").fetchone()[0]
    logger.info("Обновлено %d confirmed_pump строк (все labels=1)", n)


# ── Загрузка символов ─────────────────────────────────────────────────────────

def load_scan_symbols(limit: int = 200) -> list[str]:
    conn = psycopg2.connect(DB_URL)
    with conn.cursor() as cur:
        cur.execute("""
            SELECT symbol FROM prescan_tracker
            WHERE cycle_count >= 1
            ORDER BY cycle_count DESC
            LIMIT %s
        """, (limit,))
        syms = [r[0] for r in cur.fetchall()]
    conn.close()
    logger.info("Выбрано %d символов из prescan_tracker", len(syms))
    return syms


# ── Сбор одного CG-символа ────────────────────────────────────────────────────

def collect_cg_symbol(
    symbol: str,
    oi_data: dict[str, list[dict]],
    from_ms: int,
    to_ms: int,
    source: str = "full_scan",
) -> int:
    """
    Скачивает OHLCV через BingX API (CG price/history недоступен на текущем плане).
    oi_data: {cz_base: sorted_bars} — уже загружено батчем.
    """
    cg_sym   = symbol.replace("-USDT", "").replace("_USDT", "").replace("1000", "")
    cz_base  = cg_sym + "USDT"  # key в oi_data (FARTCOINUSDT)

    # Скачиваем через BingX API (публичный, покрывает все BingX-символы)
    try:
        bars = get_klines_range(symbol, start_ms=from_ms, end_ms=to_ms, interval="1h")
    except Exception as exc:
        logger.warning("  %s BingX OHLCV failed: %s", symbol, exc)
        bars = []
    if not bars:
        logger.info("  %s: 0 CG bars → пропускаем", symbol)
        return 0

    # Сохраняем бары
    duck.upsert_bars_batch([
        {"symbol": symbol, "ts_ms": b["ts_ms"], "high": b["high"], "close": b["close"]}
        for b in bars
    ])

    # OI для этого символа
    oi_bars = oi_data.get(cz_base, [])

    # Точки снапшотов (каждые 4h, с отступом 14d в начале для RSI/vol14d)
    snap_start = from_ms + 14 * MS_PER_DAY
    snap_points = list(range(
        (snap_start // SNAP_STEP_MS + 1) * SNAP_STEP_MS,
        to_ms - WIN_24_MS,  # нужно 24h вперёд для label
        SNAP_STEP_MS,
    ))

    snap_rows = []
    for snap_ts_ms in snap_points:
        pf = compute_price_features(bars, snap_ts_ms)
        if pf is None:
            continue

        snap_close = pf.pop("_close", None)
        if snap_close is None or snap_close == 0:
            continue

        oi_feats = compute_oi_features(oi_bars, snap_ts_ms // 1000) if oi_bars else {
            "oi_30m": None, "oi_prev_30m": None, "oi_1h": None,
            "oi_prev_1h": None, "oi_4h": None,
        }

        rsi    = compute_rsi(bars, snap_ts_ms)
        vol14d = compute_price_vol_14d(bars, snap_ts_ms)
        labels = compute_labels_v2(bars, snap_ts_ms, snap_close)

        snap_rows.append({
            "symbol":             symbol,
            "snapshot_ts_ms":     snap_ts_ms,
            **pf,
            **oi_feats,
            "cvd_1h":             None,
            "cvd_30m":            None,
            "spot_net_pct":       None,
            "funding":            None,
            "rsi_1h":             rsi,
            "price_vol_14d":      vol14d,
            "is_bingx_exclusive": False,
            **labels,
            "source":             source,
        })

    if not snap_rows:
        return 0

    inserted = duck.upsert_snapshot_batch(snap_rows)
    logger.info("  %s: %d bars → %d snapshots (OI bars=%d)", symbol, len(bars), inserted, len(oi_bars))
    return inserted


# ── BingX-exclusive ───────────────────────────────────────────────────────────

def collect_bingx_exclusive(from_ms: int, to_ms: int) -> int:
    total = 0
    for sym in BINGX_EXCLUSIVE_SYMBOLS:
        logger.info("BingX-excl: %s", sym)
        try:
            bars = get_klines_range(sym, start_ms=from_ms, end_ms=to_ms, interval="1h")
        except Exception as exc:
            logger.warning("  %s BingX API failed: %s", sym, exc)
            continue
        if not bars:
            logger.info("  %s: 0 bars", sym)
            continue

        duck.upsert_bars_batch([
            {"symbol": sym, "ts_ms": b["ts_ms"], "high": b["high"], "close": b["close"]}
            for b in bars
        ])

        snap_start = from_ms + 14 * MS_PER_DAY
        snap_points = list(range(
            (snap_start // SNAP_STEP_MS + 1) * SNAP_STEP_MS,
            to_ms - WIN_24_MS,
            SNAP_STEP_MS,
        ))

        snap_rows = []
        for snap_ts_ms in snap_points:
            pf = compute_price_features(bars, snap_ts_ms)
            if pf is None:
                continue
            snap_close = pf.pop("_close", None)
            if not snap_close:
                continue

            rsi    = compute_rsi(bars, snap_ts_ms)
            vol14d = compute_price_vol_14d(bars, snap_ts_ms)
            labels = compute_labels_v2(bars, snap_ts_ms, snap_close)

            snap_rows.append({
                "symbol":             sym,
                "snapshot_ts_ms":     snap_ts_ms,
                **pf,
                "oi_30m": None, "oi_prev_30m": None, "oi_1h": None,
                "oi_prev_1h": None, "oi_4h": None,
                "cvd_1h": None, "cvd_30m": None,
                "spot_net_pct": None, "funding": None,
                "rsi_1h":             rsi,
                "price_vol_14d":      vol14d,
                "is_bingx_exclusive": True,
                **labels,
                "source":             "bingx_excl",
            })

        if snap_rows:
            inserted = duck.upsert_snapshot_batch(snap_rows)
            logger.info("  %s: %d bars → %d snapshots", sym, len(bars), inserted)
            total += inserted

    return total


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--mode", choices=["scan", "bingx", "update_pumps"], default="scan")
    parser.add_argument("--start-idx", type=int, default=0)
    parser.add_argument("--count",     type=int, default=20)
    parser.add_argument("--days",      type=int, default=DAYS_BACK)
    args = parser.parse_args()

    # Инициализируем схему
    duck.get_conn()

    now_ms   = int(time.time() * 1000)
    from_ms  = now_ms - args.days * MS_PER_DAY
    to_ms    = now_ms - WIN_24_MS  # нужно 24h вперёд для label

    if args.mode == "update_pumps":
        update_confirmed_pump_labels()
        return

    if args.mode == "bingx":
        n = collect_bingx_exclusive(from_ms, to_ms)
        logger.info("BingX-excl итого: %d snapshots", n)
        _print_db_stats()
        return

    # mode == "scan"
    all_symbols = load_scan_symbols(limit=200)
    symbols = all_symbols[args.start_idx: args.start_idx + args.count]
    logger.info("Обрабатываем %d символов [%d..%d] из %d total, days=%d",
                len(symbols), args.start_idx, args.start_idx + len(symbols) - 1,
                len(all_symbols), args.days)

    # Загружаем OI батчем
    from_s = from_ms // 1000
    to_s   = to_ms   // 1000
    logger.info("Загружаем OI для %d символов...", len(symbols))
    oi_map = {}
    OI_BATCH = 20
    for i in range(0, len(symbols), OI_BATCH):
        batch = symbols[i:i + OI_BATCH]
        data  = download_oi_batch(batch, from_s, to_s)
        oi_map.update(data)
        done = min(i + OI_BATCH, len(symbols))
        logger.info("  OI: %d/%d готово (%d ответов)", done, len(symbols), len(data))
        time.sleep(0.2)
    logger.info("OI загружен для %d/%d символов", len(oi_map), len(symbols))

    total_snaps = 0
    for i, sym in enumerate(symbols):
        logger.info("[%d/%d] %s", i + 1, len(symbols), sym)
        try:
            n = collect_cg_symbol(sym, oi_map, from_ms, to_ms)
            total_snaps += n
        except Exception as exc:
            logger.error("%s failed: %s", sym, exc, exc_info=True)
        time.sleep(0.2)

    logger.info("Готово: %d snapshots из %d символов", total_snaps, len(symbols))
    _print_db_stats()


def _print_db_stats():
    con = duck.get_conn()
    rows = con.execute("""
        SELECT source, COUNT(*) n,
               SUM(CASE WHEN label_10pct_24h=1 THEN 1 ELSE 0 END) wins10,
               SUM(CASE WHEN label_8pct_24h=1  THEN 1 ELSE 0 END) wins8
        FROM market_snapshots GROUP BY source
    """).fetchall()
    bars_n = con.execute("SELECT COUNT(*) FROM price_bars_1h").fetchone()[0]
    print("\n── DB stats ──")
    for src, n, w10, w8 in rows:
        pct10 = round(100 * (w10 or 0) / max(1, n), 1)
        pct8  = round(100 * (w8  or 0) / max(1, n), 1)
        print(f"  {src:20s}: {n:6d} rows  wins_10%={pct10}%  wins_8%={pct8}%")
    print(f"  price_bars_1h: {bars_n:,} rows")


if __name__ == "__main__":
    main()
