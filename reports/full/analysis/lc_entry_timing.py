"""LC: is the capitulation entry too early? Compare entering at the detection
candle close (live) with waiting for confirmation on the next 15m candles.
Watches Jul 14 - Oct 24 (reports/full/lc_watches + oct30 candles). LC exit
approximated as live: stop -10%, B.U. once the peak reached +8%, trailing from
+15% at 10 pp below the peak, close at 72h; stop first within a candle; fee 0.1%.
Run: WORK=/path/ python3 lc_entry_timing.py"""
import csv, gzip, os, collections, datetime as dt
H = os.path.dirname(os.path.abspath(__file__)); WORK = os.environ.get("WORK", "work/")
W = {r["id"]: r for r in csv.DictReader(open(f"{H}/../lc_watches/watches.csv"))}
C = collections.defaultdict(list)
for r in csv.DictReader(open(WORK + "lc_candles.csv")):
    C[r["id"]].append((int(r["open_time_ms"]), float(r["open"]), float(r["high"]), float(r["low"]), float(r["close"])))
old = set(C)
for r in csv.DictReader(gzip.open(f"{H}/../lc_watches/watch_candles_new.csv.gz", "rt")):
    if r["id"] not in old:
        C[r["id"]].append((int(r["open_time_ms"]), float(r["open"]), float(r["high"]), float(r["low"]), float(r["close"])))
def lc_exit(a, e):
    stop, peak = e * 0.9, e
    for _, o, h, l, c in a[:288]:
        if l <= stop: return (stop / e - 1) * 100 - 0.1, (peak / e - 1) * 100
        peak = max(peak, h); pp = (peak / e - 1) * 100
        if pp >= 8: stop = max(stop, e)
        if pp >= 15: stop = max(stop, e * (1 + (pp - 10) / 100))
    return (a[min(len(a), 288) - 1][4] / e - 1) * 100 - 0.1, (peak / e - 1) * 100
V = collections.defaultdict(list)
for i, w in W.items():
    cs = sorted(C.get(i, []))
    if len(cs) < 270: continue
    d = dt.datetime.fromisoformat(w["detected_at"]).replace(tzinfo=dt.timezone.utc)
    if cs[0][0] != int(d.timestamp() // 900 * 900 * 1000): continue
    if w["long_liq1h_at_detect"] != "" and float(w["long_liq1h_at_detect"]) == 0: continue
    if w["symbol"] in ("BTC-USDT",): continue
    _, o, h, l, c = cs[0]
    if o <= 0 or h <= l: continue
    rng, body = (h - l) / o * 100, (c - o) / o * 100
    if rng < 5.6 or not (-5.5 <= body <= -3.5): continue
    mon = "10-15" if w["detected_at"][:10] == "2026-10-15" else w["detected_at"][5:7]
    def add(name, k, entry):
        r, pk = lc_exit(cs[k + 1:], entry); V[name].append((mon, r, pk))
    add("LIVE enter at capitulation close", 0, c)
    n1 = cs[1]
    # wait 1 candle: enter at its close only if it made no new low
    if n1[3] >= l: add("next 15m: no new low -> enter", 1, n1[4])
    else: V["next 15m: no new low -> enter (skipped)"].append((mon, *lc_exit(cs[1:], c)))
    if n1[4] > n1[1]: add("next 15m green -> enter", 1, n1[4])
    # wait up to 4 candles (1h) for a candle closing above the capitulation close
    for k in range(1, 5):
        if cs[k][4] > c: add("close back above capitulation close within 1h", k, cs[k][4]); break
    # wait up to 4 candles for a green candle with no new low below capitulation low
    lo = l
    for k in range(1, 5):
        lo = min(lo, cs[k][3])
        if cs[k][4] > cs[k][1] and cs[k][3] >= l: add("green 15m holding the capitulation low within 1h", k, cs[k][4]); break
def show(name, xs):
    if not xs: print(f"{name:52} n=0"); return
    by = collections.defaultdict(list)
    for m, r, pk in xs: by[m].append(r)
    n = len(xs); s = sum(r for _, r, _ in xs); p10 = sum(1 for *_, pk in xs if pk >= 10)
    print(f"{name:52} n={n:4} sum={s:+7.0f}% avg={s/n:+.2f}% pk>=10={100*p10/n:3.0f}% stops={100*sum(1 for _,r,_ in xs if r<-9)/n:3.0f}% | " +
          " ".join(f"{m}:{sum(v):+.0f}({len(v)})" for m, v in sorted(by.items())))
for k in ["LIVE enter at capitulation close", "next 15m: no new low -> enter", "next 15m: no new low -> enter (skipped)",
          "next 15m green -> enter", "close back above capitulation close within 1h", "green 15m holding the capitulation low within 1h"]:
    show(k, V[k])
