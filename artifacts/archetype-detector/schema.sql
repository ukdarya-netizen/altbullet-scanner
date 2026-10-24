-- Схема БД архетипного детектора (SQLite/PostgreSQL).
-- Для SQLite используется в db.py напрямую.
-- Для PostgreSQL: заменить INTEGER PRIMARY KEY AUTOINCREMENT → BIGSERIAL PRIMARY KEY,
--                 TEXT → TIMESTAMPTZ для дат, INTEGER (0/1) → BOOLEAN для cvd_*.
--
-- ВАЖНО: архетип "Explosive Ignition" исключён из системы по решению заказчика.
-- Он не является допустимым значением поля archetype.

CREATE TABLE IF NOT EXISTS snapshots (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol        TEXT NOT NULL,
    snapshot_time TEXT NOT NULL,          -- ISO-8601 datetime
    oi_30m        REAL,  oi_prev_30m REAL,
    oi_1h         REAL,  oi_prev_1h  REAL,
    oi_4h         REAL,
    vol_mult      REAL,  spot_vol_mult REAL,
    price_1h      REAL,  price_3h REAL,  price_4h REAL,  price_24h REAL,
    cvd_1h        INTEGER,               -- 0/1 (boolean)
    cvd_1h_ratio  REAL,
    cvd_30m       INTEGER,               -- 0/1 (boolean)
    spot_net_pct  REAL,
    net_buy_pct   REAL,
    funding       REAL,
    raw_json      TEXT,                  -- полный слепок входных данных
    created_at    TEXT DEFAULT (datetime('now')),
    UNIQUE(symbol, snapshot_time)
);
CREATE INDEX IF NOT EXISTS idx_snapshots_symbol_time
    ON snapshots(symbol, snapshot_time DESC);


CREATE TABLE IF NOT EXISTS signals (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol              TEXT NOT NULL,
    snapshot_time       TEXT NOT NULL,
    -- Допустимые значения archetype (Explosive Ignition не входит):
    -- B_silent_accumulation | C_price_led_momentum | D_pullback_continuation
    -- F_balanced_grind | E_stealth_breakout
    archetype           TEXT NOT NULL,
    confidence_score    INTEGER,
    trigger_metrics     TEXT,            -- JSON с полями, вызвавшими срабатывание
    risk_recommendation TEXT,
    status              TEXT DEFAULT 'active',  -- active | expired | confirmed | invalidated
    created_at          TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_signals_symbol ON signals(symbol);
CREATE INDEX IF NOT EXISTS idx_signals_archetype ON signals(archetype);


CREATE TABLE IF NOT EXISTS watchlist_stealth (
    symbol             TEXT PRIMARY KEY,
    added_at           TEXT DEFAULT (datetime('now')),
    last_snapshot_time TEXT,
    last_metrics       TEXT             -- JSON последних метрик
);
