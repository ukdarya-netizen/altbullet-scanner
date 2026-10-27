"""Independent check of the LC candle rule by BTC 24h regime, per year.

Input: reports/history/capitulation_events.csv.gz (Binance spot 15m, 2021+).
LC candle: range >= 5.6% and body <= -3.5%. Entry = candle close, stop -10%,
72h. A take counts only if reached before the stop; neither = close at 72h.
Fee 0.1% per trade. Prints trades and average % per trade for take +5 / +10.

Run: python3 reports/history/btc_regime_check.py
"""
import csv, gzip, os
from collections import defaultdict
from datetime import datetime, timezone

PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "capitulation_events.csv.gz")


def pnl(first, take, close72):
    if first == "take":
        return take - 0.1
    if first == "stop":
        return -10.1
    return float(close72) - 0.1


groups = {
    "all LC candles": lambda b: True,
    "BTC 24h >= +3%": lambda b: b is not None and b >= 3,
    "BTC 24h <= -8%": lambda b: b is not None and b <= -8,
    "BTC 24h between -8% and +3%": lambda b: b is not None and -8 < b < 3,
    "BTC 24h <= -8% OR >= +3%": lambda b: b is not None and (b <= -8 or b >= 3),
}
stats = {g: defaultdict(lambda: [0, 0.0, 0.0]) for g in groups}
with gzip.open(PATH, "rt") as f:
    for r in csv.DictReader(f):
        if not (float(r["range_pct"]) >= 5.6 and float(r["body_pct"]) <= -3.5):
            continue
        b = float(r["btc24h_pct"]) if r["btc24h_pct"] else None
        y = datetime.fromtimestamp(int(r["open_time_ms"]) / 1000, timezone.utc).year
        p5 = pnl(r["first_5_vs_stop10"], 5, r["close72_pct"])
        p10 = pnl(r["first_10_vs_stop10"], 10, r["close72_pct"])
        for g, test in groups.items():
            if test(b):
                for key in (y, "ALL"):
                    s = stats[g][key]
                    s[0] += 1; s[1] += p5; s[2] += p10

for g in groups:
    print(f"\n{g}")
    for key in sorted(stats[g], key=str):
        n, s5, s10 = stats[g][key]
        print(f"  {key}: trades {n:5}  take+5 avg {s5 / n:+.2f}%  take+10 avg {s10 / n:+.2f}%")
