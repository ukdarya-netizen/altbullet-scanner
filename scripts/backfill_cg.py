#!/usr/bin/env python3
"""
CoinGlass historical data backfill script.
Collects large orders (futures+spot) and HL whale events/positions.

Run: python3 scripts/backfill_cg.py
"""

import os, sys, requests, psycopg2
from datetime import datetime, timezone
from psycopg2.extras import execute_values

CG_KEY = os.environ["COINGLASS_API_KEY"]
DATABASE_URL = os.environ["DATABASE_URL"]
ADMIN_TOKEN = os.environ["ADMIN_TOKEN"]
CG_BASE = "https://open-api-v4.coinglass.com"
ARCHETYPE_API = "http://localhost:8000"

HEADERS = {"CG-API-KEY": CG_KEY}

cg_credits_used = 0

def cg_get(path, params, timeout=15, cost=1):
    global cg_credits_used
    url = f"{CG_BASE}{path}"
    r = requests.get(url, headers=HEADERS, params=params, timeout=timeout)
    data = r.json()
    if data.get("code") not in ("0", 0):
        return None
    cg_credits_used += cost
    return data.get("data")

def get_symbol_pool():
    """Get 224 unique symbols from market_snapshots via archetype-detector admin/sql."""
    r = requests.post(
        f"{ARCHETYPE_API}/admin/sql",
        headers={"X-Admin-Token": ADMIN_TOKEN, "Content-Type": "application/json"},
        json={"sql": "SELECT DISTINCT symbol FROM market_snapshots ORDER BY symbol"},
        timeout=15
    )
    rows = r.json()
    return [row["symbol"] for row in rows]

def to_binance_symbol(bingx_symbol):
    """Convert BingX-USDT format to Binance format: BTC-USDT → BTCUSDT"""
    return bingx_symbol.replace("-", "")

def collect_large_orders_futures(conn, symbols):
    """Collect FUTURES large orders history for all symbols (Binance only)."""
    print(f"\n[FUTURES large orders] Processing {len(symbols)} symbols...")
    inserted = 0
    skipped_empty = 0

    for i, sym in enumerate(symbols):
        binance_sym = to_binance_symbol(sym)
        try:
            data = cg_get(
                "/api/futures/orderbook/v2/large-limit-order-history",
                {"symbol": binance_sym, "exchange": "Binance", "limit": 1000}
            )
            if not data:
                skipped_empty += 1
                continue

            rows = []
            for item in data:
                rows.append((
                    item.get("id"),
                    item.get("exchange_name", "Binance"),
                    binance_sym,
                    item.get("base_asset"),
                    item.get("limit_price"),
                    item.get("start_time"),
                    item.get("start_usd_value"),
                    item.get("current_usd_value"),
                    item.get("executed_usd_value"),
                    item.get("trade_count"),
                    item.get("order_side"),
                    item.get("order_state"),
                    item.get("order_end_time"),
                ))
            if rows:
                with conn.cursor() as cur:
                    execute_values(cur,
                        """INSERT INTO cg_large_orders_futures
                           (id, exchange_name, symbol, base_asset, limit_price,
                            start_time, start_usd_value, current_usd_value,
                            executed_usd_value, trade_count, order_side,
                            order_state, order_end_time)
                           VALUES %s ON CONFLICT (id) DO NOTHING""",
                        rows
                    )
                conn.commit()
                inserted += cur.rowcount
                if i % 20 == 0:
                    print(f"  [{i+1}/{len(symbols)}] {sym}: {len(rows)} records | total inserted: {inserted}")
        except Exception as e:
            print(f"  [{i+1}] {sym}: ERROR {e}")
            continue

    print(f"[FUTURES large orders] Done: {inserted} rows inserted, {skipped_empty} symbols empty (BingX-exclusive)")
    return inserted

def collect_large_orders_spot(conn, symbols):
    """Collect SPOT large orders history for all symbols (Binance only)."""
    print(f"\n[SPOT large orders] Processing {len(symbols)} symbols...")
    inserted = 0
    skipped_empty = 0

    for i, sym in enumerate(symbols):
        binance_sym = to_binance_symbol(sym)
        try:
            data = cg_get(
                "/api/spot/orderbook/v2/large-limit-order-history",
                {"symbol": binance_sym, "exchange": "Binance", "limit": 1000}
            )
            if not data:
                skipped_empty += 1
                continue

            rows = []
            for item in data:
                rows.append((
                    item.get("id"),
                    item.get("exchange_name", "Binance"),
                    binance_sym,
                    item.get("base_asset"),
                    item.get("limit_price"),
                    item.get("start_time"),
                    item.get("start_usd_value"),
                    item.get("current_usd_value"),
                    item.get("executed_usd_value"),
                    item.get("trade_count"),
                    item.get("order_side"),
                    item.get("order_state"),
                    item.get("order_end_time"),
                ))
            if rows:
                with conn.cursor() as cur:
                    execute_values(cur,
                        """INSERT INTO cg_large_orders_spot
                           (id, exchange_name, symbol, base_asset, limit_price,
                            start_time, start_usd_value, current_usd_value,
                            executed_usd_value, trade_count, order_side,
                            order_state, order_end_time)
                           VALUES %s ON CONFLICT (id) DO NOTHING""",
                        rows
                    )
                conn.commit()
                inserted += cur.rowcount
                if i % 20 == 0:
                    print(f"  [{i+1}/{len(symbols)}] {sym}: {len(rows)} records | total inserted: {inserted}")
        except Exception as e:
            print(f"  [{i+1}] {sym}: ERROR {e}")
            continue

    print(f"[SPOT large orders] Done: {inserted} rows inserted, {skipped_empty} symbols empty")
    return inserted

