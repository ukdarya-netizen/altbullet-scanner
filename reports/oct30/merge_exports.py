#!/usr/bin/env python3
"""Merge chunked production exports (read-only SQL results) into CSV files.
1) /tmp/rej/*.csv (export_rejected.sql, paged 250 rows) -> rejected_candidates.csv (+ flattened top-level entry_metrics keys as m_<key>)
2) /tmp/cancel.csv (export_cancel_reasons.sql) -> adds columns to signals_entry_snapshot.csv:
   cancel_reason, terminal_reason (= cancel_reason for cancelled/reclassified, otherwise the tracker status), was_cancelled_entry (да if status=cancelled else нет)
"""
import csv, glob, json, os
csv.field_size_limit(10**9)
HERE = os.path.dirname(os.path.abspath(__file__))

hdr, rows = None, []
for f in sorted(glob.glob("/tmp/rej/*.csv")):
    r = list(csv.reader(open(f, newline="")))
    if not r:
        continue
    hdr = hdr or r[0]
    assert r[0] == hdr, f
    rows += r[1:]
rows.sort(key=lambda x: int(x[0]))
assert len({x[0] for x in rows}) == len(rows)
idx = hdr.index("entry_metrics_json")
keys = []
parsed = []
for x in rows:
    try:
        d = json.loads(x[idx]) if x[idx] else {}
    except Exception:
        d = {}
    d = {k: (json.dumps(v) if isinstance(v, (dict, list)) else v) for k, v in d.items()}
    parsed.append(d)
    for k in d:
        if k not in keys:
            keys.append(k)
with open(os.path.join(HERE, "rejected_candidates.csv"), "w", newline="") as f:
    w = csv.writer(f)
    w.writerow(hdr + ["m_" + k for k in keys])
    for x, d in zip(rows, parsed):
        w.writerow(x + [d.get(k, "") for k in keys])
print("rejected rows", len(rows), "metric cols", len(keys))

canc = {r["id"]: r for r in csv.DictReader(open("/tmp/cancel.csv", newline=""))}
p = os.path.join(HERE, "signals_entry_snapshot.csv")
data = list(csv.DictReader(open(p, newline="")))
fields = [k for k in data[0].keys() if k not in ("cancel_reason", "terminal_reason", "was_cancelled_entry")]
out = []
for r in data:
    c = canc.get(r["id"])
    r["cancel_reason"] = c["cancel_reason"] if c else ""
    r["terminal_reason"] = c["cancel_reason"] if c else r["status"]
    r["was_cancelled_entry"] = "да" if r["status"] == "cancelled" else "нет"
    out.append(r)
# place the new columns right after status/peak block (after pnl_percent/closed_at) for readability
new = ["cancel_reason", "terminal_reason", "was_cancelled_entry"]
pos = fields.index("closed_at") + 1
cols = fields[:pos] + new + fields[pos:]
with open(p, "w", newline="") as f:
    w = csv.DictWriter(f, fieldnames=cols)
    w.writeheader()
    w.writerows(out)
print("snapshot rows", len(out), "cancelled", sum(r["was_cancelled_entry"] == "да" for r in out), "with reason", sum(bool(r["cancel_reason"]) for r in out))
