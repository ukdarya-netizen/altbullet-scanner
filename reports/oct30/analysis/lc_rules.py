"""LC quality rule search + evaluation (run after lcq.py; WORK dir holds lcq.pkl).
Outcome: entry at the close of the 15m detection candle, stop -10%, +10% target, 72h.
Rules must be profitable (take +10%) in all three chronological thirds."""
import pickle,itertools,collections,os
S=os.environ.get('WORK','work/')
rows=pickle.load(open(S+'lcq.pkl','rb'))
n=len(rows); T=[rows[:n//3],rows[n//3:2*n//3],rows[2*n//3:]]
keys=sorted({k for r in rows for k in r['f']})
conds=[]
for k in keys:
    vals=sorted(r['f'][k] for r in rows if k in r['f'])
    if len(vals)<0.5*n: continue
    if len(set(vals))<=2:
        for v in set(vals): conds.append((f"{k}=={v:g}",lambda r,k=k,v=v:r['f'].get(k)==v)); continue
    for q in (0.5,0.67,0.8,0.9,0.95):
        t=vals[int(len(vals)*q)]; conds.append((f"{k}>={t:.4g}",lambda r,k=k,t=t:k in r['f'] and r['f'][k]>=t))
    for q in (0.05,0.1,0.2,0.33,0.5):
        t=vals[int(len(vals)*q)]; conds.append((f"{k}<{t:.4g}",lambda r,k=k,t=t:k in r['f'] and r['f'][k]<t))
def ev(p,minn=12):
    out=[]
    for t in T:
        z=[r for r in t if p(r)]
        if len(z)<minn: return None
        out.append((len(z),sum(r['hit'] for r in z)/len(z),sum(r['pr'] for r in z)/len(z)))
    return out
res=[]
for name,p in conds:
    o=ev(p)
    if o and all(x[2]>0 for x in o): res.append((min(x[1] for x in o),name,o))
for (n1,p1),(n2,p2) in itertools.combinations(conds,2):
    o=ev(lambda r:p1(r) and p2(r))
    if o and all(x[2]>0 for x in o): res.append((min(x[1] for x in o),n1+' AND '+n2,o))
res.sort(key=lambda x:-x[0])
for m,name,o in res[:40]: print(f"{name[:80]:80} | "+' | '.join(f"n={a} +10%:{b:.0%} {c:+.2f}" for a,b,c in o))
