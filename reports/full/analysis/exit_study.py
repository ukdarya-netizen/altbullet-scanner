"""Exit variants for LC (current live candle rule) and IB (current live gate) on our data.
LC: lc_watches (oct30 + full), detection 15m candle: range>=5.6%, body -5.5..-3.5%; entry = its close; stop -10%.
IB: impulse_buy signals (oct30 + full snapshots), gate oi30m>=0.26% and long liq 24h>=$47k; entry = entry_price_used; stop -8%.
15m candles, 72h, stop first in a candle, fee 0.1%. Remaining part closed at the 72h close.
Run: python3 reports/full/analysis/exit_study.py  (needs /tmp/lc_old.csv: cat reports/oct30/lc_watches/watch_candles.csv.gz.part* | gunzip)"""
import csv, gzip, os, collections, sys
csv.field_size_limit(10**9)
R = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..")
def f(v):
    try: return float(v)
    except: return None

# ---------- exits ----------
def run(after, e, stop_pct, v):
    stop = e * (1 - stop_pct / 100); peak = e; done = 0.0; rem = 1.0; hit = set()
    for o, h, l, c in after:
        if l <= stop:
            return done + rem * ((stop / e - 1) * 100) - 0.1
        peak = max(peak, h); pp = (peak / e - 1) * 100
        for lvl, frac in v.get("parts", []):
            if lvl not in hit and pp >= lvl:
                hit.add(lvl); take = min(frac, rem); done += take * lvl; rem -= take
        if rem <= 1e-9: return done - 0.1
        if v.get("be") is not None and pp >= v["be"]: stop = max(stop, e)
        if v.get("lock") and pp >= v["lock"][0]: stop = max(stop, e * (1 + v["lock"][1] / 100))
        if v.get("trail") and pp >= v["trail"][0]: stop = max(stop, e * (1 + (pp - v["trail"][1]) / 100))
    return done + rem * ((after[-1][3] / e - 1) * 100) - 0.1

V = {
 "все на +5":               {"parts": [(5, 1)]},
 "все на +10":              {"parts": [(10, 1)]},
 "все на +15":              {"parts": [(15, 1)]},
 "все на +20":              {"parts": [(20, 1)]},
 "трекер сейчас: БУ+5, на +10 стоп +5, трейл с +15 на 10":  {"be": 5, "lock": (10, 5), "trail": (15, 10)},
 "БУ+8, трейл с +15 на 10": {"be": 8, "trail": (15, 10)},
 "БУ+5, трейл с +10 на 5":  {"be": 5, "trail": (10, 5)},
 "50% на +10, БУ, трейл с +15 на 10": {"parts": [(10, .5)], "be": 10, "trail": (15, 10)},
 "50% на +10, БУ, трейл с +20 на 10": {"parts": [(10, .5)], "be": 10, "trail": (20, 10)},
 "50% на +10, БУ, трейл с +30 на 15": {"parts": [(10, .5)], "be": 10, "trail": (30, 15)},
 "50% на +10, стоп +5, трейл с +20 на 10": {"parts": [(10, .5)], "lock": (10, 5), "trail": (20, 10)},
 "30% +10, 30% +20, БУ, трейл с +25 на 10": {"parts": [(10, .3), (20, .3)], "be": 10, "trail": (25, 10)},
}

def report(name, data, stop_pct):
    data.sort(key=lambda x: x[0])
    n = len(data); k = n // 3
    days = len(set(d[0][:10] for d in data))
    print(f"\n===== {name}: сделок {n}, дней {days}, период {data[0][0][:10]}..{data[-1][0][:10]}, стоп -{stop_pct}%")
    pk = [(max(h for _, h, _, _ in a) / e - 1) * 100 for _, a, e in data]
    print(f"   пик >=+10%: {sum(p>=10 for p in pk)}, >=+20%: {sum(p>=20 for p in pk)}, >=+40%: {sum(p>=40 for p in pk)}")
    print(f"   {'выход':48} {'ср.%':>6} {'сумма':>7} {'1/3':>7} {'2/3':>7} {'3/3':>7} {'без лучш.дня':>12} {'сделок>=+10':>11}")
    for vn, v in V.items():
        res = [(d[0], run(d[1], d[2], stop_pct, v)) for d in data]
        s = sum(r for _, r in res)
        thirds = [sum(r for _, r in res[i*k:(i+1)*k if i < 2 else n]) for i in range(3)]
        byd = collections.defaultdict(float)
        for t, r in res: byd[t[:10]] += r
        best = max(byd.values())
        print(f"   {vn:48} {s/n:+6.2f} {s:+7.0f} {thirds[0]:+7.0f} {thirds[1]:+7.0f} {thirds[2]:+7.0f} {s-best:+12.0f} {sum(r>=9.9 for _, r in res):11}")

# ---------- LC ----------
def load_candles(path, gz=False):
    C = collections.defaultdict(list)
    op = gzip.open(path, "rt") if gz else open(path)
    with op as fh:
        for r in csv.DictReader(fh):
            C[r["id"]].append((int(r["open_time_ms"]) if "open_time_ms" in r else 0, float(r["open"]), float(r["high"]), float(r["low"]), float(r["close"])))
    return {i: [x[1:] for x in sorted(v)] for i, v in C.items()}

W = {}
for p in (os.path.join(R, "oct30/lc_watches/watches.csv"), os.path.join(R, "full/lc_watches/watches.csv")):
    for r in csv.DictReader(open(p)): W[r["id"]] = r
LC = load_candles("/tmp/lc_old.csv"); LC.update(load_candles(os.path.join(R, "full/lc_watches/watch_candles_new.csv.gz"), gz=True))
lc = []
for i, w in W.items():
    cs = LC.get(i)
    if not cs or len(cs) < 270: continue
    o, h, l, c = cs[0]
    rng = (h - l) / o * 100; body = (c - o) / o * 100
    if rng >= 5.6 and -5.5 <= body <= -3.5:
        lc.append((w["detected_at"], cs[1:], c))
report("LC (живое правило свечи)", lc, 10)
report("LC без 15.10", [d for d in lc if not d[0].startswith("2026-10-15")], 10)

# ---------- IB ----------
S = {}
for p in (os.path.join(R, "oct30/signals_entry_snapshot.csv"), os.path.join(R, "full/signals_entry_snapshot.csv")):
    for r in csv.DictReader(open(p)):
        if r["pattern"] == "impulse_buy": S[r["id"]] = r
SC = load_candles(os.path.join(R, "oct30/candles_15m_72h.csv")); SC.update(load_candles(os.path.join(R, "full/signal_candles_new.csv.gz"), gz=True))
ib_all, ib = [], []
for i, s in S.items():
    cs = SC.get(i); e = f(s["entry_price_used"])
    if not cs or len(cs) < 270 or not e: continue
    d = (s["detected_at"], cs, e)
    ib_all.append(d)
    oi, lq = f(s["entry_oi_30m"]), f(s["entry_liq_long24h"])
    if oi is not None and lq is not None and oi >= 0.26 and lq >= 47000: ib.append(d)
report("IB все сигналы", ib_all, 8)
report("IB с живым гейтом (OI30м>=0.26, ликв.лонгов 24ч>=47k)", ib, 8)
