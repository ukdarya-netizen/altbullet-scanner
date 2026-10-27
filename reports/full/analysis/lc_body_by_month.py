"""LC detection-candle rule by month on all our LC watches (Jul 14 - Oct 24).
Candles: reports/oct30 watch candles (restore: cat ../../oct30/lc_watches/watch_candles.csv.gz.part* | gunzip > WORK/lc_candles.csv)
plus reports/full/lc_watches/watch_candles_new.csv.gz (only ids absent from the old file; first bar must equal floor(detected_at)).
Entry = detection 15m candle close, stop -10%, 72h; take +5 / +10 counted only if reached before the stop.
Run: WORK=/path/ python3 lc_body_by_month.py
"""
import csv, gzip, os, collections, datetime as dt
H = os.path.dirname(os.path.abspath(__file__)); WORK = os.environ.get("WORK", "work/")
W = {r["id"]: r for r in csv.DictReader(open(f"{H}/../lc_watches/watches.csv"))}
C = collections.defaultdict(list)
for r in csv.DictReader(open(WORK + "lc_candles.csv")):
    C[r["id"]].append((0, float(r["open"]), float(r["high"]), float(r["low"]), float(r["close"])))
old = set(C)
for r in csv.DictReader(gzip.open(f"{H}/../lc_watches/watch_candles_new.csv.gz", "rt")):
    if r["id"] not in old:
        C[r["id"]].append((int(r["open_time_ms"]), float(r["open"]), float(r["high"]), float(r["low"]), float(r["close"])))
def pnl(a, e, take):
    for _, o, h, l, c in a:
        if l <= e * 0.9: return -10.1
        if h >= e * (1 + take / 100): return take - 0.1
    return (a[-1][4] / e - 1) * 100 - 0.1
agg = collections.defaultdict(lambda: [0, 0.0, 0.0])
for i, w in W.items():
    cs = sorted(C.get(i, []))
    if len(cs) < 270: continue
    d = dt.datetime.fromisoformat(w["detected_at"]).replace(tzinfo=dt.timezone.utc)
    if cs[0][0] and cs[0][0] != int(d.timestamp() // 900 * 900 * 1000): continue
    _, o, h, l, c = cs[0]
    if o <= 0 or h <= l: continue
    if w["long_liq1h_at_detect"] != "" and float(w["long_liq1h_at_detect"]) == 0: continue
    rng, body = (h - l) / o * 100, (c - o) / o * 100
    if rng < 5.6 or body > -3.5: continue
    grp = "body -3.5..-5.5" if body >= -5.5 else "body deeper than -5.5"
    per = "2026-10-15" if w["detected_at"][:10] == "2026-10-15" else w["detected_at"][:7]
    s = agg[(grp, per)]; s[0] += 1; s[1] += pnl(cs[1:], c, 5); s[2] += pnl(cs[1:], c, 10)
for k in sorted(agg): print(k, "trades", agg[k][0], "take+5 sum %+.0f" % agg[k][1], "take+10 sum %+.0f" % agg[k][2])
