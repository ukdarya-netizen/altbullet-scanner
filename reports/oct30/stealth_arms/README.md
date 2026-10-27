Stealth auto_range_1h arms since 2026-10-01 (11499 arms, 931 symbols). Production, read-only.
- arms.csv: one row per arm. trigger_candle_at is stored in DB as the breakout candle CLOSE time; trigger_candle_open_utc = open time. + verdict_rows, verdicts_seq, last_verdict_reason, cutoff_shadow_rows.
- arm_verdicts.csv: all stealth_arm_verdict_log rows (11988). arm_cutoff_shadow.csv: all stealth_cutoff_shadow rows (1193).
- arms_candles_1h.csv.gz.partNN (concatenate parts, then gunzip): BingX 1H candles from the hour containing armed_at to armed_at+96h, closed candles only (978972 rows). Arms near 27.10 have fewer than 96h.
- arms_without_candles.csv: 311 arms on 46 symbols that BingX reports offline/paused, no klines returned.
- bulla_*.csv: raw rows for BULLA-USDT arms 45928, 46156, 47510 and stealth reject/decision rows 24-26.10.
- queries.sql: SQL used.
