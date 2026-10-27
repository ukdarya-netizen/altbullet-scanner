#!/usr/bin/env python3
"""15m BingX swap candles, 72h from the decision time, for ids NOT present in the earlier exports (reports/oct30).
Watches (lc_watches/watches.csv): first bar = floor(detected_at)   -> watch_candles_new.csv (same columns as oct30/lc_watches/watch_candles.csv)
Signals (signals_entry_snapshot.csv): first bar = ceil(detected_at) -> signal_candles_new.csv (same columns as oct30/candles_15m_72h.csv)
Errors: candles_errors.json (id -> message). No labelling.
"""
import csv, json, math, os, sys, time, urllib.parse, urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

csv.field_size_limit(10**9)
HERE = os.path.dirname(os.path.abspath(__file__))
OLD = os.path.join(HERE, "..", "oct30")
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
            err = f"code {j.get('code')} {str(j.get('msg'))[:80]}"
            if j.get("code") == 109418:
                break
        except Exception as e:  # noqa
            err = str(e)[:80]
        time.sleep(1.5 * (a + 1))
    return key, [], err


def ts(r):
    return datetime.strptime(r["detected_at"][:19], "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc).timestamp() * 1000


def ids(path):
    return {r["id"] for r in csv.DictReader(open(path, newline=""))}


def rd(path):
    return list(csv.DictReader(open(path, newline="")))


def utc(t):
    return datetime.fromtimestamp(t / 1000, timezone.utc).strftime("%Y-%m-%d %H:%M")


old_w = ids(os.path.join(OLD, "lc_watches", "watches.csv"))
old_s = ids(os.path.join(OLD, "signals_entry_snapshot.csv"))
w_new = [r for r in rd(os.path.join(HERE, "lc_watches", "watches.csv")) if r["id"] not in old_w]
s_new = [r for r in rd(os.path.join(HERE, "signals_entry_snapshot.csv")) if r["id"] not in old_s]
for r in w_new:
    r["_start"] = math.floor(ts(r) / MS15) * MS15
for r in s_new:
    r["_start"] = math.ceil(ts(r) / MS15) * MS15
keys = sorted({(r["symbol"], r["_start"]) for r in w_new + s_new})
print("new watches", len(w_new), "new signals", len(s_new), "unique requests", len(keys), file=sys.stderr)
res, kerr = {}, {}
with ThreadPoolExecutor(6) as ex:
    for i, (k, c, e) in enumerate(ex.map(fetch, keys)):
        res[k] = c
        if e and not c:
            kerr[k] = e
        if i % 500 == 0:
            print("done", i, file=sys.stderr)
errs = {"watches": {}, "signals": {}}
with open(os.path.join(HERE, "lc_watches", "watch_candles_new.csv"), "w", newline="") as f:
    w = csv.writer(f)
    w.writerow(["id", "symbol", "detected_at", "open_time_ms", "open_time_utc", "open", "high", "low", "close", "volume"])
    for r in w_new:
        k = (r["symbol"], r["_start"])
        if not res[k]:
            errs["watches"][r["id"]] = kerr.get(k, "empty response")
        for t, o, h, l, c, v in res[k]:
            w.writerow([r["id"], r["symbol"], r["detected_at"], t, utc(t), o, h, l, c, v])
with open(os.path.join(HERE, "signal_candles_new.csv"), "w", newline="") as f:
    w = csv.writer(f)
    w.writerow(["id", "pattern", "symbol", "open_time_ms", "open_time_utc", "open", "high", "low", "close", "volume"])
    for r in s_new:
        k = (r["symbol"], r["_start"])
        if not res[k]:
            errs["signals"][r["id"]] = kerr.get(k, "empty response")
        for t, o, h, l, c, v in res[k]:
            w.writerow([r["id"], r["pattern"], r["symbol"], t, utc(t), o, h, l, c, v])
json.dump(errs, open(os.path.join(HERE, "candles_errors.json"), "w"), indent=0)
print("new watches", len(w_new), "without candles", len(errs["watches"]), "| new signals", len(s_new), "without candles", len(errs["signals"]), file=sys.stderr)
