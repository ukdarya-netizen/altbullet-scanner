import csv,collections,json,itertools
csv.field_size_limit(10**9)
S={r['id']:r for r in csv.DictReader(open('../signals_entry_snapshot.csv')) if r['pattern']=='stealth_breakout'}
L={r['id']:r for r in csv.DictReader(open('../labels.csv')) if r['id'] in S}
need={i for i,r in L.items() if r['label']=='no_stop'}
C=collections.defaultdict(list)
for r in csv.DictReader(open('../candles_15m_72h.csv')):
    if r['id'] in need: C[r['id']].append((float(r['high']),float(r['low'])))
SKIP={'id','entry_price','original_entry_price','stop_price','peak_price','pnl_percent','peak_pct','entry_price_used','stop_loss_pct','closed_at','market_cap_usd_x'}
rows=[]
for i,s in S.items():
    if s['status']=='cancelled' and s.get('was_cancelled_entry')!='да': continue
    l=L[i]; lab,net=l['label'],l['net_pct']
    if lab=='no_stop' and l['entry']:
        e=float(l['entry']); lab=None
        for h,lo in C[i]:
            if lo<=e*0.9: lab,net='loss',-10.1;break
            if h>=e*1.05: lab,net='win',4.9;break
    if lab not in('win','loss'): continue
    f={}
    for k,v in s.items():
        if k in SKIP or k.endswith('__flag'): continue
        try: f[k]=float(v)
        except: pass
    def walk(o,p):
        if isinstance(o,dict):
            for a,b in o.items(): walk(b,p+'.'+a)
        elif isinstance(o,bool): f[p]=float(o)
        elif isinstance(o,(int,float)): f[p]=float(o)
    for col in ('decision_metrics','impulse_decision_metrics','entry_score_breakdown'):
        try: walk(json.loads(s.get(col) or '{}'),col[:3])
        except: pass
    f={k:v for k,v in f.items() if 'After' not in k and 'followup' not in k.lower() and 'Shadow' not in k}
    rows.append((s['detected_at'],float(net),f))
rows.sort(key=lambda x:x[0])
n=len(rows); folds=[rows[:n//3],rows[n//3:2*n//3],rows[2*n//3:]]
base=[sum(r[1] for r in F)/len(F) for F in folds]
print('Stealth signals',n,'base exp per third',[round(b,2) for b in base],[ (F[0][0][:10],F[-1][0][:10]) for F in folds])
keys=[k for k,c in collections.Counter(k for r in rows for k in r[2]).items() if c>=0.6*n]
def rule_ok(pred):
    out=[]
    for F in folds:
        kept=[r for r in F if pred(r)]
        if len(kept)<0.25*len(F) or len(kept)<12: return None
        out.append((len(kept),sum(r[1] for r in kept)/len(kept)))
    return out
res=[]
for k in keys:
    vals=sorted(r[2][k] for r in rows if k in r[2])
    if len(set(vals))<5: continue
    for q in (0.2,0.33,0.5,0.67,0.8):
        t=vals[int(len(vals)*q)]
        for side in ('>=','<'):
            pred=(lambda r,k=k,t=t:(k in r[2] and r[2][k]>=t)) if side=='>=' else (lambda r,k=k,t=t:(k in r[2] and r[2][k]<t))
            o=rule_ok(pred)
            if o and all(e>0 for _,e in o) and all(e>b for (_,e),b in zip(o,base)):
                res.append((min(e for _,e in o),k,side,t,o))
res.sort(reverse=True)
print('\nsingle rules positive & above baseline in all 3 thirds:',len(res))
for m,k,sd,t,o in res[:25]: print(f"{k[:55]:55} {sd} {t:.4g}  " + ' | '.join(f"n={a} {e:+.2f}" for a,e in o))
import pickle; pickle.dump((rows,folds,base,res),open('work/stealth_full.pkl','wb'))
