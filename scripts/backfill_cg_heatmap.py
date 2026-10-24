#!/usr/bin/env python3
"""
CoinGlass HL whale backfill (large orders already done).
"""
import os, requests, psycopg2
from datetime import datetime, timezone
from psycopg2.extras import execute_values

CG_KEY = os.environ["COINGLASS_API_KEY"]
DATABASE_URL = os.environ["DATABASE_URL"]
CG_BASE = "https://open-api-v4.coinglass.com"
HEADERS = {"CG-API-KEY": CG_KEY}

cg_credits_used = 0

def cg_get(path, params, timeout=20, cost=1):
    global cg_credits_used
    r = requests.get(f"{CG_BASE}{path}", headers=HEADERS, params=params, timeout=timeout)
    if r.status_code != 200:
        return None
    d = r.json()
    if str(d.get("code", "")) not in ("0", ""):
        return None
    cg_credits_used += cost
    return d.get("data")

def collect_hl_whale_events(conn):
    print("\n[HL Whale events] Collecting...")
    data = cg_get("/api/hyperliquid/whale-alert", {"limit": 200}, cost=1)
    if not data:
        print("  No data"); return 0
    rows = [(i.get("user"), i.get("symbol"), i.get("position_size"),
             i.get("entry_price"), i.get("liq_price"), i.get("position_value_usd"),
             i.get("position_action"), i.get("create_time")) for i in data]
    with conn.cursor() as cur:
        execute_values(cur,
            """INSERT INTO cg_hl_whale_events
               (user_address, symbol, position_size, entry_price, liq_price,
                position_value_usd, position_action, create_time)
               VALUES %s ON CONFLICT (user_address, symbol, create_time) DO NOTHING""",
            rows)
    conn.commit()
    n = cur.rowcount
    print(f"[HL Whale events] {n} inserted from {len(data)} records")
    return n

def collect_hl_positions(conn):
    print("\n[HL Whale positions] Collecting...")
    snapshot_at = datetime.now(timezone.utc)
    data = cg_get("/api/hyperliquid/whale-position", {"limit": 1000}, cost=1)
    if not data:
        print("  No data"); return 0
    rows = [(i.get("user"), i.get("symbol"), i.get("position_size"),
             i.get("entry_price"), i.get("mark_price"), i.get("liq_price"),
             i.get("leverage"), i.get("margin_balance"), i.get("position_value_usd"),
             i.get("unrealized_pnl"), i.get("funding_fee"), i.get("margin_mode"),
             i.get("create_time"), i.get("update_time"), snapshot_at) for i in data]
    with conn.cursor() as cur:
        execute_values(cur,
            """INSERT INTO cg_hl_whale_positions
               (user_address, symbol, position_size, entry_price, mark_price,
                liq_price, leverage, margin_balance, position_value_usd,
                unrealized_pnl, funding_fee, margin_mode, create_time,
                update_time, snapshot_at)
               VALUES %s ON CONFLICT (user_address, symbol, snapshot_at) DO NOTHING""",
            rows)
    conn.commit()
    n = cur.rowcount
    print(f"[HL Whale positions] {n} inserted from {len(data)} records")
    return n

if __name__ == "__main__":
    print(f"[Start] {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S UTC')}")
    conn = psycopg2.connect(DATABASE_URL)
    collect_hl_whale_events(conn)
    collect_hl_positions(conn)

    with conn.cursor() as cur:
        print("\n=== FINAL COUNTS ===")
        for t in ["cg_large_orders_futures", "cg_large_orders_spot",
                  "cg_liq_heatmap_snapshot", "cg_hl_whale_events", "cg_hl_whale_positions"]:
            cur.execute(f"SELECT count(*) FROM {t}")
            print(f"  {t}: {cur.fetchone()[0]}")

    print(f"\n[Done] Total CG credits used: {cg_credits_used}")
    print(f"[Done] {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S UTC')}")
    conn.close()
