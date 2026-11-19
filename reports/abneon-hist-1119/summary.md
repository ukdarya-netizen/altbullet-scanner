# ABNeon historical study — A only

A signals: 145; unique symbols: 120.
Price outcomes on 15m OHLC within 96h: {"good":19,"bad":108,"open":17,"censored":1,"ambiguous":0}.
CoinGlass HTTP requests: 236; by endpoint: {"oi15":121,"fut15":33,"spot15":30,"fut1h":26,"spot1h":26}; 429: 1; five-minute pauses: 1.
Inputs: reports/abneon-snap-1119/events.csv, cached BingX 15m price bars, and cached/fetched CoinGlass history. 15m starts 24 hours before the earliest entry per symbol; series extend to 96 hours after the latest entry, capped at the present because future candles do not exist yet. 1H starts 120×4H before the earliest entry so both the 120-bar 1H and 120-bar 4H Lucy windows are available, and continues to the same end.
T0: lowest-low 15m candle from entry through the first +10% candle for a good outcome. If +10% and −6% occur inside the same 15m candle, the result is marked ambiguous.
Signals not yet at 96h without either threshold: 1; their observed history ends at the present and is not labeled as a completed open outcome.

## T0 by good signal

3790 ZEST-USDT T0=2026-11-13T04:15:00.000Z low=0.10492 +10=2026-11-13T11:45:00.000Z
3794 BARD-USDT T0=2026-11-12T13:00:00.000Z low=0.0834 +10=2026-11-12T16:30:00.000Z
3809 VELVET-USDT T0=2026-11-13T03:15:00.000Z low=0.04807 +10=2026-11-13T14:45:00.000Z
3824 ARIA-USDT T0=2026-11-12T18:45:00.000Z low=0.16936 +10=2026-11-12T19:15:00.000Z
3838 PONS-USDT T0=2026-11-13T05:00:00.000Z low=0.1445 +10=2026-11-13T06:45:00.000Z
3845 MARSCOIN-USDT T0=2026-11-13T05:00:00.000Z low=0.03752 +10=2026-11-13T07:45:00.000Z
3851 BILL-USDT T0=2026-11-13T05:30:00.000Z low=0.004205 +10=2026-11-14T00:00:00.000Z
3856 PRL-USDT T0=2026-11-13T06:00:00.000Z low=0.06878 +10=2026-11-13T12:15:00.000Z
3874 MEGA-USDT T0=2026-11-14T20:15:00.000Z low=0.04232 +10=2026-11-15T09:00:00.000Z
3886 PIEVERSE-USDT T0=2026-11-13T23:45:00.000Z low=1.6328 +10=2026-11-14T05:45:00.000Z
3888 ARX-USDT T0=2026-11-13T12:00:00.000Z low=0.2034 +10=2026-11-13T18:30:00.000Z
3898 STO-USDT T0=2026-11-13T18:00:00.000Z low=0.02706 +10=2026-11-13T18:15:00.000Z
3919 QNT-USDT T0=2026-11-15T02:00:00.000Z low=141.38 +10=2026-11-15T19:30:00.000Z
3920 VELVET-USDT T0=2026-11-15T02:00:00.000Z low=0.04595 +10=2026-11-16T14:30:00.000Z
3930 MELANIA-USDT T0=2026-11-16T13:15:00.000Z low=0.04482 +10=2026-11-18T03:30:00.000Z
3931 XNY-USDT T0=2026-11-15T08:45:00.000Z low=0.004327 +10=2026-11-16T18:15:00.000Z
3953 MMT-USDT T0=2026-11-17T14:30:00.000Z low=0.1152 +10=2026-11-17T16:30:00.000Z
3958 PIEVERSE-USDT T0=2026-11-18T00:00:00.000Z low=2.0512 +10=2026-11-18T10:00:00.000Z
3963 EVAA-USDT T0=2026-11-19T01:45:00.000Z low=3.7728 +10=2026-11-19T06:30:00.000Z

Detailed entry/T0 readings: t0.csv (152 rows). Full post-entry 15m paths for bad/open/censored/ambiguous: path15m.csv (48154 rows). Missing API values are blank; errors.json contains explicit unavailable reasons.
