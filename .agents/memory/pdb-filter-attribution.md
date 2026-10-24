---
name: PDB filter attribution
description: Evidence standard for distinguishing true gate-specific missed opportunities from repeated diagnostic rejects.
---

Treat Pattern Debug counts as repeated scanner checks, not independent missed
signals. A first-fail diagnostic label does not mean the candidate would pass
all other gates, reach delivery, or produce an executable profit if that gate
were relaxed. Match immutable decision-time metrics, subsequent candles,
existing open exposure, and later delivered signals before attributing a miss.

**Why:** A broad production replay showed many strong price moves after
diagnostic rejects, but most purported Price-Led Momentum 24h-cap rejects also
failed other entry conditions. Some PDB reason strings even contradict their
captured metrics (e.g. a count of four CVD confirmations labeled as below two),
so those labels cannot establish gate causality. Isolated Impulse Buy
spot-volume-above-2x rejects did include several distinct strong 24-hour
paths with no intervening tracked signal, but the mature cohort was too small
and included a sharp loss.

**How to apply:** Separate isolated single-gate rejects from compound reasons
and early-stage/waiting states. Count one business opportunity rather than
every scan, require sufficient post-decision 15-minute candle coverage, and
compare the first +10% touch with the first -10% touch; an intrabar high is
not a realized trade. Keep the Impulse Buy upper spot-volume gate unchanged
until a sufficiently large, independent and execution-aware forward cohort
confirms that relaxing it preserves acceptable downside.