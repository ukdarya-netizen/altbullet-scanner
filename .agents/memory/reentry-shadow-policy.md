---
name: Re-entry shadow policy
description: Durable boundary for user-facing re-entry, health observations, and cancellation independence.
---

Re-entry is observation-only. A qualifying candidate must not send Telegram, create an outbox item, increment a live re-entry count, reset peaks/timestamps, or otherwise mutate the tracked trade lifecycle.

**Why:** the old message recommended an additional trade without separately measuring that trade. Recovery of the original position is not evidence that an extra entry had positive expected value.

**How to apply:** persist source/version-aware immutable candidates with the exact proposed price and observation time. Measure direction-aware outcomes from that price at strict +4h/+8h/+24h windows. Reconsider delivery only after at least 20 observed 24h candidates, split by pattern and source.

FOLLOW/HOLD/EXIT remain Telegram-disabled while their classifier observations and outcome telemetry continue. Their disabled path must never skip smart-cancel, EXPIRED, or technical lifecycle processing.

**Why:** observation is useful for calibration, but unproven advice should not create user actions or alter existing cancellation behavior.

**How to apply:** gate only egress, not evaluation/backfill or the rest of the watcher iteration. Keep stale cancellation disabled and preserve dedicated smart, max-age, and technical policies independently.