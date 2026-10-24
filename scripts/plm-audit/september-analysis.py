"""Offline September PLM audit: joins frozen cohort, fixed-72h paths, fire-time metrics and indicator telemetry. No network/DB."""
import csv, json, datetime as dt
R='.local/reports/'
paths={r['id']:r for r in csv.DictReader(open(R+'plm-lifecycle-cohort-paths-2026-10-01.csv'))}
met={r['tracked_signal_id']:r for r in csv.DictReader(open(R+'plm-september-metrics-raw.csv'))}
tel={}
for r in csv.DictReader(open(R+'plm-indicator-telemetry-2026-10-01.csv')): tel[(r['id'],r['timeframe'])]=r
coh=[r for r in csv.DictReader(open(R+'plm-september-cohort-2026-10-01.csv'))]
def num(x):
    try: return float(x) if x not in ('',None,'null') else None
    except: return None
def boo(x): return None if x in ('',None) else x=='true'
rows=[]
for c in coh:
    p=paths[c['id']]; m=met[c['id']]
    complete=p['path_coverage']=='complete_72h'
    strong=complete and p['mfe_72h_hit_10']=='hit'
    cv=[boo(m[k]) for k in ('entry_cvd_15m','entry_cvd_30m','entry_cvd_1h','entry_cvd_4h')]
    d=dict(id=c['id'],symbol=c['symbol'],status=p['status_as_of_cohort'],detected=c['detected_at'],complete=complete,strong=strong,
      mfe=num(p['mfe_72h_pct_observed']),recpeak=num(p['recorded_peak_pct']),pnl=num(c['pnl_percent']),stop=p['status_as_of_cohort']=='stop_loss',
      bu=p['status_as_of_cohort']=='bu_stop',
      p24=num(m['price_24h_at_fire']),p3=num(m['entry_price_3h']),sv=num(m['entry_spot_vol_mult']),
      snf1=num(m['entry_spot_net_buy_1h']),snf4=num(m['entry_spot_net_buy_4h']),
      cvdn=(sum(1 for x in cv if x) if all(x is not None for x in cv) else None),
      oi30=num(m['entry_oi_30m']),ft=num(m['entry_fut_taker_net_buy']),fv=num(m['entry_fut_vol_mult']),
      ob=num(m['entry_ob_ratio']),fund=num(m['entry_funding_rate']),whale=num(m['entry_whale_index']),
      oi1=num(m['entry_oi_1h']),oi4=num(m['entry_oi_4h']),spt=num(m['entry_spot_taker_net_buy']),
      src=m['sv_src'] or 'unknown',ind_cap=m['ind_cap'])
    rows.append(d)
for d in rows:
    d['snf']=None if d['snf1'] is None and d['snf4'] is None else any(x is not None and x>0 for x in (d['snf1'],d['snf4']))
    d['g_p24']=None if d['p24'] is None else 5<=d['p24']<=15
    d['g_p3']=None if d['p3'] is None else 1.5<=d['p3']<=4
    d['g_sv']=None if d['sv'] is None else d['sv']>=1.1
    d['g_cvd']=None if d['cvdn'] is None else d['cvdn']>=2
    gs=[d['g_p24'],d['g_p3'],d['g_sv'],d['snf'],d['g_cvd']]
    d['g_all']=None if None in gs else all(gs)
def summarize(sub):
    comp=[r for r in sub if r['complete']]
    return dict(n=len(sub),complete=len(comp),strong=sum(r['strong'] for r in comp),
      strong_rate=(sum(r['strong'] for r in comp)/len(comp)) if comp else None,
      stops=sum(r['stop'] for r in sub),bu=sum(r['bu'] for r in sub),
      censored=len(sub)-len(comp),recpeak10=sum((r['recpeak'] or 0)>=10 for r in sub))
base=summarize(rows)
def cut(name,fn):
    keep=[r for r in rows if fn(r) is not False]; rem=[r for r in rows if fn(r) is False]
    unk=[r for r in rows if fn(r) is None]
    kk=summarize(keep); rr=summarize(rem)
    return dict(name=name,measured=len(rows)-len(unk),unknown=len(unk),removed=rr['n'],kept=kk['n'],
      strong_total=base['strong'],strong_removed=rr['strong'],strong_kept=kk['strong'],
      stops_total=base['stops'],stops_removed=rr['stops'],bu_total=base['bu'],bu_removed=rr['bu'],
      censored_removed=rr['censored'],censored_total=base['censored'],
      removed_stop_ids=[r['symbol'] for r in rem if r['stop']][:30],
      removed_strong_ids=[r['symbol'] for r in rem if r['strong']][:50])
