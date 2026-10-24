---
name: flush_reversal timing fix — flushSeenAt
description: Why prevOi30m from CG candle[-2] caused 0 fires; how flushSeenAt tracker fixes it.
---

## Problem
`prevOi30m` comes from CG OHLC candle[-2] = the PREVIOUS completed 30m period.
With 10-min scan cycles, the detection window for a flush→rebound is too narrow:

- Period A (00:00–00:30): flush, OI = -0.8%. Scan at 00:25 → `lastOi30m = -0.8%`.
- Period B (00:30–01:00): recovery starts.
  - Scan at 00:35 (5 min in): `prevOi30m = -0.8%` ✅ but `lastOi30m = 0.3%` ❌ (`oi30m_low`)
  - By 01:00: OI = 2.5% — missed it
- Period C (01:00+): `prevOi30m = +2.5%` → precond fails

Result: 0 fires over 21 cycles. PDB stat `oi30m_low: 46` was the real current bottleneck (the large `prev_oi_not_flush: 2505` was historical data from before Variant A on 2026-07-20).

## Fix (Variant B, 2026-07-21)
Added `flushSeenAt: real` to `prescanTrackerTable` and `PrescanEntry`.

In the CG OI update loop (after `pe.lastOi30m = cg.oiChange30m`):
```typescript
if (pe.lastOi30m !== null && pe.lastOi30m <= -0.3) {
  pe.flushSeenAt = Date.now();
}
```

In `flush_reversal` precond:
```typescript
const _FLUSH_WINDOW_MS = 40 * 60 * 1000;
const _flushAge = _peFlush?.flushSeenAt != null ? Date.now() - _peFlush.flushSeenAt : Infinity;
const _flushPrecond = _flushAge < _FLUSH_WINDOW_MS;
```

This gives 4 scan cycles (~40 min) to detect the OI rebound instead of 1.

## ON CONFLICT for flushSeenAt
Uses null-safe GREATEST to avoid dual-process clobbering:
```sql
COALESCE(GREATEST(excluded.flush_seen_at, prescan_tracker.flush_seen_at), excluded.flush_seen_at, prescan_tracker.flush_seen_at)
```

**Why:** GREATEST(a, null) = null in PostgreSQL; COALESCE wrapper handles the null case, giving the max of two non-null timestamps.

## Files changed
- `lib/db/src/schema/signals.ts` — `flushSeenAt: real("flush_seen_at")` on prescanTrackerTable
- `artifacts/api-server/src/index.ts` — DDL ALTER TABLE in Part 1
- `artifacts/api-server/src/lib/scanner.ts` — PrescanEntry type, CG OI loop, savePrescanToDb, loadPrescanFromDb, flush_reversal precond, _liqPrecondLog
- Dev DB: direct `ALTER TABLE prescan_tracker ADD COLUMN IF NOT EXISTS flush_seen_at real`
