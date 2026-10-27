"""LC exits on the best entry rule (size>=5.6%, red body>=3.5%, liquidations exhausted): totals per half.
Needs WORK/lc_candles.csv (restore: cat ../lc_watches/watch_candles.csv.gz.part* | gunzip > work/lc_candles.csv)."""
import csv,collections,os
csv.field_size_limit(10**9)
S=os.environ.get('WORK','work/')
W={r['id']:r for r in csv.DictReader(open('../lc_watches/watches.csv'))}
C=collections.defaultdict(list)
for r in csv.DictReader(open(S+'lc_candles.csv')):
    C[r['id']].append((float(r['open']),float(r['high']),float(r['low']),float(r['close'])))
def ex(after,e,act,gap,frac):
    stop=e*0.9; peak=e; part=0; rem=1; tp=False
    for o,h,l,c in after:
        if l<=stop: return part+rem*((stop/e-1)*100)-0.1
        if frac==1 and h>=e*1.1: return 9.9
        peak=max(peak,h); pp=(peak/e-1)*100
        if pp>=10 and not tp: tp=True; part+=frac*10; rem=1-frac; stop=max(stop,e)
        if tp and pp>=act: stop=max(stop,e*(1+(pp-gap)/100))
    return part+rem*((after[-1][3]/e-1)*100)-0.1
for i,w in list(W.items()):
    pass
data=[]
for i,w in W.items():
    cs=C.get(i,[])
    if len(cs)<270: continue
    o,h,l,c=cs[0]
    rng=(h-l)/o*100; body=(c-o)/o*100
    if rng>=5.6 and body<=-3.5 and w['liq_exhausted'].lower() in('t','true','1'):
        data.append((w['detected_at'],cs[1:],c))
for frac,act,gap in ((1,0,0),(0.5,15,10),(0.5,30,20),(0.5,40,20)):
    a=sum(ex(x[1],x[2],act,gap,frac) for x in data if x[0]<'2026-10-15'); b=sum(ex(x[1],x[2],act,gap,frac) for x in data if x[0]>='2026-10-15')
    print(f"close {int(frac*100)}% at +10%, trail from +{act}% gap {gap}pp: before 15.10 {a:+.0f}% | from 15.10 {b:+.0f}% | n={len(data)}")
