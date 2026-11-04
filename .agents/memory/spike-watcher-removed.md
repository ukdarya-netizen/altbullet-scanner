---
name: Spike Watcher (Volume Spike) removed
description: Real-time 60s poller feature was fully deleted 2026-07-04 at user request; explains why spike-watcher.ts, getSpotTickers/getSpotKlines, broadcastRawAlertWithPhoto no longer exist.
---

The standalone real-time spike detector (`spike-watcher.ts`, polled all tickers every 60s independent of the 10-min main scanner cycle) was removed entirely at user request, including its call sites in `index.ts` (`startSpikeWatcher`/`stopSpikeWatcher`), its exclusive helper functions in `bingx.ts` (`getSpotTickers`, `getSpotKlines`, `BingXSpotTicker`), and `telegram.ts` (`broadcastRawAlertWithPhoto`).

**Why it caused confusion:** Spike Watcher fired signals using `sentimentKey: "volume_breakout_futures"` — but that exact sentimentKey string is *also* used by a completely unrelated, still-active main-scanner pattern (prescan-based, score/rank/growth gates, documented as pattern #13 in `scanner-patterns.ts`). Two independent detectors shared one label. The user's confusion ("bot analyzes spot tokens, but I meant checking spot volume") stemmed from not being able to tell, from the dashboard, which detector produced a given `volume_breakout_futures` signal.

**How to apply:** If a user asks about "volume breakout" signal behavior, first ask/check whether they mean the main scanner's prescan pattern (`volume_breakout_futures`/`volume_breakout_spot`/`volume_breakout_quiet`/`volume_breakout_mover` in `scanner.ts`/`scanner-patterns.ts`) — which is still live — since the old real-time Spike Watcher path no longer exists. Do not reintroduce a feature sharing an existing sentimentKey with another live pattern; use a distinct key to avoid this exact confusion again.
