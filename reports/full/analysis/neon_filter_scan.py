"""ABNeon: single-feature range filters (quintile edges) that keep every month positive.
Run: python3 reports/full/analysis/neon_filter_scan.py"""
import csv, os
from collections import defaultdict
P = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "neon_exits", "signals.csv")
rows = list(csv.DictReader(open(P)))
def f(v):
    try: return float(v)
    except: return None
FEATS = ["entryAboveLevelPct","trigBodyPct","trigRangePct","trigClosePos","trigVolRatio","price1hPct","price4hPct","price24hPct","price7dPct","fromHigh30dPct","fromLow30dPct","atr4hPct","vsEma50_4hPct","vsEma200_4hPct","vol24hVs7dAvg","vol24hUsd","zoneHeightPct","zoneCount","entryAboveZoneBottomPct","armAgeHours","trigLowVsZoneTopPct"]
for var in ("live_k3","live_k3_h1only"):
  for col in ("fx8_trk","fx10_rtr","zb_trk"):
    sub=[r for r in rows if r["variant"]==var and f(r[col]) is not None]
    tested=0; out=[]
    for ft in FEATS:
        vals=sorted(f(r[ft]) for r in sub if f(r[ft]) is not None)
        if len(vals)<300: continue
        qs=[vals[int(len(vals)*q/5)] for q in range(1,5)]; e=[-1e18]+qs+[1e18]
        for lo in range(5):
            for hi in range(lo+1,6):
                if lo==0 and hi==5: continue
                s=[r for r in sub if f(r[ft]) is not None and e[lo]<=f(r[ft])<e[hi]]
                tested+=1
                bym=defaultdict(list)
                for r in s: bym[r["observed_at"][:7]].append(f(r[col]))
                if len(bym)<4 or min(len(v) for v in bym.values())<15: continue
                m={k:sum(v)/len(v) for k,v in bym.items()}
                if all(x>0 for x in m.values()):
                    s.sort(key=lambda r:r["observed_at"]); n=len(s); k=n//3
                    th=[sum(f(r[col]) for r in s[i*k:(i+1)*k if i<2 else n]) for i in range(3)]
                    out.append((min(m.values()),ft,round(e[lo],3),round(e[hi],3),n,round(sum(f(r[col]) for r in s)/n,2),{k:round(v,2) for k,v in sorted(m.items())},[round(x) for x in th]))
    print(f"\n{var} exit={col}: tested {tested}, all-months-positive {len(out)}")
    for o in sorted(out,reverse=True)[:12]: print("  ",o)
