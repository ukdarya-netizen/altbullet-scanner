"""
FastAPI-сервис детектора архетипов роста.

Endpoints:
  POST /classify         — классификация снэпшота
  GET  /signals/{symbol} — история сигналов по символу
  GET  /watchlist        — текущий stealth watchlist
  GET  /healthz          — healthcheck
"""
from __future__ import annotations
import logging
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException

from models import SnapshotInput, SignalOutput, WatchlistEntry
from orchestrator import classify_snapshot
from db import init_db, save_snapshot, save_signal, upsert_watchlist, get_signals, get_watchlist, get_previous_snapshot
from pipeline import analyzer, duckdb_store

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s — %(message)s",
)
logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    logger.info("DB initialised (SQLite)")
    yield


app = FastAPI(
    title="Archetype Detector",
    description=(
        "Детектор торговых сигналов по архетипам роста. "
        "5 архетипов: B_silent_accumulation, C_price_led_momentum, "
        "D_pullback_continuation, F_balanced_grind, E_stealth_breakout. "
        "Архетип Explosive Ignition исключён по решению заказчика."
    ),
    version="1.0.0",
    lifespan=lifespan,
)


@app.get("/healthz")
def healthz():
    return {"status": "ok"}


@app.post("/classify", response_model=SignalOutput)
def classify(snapshot: SnapshotInput):
    """
    Классифицирует снэпшот по 5 архетипам.
    Сохраняет снэпшот и сигнал в БД (идемпотентно по symbol+snapshot_time).
    """
    current = snapshot.model_dump()
    st = str(snapshot.snapshot_time)

    # Сохранить снэпшот (ON CONFLICT DO NOTHING)
    save_snapshot(snapshot.symbol, current)

    # Достать предыдущий снэпшот для state-зависимых правил (C, D, E)
    previous = get_previous_snapshot(snapshot.symbol, st)

    # Классифицировать
    result = classify_snapshot(snapshot.symbol, current, previous)

    # Персистировать сигнал и watchlist
    archetype = result.get("archetype", "no_signal")
    save_signal(snapshot.symbol, result)
    if archetype == "watchlist_stealth":
        upsert_watchlist(snapshot.symbol, st, current)

    # Для no_signal / watchlist — возвращаем облегчённый объект
    if archetype in ("no_signal", "watchlist_stealth"):
        return SignalOutput(
            symbol=snapshot.symbol,
            snapshot_time=snapshot.snapshot_time,
            archetype=archetype,
            reason=result.get("reason"),
        )

    return SignalOutput(**{
        "symbol": result.get("symbol", snapshot.symbol),
        "snapshot_time": result.get("snapshot_time"),
        "archetype": archetype,
        "confidence_score": result.get("confidence_score"),
        "trigger_metrics": result.get("trigger_metrics"),
        "risk_recommendation": result.get("risk_recommendation"),
        "status": result.get("status", "active"),
        "note": result.get("note"),
    })


@app.get("/signals/{symbol}")
def signals_by_symbol(symbol: str):
    """История торговых сигналов по символу."""
    rows = get_signals(symbol.upper())
    if not rows:
        raise HTTPException(status_code=404, detail=f"No signals found for {symbol}")
    return rows


@app.get("/watchlist")
def watchlist():
    """Текущий список токенов в stealth watchlist."""
    return get_watchlist()


@app.post("/admin/sql")
def admin_sql(payload: dict):
    """
    Временный эндпоинт для анализа DuckDB market_snapshots.
    Принимает: {"sql": "SELECT ..."}
    """
    from pipeline.duckdb_store import get_conn
    sql = payload.get("sql", "").strip()
    if not sql:
        raise HTTPException(status_code=400, detail="sql is required")
    try:
        conn = get_conn()
        result = conn.execute(sql).fetchdf()
        return result.to_dict(orient="records")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/pipeline/analyze")
def pipeline_analyze(min_price24h: float = 20.0):
    """
    Запускает анализ паттернов на данных DuckDB (синхронно).
    Возвращает список паттернов с win rate.
    """
    try:
        result = analyzer.run_analysis(min_price24h=min_price24h)
        return result
    except Exception as exc:
        logger.error("pipeline_analyze error: %s", exc)
        raise HTTPException(status_code=500, detail=str(exc))


