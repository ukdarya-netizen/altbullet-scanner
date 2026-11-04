---
name: Stealth BingX-only exception
description: Stealth BingX-only exception REVOKED 2026-10-14 (all patterns aggregated)
---
Stealth Breakout (both TFs) may fire without aggregated data ONLY when the token is confirmed BingX-only, and the Telegram message carries "BingX only". Volume gate uses BingX futures >=2x; OI/CVD/taker are not required.

**Why:** the owner asked (2026-10-06); "no CoinGlass data" is explicitly not proof. Confirmation = CoinGlass per-exchange futures+spot listing lists loaded OK, token on BingX futures, absent elsewhere, and no similar ticker (alias guard).
**How to apply:** MIRANETWORK on BingX is the same asset as MIRA elsewhere (same price), so it is NOT BingX-only; its CG failures come from the ticker alias, not exclusivity. Never extend this exception to other patterns.
