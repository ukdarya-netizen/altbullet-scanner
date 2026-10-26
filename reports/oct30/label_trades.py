#!/usr/bin/env python3
"""Read-only labelling of tracked signals by the trading-bot rule.

Input : signals_entry_snapshot.csv (export_signals.sql run on production, read-only)
Output: candles_15m_72h.csv, labels.csv, summary.csv, summary.txt

Rule (per signal): entry = entry_price_used, stop = stop_price.
  candles = BingX swap 15m klines whose open time >= detected_at (ceiling to 15m), 288 candles (72h).
  per candle in time order:
    hit_stop = low  <= stop
    hit_win  = high >= entry*1.05
    stop and win in same candle -> loss
  first candle with a hit decides. No hit in 72h -> censored.
  If fewer than 288 candles are available because 72h has not elapsed -> incomplete (excluded).
  Fee: 0.1% subtracted from every closed result.
  win  = +5% - 0.1
  loss = -(entry-stop)/entry*100 - 0.1
  censored: reported separately; also valued at the close of the last candle (mark-to-market) for one variant.
Split: per pattern, sorted by detected_at, first 70% by count vs last 30%.
"""
import csv, json, math, os, sys, time, urllib.request, urllib.parse
from datetime import datetime, timezone, timedelta
from collections import defaultdict

csv.field_size_limit(10**9)
HERE = os.path.dirname(os.path.abspath(__file__))
FEE = 0.1
WIN = 5.0
BARS = 288
MS15 = 900_000
NOW = datetime.now(timezone.utc)
URL = "https://open-api.bingx.com/openApi/swap/v3/quote/klines"
PATTERNS = ["neon_support_bounce", "stealth_breakout", "liquidation_cascade", "price_led_momentum", "impulse_buy"]


