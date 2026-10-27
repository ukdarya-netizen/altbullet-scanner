import csv,glob,json,time,urllib.request,datetime as dt,concurrent.futures as cf,io,gzip,re
rows=[]
for f in sorted(glob.glob('/tmp/work/ibr_*.csv')):
    rows+=list(csv.DictReader(open(f)))
ids=[r['id'] for r in rows];print(len(rows),len(set(ids)))
def T(s): return dt.datetime.strptime(s,'%Y-%m-%d %H:%M:%S.%f').replace(tzinfo=dt.timezone.utc)
by={}
for r in rows:
    r['t']=T(r['cycle_at_utc']);by.setdefault(r['symbol'],[]).append(r)
def fetch(sym):
    lo=min(r['t'] for r in by[sym]);st=int((lo.timestamp()-1800)*1000)
    url=f"https://open-api.bingx.com/openApi/swap/v3/quote/klines?symbol={sym}&interval=15m&startTime={st}&limit=1000"
    err=None
    for k in range(4):
        try:
            d=json.load(urllib.request.urlopen(url,timeout=20))
            if d.get('code')==0: return sym,sorted(d['data'],key=lambda x:x['time']),None
            err=str(d.get('msg'))
            if 'offline' in err or 'pause' in err or 'not exist' in err: break
            time.sleep(3)
        except Exception as e: err=str(e);time.sleep(2)
    return sym,[],err
kl={}
with cf.ThreadPoolExecutor(6) as ex:
    for s,d,e in ex.map(fetch,list(by)): kl[s]=(d,e)
json.dump(kl,open('kl.json','w'))
print(len(kl),sum(1 for v in kl.values() if not v[0]))
