"""ABNeon: entry rule x stop x exit on reports/full/neon_exits/signals.csv.
Prints avg % per trade, sum, months, thirds, without best day. Run: python3 reports/full/analysis/neon_exits_analysis.py"""
import csv, os
from collections import defaultdict
P = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "neon_exits", "signals.csv")
rows = list(csv.DictReader(open(P)))
def f(v):
    try: return float(v)
    except: return None
STOPS = ["fx8", "fx10", "zb", "zt", "tl"]
EXITS = ["t10", "t15", "t20", "trk", "rtr", "r2", "r3"]
def stats(rs, col):
    v = [(r["observed_at"], f(r[col])) for r in rs if f(r[col]) is not None]
    if not v: return None
    v.sort(); n = len(v); k = n // 3; s = sum(x for _, x in v)
    th = [sum(x for _, x in v[i*k:(i+1)*k if i < 2 else n]) for i in range(3)]
    byd = defaultdict(float); bym = defaultdict(list)
    for t, x in v: byd[t[:10]] += x; bym[t[:7]].append(x)
    return n, s / n, s, th, s - max(byd.values()), {m: sum(x)/len(x) for m, x in sorted(bym.items())}
out = []
for var in ("live_k3", "live_k3_h1only"):
    rs = [r for r in rows if r["variant"] == var]
    print(f"\n===== {var}: signals {len(rs)}")
    for st in STOPS:
        risk = [f(r[f"risk_{st}"]) for r in rs if f(r[f"risk_{st}"]) is not None]
        print(f"  stop {st}: median risk {sorted(risk)[len(risk)//2]:.2f}%" if risk else f"  stop {st}: n/a")
        for ex in EXITS:
            s = stats(rs, f"{st}_{ex}")
            if not s: continue
            n, a, tot, th, wob, bym = s
            out.append((var, st, ex, n, a, tot, th, wob, bym))
            print(f"    {ex:4} n={n:5} avg={a:+.2f}% sum={tot:+7.0f} thirds={[round(x) for x in th]} wo_best_day={wob:+.0f} months={ {m: round(x,2) for m,x in bym.items()} }")
print("\n=== combos with all thirds > 0 and all months > 0, by avg:")
for o in sorted(out, key=lambda o: -o[4]):
    if all(x > 0 for x in o[6]) and all(x > 0 for x in o[8].values()):
        print(f"  {o[0]:15} stop={o[1]:4} exit={o[2]:4} n={o[3]} avg={o[4]:+.2f}% sum={o[5]:+.0f} wo_best={o[7]:+.0f}")
