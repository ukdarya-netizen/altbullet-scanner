import csv,collections,json
from datetime import datetime,timezone
D='../stealth_arms/'
C=collections.defaultdict(list)
for r in csv.DictReader(open('work/arms_candles_1h.csv')):
    C[r['arm_id']].append((r['candle_open_utc'],float(r['open']),float(r['high']),float(r['low']),float(r['close'])))
A={r['arm_id']:r for r in csv.DictReader(open(D+'arms.csv'))}
V=collections.defaultdict(list)
for r in csv.DictReader(open(D+'arm_verdicts.csv')): V[r['arm_id']].append(r)
def lab(cs,start,entry,stop=0.08,win=0.05,h=72):
    after=[c for c in cs if c[0]>=start][:h]
    if len(after)<h: 
        for c in after:
            if c[3]<=entry*(1-stop): return 'loss'
            if c[2]>=entry*(1+win): return 'win'
        return 'incomplete'
    for c in after:
        if c[3]<=entry*(1-stop): return 'loss'
        if c[2]>=entry*(1+win): return 'win'
    return 'censored'
rows=[]
for i,a in A.items():
    if not a['trigger_candle_open_utc'] or i not in C: continue
    cs=sorted(C[i]); t=a['trigger_candle_open_utc'][:19]
    trig=[c for c in cs if c[0]==t]
    if not trig: continue
    entry=trig[0][4]
    nxt=(datetime.strptime(t,"%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc).timestamp()+3600)
    start=datetime.fromtimestamp(nxt,timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
    l=lab(cs,start,entry)
    vs=V.get(i,[])
    blk=collections.Counter(v['reason'].split(':')[0] for v in vs if v['verdict'] in('rejected','held'))
    main=blk.most_common(1)[0][0] if blk else ''
    body=(trig[0][4]/trig[0][1]-1)*100
    up=float(a['range_upper_identity'] or a['range_upper_breakout_level'])
    rows.append(dict(id=i,sym=a['symbol'],t=t,status=a['status'],term=a['terminal_reason'],blk=main,lab=l,body=body,dist=(entry/up-1)*100,fired=a['status']=='fired'))
print('arms with breakout candle:',len(rows))
def rep(name,rs):
    d=[r for r in rs if r['lab'] in('win','loss')]
    if not d: return
    w=sum(r['lab']=='win' for r in d)
    print(f"{name[:60]:60} n={len(d):4} win={w/len(d):.0%} exp={(w*4.9-(len(d)-w)*8.1)/len(d):+.2f}% days={len({r['t'][:10] for r in d})}")
rep('ALL breakouts',rows)
rep('fired',[r for r in rows if r['fired']])
for k,_ in collections.Counter(r['term'] for r in rows if not r['fired']).most_common(14):
    rep('term: '+k,[r for r in rows if not r['fired'] and r['term']==k])
print()
for k,_ in collections.Counter(r['blk'] for r in rows if not r['fired'] and r['blk']).most_common(12):
    rep('blocker: '+k,[r for r in rows if not r['fired'] and r['blk']==k])
import pickle; pickle.dump(rows,open('work/arms_rows.pkl','wb'))
