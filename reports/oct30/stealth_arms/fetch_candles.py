import json,time,urllib.request,datetime as dt,concurrent.futures as cf
arms=json.load(open('arms.json'))
def ts(s): return dt.datetime.fromisoformat(s.replace('Z','+00:00'))
by={}
for a in arms: by.setdefault(a['symbol'],[]).append(a)
def fetch(sym):
    lo=min(ts(a['armed_at']) for a in by[sym]); st=int((lo.timestamp()-3600)*1000)
    url=f"https://open-api.bingx.com/openApi/swap/v3/quote/klines?symbol={sym}&interval=1h&startTime={st}&limit=1000"
    for t in range(4):
        try:
            d=json.load(urllib.request.urlopen(url,timeout=20))
            if d.get('code')==0: return sym,d['data'],None
            err=str(d.get('msg'))
            if d.get('code') in (100410,109400): time.sleep(3)
            else: break
        except Exception as e: err=str(e); time.sleep(2)
    return sym,[],err
res={}
with cf.ThreadPoolExecutor(6) as ex:
    for sym,data,err in ex.map(fetch,list(by)):
        res[sym]=(sorted(data,key=lambda x:x['time']),err)
json.dump({k:v for k,v in res.items()},open('klines_raw.json','w'))
print(len(res),sum(1 for v in res.values() if v[1]),sum(1 for v in res.values() if not v[0]))
