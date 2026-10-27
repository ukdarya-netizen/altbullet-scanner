import csv,glob,json,gzip,io,time,datetime as dt,bisect
rows=[]
for f in sorted(glob.glob('/tmp/work/ibr_*.csv')): rows+=list(csv.DictReader(open(f)))
kl=json.load(open('kl.json'))
def T(s): return dt.datetime.strptime(s,'%Y-%m-%d %H:%M:%S.%f').replace(tzinfo=dt.timezone.utc)
SEL=['funding_below_minus_0_1pct','p24h_5_to_10pct','price3h_ge_20pct','oi1h_above_20pct','spot_volume_below_2x','volume_lt_1_5x','impulse_spot_taker_netbuy_le_10pct']
now=time.time()*1000
times={s:[k['time'] for k in v[0]] for s,v in kl.items()}
out=open('out/ib_rejects.csv','w',newline='');w=csv.writer(out)
w.writerow(['id','cycle_at_utc','symbol','reasons','price','price_source','price_candle_open_utc','oi30m','vol_mult','price24h','prescan_cycles','has_selected_reason'])
buf=io.StringIO();cw=csv.writer(buf);cw.writerow(['reject_id','symbol','candle_open_utc','open','high','low','close','volume'])
nsel=0;nc=0;nopx=0;src={}
for r in rows:
    s=r['symbol'];t=int(T(r['cycle_at_utc']).timestamp()*1000);d=kl[s][0];tm=times[s]
    px='';ps='';pc=''
    if r['snapshot_price']: px=r['snapshot_price'];ps='decision_snapshot'
    else:
        i=bisect.bisect_right(tm,t-900000)-1  # last candle fully closed: open<=t-15m
        if i>=0 and t-tm[i]<=3*900000: px=d[i]['close'];ps='bingx_15m_last_closed_close';pc=dt.datetime.utcfromtimestamp(tm[i]/1000).strftime('%Y-%m-%d %H:%M:%S')
        else: ps='unavailable';nopx+=1
    src[ps]=src.get(ps,0)+1
    sel=any(x in r['reason'].split('+') for x in SEL)
    w.writerow([r['id'],r['cycle_at_utc'],s,r['reason'],px,ps,pc,r['oi30m'],r['vol_mult'],r['price24h'],r['prescan_cycles'],int(sel)])
    if sel and d:
        nsel+=1
        a=bisect.bisect_left(tm,t-t%900000);e=t+72*3600000
        for k in d[a:]:
            if k['time']>e: break
            if k['time']+900000>now: break
            cw.writerow([r['id'],s,dt.datetime.utcfromtimestamp(k['time']/1000).strftime('%Y-%m-%d %H:%M:%S'),k['open'],k['high'],k['low'],k['close'],k['volume']]);nc+=1
out.close()
print(src,nsel,nc)
open('ib_candles.csv.gz','wb').write(gzip.compress(buf.getvalue().encode(),9))
