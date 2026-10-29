"""LC capitulation entries (live rule): which features known at fire time separate
stopped trades (JCT-type: dump continues) from the rest. Same data/exit as lc_entry_timing.py."""
import csv, gzip, os, collections, datetime as dt
exec(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "lc_entry_timing.py")).read().split("V = collections")[0])
rows = []
for i, w in W.items():
    cs = sorted(C.get(i, []))
    if len(cs) < 270: continue
    d = dt.datetime.fromisoformat(w["detected_at"]).replace(tzinfo=dt.timezone.utc)
    if cs[0][0] != int(d.timestamp() // 900 * 900 * 1000): continue
    if w["long_liq1h_at_detect"] != "" and float(w["long_liq1h_at_detect"]) == 0: continue
    _, o, h, l, c = cs[0]
    if o <= 0 or h <= l: continue
    rng, body = (h - l) / o * 100, (c - o) / o * 100
    if rng < 5.6 or not (-5.5 <= body <= -3.5): continue
    r, pk = lc_exit(cs[1:], c)
    def f(k):
        try: return float(w[k])
        except (TypeError, ValueError): return None
    rows.append(dict(id=i, sym=w["symbol"], day=w["detected_at"][:16], mon=w["detected_at"][5:7] if w["detected_at"][:10] != "2026-10-15" else "10-15",
        r=r, pk=pk, rng=rng, body=body, lw=(c - l) / (h - l) * 100, uw=(h - o) / (h - l) * 100,
        p1h=f("price1h_at_detect"), p24=f("price24h_at_detect"), oi1h=f("oi1h_at_detect"), cvd1h=f("cvd1h_at_detect"),
        liq1h=f("long_liq1h_at_detect"), gl=f("global_long_pct")))
print("n", len(rows))
def q(xs, p): xs = sorted(xs); return xs[int(p * (len(xs) - 1))]
for k in ["rng", "body", "lw", "uw", "p1h", "p24", "oi1h", "cvd1h", "liq1h", "gl"]:
    good = [x[k] for x in rows if x[k] is not None and x["r"] > -9]; bad = [x[k] for x in rows if x[k] is not None and x["r"] <= -9]
    if bad: print(f"{k:6} ok n={len(good):3} med={q(good,.5):9.2f} | stopped n={len(bad):2} med={q(bad,.5):9.2f} vals={[round(v,1) for v in sorted(bad)]}")
print("\nstopped trades:")
for x in rows:
    if x["r"] <= -9: print({k: (round(v, 2) if isinstance(v, float) else v) for k, v in x.items()})
import json; json.dump(rows, open(os.environ["WORK"] + "lc_rows.json", "w"))
