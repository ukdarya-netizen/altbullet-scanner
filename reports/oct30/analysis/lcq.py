import csv,collections,itertools,pickle
csv.field_size_limit(10**9)
S=__import__('os').environ.get('WORK','work/')
W={r['id']:r for r in csv.DictReader(open('../lc_watches/watches.csv'))}
C=collections.defaultdict(list)
for r in csv.DictReader(open(S+'lc_candles.csv')):
    C[r['id']].append((float(r['open']),float(r['high']),float(r['low']),float(r['close'])))
F=['price24h_at_detect','price1h_at_detect','oi30m_at_detect','oi1h_at_detect','oi4h_at_detect','spot_vol_mult_at_detect','spot_vol_mcap_pct','long_liq1h_at_detect','long_liq4h_at_detect','long_liq24h_at_detect','global_long_pct','large_bid_usd','liq_orders_count_at_detect','liq_orders_usd_at_detect','cycle_count_at_detect']
rows=[]
for i,w in W.items():
    cs=C.get(i,[])
    if len(cs)<270: continue
    o,h,l,c=cs[0]
    f={'rng':(h-l)/o*100,'wick':(min(o,c)-l)/o*100,'body':(c-o)/o*100,'close_pos':(c-l)/(h-l) if h>l else 0.5}
    for k in F:
        try: f[k]=float(w[k])
        except: pass
    for k in ('cvd30m_at_detect','cvd1h_at_detect','cvd4h_at_detect','liq_exhausted'):
        v=w[k].lower()
        if v in('true','t','1'): f[k]=1.0
        elif v in('false','f','0'): f[k]=0.0
    if 'long_liq1h_at_detect' in f and 'liq_orders_usd_at_detect' in f: pass
    st=c*0.9; hit=0; pk=0
    for oo,hh,ll,cc in cs[1:]:
        if ll<=st: break
        pk=max(pk,hh/c*100-100)
        if pk>=10: hit=1
    # profit with full take +10
    pr=None
    for oo,hh,ll,cc in cs[1:]:
        if ll<=c*0.9: pr=-10.1;break
        if hh>=c*1.1: pr=9.9;break
    if pr is None: pr=(cs[-1][3]/c-1)*100-0.1
    rows.append(dict(t=w['detected_at'],day=w['detected_at'][:10],hit=hit,pk=pk,pr=pr,f=f))
rows.sort(key=lambda r:r['t'])
pickle.dump(rows,open(S+'lcq.pkl','wb'))
print(len(rows))
