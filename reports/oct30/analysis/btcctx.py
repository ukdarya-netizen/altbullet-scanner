import csv,collections,bisect
from datetime import datetime,timezone
csv.field_size_limit(10**9)
D='../'
B=[(datetime.strptime(r['open_time_utc'][:16],"%Y-%m-%d %H:%M").replace(tzinfo=timezone.utc).timestamp(),float(r['close']),float(r['high']),float(r['low'])) for r in csv.DictReader(open(D+'btc_15m.csv'))]
B.sort(); T=[b[0] for b in B]
def ctx(ts):
    i=bisect.bisect_right(T,ts-900)-1   # last candle closed by ts
    if i<96: return None
    c=B[i][1]
    ch=lambda n:(c/B[i-n][1]-1)*100
    hi24=max(b[2] for b in B[i-95:i+1])
    # EMA of 1h closes (every 4th)
    closes=[B[j][1] for j in range(i%4,i+1,4)][-200:]
    k=2/51; e=closes[0]
    for x in closes[1:]: e=x*k+e*(1-k)
    return dict(b1=ch(4),b4=ch(16),b24=ch(96),dd24=(c/hi24-1)*100,ema50=(c/e-1)*100)
