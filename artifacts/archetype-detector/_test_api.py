import sys, os, time
sys.path.insert(0, '.')
os.environ['PYTHONUNBUFFERED'] = '1'

import logging
logging.basicConfig(level=logging.WARNING)

from pipeline import cg_client

def test(label, endpoint, params):
    d = cg_client.cg_get(endpoint, params)
    t = type(d).__name__
    n = len(d) if isinstance(d, list) else '-'
    s = d[0] if (isinstance(d, list) and d) else d
    print(f"[{label}] type={t} len={n}")
    print(f"  sample: {str(s)[:200]}")
    time.sleep(0.3)

test("OI 30m",  '/api/futures/open-interest-history',
     {'exchange':'Binance','symbol':'BTCUSDT','interval':'30m','limit':4})

test("OI 1h",  '/api/futures/open-interest-history',
     {'exchange':'Binance','symbol':'ETHUSDT','interval':'1h','limit':4})

test("OI 4h",  '/api/futures/open-interest-history',
     {'exchange':'Binance','symbol':'ETHUSDT','interval':'4h','limit':4})

pairs = cg_client.cg_get('/api/futures/supported-exchange-pairs', {'exchange':'Binance'})
if isinstance(pairs, list):
    print(f"[Pairs] total={len(pairs)}")
    print(f"  keys: {list(pairs[0].keys()) if pairs else []}")
    print(f"  sample: {pairs[:2]}")
else:
    print(f"[Pairs] {pairs}")
