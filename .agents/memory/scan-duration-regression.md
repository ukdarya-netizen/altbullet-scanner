---
name: Scan duration regression — 42 min
description: Production scan cycle now takes ~42 min instead of expected 10-14 min; root cause TBD; risk to confirming-logic timing accuracy.
---

## Rule
Investigate scan duration regression AFTER oiWatch telemetry is confirmed working. Do not close this as resolved by oiWatch fix.

## Observed fact
From deployment logs (Jun 20, 2026): gap between `OI Universe Discovery: count=520` and `Next scan scheduled` = **~42 minutes** for a single scan cycle. Historical baseline was ~10-14 min for the same 520 tokens.

## Why it matters
- `confirming` cycle measures `drift4h` and `priceFromDetection` relative to the moment of token detection during the scan.
- If the scan takes 4× longer, tokens processed late in the loop see 30-40 extra minutes of real market movement attributed to "scan latency," not signal quality.
- This can cause false confirming-failures (price moved too fast → expired before watcher fires) or false confirming-passes (price held artificially long in window).

## Root cause analysis (Jun 25, 2026)

Three contributors identified from logs:

1. **Layer 8 (+100 tokens into inner loop)** — Layer 8 injects top-100 OI-24h CG leaders into usdtTickers each cycle. Inner loop was ~150 prescan tokens, now ~250. At ~7s/token avg = +700s = +12 min.

2. **BingX-exclusive CoinGlass retries** — For each symbol CG doesn't have (FIGHTID, GENSYN, NOMINA, KAIA, BLUR, etc.), the per-symbol `getCoinglassOI()` call tries "SYMBOL" → empty → 300ms wait → retry different key → "SYMBOLUSDT" → empty → 300ms wait → gives up. ~3.5s per BingX-exclusive token. 50-70 such tokens = +3-4 min.

3. **Neon connection timeouts** — "Authentication timed out", "Connection terminated" visible in logs. Each pg-pool reconnect adds several seconds. 10-15 reconnects per scan = +3-5 min.

## Symptoms seen in logs
- `Failed to save prescan tracker to DB: timeout exceeded when trying to connect`
- `CoinGlass OI: ошибка ответа — retry с другим ключом через 300ms` (FIGHTID, GENSYN, NOMINA, KAIA, FIDA, PIPPIN, RIVER…)
- `pg pool: idle client error (Neon closed connection) — pool will reconnect automatically`

## How to apply
Actionable quick wins (not yet implemented):
- Cache BingX-exclusive "no-data" symbols for 24h to skip CG retry overhead (~4 min saving)
- Reduce Layer 8 from top-100 → top-50 (~6 min saving)
