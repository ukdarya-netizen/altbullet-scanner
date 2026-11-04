# Stealth Breakout production review — 2026-09-14

## Production facts

The production investigation found **165 live `status='armed'` rows**, of
which **48 were stale** before the global TTL cleanup. The old “0 pending”
observation was a query interpretation error: it counted the wrong table and
status, rather than the durable Stealth arm rows.

The CHR evidence snapshot was:

- frozen level: **0.0163**
- ABNeon nearest resistance: **0.01686**
- trigger close: **0.01672**
- volume ratio: **0.993**
- turnover: **$224k**

ROSE had a volume ratio of **1.023** and turnover of **$418k**.

Only **12 current fired volume-shadow rows** were found, and **2 were closed**;
both closed outcomes were favorable. The higher-ABNeon/not-cleared group
included API3 profit, while BLESS and COTI were protected. The evidence does
not justify introducing a hybrid or volume gate now.

## Fixes and evidence boundary

The scanner now performs an unfiltered global sweep before market filtering.
Expired `armed` rows are terminalized as `expired` with
`terminal_reason='arm_ttl_elapsed'`, evaluated-at decision metadata, and
merged decision JSON. The sweep reports armed, qualified, and firing counts;
the scanner logs the sweep whenever any count is non-zero. This prevents an
out-of-universe symbol from retaining a partial-unique active-arm slot.

For a newly-created normal quiet-zone Stealth arm, the service also stores an
immutable event-time ABNeon/AltBullet nearest-resistance comparison. Only
closed 4H and 1H candles visible at capture time are used. Missing coverage
and detector errors are preserved as observational evidence. The snapshot is
**shadow-only**: it cannot affect `allowCreate`, the selected breakout level,
confirmation, signal eligibility, pattern key, exits, Telegram, or any live
gate. Continuation-shelf rows do not require this snapshot.