def collect_hl_whale_events(conn):
    """Collect Hyperliquid whale alert events (max 50 records, ~3h depth)."""
    print("\n[HL Whale events] Collecting up to 50 whale alert events...")
    try:
        data = cg_get("/api/hyperliquid/whale-alert", {"limit": 200}, cost=1)
        if not data:
            print("  No data returned")
            return 0

        rows = [(
            item.get("user"),
            item.get("symbol"),
            item.get("position_size"),
            item.get("entry_price"),
            item.get("liq_price"),
            item.get("position_value_usd"),
            item.get("position_action"),
            item.get("create_time"),
        ) for item in data]

        with conn.cursor() as cur:
            execute_values(cur,
                """INSERT INTO cg_hl_whale_events
                   (user_address, symbol, position_size, entry_price, liq_price,
                    position_value_usd, position_action, create_time)
                   VALUES %s ON CONFLICT (user_address, symbol, create_time) DO NOTHING""",
                rows
            )
        conn.commit()
        inserted = cur.rowcount
        print(f"[HL Whale events] Done: {inserted} events inserted from {len(data)} records")
        return inserted
    except Exception as e:
        print(f"  ERROR: {e}")
        return 0

def collect_hl_whale_positions(conn):
    """Collect current Hyperliquid whale positions snapshot."""
    print("\n[HL Whale positions] Collecting current whale positions snapshot...")
    snapshot_at = datetime.now(timezone.utc)
    try:
        data = cg_get("/api/hyperliquid/whale-position", {"limit": 1000}, cost=1)
        if not data:
            print("  No data returned")
            return 0

        rows = [(
            item.get("user"),
            item.get("symbol"),
            item.get("position_size"),
            item.get("entry_price"),
            item.get("mark_price"),
            item.get("liq_price"),
            item.get("leverage"),
            item.get("margin_balance"),
            item.get("position_value_usd"),
            item.get("unrealized_pnl"),
            item.get("funding_fee"),
            item.get("margin_mode"),
            item.get("create_time"),
            item.get("update_time"),
            snapshot_at,
        ) for item in data]

        with conn.cursor() as cur:
            execute_values(cur,
                """INSERT INTO cg_hl_whale_positions
                   (user_address, symbol, position_size, entry_price, mark_price,
                    liq_price, leverage, margin_balance, position_value_usd,
                    unrealized_pnl, funding_fee, margin_mode, create_time,
                    update_time, snapshot_at)
                   VALUES %s ON CONFLICT (user_address, symbol, snapshot_at) DO NOTHING""",
                rows
            )
        conn.commit()
        inserted = cur.rowcount
        print(f"[HL Whale positions] Done: {inserted} positions inserted from {len(data)} records")
        return inserted
    except Exception as e:
        print(f"  ERROR: {e}")
        return 0

def print_final_counts(conn):
    with conn.cursor() as cur:
        tables = [
            "cg_large_orders_futures",
            "cg_large_orders_spot",
            "cg_liq_heatmap_snapshot",
            "cg_hl_whale_events",
            "cg_hl_whale_positions",
        ]
        print("\n=== FINAL COUNTS ===")
        for t in tables:
            cur.execute(f"SELECT count(*) FROM {t}")
            cnt = cur.fetchone()[0]
            print(f"  {t}: {cnt} rows")

def main():
    print(f"[Start] {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S UTC')}")

    print("\n=== PRE-BACKFILL COUNTS (должно быть 0) ===")
    conn = psycopg2.connect(DATABASE_URL)
    with conn.cursor() as cur:
        for t in ["cg_large_orders_futures", "cg_large_orders_spot",
                  "cg_liq_heatmap_snapshot", "cg_hl_whale_events", "cg_hl_whale_positions"]:
            cur.execute(f"SELECT count(*) FROM {t}")
            print(f"  {t}: {cur.fetchone()[0]}")

    symbols = get_symbol_pool()
    print(f"\n[Token pool] {len(symbols)} symbols from market_snapshots")
    print(f"  First 5: {symbols[:5]}")
    print(f"  Note: many are BingX-exclusive → large orders will return empty for most")

    # 1. FUTURES large orders
    collect_large_orders_futures(conn, symbols)

    # 2. SPOT large orders
    collect_large_orders_spot(conn, symbols)

    # 3. HL whale events
    collect_hl_whale_events(conn)

    # 4. HL whale positions (current snapshot)
    collect_hl_whale_positions(conn)

    print_final_counts(conn)
    print(f"\n[Done] Total CG credits used: {cg_credits_used}")
    print(f"[Done] {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S UTC')}")

    conn.close()

if __name__ == "__main__":
    main()
