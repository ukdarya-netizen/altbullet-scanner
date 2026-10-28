"""R-exit breakout analysis on reports/full/stealth_research2/events.csv.
Prints per variant: n, avg R, sum R, avg %, win%, by month, by thirds, w/o best day.
Run: python3 reports/full/analysis/stealth_r_exits.py"""
import csv, os, sys
from collections import defaultdict
P = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "stealth_research2", "events.csv")
rows = []
with open(P) as f:
    for r in csv.DictReader(f):
        rows.append(r)
def fl(r, k):
    v = r.get(k, "")
    try: return float(v)
    except: return None
EX = ["r_level_trail","r_level_t2","r_level_t3","r_candle_trail","r_candle_t2","r_candle_t3"]
RISK = {"r_level": "risk_level_pct", "r_candle": "risk_candle_pct"}
def stats(sub, ex):
    rk = RISK[ex.rsplit("_",1)[0]]
    xs = [(fl(r,ex), fl(r,rk), r["time"][:10]) for r in sub]
    xs = [x for x in xs if x[0] is not None and x[1] is not None]
    if not xs: return None
    n = len(xs); sR = sum(x[0] for x in xs)
    pcts = [x[0]*abs(x[1]) for x in xs]
    byday = defaultdict(float)
    for x,p in zip(xs,pcts): byday[x[2]] += p
    best = max(byday, key=byday.get)
    return n, sR/n, sR, sum(pcts)/n, sum(pcts), sum(1 for x in xs if x[0]>0)/n*100, sum(pcts)-byday[best], best
def report(name, sub):
    print(f"\n=== {name}: events {len(sub)}, days {len(set(r['time'][:10] for r in sub))}")
    for ex in EX:
        s = stats(sub, ex)
        if not s: continue
        n,aR,sR,aP,sP,w,sPnb,best = s
        print(f"  {ex:15} n={n:6} avgR={aR:+.3f} sumR={sR:+9.1f} avg%={aP:+.3f} sum%={sP:+9.1f} win%={w:4.1f} sum%_wo_best_day({best})={sPnb:+9.1f}")
    for ex in ("r_level_trail","r_level_t3","r_candle_trail","r_candle_t3"):
        bym = defaultdict(list)
        for r in sub:
            v = fl(r,ex); rk = fl(r, RISK[ex.rsplit('_',1)[0]])
            if v is not None and rk is not None: bym[r["time"][:7]].append((v, v*abs(rk)))
        print("   ", ex, " | ".join(f"{m}: n{len(v)} R{sum(a for a,_ in v)/len(v):+.3f} %{sum(b for _,b in v)/len(v):+.2f}" for m,v in sorted(bym.items())))
sel = {
 "ALL new-24h-high": lambda r: True,
 "fresh (no new 24h high in prev 24h)": lambda r: fl(r,"new24h_highs_prev24")==0,
 "fresh + brk_168": lambda r: fl(r,"new24h_highs_prev24")==0 and r["brk_168"]=="1",
 "fresh + brk_72": lambda r: fl(r,"new24h_highs_prev24")==0 and r["brk_72"]=="1",
 "fresh + ar_breakout": lambda r: fl(r,"new24h_highs_prev24")==0 and r["ar_breakout"]=="1",
 "fresh + vol_ratio>=3": lambda r: fl(r,"new24h_highs_prev24")==0 and (fl(r,"vol_ratio_20med") or 0)>=3,
 "fresh + vol24_usd>=2M": lambda r: fl(r,"new24h_highs_prev24")==0 and (fl(r,"vol24_usd") or 0)>=2e6,
}
for k,fn in sel.items(): report(k, [r for r in rows if fn(r)])
