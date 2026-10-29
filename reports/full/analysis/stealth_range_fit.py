"""Stealth Auto Range breakout (crypto only): single and paired quintile-range
filters on breakout features, live R exit (r_trail). Reports filters whose
every month (>=12 trades) and every chronological third is positive.
Run: python3 reports/full/analysis/stealth_range_fit.py <4h|1h> [variant]"""
import csv, os, sys, itertools
from collections import defaultdict
TF = sys.argv[1] if len(sys.argv) > 1 else "4h"
VAR = sys.argv[2] if len(sys.argv) > 2 else "A_all_breakouts"
P = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", f"stealth_detect_{TF}_crypto", "trades.csv")
def f(v):
    try: return float(v)
    except: return None
rows = [r for r in csv.DictReader(open(P)) if r["variant"] == VAR and f(r["r_trail"]) is not None]
FEATS = ["volRatio","bodyAtr","rangeAtr","closePos","closeAboveTopPct","rangeHeightPct","rangeHours","ret24hPct","ret7dPct","riskPct"]
def stats(sub):
    n = len(sub)
    if n == 0: return None
    bym = defaultdict(list)
    for r in sub: bym[r["entry_time"][:7]].append(f(r["r_trail"]))
    s = sorted(sub, key=lambda r: r["entry_time"]); k = n // 3
    th = [sum(f(r["r_trail"]) for r in s[i*k:(i+1)*k if i < 2 else n]) / max(1, len(s[i*k:(i+1)*k if i < 2 else n])) for i in range(3)]
    return n, sum(f(r["r_trail"]) for r in sub) / n, {m: (sum(v)/len(v), len(v)) for m, v in sorted(bym.items())}, th, \
        sum(1 for r in sub if f(r["peak72_pct"]) and f(r["peak72_pct"]) >= 10) / n * 100
def show(name, st):
    n, avg, bym, th, pk = st
    print(f"{name:60} n={n:5} avg={avg:+.2f}% pk>=10:{pk:4.1f}% thirds {th[0]:+.2f}/{th[1]:+.2f}/{th[2]:+.2f} | " +
          " ".join(f"{m[5:]}:{a:+.2f}({c})" for m, (a, c) in bym.items()))
base = stats(rows); show(f"BASE {TF} {VAR}", base)
edges = {}
for ft in FEATS:
    vals = sorted(f(r[ft]) for r in rows if f(r[ft]) is not None)
    if len(vals) < 100: continue
    edges[ft] = [-1e18] + [vals[int(len(vals)*q/5)] for q in range(1, 5)] + [1e18]
def ranges(ft):
    e = edges[ft]
    for lo in range(5):
        for hi in range(lo + 1, 6):
            if lo == 0 and hi == 5: continue
            yield (ft, e[lo], e[hi], f"{ft} in [{e[lo]:.3g},{e[hi]:.3g})")
def ok(st, minm=12):
    n, avg, bym, th, pk = st
    return len(bym) >= 4 and all(c >= minm and a > 0 for a, c in bym.values()) and all(t > 0 for t in th)
cands = []
singles = [x for ft in edges for x in ranges(ft)]
for ft, lo, hi, lab in singles:
    sub = [r for r in rows if f(r[ft]) is not None and lo <= f(r[ft]) < hi]
    st = stats(sub)
    if st and ok(st): cands.append((st[1]*st[0]**0.5, lab, st))
print(f"\nsingle filters tested {len(singles)}, passing {len(cands)}")
for _, lab, st in sorted(cands, reverse=True)[:12]: show(lab, st)
pairs = []; tested = 0
for (a, b) in itertools.combinations(singles, 2):
    if a[0] == b[0]: continue
    tested += 1
    sub = [r for r in rows if f(r[a[0]]) is not None and f(r[b[0]]) is not None and a[1] <= f(r[a[0]]) < a[2] and b[1] <= f(r[b[0]]) < b[2]]
    st = stats(sub)
    if st and st[0] >= 80 and ok(st): pairs.append((st[1]*st[0]**0.5, a[3] + " & " + b[3], st))
print(f"\npair filters tested {tested}, passing (n>=80) {len(pairs)}")
for _, lab, st in sorted(pairs, reverse=True)[:15]: show(lab, st)
