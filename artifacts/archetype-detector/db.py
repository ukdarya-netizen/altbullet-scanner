"""
Инициализация БД и вспомогательные функции.
MVP использует SQLite (файл archetype_detector.db).
Примечание: перед продакшеном мигрировать на PostgreSQL.
"""
from __future__ import annotations
import json
import sqlite3
import os
from pathlib import Path
from datetime import datetime

DB_PATH = Path(__file__).parent / "archetype_detector.db"


def get_conn() -> sqlite3.Connection:
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def init_db() -> None:
    """Создаёт таблицы если не существуют."""
    schema = Path(__file__).parent / "schema.sql"
    if schema.exists():
        with get_conn() as conn:
            conn.executescript(schema.read_text())
    else:
        _create_tables_inline()


def _create_tables_inline() -> None:
    with get_conn() as conn:
        conn.executescript("""
        CREATE TABLE IF NOT EXISTS snapshots (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            symbol      TEXT NOT NULL,
            snapshot_time TEXT NOT NULL,
            oi_30m      REAL, oi_prev_30m REAL,
            oi_1h       REAL, oi_prev_1h  REAL,
            oi_4h       REAL,
            vol_mult    REAL, spot_vol_mult REAL,
            price_1h    REAL, price_3h REAL, price_4h REAL, price_24h REAL,
            cvd_1h      INTEGER, cvd_1h_ratio REAL, cvd_30m INTEGER,
            spot_net_pct REAL, net_buy_pct REAL, funding REAL,
            raw_json    TEXT,
            created_at  TEXT DEFAULT (datetime('now')),
            UNIQUE(symbol, snapshot_time)
        );
        CREATE INDEX IF NOT EXISTS idx_snapshots_symbol_time
            ON snapshots(symbol, snapshot_time DESC);

        CREATE TABLE IF NOT EXISTS signals (
            id               INTEGER PRIMARY KEY AUTOINCREMENT,
            symbol           TEXT NOT NULL,
            snapshot_time    TEXT NOT NULL,
            archetype        TEXT NOT NULL,
            confidence_score INTEGER,
            trigger_metrics  TEXT,
            risk_recommendation TEXT,
            status           TEXT DEFAULT 'active',
            created_at       TEXT DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_signals_symbol ON signals(symbol);

        CREATE TABLE IF NOT EXISTS watchlist_stealth (
            symbol             TEXT PRIMARY KEY,
            added_at           TEXT DEFAULT (datetime('now')),
            last_snapshot_time TEXT,
            last_metrics       TEXT
        );
        """)


def save_snapshot(symbol: str, data: dict) -> None:
    """Сохраняет снэпшот (ON CONFLICT DO NOTHING — идемпотентность)."""
    with get_conn() as conn:
        conn.execute("""
        INSERT OR IGNORE INTO snapshots
            (symbol, snapshot_time, oi_30m, oi_prev_30m, oi_1h, oi_prev_1h, oi_4h,
             vol_mult, spot_vol_mult, price_1h, price_3h, price_4h, price_24h,
             cvd_1h, cvd_1h_ratio, cvd_30m, spot_net_pct, net_buy_pct, funding, raw_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            symbol,
            str(data.get("snapshot_time")),
            data.get("oi_30m"), data.get("oi_prev_30m"),
            data.get("oi_1h"), data.get("oi_prev_1h"),
            data.get("oi_4h"),
            data.get("vol_mult"), data.get("spot_vol_mult"),
            data.get("price_1h"), data.get("price_3h"),
            data.get("price_4h"), data.get("price_24h"),
            int(data["cvd_1h"]) if data.get("cvd_1h") is not None else None,
            data.get("cvd_1h_ratio"),
            int(data["cvd_30m"]) if data.get("cvd_30m") is not None else None,
            data.get("spot_net_pct"), data.get("net_buy_pct"),
            data.get("funding"),
            json.dumps(data, default=str),
        ))


def get_previous_snapshot(symbol: str, before_time: str) -> dict | None:
    """Достаёт последний снэпшот по символу до указанного времени."""
    with get_conn() as conn:
        row = conn.execute("""
            SELECT * FROM snapshots
            WHERE symbol = ? AND snapshot_time < ?
            ORDER BY snapshot_time DESC
            LIMIT 1
        """, (symbol, before_time)).fetchone()
    if row is None:
        return None
    d = dict(row)
    if d.get("cvd_1h") is not None:
        d["cvd_1h"] = bool(d["cvd_1h"])
    if d.get("cvd_30m") is not None:
        d["cvd_30m"] = bool(d["cvd_30m"])
    return d


def save_signal(symbol: str, result: dict) -> None:
    """Сохраняет сигнал. no_signal и watchlist — только логируются, не сохраняются."""
    archetype = result.get("archetype", "no_signal")
    if archetype in ("no_signal", "watchlist_stealth"):
        return
    with get_conn() as conn:
        conn.execute("""
        INSERT INTO signals
            (symbol, snapshot_time, archetype, confidence_score,
             trigger_metrics, risk_recommendation, status)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        """, (
            symbol,
            str(result.get("snapshot_time")),
            archetype,
            result.get("confidence_score"),
            json.dumps(result.get("trigger_metrics", {})),
            result.get("risk_recommendation", ""),
            result.get("status", "active"),
        ))


def upsert_watchlist(symbol: str, snapshot_time: str, metrics: dict) -> None:
    with get_conn() as conn:
        conn.execute("""
        INSERT INTO watchlist_stealth (symbol, added_at, last_snapshot_time, last_metrics)
        VALUES (?, datetime('now'), ?, ?)
        ON CONFLICT(symbol) DO UPDATE SET
            last_snapshot_time = excluded.last_snapshot_time,
            last_metrics = excluded.last_metrics
        """, (symbol, snapshot_time, json.dumps(metrics, default=str)))


def get_signals(symbol: str) -> list[dict]:
    with get_conn() as conn:
        rows = conn.execute("""
            SELECT * FROM signals WHERE symbol = ? ORDER BY created_at DESC
        """, (symbol,)).fetchall()
    result = []
    for r in rows:
        d = dict(r)
        if d.get("trigger_metrics"):
            try:
                d["trigger_metrics"] = json.loads(d["trigger_metrics"])
            except Exception:
                pass
        result.append(d)
    return result


def get_watchlist() -> list[dict]:
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT * FROM watchlist_stealth ORDER BY added_at DESC"
        ).fetchall()
    result = []
    for r in rows:
        d = dict(r)
        if d.get("last_metrics"):
            try:
                d["last_metrics"] = json.loads(d["last_metrics"])
            except Exception:
                pass
        result.append(d)
    return result
