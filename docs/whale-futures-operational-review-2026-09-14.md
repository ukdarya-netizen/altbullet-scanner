# Whale Futures operational review — 2026-09-14

## Scope

This review covers the live `whale_watch` / Whale Futures v1 detector and its
three-stage decision boundary. No production publishing was performed.

## Production facts

- Whale Futures v1 has produced no fires.
- There are three recurring full candidates in the production evidence.
- GENSYN has 103 rejects for the missing final metric, with OI1h
  **6.209648** in the observed candidate.
- AEONBSC and OPENEDEN remain blocked because OI1h is above the permitted
  maximum of **7**.
- Generic stage-1 PDB counts are not unique trade opportunities. They describe
  stage progress and must not be counted as independent candidates.

## Operational resolution

The strict unavailable-taker fallback is now explicit. Every selected stage
must have an unavailable spot-taker metric, OI30m at least **5%**, and absolute
price movement no greater than **0.5%**. Only that all-three-stage path may
pass a missing `spotVolumeMcapPct` final coverage check. Normal taker-qualified
and mixed paths remain fail-closed when spot volume is missing. An available
spot-volume value below **1%** remains a rejection on every path.

The existing OI1h **1.5–7** range, CVD false veto, stage progression,
blacklist, thresholds, exits, cooldown, and delivery behavior are unchanged.
Decision telemetry records the evaluated stage path and whether the missing
spot-volume fallback was used, from the same values evaluated at decision time.