@app.get("/pipeline/results")
def pipeline_results():
    """Последние сохранённые результаты анализа паттернов из DuckDB."""
    try:
        rows = analyzer.get_latest_results()
        return {"patterns": rows, "count": len(rows)}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


@app.get("/pipeline/stats")
def pipeline_stats():
    """Статистика по данным в DuckDB (количество строк по таблицам)."""
    try:
        con = duckdb_store.get_conn()
        stats = {}
        for table in ("ohlcv", "orderbook_heatmap", "large_limit_orders",
                      "pump_events", "analysis_results"):
            try:
                n = con.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
                stats[table] = n
            except Exception:
                stats[table] = "error"
        return stats
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


# ── Retro Analysis Endpoints ──────────────────────────────────────────────────

@app.get("/api/retro/spot-sell-wall")
def retro_spot_sell_wall(days: int = 90, min_signals: int = 0):
    """
    Бэктест: влияние спотовой стены продаж (spot_ask_usd) на исходы сигналов.

    Группирует закрытые сигналы по корзинам spot_ask_usd:
      - null        — данных нет (BingX-эксклюзив или не успело обновиться)
      - <200K       — слабая/нет стены
      - 200K–500K   — умеренная стена
      - >500K       — сильная стена

    Метрики на группу:
      count           — число сигналов
      hit_10_pct      — % с peak_pnl ≥ 10%
      hit_first_target_pct — % закрытых в profit / bu_stop
      median_peak_pnl — медиана peak PnL %
      avg_peak_pnl    — среднее peak PnL %
      cancel_rate_pct — % отменённых (status=cancelled)
      stop_loss_rate_pct — % остановленных по стопу (status=stop_loss)

    Query params:
      days        — глубина выборки (по умолчанию 90 дней)
      min_signals — отфильтровать корзины с count < min_signals (0 = показать все)
    """
    import psycopg2
    import psycopg2.extras

    db_url = os.environ.get("DATABASE_URL")
    if not db_url:
        raise HTTPException(status_code=500, detail="DATABASE_URL не настроен")

    sql = """
        WITH base AS (
            SELECT
                spot_ask_usd,
                spot_ask_nearest_pct,
                entry_price,
                peak_price,
                pnl_percent,
                status,
                sentiment_key,
                CASE
                    WHEN entry_price > 0 AND peak_price > 0
                    THEN (peak_price - entry_price) / entry_price * 100.0
                    ELSE NULL
                END AS peak_pnl_pct,
                CASE
                    WHEN spot_ask_usd IS NULL THEN 'null'
                    WHEN spot_ask_usd < 200000 THEN '<200K'
                    WHEN spot_ask_usd < 500000 THEN '200K-500K'
                    ELSE '>500K'
                END AS bucket
            FROM tracked_signals
            WHERE status IN ('profit', 'stop_loss', 'bu_stop', 'breakeven', 'cancelled')
              AND is_short = false
              AND detected_at > NOW() - (%(days)s || ' days')::interval
        )
        SELECT
            bucket,
            COUNT(*)::int                                                              AS count,
            ROUND(AVG(CASE WHEN peak_pnl_pct >= 10 THEN 1.0 ELSE 0.0 END) * 100, 1)  AS hit_10_pct,
            ROUND(AVG(CASE WHEN status IN ('profit','bu_stop') THEN 1.0 ELSE 0.0 END) * 100, 1)
                                                                                       AS hit_first_target_pct,
            ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY peak_pnl_pct)::numeric, 2)
                                                                                       AS median_peak_pnl,
            ROUND(AVG(peak_pnl_pct)::numeric, 2)                                      AS avg_peak_pnl,
            ROUND(AVG(CASE WHEN status = 'cancelled' THEN 1.0 ELSE 0.0 END) * 100, 1)
                                                                                       AS cancel_rate_pct,
            ROUND(AVG(CASE WHEN status = 'stop_loss' THEN 1.0 ELSE 0.0 END) * 100, 1)
                                                                                       AS stop_loss_rate_pct,
            ROUND(AVG(spot_ask_nearest_pct)::numeric, 2)                              AS avg_nearest_pct
        FROM base
        GROUP BY bucket
        ORDER BY
            CASE bucket
                WHEN 'null'      THEN 0
                WHEN '<200K'     THEN 1
                WHEN '200K-500K' THEN 2
                WHEN '>500K'     THEN 3
            END
    """

    try:
        conn = psycopg2.connect(db_url, cursor_factory=psycopg2.extras.RealDictCursor)
        cur = conn.cursor()
        cur.execute(sql, {"days": days})
        rows = [dict(r) for r in cur.fetchall()]
        conn.close()
    except psycopg2.errors.UndefinedColumn as exc:
        # spot_ask_usd columns not yet migrated — api-server runStartupMigration
        # adds them via ALTER TABLE IF NOT EXISTS; run api-server once to populate.
        logger.warning("retro_spot_sell_wall: spot_ask_usd column missing — migration not yet run: %s", exc)
        return {
            "buckets": [],
            "total_signals": 0,
            "days": days,
            "report_md": (
                "## Spot Sell Wall Backtest\n\n"
                "⚠️ Колонки `spot_ask_usd` / `spot_ask_nearest_pct` ещё не созданы в БД.\n\n"
                "Запустите api-server хотя бы раз — `runStartupMigration` добавит колонки автоматически.\n"
                "Затем подождите несколько FastCycle (~3 мин каждый) пока backfill заполнит исторические сигналы."
            ),
            "migration_needed": True,
        }
    except Exception as exc:
        logger.error("retro_spot_sell_wall DB error: %s", exc)
        raise HTTPException(status_code=500, detail=str(exc))

    if min_signals > 0:
        rows = [r for r in rows if r["count"] >= min_signals]

    # ── Итоговый вывод: строим текстовый markdown-отчёт для удобного чтения ──
    total = sum(r["count"] for r in rows)
    lines = [
        f"## Spot Sell Wall Backtest — последние {days} дней",
        f"Всего закрытых сигналов: **{total}**",
        "",
        "| Корзина     | N | Hit10% | HitFT% | MedPeak | AvgPeak | Cancel% | SL% | NearestPct |",
        "|-------------|---|--------|--------|---------|---------|---------|-----|------------|",
    ]
    for r in rows:
        def _f(v, fmt=".1f"):
            return f"{v:{fmt}}" if v is not None else "—"
        lines.append(
            f"| {r['bucket']:<11} "
            f"| {r['count']} "
            f"| {_f(r['hit_10_pct'])}% "
            f"| {_f(r['hit_first_target_pct'])}% "
            f"| {_f(r['median_peak_pnl'])} "
            f"| {_f(r['avg_peak_pnl'])} "
            f"| {_f(r['cancel_rate_pct'])}% "
            f"| {_f(r['stop_loss_rate_pct'])}% "
            f"| {_f(r['avg_nearest_pct'])}% |"
        )

    # Вывод: добавляем интерпретацию если есть достаточно данных
    non_null = [r for r in rows if r["bucket"] != "null" and r["count"] >= 5]
    if len(non_null) >= 2:
        best = max(non_null, key=lambda r: r["hit_10_pct"] or 0)
        worst = min(non_null, key=lambda r: r["hit_10_pct"] or 0)
        lines += [
            "",
            "### Интерпретация",
            f"- Лучшая корзина по Hit10%: **{best['bucket']}** ({best['hit_10_pct']}%)",
            f"- Худшая корзина по Hit10%: **{worst['bucket']}** ({worst['hit_10_pct']}%)",
        ]
        if best["bucket"] in ("<200K",) and worst["bucket"] in (">500K", "200K-500K"):
            lines.append(
                "- 📊 **Вывод**: большие спот-стены УХУДШАЮТ исходы — целесообразно добавить gate или снизить alphaScore."
            )
        elif worst["bucket"] in ("<200K",) and best["bucket"] in (">500K", "200K-500K"):
            lines.append(
                "- 📊 **Вывод**: большие спот-стены НЕ ухудшают исходы — gate не оправдан."
            )
        else:
            lines.append(
                "- 📊 **Вывод**: корреляция неоднозначна — нужно больше данных."
            )

    return {
        "buckets": rows,
        "total_signals": total,
        "days": days,
        "report_md": "\n".join(lines),
    }