def parse_ts(s):
    return datetime.strptime(s[:19], "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc)


def fetch(symbol, start_ms):
    q = urllib.parse.urlencode({"symbol": symbol, "interval": "15m", "startTime": start_ms,
                                "endTime": start_ms + BARS * MS15 - 1, "limit": 1000})
    for attempt in range(4):
        try:
            with urllib.request.urlopen(f"{URL}?{q}", timeout=25) as r:
                j = json.load(r)
            if j.get("code") == 0:
                d = j.get("data") or []
                d = sorted({int(x["time"]): x for x in d}.values(), key=lambda x: int(x["time"]))
                return [(int(x["time"]), float(x["open"]), float(x["high"]), float(x["low"]), float(x["close"]), float(x["volume"])) for x in d], None
            err = f"code {j.get('code')} {j.get('msg')}"
        except Exception as e:  # noqa
            err = str(e)[:80]
        time.sleep(1.5 * (attempt + 1))
    return [], err


def main():
    rows = list(csv.DictReader(open(os.path.join(HERE, "signals_entry_snapshot.csv"), newline="")))
    cpath = os.path.join(HERE, "candles_15m_72h.csv")
    cache = defaultdict(list)
    if os.path.exists(cpath):
        for r in csv.DictReader(open(cpath, newline="")):
            cache[r["id"]].append((int(r["open_time_ms"]), float(r["open"]), float(r["high"]), float(r["low"]), float(r["close"]), float(r["volume"])))
    errs = {}
    for i, r in enumerate(rows):
        if r["id"] in cache:
            continue
        det = parse_ts(r["detected_at"])
        start = math.ceil(det.timestamp() * 1000 / MS15) * MS15
        c, e = fetch(r["symbol"], start)
        cache[r["id"]] = c
        if e and not c:
            errs[r["id"]] = e
        if i % 100 == 0:
            print("fetched", i, file=sys.stderr)
        time.sleep(0.05)
    with open(cpath, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["id", "pattern", "symbol", "open_time_ms", "open_time_utc", "open", "high", "low", "close", "volume"])
        byid = {r["id"]: r for r in rows}
        for r in rows:
            for t, o, h, l, c, v in cache[r["id"]]:
                w.writerow([r["id"], r["pattern"], r["symbol"], t, datetime.fromtimestamp(t / 1000, timezone.utc).strftime("%Y-%m-%d %H:%M"), o, h, l, c, v])

    out = []
    for r in rows:
        entry = float(r["entry_price_used"]) if r["entry_price_used"] else None
        stop = float(r["stop_price"]) if r["stop_price"] else None
        det = parse_ts(r["detected_at"])
        cs = cache[r["id"]]
        res = dict(id=r["id"], pattern=r["pattern"], symbol=r["symbol"], detected_at=r["detected_at"], status=r["status"],
                   entry=entry, stop=stop, stop_src=r["stop_src"], label="", net_pct="", hit_time="", candles=len(cs), mtm_pct="")
        if entry is None or entry <= 0:
            res["label"] = "no_entry"
        elif stop is None or stop <= 0 or stop >= entry:
            res["label"] = "no_stop"
        elif not cs:
            res["label"] = "no_candles"
        else:
            target = entry * (1 + WIN / 100)
            loss_pct = -(entry - stop) / entry * 100 - FEE
            for t, o, h, l, c, v in cs:
                hs, hw = l <= stop, h >= target
                if hs or hw:
                    res["hit_time"] = datetime.fromtimestamp(t / 1000, timezone.utc).strftime("%Y-%m-%d %H:%M")
                    if hs:  # stop first, or both in same candle -> loss
                        res["label"], res["net_pct"] = "loss", loss_pct
                    else:
                        res["label"], res["net_pct"] = "win", WIN - FEE
                    break
            else:
                full = len(cs) >= BARS - 1 and (det + timedelta(hours=72)) <= NOW
                if full:
                    res["label"] = "censored"
                    res["mtm_pct"] = (cs[-1][4] / entry - 1) * 100 - FEE
                else:
                    res["label"] = "incomplete"
        out.append(res)
    with open(os.path.join(HERE, "labels.csv"), "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(out[0].keys()))
        w.writeheader()
        w.writerows(out)

    lines = []

    def stat(rs):
        n_lab = [x for x in rs if x["label"] in ("win", "loss", "censored")]
        win = sum(x["label"] == "win" for x in n_lab)
        loss = sum(x["label"] == "loss" for x in n_lab)
        cen = sum(x["label"] == "censored" for x in n_lab)
        wl = [x["net_pct"] for x in n_lab if x["label"] != "censored"]
        e_wl = sum(wl) / len(wl) if wl else float("nan")
        e_cen0 = sum(wl) / len(n_lab) if n_lab else float("nan")  # censored = 0
        mt = wl + [x["mtm_pct"] for x in n_lab if x["label"] == "censored"]
        e_mtm = sum(mt) / len(mt) if mt else float("nan")
        other = defaultdict(int)
        for x in rs:
            if x["label"] not in ("win", "loss", "censored"):
                other[x["label"]] += 1
        return dict(n_total=len(rs), n=len(n_lab), win=win, loss=loss, censored=cen,
                    exp_win_loss_only=round(e_wl, 3), exp_censored_as_0=round(e_cen0, 3), exp_censored_mtm72h=round(e_mtm, 3),
                    excluded=json.dumps(dict(other)))

    srows = []
    for p in PATTERNS:
        rs = sorted([x for x in out if x["pattern"] == p], key=lambda x: (x["detected_at"], int(x["id"])))
        k = int(round(len(rs) * 0.7))
        for name, sub in (("all", rs), ("first70", rs[:k]), ("last30", rs[k:])):
            s = stat(sub)
            s.update(pattern=p, part=name, from_=sub[0]["detected_at"] if sub else "", to=sub[-1]["detected_at"] if sub else "")
            srows.append(s)
    keys = ["pattern", "part", "from_", "to", "n_total", "n", "win", "loss", "censored", "exp_win_loss_only", "exp_censored_as_0", "exp_censored_mtm72h", "excluded"]
    with open(os.path.join(HERE, "summary.csv"), "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=keys)
        w.writeheader()
        w.writerows({k: s[k] for k in keys} for s in srows)
    for s in srows:
        lines.append(" | ".join(f"{k}={s[k]}" for k in keys))
    open(os.path.join(HERE, "summary.txt"), "w").write("\n".join(lines) + "\n")
    print("\n".join(lines))
    print("fetch errors:", len(errs), file=sys.stderr)
    if errs:
        json.dump(errs, open(os.path.join(HERE, "fetch_errors.json"), "w"))


if __name__ == "__main__":
    main()
