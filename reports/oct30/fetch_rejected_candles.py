#!/usr/bin/env python3
"""15m BingX swap candles, 72h from the decision time, for every row of rejected_candidates.csv (no labelling).
First candle = first 15m bar whose open time >= decision_at (ceiling). One request per unique (symbol, start bar).
Output: rejected_candles.csv (id, pattern, symbol, decision_at, open_time_ms, open_time_utc, o,h,l,c,volume); rejected_candles_errors.json
"""
import csv, json, math, os, sys, time, urllib.parse, urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

csv.field_size_limit(10**9)
HERE = os.path.dirname(os.path.abspath(__file__))
MS15, BARS = 900_000, 288
URL = "https://open-api.bingx.com/openApi/swap/v3/quote/klines"


def fetch(key):
    sym, start = key
    q = urllib.parse.urlencode({"symbol": sym, "interval": "15m", "startTime": start, "endTime": start + BARS * MS15 - 1, "limit": 1000})
    err = ""
    for a in range(4):
        try:
            with urllib.request.urlopen(f"{URL}?{q}", timeout=25) as r:
                j = json.load(r)
            if j.get("code") == 0:
                d = sorted({int(x["time"]): x for x in (j.get("data") or [])}.values(), key=lambda x: int(x["time"]))
                return key, [(int(x["time"]), x["open"], x["high"], x["low"], x["close"], x["volume"]) for x in d], ""
            err = f"code {j.get('code')} {str(j.get('msg'))[:60]}"
            if j.get("code") == 109418:
                break
        except Exception as e:  # noqa
            err = str(e)[:80]
        time.sleep(1.5 * (a + 1))
    return key, [], err


rows = list(csv.DictReader(open(os.path.join(HERE, "rejected_candidates.csv"), newline="")))


def start_of(r):
    t = datetime.strptime(r["decision_at"][:19], "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc)
    return math.ceil(t.timestamp() * 1000 / MS15) * MS15


keys = sorted({(r["symbol"], start_of(r)) for r in rows})
print("rows", len(rows), "unique requests", len(keys), file=sys.stderr)
res, errs = {}, {}
with ThreadPoolExecutor(6) as ex:
    for i, (k, c, e) in enumerate(ex.map(fetch, keys)):
        res[k] = c
        if e and not c:
            errs[f"{k[0]}@{k[1]}"] = e
        if i % 500 == 0:
            print("done", i, file=sys.stderr)
with open(os.path.join(HERE, "rejected_candles.csv"), "w", newline="") as f:
    w = csv.writer(f)
    w.writerow(["id", "pattern", "symbol", "decision_at", "open_time_ms", "open_time_utc", "open", "high", "low", "close", "volume"])
    for r in rows:
        for t, o, h, l, c, v in res[(r["symbol"], start_of(r))]:
            w.writerow([r["id"], r["pattern"], r["symbol"], r["decision_at"], t, datetime.fromtimestamp(t / 1000, timezone.utc).strftime("%Y-%m-%d %H:%M"), o, h, l, c, v])
json.dump(errs, open(os.path.join(HERE, "rejected_candles_errors.json"), "w"))
print("errors", len(errs), "rows without candles", sum(1 for r in rows if not res[(r["symbol"], start_of(r))]), file=sys.stderr)
