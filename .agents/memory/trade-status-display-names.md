---
name: Trade status display names
description: Canonical user-facing names for every tracked trade status.
---

All user-facing dashboard, report, filter, and analytics labels use one canonical English vocabulary: `ACTIVE`, `IN RUN`, `ACCUMULATION`, `RE-ENTRY`, `PROFIT`, `STOP LOSS`, `BREAKEVEN`, `BE STOP`, `EXPIRED`, `CANCELLED`, and `RECLASSIFIED`. Never shorten these to `STOP`, `CANCEL`, or `BE`, and never render `breakeven` as `EXPIRED`.

**Why:** Mixed Russian and English labels and shortened variants made the same outcome look like different statuses and blurred the distinction between ordinary breakeven, protected BE stop, and lifetime expiration.

**How to apply:** Keep internal enum/API keys unchanged. Reuse the shared frontend status-label mapping instead of defining display strings inside pages or components.