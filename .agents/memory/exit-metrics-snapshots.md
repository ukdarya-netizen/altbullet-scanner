---
name: Exit metrics snapshots on signal close
description: How tracked_signals exit_* snapshot works and the full-metric-parity rule for growth_leader_log/overheat_log
---

# Exit metrics snapshots

- `tracked_signals` has 19 `exit_*` columns (OI 30m/1h/4h/24h, CVD 15m..4h, WI, spot/fut taker, spot netbuy 1h, spot vol 1h, spot/fut vol mult, FR, price 1h/24h, fut/spot ratio).
- Written by `_writeExitMetrics(id, symbol)` in watcher.ts — best-effort UPDATE from in-memory prescanTracker + FR cache (zero API calls, data up to ~14 min stale, nulls if token out of prescan).
- **Rule:** every code path that sets a final status (profit/stop_loss/cancelled/breakeven/bu_stop) MUST call `void _writeExitMetrics(...)` after the atomic claim — including admin routes (spot-audit bulk cancel in routes/tracker.ts). 20 call sites as of 2026-07-30.
- UPDATE predicate requires the row still be in a final status — protects against writing to reopened rows.
- **Why:** user demands FULL metric parity across all three analytics logs (growth_leader_log, overheat_log, signal history) — no "not enough data" gaps. New metric added to prescanTracker should be propagated to all three writers + `/api/tracker/signal-history` SELECT + signal-history UI.
- UI: sidebar "Аналитика" → /analytics page with 3 tabs (Лидеры роста / Перегретые / История сигналов), signal-history.tsx shows Вход→Выход comparison grid.