def L(k,op,v):
    def f(r):
        x=r[k]
        if x is None:return None
        return x>=v if op=='>=' else (x<=v if op=='<=' else x<v)
    return f
cuts=[('Spot volume ≥1,5x',L('sv','>=',1.5)),('Spot volume ≤2,0x',L('sv','<=',2.0)),('Spot volume ≥1,1x (нынешний гейт)',L('sv','>=',1.1)),
 ('p3h ≥2%',L('p3','>=',2)),('p3h ≤3%',L('p3','<=',3)),('p3h в 1,5–4% (нынешний)',lambda r:r['g_p3']),
 ('p24h ≤10%',L('p24','<=',10)),('p24h в 5–15% (нынешний)',lambda r:r['g_p24']),('p24h ≤18%',L('p24','<=',18)),
 ('OI30m <2%',L('oi30','<',2)),('OI30m <1%',L('oi30','<',1)),('Futures Taker <20%',L('ft','<',20)),
 ('CVD ≥2 TF (нынешний)',lambda r:r['g_cvd']),('CVD ≥3 TF',lambda r:None if r['cvdn'] is None else r['cvdn']>=3),
 ('SNF >0 на 1h или 4h (нынешний)',lambda r:r['snf']),('Funding ≤0,01%',L('fund','<=',0.0001)),('Funding ≤0,005%',L('fund','<=',0.00005)),
 ('Orderbook ratio ≥1',L('ob','>=',1)),('Все пять нынешних условий',lambda r:r['g_all'])]
vol=[cut(n,f) for n,f in cuts]
# gate class cross-tab
cls={}
for name,fn in [('Прошли все пять нынешних условий',lambda r:r['g_all'] is True),('Не прошли хотя бы одно (значения известны)',lambda r:r['g_all'] is False),('Не оценимо (нет метрики)',lambda r:r['g_all'] is None)]:
    cls[name]=summarize([r for r in rows if fn(r)])
fails={}
for k,n in [('g_p24','p24h вне 5–15%'),('g_p3','p3h вне 1,5–4%'),('g_sv','spot <1,1x'),('snf','нет положительного SNF'),('g_cvd','CVD <2 TF')]:
    fails[n]=summarize([r for r in rows if r[k] is False])
passes={}
for k,n in [('g_p24','p24h в 5–15%'),('g_p3','p3h в 1,5–4%'),('g_sv','spot ≥1,1x'),('snf','SNF >0'),('g_cvd','CVD ≥2 TF')]:
    passes[n]=summarize([r for r in rows if r[k] is True])
