"""
DuckDB — хранилище исторических данных CoinGlass.

Таблицы:
  ohlcv               — OHLCV-свечи фьючерсов (Binance, интервал 1h/4h)
  orderbook_heatmap   — снапшоты ордербука (bids/asks JSON, интервал 30m)
  large_limit_orders  — крупные лимитные ордера (история)
  pump_events         — события «пампа» из growth_leader_log PostgreSQL
  analysis_results    — результаты анализа паттернов
  market_snapshots    — снимки рынка: confirmed_pump + full_scan, с label_win
  oi_30m_history      — 30-минутные бары OI от Coinalyze (для full_scan)
"""
from __future__ import annotations

import json
import logging
import threading
from pathlib import Path
from typing import Any

import duckdb

logger = logging.getLogger(__name__)

DB_PATH = Path(__file__).parent.parent / "crypto_data.duckdb"

_conn_lock = threading.Lock()
_conn: duckdb.DuckDBPyConnection | None = None


def get_conn() -> duckdb.DuckDBPyConnection:
    global _conn
    with _conn_lock:
        if _conn is None:
            _conn = duckdb.connect(str(DB_PATH))
            _init_schema(_conn)
    return _conn


def _init_schema(con: duckdb.DuckDBPyConnection) -> None:
    con.execute("""
        CREATE TABLE IF NOT EXISTS ohlcv (
            ts_ms        BIGINT  NOT NULL,
            symbol       VARCHAR NOT NULL,
            exchange     VARCHAR NOT NULL DEFAULT 'Binance',
            interval_str VARCHAR NOT NULL DEFAULT '1h',
            open         DOUBLE,
            high         DOUBLE,
            low          DOUBLE,
            close        DOUBLE,
            volume       DOUBLE,
            PRIMARY KEY (ts_ms, symbol, exchange, interval_str)
        )
    """)

    con.execute("""
        CREATE TABLE IF NOT EXISTS orderbook_heatmap (
            ts_ms        BIGINT  NOT NULL,
            symbol       VARCHAR NOT NULL,
            exchange     VARCHAR NOT NULL DEFAULT 'Binance',
            interval_str VARCHAR NOT NULL DEFAULT '30m',
            bids_json    VARCHAR,
            asks_json    VARCHAR,
            PRIMARY KEY (ts_ms, symbol, exchange, interval_str)
        )
    """)

    con.execute("""
        CREATE TABLE IF NOT EXISTS large_limit_orders (
            symbol        VARCHAR NOT NULL,
            exchange      VARCHAR NOT NULL DEFAULT 'Binance',
            collected_ms  BIGINT  NOT NULL,
            limit_price   DOUBLE,
            usd_value     DOUBLE,
            order_state   INTEGER,
            order_side    INTEGER
        )
    """)

    con.execute("""
        CREATE TABLE IF NOT EXISTS pump_events (
            pg_id             INTEGER PRIMARY KEY,
            symbol            VARCHAR NOT NULL,
            pump_ts_ms        BIGINT  NOT NULL,
            price_24h         DOUBLE,
            price_1h          DOUBLE,
            oi_30m            DOUBLE,
            oi_1h             DOUBLE,
            vol_mult          DOUBLE,
            spot_vol_mult     DOUBLE,
            cycle_count       INTEGER,
            layers_json       VARCHAR,
            entry_price_24h   DOUBLE,
            entry_whale_index DOUBLE,
            entry_snf_1h      DOUBLE,
            entry_ob_ratio    DOUBLE
        )
    """)
    # Idempotent: добавляем новые колонки если таблица уже существует без них
    for col_def in [
        "entry_whale_index DOUBLE",
        "entry_snf_1h      DOUBLE",
        "entry_ob_ratio    DOUBLE",
    ]:
        try:
            con.execute(f"ALTER TABLE pump_events ADD COLUMN IF NOT EXISTS {col_def}")
        except Exception:
            pass  # column already exists

    con.execute("""
        CREATE TABLE IF NOT EXISTS analysis_results (
            run_at         VARCHAR NOT NULL,
            pattern_name   VARCHAR NOT NULL,
            win_rate       DOUBLE,
            sample_count   INTEGER,
            tp_count       INTEGER,
            conditions_json VARCHAR,
            PRIMARY KEY (run_at, pattern_name)
        )
    """)

    # ── Новые таблицы для честного датасета ────────────────────────────────────

    con.execute("""
        CREATE TABLE IF NOT EXISTS oi_30m_history (
            ts_s         BIGINT  NOT NULL,   -- unix seconds (Coinalyze формат)
            symbol       VARCHAR NOT NULL,   -- BTCUSDT_PERP (без .A)
            oi_usd       DOUBLE,             -- OI в USD на закрытие бара
            PRIMARY KEY (ts_s, symbol)
        )
    """)

    con.execute("""
        CREATE TABLE IF NOT EXISTS market_snapshots (
            symbol              VARCHAR NOT NULL,
            snapshot_ts_ms      BIGINT  NOT NULL,
            -- Ценовые метрики
            price_1h            DOUBLE,
            price_3h            DOUBLE,
            price_4h            DOUBLE,
            price_24h           DOUBLE,
            vol_mult            DOUBLE,
            -- OI метрики (из Coinalyze 30m)
            oi_30m              DOUBLE,
            oi_prev_30m         DOUBLE,
            oi_1h               DOUBLE,
            oi_prev_1h          DOUBLE,
            oi_4h               DOUBLE,
            -- Вспомогательные (fail-open для cvd, funding)
            cvd_1h              BOOLEAN,
            cvd_30m             BOOLEAN,
            spot_net_pct        DOUBLE,
            funding             DOUBLE,
            -- Метка (legacy: +20% за 12ч)
            label_win           INTEGER,
            source              VARCHAR,     -- 'confirmed_pump' | 'full_scan' | 'bingx_excl'
            -- Дополнительные поля v2
            rsi_1h              DOUBLE,      -- RSI14 на 1h TF (для oversold_reversal)
            price_vol_14d       DOUBLE,      -- (max-min)/avg за 14д в % (для whale_futures sideways)
            is_bingx_exclusive  BOOLEAN,     -- True если токен отсутствует в CoinGlass
            label_8pct_24h      INTEGER,     -- 1 если max_high в 24h ≥ +8% от snapshot (whale exit target)
            label_10pct_12h     INTEGER,     -- 1 если max_high в 12h ≥ +10%
            label_10pct_24h     INTEGER,     -- 1 если max_high в 24h ≥ +10%
            PRIMARY KEY (symbol, snapshot_ts_ms, source)
        )
    """)

    # Добавляем новые колонки в существующие таблицы (idempotent)
    for col_def in [
        "rsi_1h DOUBLE",
        "price_vol_14d DOUBLE",
        "is_bingx_exclusive BOOLEAN",
        "label_8pct_24h INTEGER",
        "label_10pct_12h INTEGER",
        "label_10pct_24h INTEGER",
    ]:
        try:
            con.execute(f"ALTER TABLE market_snapshots ADD COLUMN IF NOT EXISTS {col_def}")
        except Exception:
            pass  # column already exists

    # Таблица ценовых баров (для per-pattern label computation)
    con.execute("""
        CREATE TABLE IF NOT EXISTS price_bars_1h (
            symbol  VARCHAR NOT NULL,
            ts_ms   BIGINT  NOT NULL,
            high    DOUBLE,
            close   DOUBLE,
            PRIMARY KEY (symbol, ts_ms)
        )
    """)
    logger.info("DuckDB schema инициализирована: %s", DB_PATH)


