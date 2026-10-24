---
name: CoinGlass OI collision check false positives
description: Why CoinGlass OI became "unavailable" for ~35% of tokens from 2026-10-01 and what Impulse Buy does about it.
---
The CoinGlass-vs-BingX OI magnitude check (OI_MISMATCH_RATIO=30) discards legit CoinGlass OI as a "ticker collision" when BingX holds a small share of global OI. Live ratios on 2026-10-05: ENA 36, DOT 48, STRK 133, VVV 138, ADA 96 (CoinGlass itself answers 200 for them). Prod logs were not accessible, so this is a strong correlation, not a log-proven cause.
**Why:** Impulse Buy showed 0 signals for 2+ days; oi30m_unavailable grew 0%→12%→31–38% of decisions from 10-01.
**How to apply:** Owner rejected BingX-only OI. Collision check now accepts a large CG/BingX ratio if CoinGlass OI is within 5x of Coinalyze aggregate OI (verdict cached 6h; Coinalyze unavailable → still rejected). Missing CG OI30m falls to Coinalyze for all patterns and Impulse Buy (oi30mSource). Coinalyze free quota ~100 req/day/key is the limit.
