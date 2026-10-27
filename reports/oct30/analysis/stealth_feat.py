import csv,collections,json,math,sys
csv.field_size_limit(10**9)
D='../'
S={r['id']:r for r in csv.DictReader(open(D+'signals_entry_snapshot.csv')) if r['pattern']=='stealth_breakout'}
L={r['id']:r for r in csv.DictReader(open(D+'labels.csv')) if r['pattern']=='stealth_breakout'}
need={i for i,r in L.items() if r['label']=='no_stop'}
C=collections.defaultdict(list)
for r in csv.DictReader(open(D+'candles_15m_72h.csv')):
    if r['id'] in need: C[r['id']].append((float(r['high']),float(r['low'])))
rows=[]
for i,r in L.items():
    lab=r['label']
    if lab=='no_stop' and r['entry']:
        e=float(r['entry']);lab=None
        for h,l in C[i]:
            if l<=e*0.9: lab='loss';break
            if h>=e*1.05: lab='win';break
    if lab not in('win','loss') or r['status']=='cancelled': continue
    s=S[i]; feat={}
    for k,v in s.items():
        if k.endswith('__flag') or k in('id','entry_price','original_entry_price','stop_price','peak_price','pnl_percent','peak_pct','entry_price_used','stop_loss_pct'): continue
        try: feat[k]=float(v)
        except: pass
    for jk in ('decision_metrics',):
        try:
            j=json.loads(s.get(jk) or '{}')
            def walk(o,p):
                if isinstance(o,dict):
                    for a,b in o.items(): walk(b,p+'.'+a)
                elif isinstance(o,(int,float)) and not isinstance(o,bool): feat[p]=float(o)
                elif isinstance(o,bool): feat[p]=float(o)
            walk(j,'dm')
        except Exception: pass
    rows.append((s['detected_at'],lab=='win',feat,s['symbol']))
rows.sort()
print('n',len(rows),'win',sum(r[1] for r in rows), rows[0][0][:10], rows[-1][0][:10])
k=int(len(rows)*0.6); tr,te=rows[:k],rows[k:]
print('train',tr[0][0][:10],tr[-1][0][:10],'wr %.2f'%(sum(r[1] for r in tr)/len(tr)),'test',te[0][0][:10],te[-1][0][:10],'wr %.2f'%(sum(r[1] for r in te)/len(te)))
keys=collections.Counter(f for r in rows for f in r[2])
res=[]
for f,c in keys.items():
    if c<0.6*len(rows): continue
    vals=sorted(r[2][f] for r in tr if f in r[2])
    if len(set(vals))<4: continue
    q=[vals[int(len(vals)*p)] for p in (0.25,0.5,0.75)]
    def wr(rs):
        b=[[0,0] for _ in range(4)]
        for r in rs:
            if f not in r[2]: continue
            x=r[2][f]; j=sum(x>t for t in q); b[j][0]+=1; b[j][1]+=r[1]
        return [(n,w/n if n else float('nan')) for n,w in b]
    a,b=wr(tr),wr(te)
    # spread top vs bottom quartile on both
    st=a[3][1]-a[0][1]; se=b[3][1]-b[0][1]
    if all(n>=8 for n,_ in a) and all(n>=5 for n,_ in b) and st*se>0:
        res.append((min(abs(st),abs(se)),f,q,a,b))
res.sort(reverse=True)
for m,f,q,a,b in res[:25]:
    print(f"{f[:60]:60} q={[round(x,3) for x in q]} train={[f'{n}:{w:.0%}' for n,w in a]} test={[f'{n}:{w:.0%}' for n,w in b]}")

print('\n--- bodyPct buckets, expectancy by bot rule')
Lnet={}
for i,r in L.items():
    pass