# ── Вставки ───────────────────────────────────────────────────────────────────

def upsert_ohlcv_batch(rows: list[dict]) -> int:
    """
    rows: [{ts_ms, symbol, exchange, interval_str, open, high, low, close, volume}]
    Возвращает количество вставленных строк.
    """
    if not rows:
        return 0
    con = get_conn()
    inserted = 0
    for r in rows:
        try:
            con.execute("""
                INSERT OR REPLACE INTO ohlcv
                    (ts_ms, symbol, exchange, interval_str, open, high, low, close, volume)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (
                r["ts_ms"], r["symbol"], r.get("exchange", "Binance"),
                r.get("interval_str", "1h"),
                r.get("open"), r.get("high"), r.get("low"),
                r.get("close"), r.get("volume"),
            ))
            inserted += 1
        except Exception as exc:
            logger.debug("upsert_ohlcv_batch skip: %s", exc)
    return inserted


def upsert_orderbook_batch(rows: list[dict]) -> int:
    if not rows:
        return 0
    con = get_conn()
    inserted = 0
    for r in rows:
        try:
            con.execute("""
                INSERT OR REPLACE INTO orderbook_heatmap
                    (ts_ms, symbol, exchange, interval_str, bids_json, asks_json)
                VALUES (?, ?, ?, ?, ?, ?)
            """, (
                r["ts_ms"], r["symbol"], r.get("exchange", "Binance"),
                r.get("interval_str", "30m"),
                json.dumps(r.get("bids", [])),
                json.dumps(r.get("asks", [])),
            ))
            inserted += 1
        except Exception as exc:
            logger.debug("upsert_orderbook_batch skip: %s", exc)
    return inserted


def insert_large_orders_batch(rows: list[dict]) -> int:
    if not rows:
        return 0
    con = get_conn()
    con.execute("DELETE FROM large_limit_orders WHERE symbol = ? AND exchange = ? AND collected_ms = ?",
                (rows[0]["symbol"], rows[0].get("exchange", "Binance"), rows[0]["collected_ms"]))
    for r in rows:
        try:
            con.execute("""
                INSERT INTO large_limit_orders
                    (symbol, exchange, collected_ms, limit_price, usd_value, order_state, order_side)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            """, (
                r["symbol"], r.get("exchange", "Binance"), r["collected_ms"],
                r.get("limit_price"), r.get("usd_value"),
                r.get("order_state"), r.get("order_side"),
            ))
        except Exception:
            pass
    return len(rows)


def upsert_pump_event(evt: dict) -> None:
    con = get_conn()
    con.execute("""
        INSERT OR REPLACE INTO pump_events
            (pg_id, symbol, pump_ts_ms, price_24h, price_1h,
             oi_30m, oi_1h, vol_mult, spot_vol_mult, cycle_count,
             layers_json, entry_price_24h,
             entry_whale_index, entry_snf_1h, entry_ob_ratio)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    """, (
        evt["pg_id"], evt["symbol"], evt["pump_ts_ms"],
        evt.get("price_24h"), evt.get("price_1h"),
        evt.get("oi_30m"), evt.get("oi_1h"),
        evt.get("vol_mult"), evt.get("spot_vol_mult"),
        evt.get("cycle_count"),
        json.dumps(evt.get("layers", [])),
        evt.get("entry_price_24h"),
        evt.get("entry_whale_index"),
        evt.get("entry_snf_1h"),
        evt.get("entry_ob_ratio"),
    ))


def save_analysis_result(run_at: str, pattern_name: str, win_rate: float,
                         sample_count: int, tp_count: int, conditions: dict) -> None:
    con = get_conn()
    con.execute("""
        INSERT OR REPLACE INTO analysis_results
            (run_at, pattern_name, win_rate, sample_count, tp_count, conditions_json)
        VALUES (?, ?, ?, ?, ?, ?)
    """, (run_at, pattern_name, win_rate, sample_count, tp_count, json.dumps(conditions)))


def upsert_oi_history_batch(rows: list[dict]) -> int:
    """
    rows: [{ts_s, symbol, oi_usd}]
    symbol: BTCUSDT_PERP (без .A)
    """
    if not rows:
        return 0
    con = get_conn()
    inserted = 0
    for r in rows:
        try:
            con.execute("""
                INSERT OR REPLACE INTO oi_30m_history (ts_s, symbol, oi_usd)
                VALUES (?, ?, ?)
            """, (r["ts_s"], r["symbol"], r.get("oi_usd")))
            inserted += 1
        except Exception as exc:
            logger.debug("upsert_oi_history skip: %s", exc)
    return inserted


_SNAP_COLS = [
    "symbol", "snapshot_ts_ms",
    "price_1h", "price_3h", "price_4h", "price_24h", "vol_mult",
    "oi_30m", "oi_prev_30m", "oi_1h", "oi_prev_1h", "oi_4h",
    "cvd_1h", "cvd_30m", "spot_net_pct", "funding",
    "label_win", "source",
    # v2 fields
    "rsi_1h", "price_vol_14d", "is_bingx_exclusive",
    "label_8pct_24h", "label_10pct_12h", "label_10pct_24h",
]


def upsert_snapshot_batch(rows: list[dict]) -> int:
    """
    rows: полные строки market_snapshots.
    Использует pandas → DuckDB INSERT для надёжности.
    """
    if not rows:
        return 0

    import pandas as pd  # lazy import

    con = get_conn()
    # Нормализуем: добавляем отсутствующие колонки с None
    normalized = []
    for r in rows:
        normalized.append({col: r.get(col) for col in _SNAP_COLS})

    df = pd.DataFrame(normalized, columns=_SNAP_COLS)

    try:
        con.register("_snap_df", df)
        # Staging через temp table → DELETE совпадений → INSERT
        con.execute("""
            CREATE TEMP TABLE IF NOT EXISTS _snap_stage AS
            SELECT * FROM market_snapshots WHERE 1=0
        """)
        con.execute("DELETE FROM _snap_stage")
        con.execute("INSERT INTO _snap_stage SELECT * FROM _snap_df")
        con.unregister("_snap_df")
        con.execute("""
            DELETE FROM market_snapshots
            WHERE (symbol, snapshot_ts_ms, source) IN (
                SELECT symbol, snapshot_ts_ms, source FROM _snap_stage
            )
        """)
        con.execute("INSERT INTO market_snapshots SELECT * FROM _snap_stage")
        con.execute("DELETE FROM _snap_stage")
        return len(df)
    except Exception as exc:
        logger.error("upsert_snapshot_batch failed: %s", exc)
        return 0


def upsert_bars_batch(rows: list[dict]) -> int:
    """
    rows: [{symbol, ts_ms, high, close}]
    Batch insert into price_bars_1h.
    """
    if not rows:
        return 0
    import pandas as pd
    con = get_conn()
    df = pd.DataFrame(rows, columns=["symbol", "ts_ms", "high", "close"])
    try:
        con.register("_bars_df", df)
        con.execute("""
            CREATE TEMP TABLE IF NOT EXISTS _bars_stage (
                symbol VARCHAR, ts_ms BIGINT, high DOUBLE, close DOUBLE
            )
        """)
        con.execute("DELETE FROM _bars_stage")
        con.execute("INSERT INTO _bars_stage SELECT * FROM _bars_df")
        con.unregister("_bars_df")
        con.execute("""
            DELETE FROM price_bars_1h
            WHERE (symbol, ts_ms) IN (SELECT symbol, ts_ms FROM _bars_stage)
        """)
        con.execute("INSERT INTO price_bars_1h SELECT * FROM _bars_stage")
        con.execute("DELETE FROM _bars_stage")
        return len(df)
    except Exception as exc:
        logger.error("upsert_bars_batch failed: %s", exc)
        return 0


def query(sql: str, params: tuple = ()) -> list[dict]:
    con = get_conn()
    res = con.execute(sql, params).fetchdf()
    return res.to_dict(orient="records")