# split halves by time
srt=sorted(rows,key=lambda r:r['detected']); half={'Первая половина (1–15 сент., Dubai)':srt[:48],'Вторая половина':srt[48:]}
halves={k:summarize(v) for k,v in half.items()}
# week buckets
weeks={}
for r in rows:
    dtm=dt.datetime.fromisoformat(r['detected'].replace(' ','T'))+dt.timedelta(hours=4)
    wk=min((dtm.day-1)//7+1,4)
    weeks.setdefault(wk,[]).append(r)
weeks={f'Неделя {k}':summarize(v) for k,v in sorted(weeks.items())}
# indicators
def tv(r,tf,k):
    t=tel.get((r['id'],tf))
    if not t or t['closed_candle_at_or_before_detection']!='true':return None
    return num(t[k])
specs=[('RSI5 ≤70',lambda v:v('rsi5')<=70 if v('rsi5') is not None else None),
('Williams %R(21) ≤−20',lambda v:v('williamsR21')<=-20 if v('williamsR21') is not None else None),
('ADX14 ≥20',lambda v:v('adx14')>=20 if v('adx14') is not None else None),
('ADX14 ≥30',lambda v:v('adx14')>=30 if v('adx14') is not None else None),
('ATR percentile ≤75',lambda v:v('atrPercentile60d')<=75 if v('atrPercentile60d') is not None else None),
('BB bandwidth percentile ≤50',lambda v:v('bollingerBandwidthPercentile60d')<=50 if v('bollingerBandwidthPercentile60d') is not None else None),
('Close location ≥60',lambda v:v('close_location_pct')>=60 if v('close_location_pct') is not None else None),
('|aVWAP| ≤2 ATR',lambda v:abs(v('anchoredVwapDistanceAtr'))<=2 if v('anchoredVwapDistanceAtr') is not None else None),
('|aVWAP| ≤2%',lambda v:abs(v('anchoredVwapDistancePercent'))<=2 if v('anchoredVwapDistancePercent') is not None else None)]
ind=[]
for tf in ['15m','30m','1h','4h']:
    for n,s in specs:
        c=cut(f'{tf}: {n}',lambda r,tf=tf,s=s:s(lambda k:tv(r,tf,k)))
        ind.append(c)
# list of strong
strongs=[dict(symbol=r['symbol'],detected=r['detected'][:16],status=r['status'],mfe=r['mfe'],recpeak=r['recpeak']) for r in rows if r['strong']]
stops=[dict(symbol=r['symbol'],detected=r['detected'][:16],pnl=r['pnl'],mfe=r['mfe'],complete=r['complete']) for r in rows if r['stop']]
# median/percentiles of key features strong vs non-strong
import statistics as S
feat={}
for k,n in [('p24','p24h %'),('p3','p3h %'),('sv','Spot volume x'),('cvdn','CVD TF'),('oi30','OI30m %'),('ft','Futures Taker %'),('ob','Orderbook ratio'),('fund','Funding %')]:
    a=[r[k] for r in rows if r['strong'] and r[k] is not None]; b=[r[k] for r in rows if r['complete'] and not r['strong'] and r[k] is not None]
    feat[n]=dict(strong_n=len(a),strong_med=S.median(a) if a else None,weak_n=len(b),weak_med=S.median(b) if b else None)
mm=[r['mfe'] for r in rows if r['complete']]
out=dict(base=base,vol=vol,cls=cls,fails=fails,passes=passes,halves=halves,weeks=weeks,ind=ind,strongs=strongs,stops=stops,feat=feat,
 mfe=dict(med=S.median(mm),n=len(mm)),
 cov={k:sum(1 for r in rows if r[k] is not None) for k in ['p24','p3','sv','snf','cvdn','oi30','ft','ob','fund']},
 status={s:sum(1 for r in rows if r['status']==s) for s in set(r['status'] for r in rows)},
 src={s:sum(1 for r in rows if r['src']==s) for s in set(r['src'] for r in rows)})
json.dump(out,open(R+'plm-september-analysis-2026-10-01.json','w'),ensure_ascii=False,indent=1)
print(json.dumps(base),out['status'],out['cov'],out['src'])
for v in vol:print(v['name'],v['removed'],'strong-',v['strong_removed'],'/',v['strong_total'],'stop-',v['stops_removed'],'/',v['stops_total'],'bu-',v['bu_removed'],'cens-',v['censored_removed'],'unk',v['unknown'])
print(cls);print(fails);print(passes);print(halves);print(weeks);print(feat)

# bands + post-close, appended as second output
def band(k,edges,labels):
    res=[]
    for i,lab in enumerate(labels):
        lo,hi=edges[i],edges[i+1]
        sub=[r for r in rows if r[k] is not None and lo<=r[k]<hi]
        res.append(dict(label=lab,**summarize(sub)))
    unk=[r for r in rows if r[k] is None]
    res.append(dict(label='нет значения',**summarize(unk)))
    return res
INF=1e9
bands=dict(
 sv=band('sv',[-INF,1.1,1.5,2.0,INF],['<1,1x','1,1–1,5x','1,5–2x','≥2x']),
 p3=band('p3',[-INF,1.5,2,3,4,INF],['<1,5%','1,5–2%','2–3%','3–4%','>4%']),
 p24=band('p24',[-INF,5,10,15,INF],['<5%','5–10%','10–15%','>15%']),
 cvdn=band('cvdn',[0,1,2,3,4,5],['0 TF','1 TF','2 TF','3 TF','4 TF']),
 ft=band('ft',[-INF,0,20,INF],['<0%','0–20%','≥20%']))
pc=[]
for r in rows:
    p=paths[r['id']]
    if p['status_as_of_cohort'] in ('active',):continue
    pc.append(dict(status=p['status_as_of_cohort'],cov=p['postclose_path_coverage'],hit=p['postclose_hit_10']=='hit',new=(p['postclose_hit_10']=='hit' and (r['recpeak'] or 0)<10),sym=r['symbol'],mfe=num(p['postclose_mfe_pct_observed'])))
pcs={}
for s in set(x['status'] for x in pc):
    sub=[x for x in pc if x['status']==s]; ev=[x for x in sub if x['cov']=='complete_observed']
    pcs[s]=dict(n=len(sub),eval=len(ev),hit=sum(x['hit'] for x in ev),new=sum(x['new'] for x in ev),syms=[x['sym'] for x in ev if x['new']][:20])
out['bands']=bands;out['postclose']=pcs
json.dump(out,open(R+'plm-september-analysis-2026-10-01.json','w'),ensure_ascii=False,indent=1)
for k,v in bands.items():
    print(k);[print(' ',b['label'],b['n'],b['complete'],b['strong'],b['stops'],b['bu']) for b in v]
print(pcs)
