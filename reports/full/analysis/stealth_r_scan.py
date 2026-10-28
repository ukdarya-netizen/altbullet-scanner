"""Scan single-feature quintile filters on new-24h-high events for r_level_trail.
Pass = every month (Jul..Oct) avg R > 0 and Oct n>=100. Also all events vs fresh.
Run: python3 reports/full/analysis/stealth_r_scan.py"""
import csv, os
from collections import defaultdict
P = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "stealth_research2", "events.csv")
rows = list(csv.DictReader(open(P)))
FEATS = ["dist_above_prev24h_high_pct","base24_height_pct","base48_height_pct","base72_height_pct","base168_height_pct","ar_height_pct","ar_hours","ret1h_pct","body_pct","body_atr","range_atr","close_pos","upper_wick_pct","vol_ratio_20med","vol_ratio_20med_prev","vol24_vs_7d","vol24_usd","ret3h_pct","ret6h_pct","ret24h_pct","ret72h_pct","ret7d_pct","atr_pct","atr24_vs_atr168","bbw_pct","bbw_pctile_120","vs_ema50_pct","vs_ema200_pct","ema50_slope24_pct","from_high30d_pct","from_low30d_pct","new24h_highs_prev24","hours_since_prev_event","risk_level_pct"]
def f(v):
    try: return float(v)
    except: return None
EX = "r_level_trail"
for scope, sub in (("ALL", rows), ("FRESH", [r for r in rows if f(r["new24h_highs_prev24"])==0])):
    sub = [r for r in sub if f(r[EX]) is not None]
    tested = passed = 0; out=[]
    for ft in FEATS:
        vals = sorted(f(r[ft]) for r in sub if f(r[ft]) is not None)
        if len(vals) < 500: continue
        qs = [vals[int(len(vals)*q/5)] for q in range(1,5)]
        edges = [-1e18]+qs+[1e18]
        for lo in range(5):
            for hi in range(lo+1,6):
                if lo==0 and hi==5: continue
                a,b = edges[lo],edges[hi]
                s=[r for r in sub if f(r[ft]) is not None and a<=f(r[ft])<b]
                bym=defaultdict(list)
                for r in s: bym[r["time"][:7]].append((f(r[EX]), f(r[EX])*abs(f(r["risk_level_pct"]))))
                tested+=1
                if len(bym)<4 or len(bym.get("2026-10",[]))<100: continue
                mR={m:sum(x for x,_ in v)/len(v) for m,v in bym.items()}
                mP={m:sum(y for _,y in v)/len(v) for m,v in bym.items()}
                if all(x>0 for x in mR.values()) and all(x>0 for x in mP.values()):
                    passed+=1
                    tot=sum(x for v in bym.values() for x,_ in v)/len(s)
                    out.append((min(mR.values()), ft, round(a,3), round(b,3), len(s), round(tot,3), {m:round(x,3) for m,x in sorted(mR.items())}, {m:round(x,2) for m,x in sorted(mP.items())}))
    print(f"\n{scope}: filters tested {tested}, passed (all 4 months R>0 and %>0) {passed}")
    for o in sorted(out, reverse=True)[:25]: print(" ", o)
