"""Capitulation-candle history test (LC candle rule on years of data).

Downloads Binance SPOT 15m klines (data.binance.vision monthly archives,
2021-01 .. last full month) for a fixed alt list + BTC, finds red 15m candles
with range >= 4% and body <= -2.5% (wider than the live rule, so thresholds can
be studied), and labels each from the candle close (entry) over the next 72h:
which of +5% / +10% / -10% came first, hours to it, peak, close at 72h.

No analysis here. Output (compact):
  reports/history/capitulation_events.csv.gz  one row per event
  reports/history/manifest.csv                symbol, months found/missing, candles

Run:  python3 reports/history/capitulation_history.py
Stdlib only. Known bias: coins delisted from Binance are absent (survivorship).
"""
import csv, gzip, io, os, sys, time, urllib.request, urllib.error, zipfile
from concurrent.futures import ThreadPoolExecutor
from datetime import date

OUT = os.path.dirname(os.path.abspath(__file__))
BASE = "https://data.binance.vision/data/spot/monthly/klines/{s}/15m/{s}-15m-{y}-{m:02d}.zip"
ALTS = """ADA XRP DOGE DOT LINK LTC BCH UNI SOL AVAX MATIC POL ATOM FIL ETC XLM TRX VET THETA AAVE
EOS ALGO XTZ NEO KSM COMP MKR SNX SUSHI YFI CRV 1INCH GRT CHZ ENJ MANA SAND AXS FTM NEAR EGLD
HBAR ICP ZEC DASH ZIL ONE KAVA RUNE CAKE BAT ZRX ICX QTUM IOST ONT ANKR STORJ SKL BAND KNC
LRC CELR COTI DENT HOT SXP AUDIO ROSE ARPA CTSI DYDX GALA IMX APE OP ARB APT SUI SEI TIA INJ
LDO PEPE WLD JUP ORDI FET RNDR RENDER SHIB FLOKI BONK WIF ENA TRB WOO C98 ALICE MASK""".split()
H72 = 288  # 15m candles in 72h


def months(start=date(2021, 1, 1)):
    today = date.today()
    y, m = start.year, start.month
    while (y, m) < (today.year, today.month):
        yield y, m
        y, m = (y + 1, 1) if m == 12 else (y, m + 1)


def fetch(sym, y, m):
    url = BASE.format(s=sym + "USDT", y=y, m=m)
    for attempt in range(4):
        try:
            with urllib.request.urlopen(url, timeout=60) as r:
                z = zipfile.ZipFile(io.BytesIO(r.read()))
            rows = []
            with z.open(z.namelist()[0]) as f:
                for line in io.TextIOWrapper(f):
                    p = line.strip().split(",")
                    if not p[0].isdigit():
                        continue  # header
                    t = int(p[0])
                    if t > 10**14:  # microseconds (2025+ archives)
                        t //= 1000
                    rows.append((t, float(p[1]), float(p[2]), float(p[3]), float(p[4]), float(p[7])))
            return rows
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None
            time.sleep(2 + attempt * 3)
        except Exception:
            time.sleep(2 + attempt * 3)
    return "error"


def load(sym):
    got, miss, err, rows = 0, 0, 0, []
    for y, m in months():
        r = fetch(sym, y, m)
        if r is None:
            miss += 1
        elif r == "error":
            err += 1
        else:
            got += 1
            rows.extend(r)
    rows.sort()
    return sym, rows, got, miss, err


def btc_index(rows):
    return {r[0]: r[4] for r in rows}


def events(sym, k, btc):
    out = []
    n = len(k)
    for i in range(96, n - H72 - 1):
        t, o, h, l, c, qv = k[i]
        if o <= 0 or h <= l:
            continue
        rng = (h - l) / o * 100
        body = (c - o) / o * 100
        if rng < 4 or body > -2.5:
            continue
        # contiguous 72h after entry, no gaps
        if k[i + H72][0] - t != H72 * 900_000:
            continue
        cp = (c - l) / (h - l)
        prev = [x[5] for x in k[i - 96:i]]
        vavg = sum(prev) / len(prev) if prev else 0
        p24 = (c / k[i - 96][4] - 1) * 100 if k[i - 96][0] == t - 96 * 900_000 else ""
        b_now, b24, b30 = btc.get(t), btc.get(t - 96 * 900_000), btc.get(t - 2880 * 900_000)
        first = {"5": "", "10": ""}
        hours = {"5": "", "10": ""}
        stop_at = None
        peak = c
        for j in range(1, H72 + 1):
            _, _, hh, ll, _, _ = k[i + j]
            if stop_at is None:
                if ll <= c * 0.9:
                    stop_at = j
                    for key in first:
                        if first[key] == "":
                            first[key], hours[key] = "stop", j / 4
                else:
                    for key, mult in (("5", 1.05), ("10", 1.10)):
                        if first[key] == "" and hh >= c * mult:
                            first[key], hours[key] = "take", j / 4
            peak = max(peak, hh)
        for key in first:
            if first[key] == "":
                first[key] = "hang"
        out.append([
            sym, t, round(rng, 3), round(body, 3), round(cp, 4),
            round(qv / vavg, 3) if vavg > 0 else "",
            round(p24, 3) if p24 != "" else "",
            round((b_now / b24 - 1) * 100, 3) if b_now and b24 else "",
            round((b_now / b30 - 1) * 100, 3) if b_now and b30 else "",
            round(qv, 0),
            first["5"], hours["5"], first["10"], hours["10"],
            round((peak / c - 1) * 100, 3), round((k[i + H72][4] / c - 1) * 100, 3),
        ])
    return out


def main():
    syms = ["BTC"] + ALTS
    with ThreadPoolExecutor(8) as ex:
        loaded = list(ex.map(load, syms))
    data = {s: (rows, g, m, e) for s, rows, g, m, e in loaded}
    btc = btc_index(data["BTC"][0])
    with open(os.path.join(OUT, "manifest.csv"), "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["symbol", "months_found", "months_missing", "months_error", "candles", "first_utc_ms", "last_utc_ms"])
        for s in syms:
            rows, g, m, e = data[s]
            w.writerow([s, g, m, e, len(rows), rows[0][0] if rows else "", rows[-1][0] if rows else ""])
    total = 0
    with gzip.open(os.path.join(OUT, "capitulation_events.csv.gz"), "wt", newline="") as f:
        w = csv.writer(f)
        w.writerow(["symbol", "open_time_ms", "range_pct", "body_pct", "close_pos", "quote_vol_mult_24h",
                    "price24h_pct", "btc24h_pct", "btc30d_pct", "quote_volume",
                    "first_5_vs_stop10", "hours_5", "first_10_vs_stop10", "hours_10",
                    "peak72_pct", "close72_pct"])
        for s in ALTS:
            ev = events(s, data[s][0], btc)
            total += len(ev)
            w.writerows(ev)
            print(s, len(data[s][0]), "candles,", len(ev), "events", flush=True)
    print("TOTAL events", total)


if __name__ == "__main__":
    sys.exit(main())
