---
name: Unlock list endpoint outage blocks every pattern
description: The no-fail-open unlock gate refuses all symbols when the CoinGlass unlock list is unavailable; the old path 404'd silently under fail-open.
---

The CoinGlass unlock list lives at `/api/coin/unlock-list?per_page=1000` (fields `next_unlock_date`, `next_unlock_of_supply`). The old path `/api/coin-unlock-list` returns 404 and was hidden while the gate was fail-open.

**Why:** after unlock became no-fail-open (2026-10-18), the 404 refused ~375 symbols per cycle before any pattern ran; Stealth arm evaluation stopped for ~10h (scan_reject_log stealth rows fell from ~500/h to 2/h).

**How to apply:** when signals/arm updates suddenly vanish, check `scan_reject_log` for `gate/unlock_data_unavailable` first. Any new no-fail-open gate needs its endpoint verified live (HTTP 200 + parsed rows) before deploy.

## Admin alerts chat
TELEGRAM_CHAT_ID in prod holds a username, so `sendMessage` returned "chat not found" and all admin health alerts (incl. the >30 min unlock alert) were lost. Admin alerts now use the numeric operational chat (OWNER_CHAT_ID or default). **How to apply:** an alert that logs "request finished" is not proof of delivery; check `ok` / description in the egress log.
