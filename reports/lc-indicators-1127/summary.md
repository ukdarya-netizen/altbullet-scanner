# LC indicators 2026-11-27

As of 2026-11-27T16:00:00.000Z (last closed BingX 15m candle). Current candle gate applied retrospectively at readiness.

## Source and cohort
- Production access was read-only; no application server started and no schema or database writes were made.
- Cohort: non-BTC `liq_cascade_watch` observations and fired LC signals from 2026-11-01 through the run time; only current-gate passes are in `events.csv`.
- Input candidates: 4117; gate outcomes: detection_candle_too_small=3860, pass=171, detection_candle_no_rebound=81, detection_candle_unavailable=5; included after gate/entry validation: 171.
- A entries use recorded tracked-signal entry; B entries use close after the rebound candle at gate readiness.
- 72h outcome: +10% before −10% = champion; −10% before +10% = bad; neither = open; both in one candle = ambiguous.

## Production SQL and row counts
See `run.txt` for exact read-only SQL and snapshot counts.
- cohort before the candle gate: 4,117 watch rows and 13 fired signals; delta exports: 118 watch rows and 2 signal rows.
- other SELECT exports: 681 grouped historical watch-symbol rows since 2026-07-14, 640 historical LC signal rows, 16 stop-bid observations, and 0 heatmap snapshots.
- follow-up read-only status SELECT at 2026-11-27 16:26Z: watches `expired=3863, fired=13, watching=275` (4,151 total); tracked signals `active=1, in_run=1, profit=3, stop_loss=5, bu_stop=1, reclassified=2` (13 total). This later count is not part of the frozen 16:00Z study cohort.
- report CSV data rows: events=171; thresholds=742; combinations=10; missing metric cells=5,859.
- `cg_liq_heatmap_snapshot`: 0 rows, so historical liquidation-map levels cannot be reconstructed.

## Outcomes by period
2026-11-01..11: total=105; champion=29; bad=42; open=33; ambiguous=1
2026-11-12..26: total=63; champion=27; bad=32; open=4; ambiguous=0
2026-11-27+_partial: total=3; champion=1; bad=0; open=2; ambiguous=0
- Overall included outcomes: champion=57, bad=74, open=39, ambiguous=1.

## Full named outcome spread
### champion (57)
EVAA-USDT@2026-11-01T02:51:06.464Z#watch-8552, JCT-USDT@2026-11-02T08:18:20.948Z#watch-8777, ARIA-USDT@2026-11-02T09:27:18.803Z#watch-8805, UAI-USDT@2026-11-03T01:17:06.891Z#watch-8998, BMT-USDT@2026-11-03T13:27:38.683Z#watch-9083, IDOL-USDT@2026-11-03T16:17:04.726Z#watch-9099, CLANKER-USDT@2026-11-04T02:15:24.925Z#watch-9145, PARTI-USDT@2026-11-04T02:15:24.925Z#watch-9160, IDOL-USDT@2026-11-04T06:07:51.240Z#watch-9377, AIO-USDT@2026-11-05T09:43:35.496Z#watch-9419, AKE-USDT@2026-11-05T09:43:35.496Z#watch-9403, 4STOCK-USDT@2026-11-05T15:07:51.031Z#watch-9526, STAR-USDT@2026-11-05T15:07:51.031Z#watch-9540, VELVET-USDT@2026-11-05T15:07:51.031Z#watch-9525, AIN-USDT@2026-11-06T05:00:52.290Z#watch-9840, CYBER-USDT@2026-11-06T05:00:52.290Z#watch-9826, NULLMASK-USDT@2026-11-06T13:23:25.722Z#watch-9883, ONE-USDT@2026-11-07T02:54:11.223Z#watch-9949, ACT-USDT@2026-11-07T11:26:55.677Z#watch-10016, IDOL-USDT@2026-11-07T16:53:49.484Z#watch-10052, UAI-USDT@2026-11-08T04:25:06.366Z#watch-10152, TA-USDT@2026-11-08T10:57:27.907Z#watch-10195, AIOT-USDT@2026-11-08T15:54:26.389Z#watch-10277, AIO-USDT@2026-11-08T16:52:13.405Z#watch-10294, AIA-USDT@2026-11-08T22:27:32.610Z#watch-10605, JASMY-USDT@2026-11-08T22:27:32.610Z#watch-10613, SQD-USDT@2026-11-08T22:27:32.610Z#watch-10557, USELESS-USDT@2026-11-08T22:27:32.610Z#watch-10499, CAP-USDT@2026-11-10T14:40:01.789Z#watch-10877, TA-USDT@2026-11-12T17:27:21.209Z#watch-11159, BTW-USDT@2026-11-13T05:07:23.486Z#signal-3848, AKE-USDT@2026-11-15T03:57:20.160Z#watch-11461, TAC-USDT@2026-11-15T08:56:11.323Z#watch-11470, ARIA-USDT@2026-11-15T11:46:33.397Z#watch-11477, RARE-USDT@2026-11-16T02:51:46.943Z#watch-11527, CASHCAT-USDT@2026-11-16T03:42:24.020Z#watch-11531, ALLO-USDT@2026-11-17T02:52:58.155Z#watch-11584, ANSEM-USDT@2026-11-17T16:46:14.889Z#watch-11686, BREV-USDT@2026-11-17T19:16:37.045Z#watch-11691, CROSS-USDT@2026-11-18T02:47:25.451Z#watch-11707, PIPPIN-USDT@2026-11-18T07:47:27.671Z#watch-11722, ZKC-USDT@2026-11-18T08:20:14.466Z#watch-11724, NAORIS-USDT@2026-11-19T08:00:20.774Z#signal-3970, PROM-USDT@2026-11-20T16:48:37.523Z#watch-12141, PHAROS-USDT@2026-11-21T00:59:21.213Z#watch-12148, BR-USDT@2026-11-21T03:52:51.655Z#signal-3980, JCT-USDT@2026-11-21T05:26:04.829Z#watch-12185, ARIA-USDT@2026-11-22T13:50:42.243Z#watch-12227, FLUX-USDT@2026-11-23T05:50:58.603Z#watch-12249, DOS-USDT@2026-11-23T12:25:03.835Z#watch-12254, SKYAI-USDT@2026-11-24T10:19:23.806Z#watch-12324, BLESS-USDT@2026-11-24T13:57:42.567Z#watch-12392, MMT-USDT@2026-11-24T14:53:35.898Z#watch-12400, WAXP-USDT@2026-11-25T04:24:24.059Z#watch-12472, EVAA-USDT@2026-11-25T07:18:04.025Z#watch-12475, ARIA-USDT@2026-11-25T14:13:18.497Z#signal-4011, CASHCAT-USDT@2026-11-27T03:44:05.945Z#watch-12580
### bad (74)
XPL-USDT@2026-11-01T04:51:22.308Z#watch-8562, ZKP-USDT@2026-11-01T10:23:31.076Z#watch-8579, US-USDT@2026-11-01T15:58:43.931Z#watch-8606, UAI-USDT@2026-11-01T16:54:28.755Z#watch-8619, 4STOCK-USDT@2026-11-02T06:27:26.766Z#watch-8736, SOPH-USDT@2026-11-02T09:27:18.803Z#watch-8797, IDOL-USDT@2026-11-02T11:47:16.819Z#watch-8821, AKE-USDT@2026-11-02T16:04:30.208Z#watch-8860, NULLMASK-USDT@2026-11-02T16:04:30.208Z#watch-8836, IDOL-USDT@2026-11-03T00:19:30.025Z#watch-8971, AGT-USDT@2026-11-03T18:35:44.774Z#watch-9101, AKE-USDT@2026-11-03T18:35:44.774Z#watch-9103, Q-USDT@2026-11-03T18:35:44.774Z#watch-9110, JCT-USDT@2026-11-05T09:43:35.496Z#watch-9402, UAI-USDT@2026-11-05T09:43:35.496Z#watch-9391, AIN-USDT@2026-11-05T10:04:08.077Z#watch-9436, CLAUDIA-USDT@2026-11-06T05:00:52.290Z#watch-9866, BLESS-USDT@2026-11-06T13:23:25.722Z#watch-9885, ZIL-USDT@2026-11-06T16:45:43.698Z#watch-9891, UAI-USDT@2026-11-06T22:26:04.797Z#watch-9941, AIN-USDT@2026-11-07T16:53:49.484Z#watch-10055, STAR-USDT@2026-11-07T16:53:49.484Z#watch-10053, LYN-USDT@2026-11-08T04:25:06.366Z#watch-10155, TRUST-USDT@2026-11-08T06:50:55.935Z#watch-10170, HOT-USDT@2026-11-08T10:57:27.907Z#watch-10196, STONK-USDT@2026-11-08T13:27:44.903Z#watch-10219, AGT-USDT@2026-11-08T14:23:36.273Z#watch-10251, JCT-USDT@2026-11-08T14:23:36.273Z#watch-10256, Q-USDT@2026-11-08T14:23:36.273Z#watch-10239, SI-USDT@2026-11-08T15:45:21.156Z#watch-10276, Q-USDT@2026-11-09T02:29:56.699Z#watch-10680, HANA-USDT@2026-11-09T04:52:27.211Z#watch-10700, AIOT-USDT@2026-11-09T06:54:57.598Z#watch-10720, AIN-USDT@2026-11-09T09:51:42.794Z#watch-10766, ZIL-USDT@2026-11-09T12:25:51.196Z#watch-10786, PROM-USDT@2026-11-09T19:48:55.059Z#watch-10804, WAVES-USDT@2026-11-10T11:18:43.799Z#watch-10837, KIMCHI-USDT@2026-11-10T13:57:54.836Z#watch-10875, 4STOCK-USDT@2026-11-10T15:39:47.411Z#watch-10879, ZEC-USDT@2026-11-10T15:39:47.411Z#watch-10883, BULLA-USDT@2026-11-11T02:26:32.695Z#watch-10938, OPG-USDT@2026-11-11T15:27:16.287Z#watch-10948, ASTR-USDT@2026-11-12T13:12:30.217Z#watch-11108, AGRIPPA-USDT@2026-11-13T03:19:00.736Z#watch-11174, BIRB-USDT@2026-11-13T03:19:00.736Z#watch-11173, IMX-USDT@2026-11-13T03:19:00.736Z#watch-11176, APEX-USDT@2026-11-13T08:44:49.623Z#watch-11257, AIA-USDT@2026-11-14T07:17:06.993Z#watch-11369, ONE-USDT@2026-11-15T09:21:41.565Z#watch-11473, INIT-USDT@2026-11-15T09:25:50.782Z#watch-11474, BTW-USDT@2026-11-15T15:42:39.451Z#watch-11499, CFG-USDT@2026-11-18T17:10:45.261Z#watch-11774, IRYS-USDT@2026-11-19T02:17:18.803Z#watch-11795, SENT-USDT@2026-11-19T04:14:48.372Z#watch-11798, DCTY-USDT@2026-11-19T07:11:09.979Z#watch-11800, US-USDT@2026-11-19T07:11:09.979Z#watch-11799, ARIA-USDT@2026-11-19T10:19:29.969Z#watch-11810, APEX-USDT@2026-11-19T17:10:02.497Z#watch-11842, MIHAO-USDT@2026-11-19T22:16:58.822Z#watch-11870, BARD-USDT@2026-11-20T03:12:12.537Z#watch-11922, KERNEL-USDT@2026-11-20T11:25:05.409Z#watch-11940, CARV-USDT@2026-11-20T11:54:47.897Z#watch-11941, DOS-USDT@2026-11-20T12:23:19.566Z#watch-11952, BLESS-USDT@2026-11-21T13:54:55.825Z#watch-12191, AKE-USDT@2026-11-22T00:12:54.461Z#watch-12203, DCTY-USDT@2026-11-22T07:13:43.126Z#watch-12219, ELSA-USDT@2026-11-24T07:58:01.294Z#watch-12271, HMSTR-USDT@2026-11-24T08:11:48.532Z#watch-12289, DNA-USDT@2026-11-24T11:56:38.135Z#watch-12340, STONK-USDT@2026-11-24T16:15:16.008Z#watch-12427, OPG-USDT@2026-11-24T22:39:53.069Z#watch-12449, AKE-USDT@2026-11-25T02:54:30.507Z#watch-12468, DCTY-USDT@2026-11-25T13:12:16.684Z#watch-12507, MOVE-USDT@2026-11-26T00:44:14.474Z#watch-12551
### open (39)
4-USDT@2026-11-01T08:25:56.429Z#watch-8572, ON-USDT@2026-11-02T08:18:20.948Z#watch-8771, XPIN-USDT@2026-11-02T11:47:16.819Z#watch-8810, 4-USDT@2026-11-05T15:07:51.031Z#watch-9584, MARSCOIN-USDT@2026-11-05T15:07:51.031Z#watch-9501, TAC-USDT@2026-11-05T15:07:51.031Z#watch-9469, BLUAI-USDT@2026-11-05T15:39:08.584Z#watch-9707, GRASS-USDT@2026-11-05T15:39:08.584Z#watch-9724, HAJIMI-USDT@2026-11-05T15:39:08.584Z#watch-9729, TRADOOR-USDT@2026-11-05T15:39:08.584Z#watch-9693, MUBARAK-USDT@2026-11-07T16:53:49.484Z#watch-10049, 10000SATS-USDT@2026-11-08T22:27:32.610Z#watch-10493, 1INCH-USDT@2026-11-08T22:27:32.610Z#watch-10489, A-USDT@2026-11-08T22:27:32.610Z#watch-10486, AEVO-USDT@2026-11-08T22:27:32.610Z#watch-10449, APEX-USDT@2026-11-08T22:27:32.610Z#watch-10509, AWE-USDT@2026-11-08T22:27:32.610Z#watch-10528, COAI-USDT@2026-11-08T22:27:32.610Z#watch-10596, CP-USDT@2026-11-08T22:27:32.610Z#watch-10455, DEXE-USDT@2026-11-08T22:27:32.610Z#watch-10590, FIL-USDT@2026-11-08T22:27:32.610Z#watch-10581, FOLKS-USDT@2026-11-08T22:27:32.610Z#watch-10454, GRASS-USDT@2026-11-08T22:27:32.610Z#watch-10585, ILV-USDT@2026-11-08T22:27:32.610Z#watch-10577, MANTRA-USDT@2026-11-08T22:27:32.610Z#watch-10609, POPCAT-USDT@2026-11-08T22:27:32.610Z#watch-10629, PUMP-USDT@2026-11-08T22:27:32.610Z#watch-10451, SEI-USDT@2026-11-08T22:27:32.610Z#watch-10572, VIRTUAL-USDT@2026-11-08T22:27:32.610Z#watch-10504, ZEN-USDT@2026-11-08T22:27:32.610Z#watch-10535, ZK-USDT@2026-11-08T22:27:32.610Z#watch-10556, DOS-USDT@2026-11-10T01:22:12.471Z#watch-10819, BR-USDT@2026-11-10T03:16:25.044Z#signal-3712, BMT-USDT@2026-11-19T11:12:47.117Z#watch-11811, MANTRA-USDT@2026-11-20T15:48:54.399Z#signal-3977, XVG-USDT@2026-11-25T16:20:50.253Z#watch-12548, BIRB-USDT@2026-11-26T04:42:07.167Z#watch-12552, LISTA-USDT@2026-11-27T07:59:45.918Z#signal-4039, KAVA-USDT@2026-11-27T11:39:48.925Z#signal-4042

## Thresholds and combinations
- `thresholds.csv` contains every event-value range by named event, plus the best single threshold for each metric/period; it does not use medians.
- `combos.csv` lists the best 2–3 metric rules that improve champion share in both comparison periods. Empty means none met the minimum-count and positive-delta requirement.
1. 1h_adx14<=24.610400797525834 AND 1h_rsi14<=37.10383886545563; min Δ=20.90 pp
2. 4h_adx14>=29.933750189720172 AND 1d_di_plus14>=24.97143141917607; min Δ=20.90 pp
3. rise_7d_before_cascade_pct>=-3.589845299484329 AND 4h_adx14>=29.933750189720172 AND absorption_plus0_range_pct<=8.029197080291972; min Δ=20.90 pp
4. 1d_di_plus14>=24.97143141917607 AND 1d_rsi14>=45.09299333644369 AND absorption_plus0_range_pct<=8.029197080291972; min Δ=20.90 pp
5. 4h_adx14>=37.90685734911715 AND 1h_rsi14>=25.840516032322597; min Δ=20.69 pp
6. 4h_adx14>=29.933750189720172 AND 1d_di_plus14>=24.97143141917607 AND 1h_rsi14>=25.840516032322597; min Δ=20.27 pp
7. rise_7d_before_cascade_pct>=-3.589845299484329 AND 4h_adx14>=37.90685734911715; min Δ=19.15 pp
8. 4h_adx14>=37.90685734911715 AND 1d_di_plus14>=24.97143141917607; min Δ=19.15 pp
9. 4h_adx14>=37.90685734911715 AND 1d_rsi14>=45.09299333644369; min Δ=19.15 pp
10. rise_7d_before_cascade_pct>=-3.589845299484329 AND 4h_adx14>=37.90685734911715 AND 1d_di_plus14>=24.97143141917607; min Δ=19.15 pp

## Missingness
- cg_funding_rate_15m: missing 171/171
- funding_before_cascade_pct: missing 171/171
- funding_after_entry_pct: missing 171/171
- liq_map_long_below_5_pct_oi: missing 171/171
- liq_map_long_below_10_pct_oi: missing 171/171
- liq_map_short_above_5_pct_oi: missing 171/171
- liq_map_short_above_10_pct_oi: missing 171/171
- liq_map_dominant_side: missing 171/171
- basis_at_trough_pct: missing 171/171
- basis_at_entry_pct: missing 171/171
- binance_trough_drop_pct: missing 171/171
- binance_entry_close_drop_pct: missing 171/171
- wick_only_one_venue: missing 171/171
- coin_vs_sector_pct: missing 171/171
- sector_coins_down5_count: missing 171/171
- unlock_7d_pct_supply: missing 171/171
- bid_depth_below_5_pct_mcap: missing 170/171
- bid_depth_below_5_pct_oi: missing 170/171
- bid_depth_levels_5pct: missing 170/171
- cg_obv_120_pct_mcap: missing 166/171
- vp_type: missing 166/171
- vp_distance_poc_pct: missing 166/171
- cg_spot_cvd_delta_1h_pct_mcap: missing 165/171
- cg_spot_cvd_delta_4h_pct_mcap: missing 165/171
- cg_futures_volume_mcap_pct_15m: missing 165/171
- cg_spot_volume_mcap_pct_15m: missing 165/171
- cg_liq_long_mcap_pct_24h: missing 165/171
- long_liq_1h_pct_mcap: missing 165/171
- long_liq_4h_pct_mcap: missing 165/171
- coin_category: missing 162/171
- top_trader_ls_before: missing 158/171
- top_trader_ls_after: missing 158/171
- global_ls_after: missing 135/171
- global_ls_before: missing 134/171
- cg_spot_taker_net_pct_15m: missing 24/171
- cg_lucy_vsa_120: missing 19/171
- cg_welkin_20: missing 9/171
- cg_mfi_14: missing 9/171
- cg_cmf_20: missing 9/171
- cg_oi_change_4h_pct: missing 9/171
- 1d_rsi14_bull_divergence: missing 7/171
- 1d_adx14: missing 7/171
- 1d_di_plus14: missing 7/171
- 1d_di_minus14: missing 7/171
- rise_30d_before_cascade_pct: missing 7/171
- cg_oi_change_30m_pct: missing 6/171
- cg_oi_change_1h_pct: missing 6/171
- daily_support_status: missing 6/171
- daily_support_distance_pct: missing 6/171
- 1d_rsi14: missing 5/171
- 1d_atr14_pct: missing 5/171
- long_liq_1h_pct_oi: missing 5/171
- long_liq_4h_pct_oi: missing 5/171
- cg_futures_taker_net_pct_15m: missing 5/171
- absorption_plus0_volume_vs_avg120: missing 5/171
- 4h_rsi14_bull_divergence: missing 4/171
- rise_7d_before_cascade_pct: missing 4/171
- absorption_plus2_volume_vs_avg120: missing 4/171
- 4h_adx14: missing 3/171
- 4h_di_plus14: missing 3/171
- 4h_di_minus14: missing 3/171
- oi_burn_cascade_pct: missing 3/171
- first_hour_rebound_pct: missing 1/171
- first_hour_recovered_38: missing 1/171
- first_hour_recovered_50: missing 1/171
- first_hour_recovered_62: missing 1/171
- 15m_rsi14_bull_divergence: missing 1/171
- 15m_adx14: missing 1/171
- 15m_di_plus14: missing 1/171
- 15m_di_minus14: missing 1/171
- 1h_rsi14: missing 1/171
- 1h_rsi14_bull_divergence: missing 1/171
- 1h_atr14_pct: missing 1/171
- 1h_adx14: missing 1/171
- 1h_di_plus14: missing 1/171
- 1h_di_minus14: missing 1/171
- 4h_rsi14: missing 1/171
- 4h_atr14_pct: missing 1/171
- cascade_range_atr_15m: missing 1/171
- wyckoff_phase: missing 1/171
- wyckoff_selling_climax: missing 1/171
- wyckoff_automatic_rally: missing 1/171
- wyckoff_spring: missing 1/171

## Recommendations
- Do not promote a rule to a live gate from this sample: the rules were selected and evaluated on the same 2026-11 windows, and Binance comparisons are missing for all 171 events. Use the combinations only for a shadow cohort.
- Best balanced shadow candidate: `4h_adx14>=29.933750189720172 AND 1d_di_plus14>=24.97143141917607`. It retained 12 champions / 7 bad / 2 open in 2026-11-01..11 (21 events; simulated +$384.89) and 10 champions / 5 bad in 2026-11-12..26 (15 events; +$747.73). Retained examples include EVAA, ON, IDOL, XPIN, AGT, AIO, AIN, TA, AKE, TAC, RARE, CROSS, IRYS, SENT, DOS, PHAROS, and BLESS.
- Smaller alternative: `rise_7d_before_cascade_pct>=-3.589845299484329 AND 4h_adx14>=29.933750189720172 AND absorption_plus0_range_pct<=8.029197080291972`. It retained 8 champions / 3 bad in the first window (11 events; +$448.74) and 6 champions / 3 bad in the second (9 events; +$710.75); retained names include EVAA, IDOL, AIO, AIN, CYBER, ACT, AIOT, ASTR, TA, RARE, BREV, ZKC, DOS, BLESS, and MMT.
- The other top-ranked rule (`1h_adx14<=24.610400797525834 AND 1h_rsi14<=37.10383886545563`) had +$182.06 in the second window but −$650.53 in the first, so its results do not support prioritizing it. Full retained and removed event keys, including timestamps and IDs, are in `combos.csv`. No BTC-regime filter is recommended.

## Simulation
- $1,000 deposit / $100 isolated margin / 10x; initial stop −10%; break-even after +8%; trailing begins at +15%, trails by 10 percentage points; 0.1% round-trip fee.
- Each event’s 4-day management result is in `events.csv`; the top-10 combination rows include retained/removed names and simulated outcomes.

## Network request counts
- BingX: 1,727 attempts, 77 HTTP/network errors.
- Binance: 610 attempts, 608 HTTP/network errors (HTTP 451).
- CoinGlass: 8 attempts, 2 HTTP/network errors.
- CoinGecko: 59 attempts, 52 HTTP/network errors.
- The final offline recalculation added zero external requests; totals above are from the data-collection pass.
- CoinGlass series reused from `reports/.cache`; new queries were limited to missing top-trader ratios for the gate-passing sample. No volume/taker/CVD/MFI/CMF/VSA/Welkin refresh was requested.
- CoinGlass top-ratio requests stopped after unsupported pair 4STOCK-USDT returned API 400; ratios were read from six cached symbol responses where available (13/171 events populated, 158 missing). The production heatmap table has 0 rows, and funding, historical sector composition/candles, and token-unlock sources were unavailable; missing cells carry per-metric reasons in `missing_metrics.csv`.
- CoinGecko categories are present for 9 events; 49 symbols had ambiguous tickers and 52 unique-detail requests returned HTTP 429. Historical full-sector candles were unavailable; category/sector gaps are listed per event.

## Capitalization and OI-weighted funding supplement

- Snapshot time: 2026-11-27T17:25:35.771Z. Market cap at event = CoinGlass futures coins-markets current `market_cap_usd / current_price` × cached BingX 15m close at `gate_cascade_at` (fallback: `detected_at`). Coverage: 162/171 events.
- Funding uses the CoinGlass OI-weighted OHLC endpoint, 1h candle close, already expressed in percent. Funding before cascade coverage: 171/171; after entry: 171/171.
- Supplement CoinGlass calls: 76 attempts; 2 HTTP/API/network errors; 2 429 responses; 74 successful responses; 0 successful empty responses. coins-markets batches: 2; funding symbols requested: 72; full-range funding cache reused: 40.
- CoinGlass markets rows missing or unusable: AGRIPPA-USDT: монета отсутствует в ответе CoinGlass futures coins-markets, CLAUDIA-USDT: в CoinGlass futures coins-markets нет положительных market_cap_usd и/или current_price, DCTY-USDT: в CoinGlass futures coins-markets нет положительных market_cap_usd и/или current_price, HAJIMI-USDT: в CoinGlass futures coins-markets нет положительных market_cap_usd и/или current_price, MIHAO-USDT: в CoinGlass futures coins-markets нет положительных market_cap_usd и/или current_price, NULLMASK-USDT: в CoinGlass futures coins-markets нет положительных market_cap_usd и/или current_price. Funding symbols with terminal request failure: нет. Request errors by name (429 retry responses included): CoinGlass coins-markets batch 1/2 [EVAA,XPL,4,ZKP,US,UAI,4STOCK,JCT,ON,ARIA,SOPH,IDOL,XPIN,AKE,NULLMASK,BMT,AGT,Q,CLANKER,PARTI,AIO,AIN,MARSCOIN,STAR,TAC,VELVET,BLUAI,GRASS,HAJIMI,TRADOOR,CLAUDIA,CYBER,BLESS,ZIL,ONE,ACT,MUBARAK,LYN,TRUST,HOT,TA,STONK,SI,AIOT,10000SATS,1INCH,A,AEVO,AIA,APEX,AWE,COAI,CP,DEXE,FIL,FOLKS]: CoinGlass API 429; пауза 5 минут и повтор; CoinGlass OI-weighted funding LYN-USDT: CoinGlass API 429; пауза 5 минут и повтор.
- Recalculated from existing `reports/.cache` only: liquidation USD (1h/4h before entry and the prior report's 24h-at-cascade metric), 15m aggregated futures/spot volume, 1h/4h spot CVD deltas and 120-bar aggregated OBV. No BingX or other OHLC/history requests were made.
- New percentage metrics left blank:
- long_liq_1h_pct_mcap: пусто 13/171
- long_liq_4h_pct_mcap: пусто 13/171
- cg_liq_long_mcap_pct_24h: пусто 13/171
- cg_futures_volume_mcap_pct_15m: пусто 13/171
- cg_spot_volume_mcap_pct_15m: пусто 24/171
- cg_spot_cvd_delta_1h_pct_mcap: пусто 24/171
- cg_spot_cvd_delta_4h_pct_mcap: пусто 24/171
- cg_obv_120_pct_mcap: пусто 25/171
- funding_before_cascade_pct: пусто 0/171
- funding_after_entry_pct: пусто 0/171. Event-level reasons are in the added `*_missing_reason` fields and `missing_metrics.csv`.
- `thresholds.csv` now has named champion/bad/open distributions for these metrics and single thresholds trained on 2026-11-01..11, then applied unchanged to 2026-11-12..26.
- Threshold selection maximizes champion-share uplift on the training period over 10th–90th percentile cuts in both directions; candidates need at least 3 retained champions and 3 retained bad outcomes. A negative best uplift is still reported; ties prefer more retained outcomes.
- Each threshold is also tested with all three fixed regime filters: `1d_rsi14>=45 AND 4h_adx14>=35 AND 1d_di_plus14>=30`. PnL columns are sums of `bot_policy_4d_pnl_pct` for passed and removed rows; missing metric/regime rows are listed separately and excluded from those sums.

| metric | threshold trained Nov 1–11 | single: pass/cut PnL sum (train · validate) | plus all 3 regime filters: pass/cut PnL sum (train · validate) |
|---|---|---|---|
| long_liq_1h_pct_mcap | long_liq_1h_pct_mcap>=0.13381430975668004 | 44.97/-269.17 · -22.85/17.36 | 8.54/-222.64 · 17.63/-23.11 |
| long_liq_4h_pct_mcap | long_liq_4h_pct_mcap>=0.17724454746950422 | 13.30/-237.50 · 22.96/-28.44 | 33.07/-247.18 · 53.53/-59.02 |
| cg_liq_long_mcap_pct_24h | cg_liq_long_mcap_pct_24h>=0.1253337712962117 | -63.23/-160.97 · 43.92/-49.41 | 3.24/-217.34 · 60.35/-65.83 |
| cg_futures_volume_mcap_pct_15m | cg_futures_volume_mcap_pct_15m>=13.877341854270146 | -19.67/-214.64 · 53.46/-58.18 | 13.44/-227.54 · 53.43/-58.15 |
| cg_spot_volume_mcap_pct_15m | cg_spot_volume_mcap_pct_15m>=0.3628577033411691 | -86.36/-101.70 · -44.29/34.45 | 13.44/-191.40 · 53.53/-63.37 |
| cg_spot_cvd_delta_1h_pct_mcap | cg_spot_cvd_delta_1h_pct_mcap<=-0.06932546055342625 | -21.99/-166.08 · 1.41/-11.25 | 18.91/-196.87 · 53.83/-63.67 |
| cg_spot_cvd_delta_4h_pct_mcap | cg_spot_cvd_delta_4h_pct_mcap>=0.608614099811739 | 21.10/-209.16 · -20.50/10.67 | 24.53/-202.50 · -0.10/-9.73 |
| cg_obv_120_pct_mcap | cg_obv_120_pct_mcap>=39.25566813158707 | 6.62/-232.99 · 14.46/-17.85 | 11.95/-218.12 · 17.53/-20.92 |
| funding_before_cascade_pct | funding_before_cascade_pct>=0.021988 | -7.91/-245.73 · 3.76/-49.75 | 29.60/-252.94 · -0.20/-15.39 |
| funding_after_entry_pct | funding_after_entry_pct>=0.024544 | 1.83/-255.46 · 3.86/-49.85 | 20.49/-243.83 · -0.10/-15.49 |
## Williams indicators supplement

- Events: 171; outcome labels retained unchanged. Counts: champion=57, bad=74, open=39, ambiguous=1.
- All calculated values use BingX candles only and only bars closed at or before `entry_at`. Timeframes: 15m, 1h, 4h, 1d. Williams fractals use strict 2-left/2-right pivots and are counted only after both right bars close. Cascade reference is the latest closed candle at/before `gate_cascade_at` that was closed by entry. Alligator uses SMMA of median price with 13/8/5 lengths and 8/5/3 plotted shifts; AO is SMA(5)-SMA(34); Williams %R is 14.
- Additional indicators: Wilder RSI/ADX/DI/ATR; bullish RSI divergence compares the two latest confirmed lower fractals; Stoch(14,3,3), StochRSI(14,14,3,3); MACD(12,26,9); Bollinger(20,2) with population standard deviation; EMA uses SMA seed and 1-bar EMA50 percent slope; CCI(20); Supertrend(10,3). Ichimoku (9,26,52) is only 4h/1d; cloud spans are read 26 bars back to respect plotting displacement without lookahead. Price changes are from the last closed 15m candle before cascade to exact 24h/7d/30d prior closes.
- Full named distributions for champion/bad/open and event-level metric missing reasons are in `thresholds.csv` and `events.csv`. Thresholds use Nov 1–11 champion/bad rows for selection (numeric 10–90% quantile cuts; categorical/boolean exact state; at least 3 champions and 3 bad outcomes retained), then the same rule is reported for Nov 12–26 with passed/removed `bot_policy_4d_pnl_pct` sums and removed names. Of 167 metrics, 166 had a qualifying rule; `1d_williams_fractal_entry_recovered_above_broken_lower` had no state meeting the 3-champion/3-bad minimum. Actual-signal filter exclusions and production status/PnL are also in `thresholds.csv`.
- Production SELECT matched eight actual signals: #3712 BR-USDT reclassified pnl_percent=NULL, #3848 BTW-USDT profit pnl_percent=18.532349, #3970 NAORIS-USDT profit pnl_percent=30.550533, #3977 MANTRA-USDT stop_loss pnl_percent=-6.187291, #3980 BR-USDT profit pnl_percent=12.684122, #4011 ARIA-USDT in_run pnl_percent=NULL, #4039 LISTA-USDT stop_loss pnl_percent=-10, #4042 KAVA-USDT bu_stop pnl_percent=0.
- Populated metric cells: 15m: 6744/6840 metric cells; 1h: 6709/6840 metric cells; 4h: 6968/7182 metric cells; 1d: 6543/7182 metric cells. Missing per-indicator values carry a `*_missing_reason` column.
- BingX: 15 HTTP attempts for three missing 1D tails; all three symbols were rejected with API code 109418 (five retries each). CoinGlass requests: 0. Refused symbols:
- 4STOCK-USDT: 109418, symbol offline
- KIMCHI-USDT: 109418, symbol offline
- SI-USDT: 109418, symbol offline
- Metrics for any timeframe with a missing expected close or a gap in the latest cached window stay blank; no stale candle was substituted. DCTY-USDT has no cached 1D series and was not queried because only cached tails could be extended. No production writes or schema changes; production access was SELECT-only.
## Errors
- BingX gate candles AGENCY-USDT: Error: code 109418 AGENCY-USDT is offline currently,all validted symbols in api:/openApi/swap/v2/quote/contracts, please verify it
- BingX gate candles CATE-USDT: Error: code 109418 CATE-USDT is offline currently,all validted symbols in api:/openApi/swap/v2/quote/contracts, please verify it
- BingX gate candles AGI-USDT: Error: code 109418 AGI-USDT is offline currently,all validted symbols in api:/openApi/swap/v2/quote/contracts, please verify it
- BingX gate candles ZCAT-USDT: Error: code 109418 ZCAT-USDT is offline currently,all validted symbols in api:/openApi/swap/v2/quote/contracts, please verify it
- BingX klines 4STOCK-USDT 15m: Error: code 109418 4STOCK-USDT is offline currently,all validted symbols in api:/openApi/swap/v2/quote/contracts, please verify it
- BingX klines 4STOCK-USDT 1h: Error: code 109418 4STOCK-USDT is offline currently,all validted symbols in api:/openApi/swap/v2/quote/contracts, please verify it
- BingX klines CLAUDIA-USDT 15m: Error: code 109418 CLAUDIA-USDT is offline currently,all validted symbols in api:/openApi/swap/v2/quote/contracts, please verify it
- BingX klines SI-USDT 15m: Error: code 109418 SI-USDT is offline currently,all validted symbols in api:/openApi/swap/v2/quote/contracts, please verify it
- BingX klines 4STOCK-USDT 4h: Error: code 109418 4STOCK-USDT is offline currently,all validted symbols in api:/openApi/swap/v2/quote/contracts, please verify it
- BingX klines CLAUDIA-USDT 1h: Error: code 109418 CLAUDIA-USDT is offline currently,all validted symbols in api:/openApi/swap/v2/quote/contracts, please verify it
- BingX klines SI-USDT 1h: Error: code 109418 SI-USDT is offline currently,all validted symbols in api:/openApi/swap/v2/quote/contracts, please verify it
- BingX klines 4STOCK-USDT 1d: Error: code 109418 4STOCK-USDT is offline currently,all validted symbols in api:/openApi/swap/v2/quote/contracts, please verify it
- BingX klines CLAUDIA-USDT 4h: Error: code 109418 CLAUDIA-USDT is offline currently,all validted symbols in api:/openApi/swap/v2/quote/contracts, please verify it
- BingX klines SI-USDT 4h: Error: code 100410 请稍后重试
- BingX klines CLAUDIA-USDT 1d: Error: code 109418 CLAUDIA-USDT is offline currently,all validted symbols in api:/openApi/swap/v2/quote/contracts, please verify it
- BingX klines KIMCHI-USDT 15m: Error: code 109418 KIMCHI-USDT is offline currently,all validted symbols in api:/openApi/swap/v2/quote/contracts, please verify it
- BingX klines SI-USDT 1d: Error: code 109418 SI-USDT is offline currently,all validted symbols in api:/openApi/swap/v2/quote/contracts, please verify it
- BingX klines AGRIPPA-USDT 15m: Error: code 100410 请稍后重试
- BingX klines KIMCHI-USDT 1h: Error: code 109418 KIMCHI-USDT is offline currently,all validted symbols in api:/openApi/swap/v2/quote/contracts, please verify it
- BingX klines AGRIPPA-USDT 1h: Error: code 109418 AGRIPPA-USDT is offline currently,all validted symbols in api:/openApi/swap/v2/quote/contracts, please verify it
- BingX klines KIMCHI-USDT 4h: Error: code 109418 KIMCHI-USDT is offline currently,all validted symbols in api:/openApi/swap/v2/quote/contracts, please verify it
- BingX klines AGRIPPA-USDT 4h: Error: code 109418 AGRIPPA-USDT is offline currently,all validted symbols in api:/openApi/swap/v2/quote/contracts, please verify it
- BingX klines KIMCHI-USDT 1d: Error: code 109418 KIMCHI-USDT is offline currently,all validted symbols in api:/openApi/swap/v2/quote/contracts, please verify it
- BingX klines AGRIPPA-USDT 1d: Error: code 109418 AGRIPPA-USDT is offline currently,all validted symbols in api:/openApi/swap/v2/quote/contracts, please verify it
- BingX history BREW-USDT: Error: BingX code 109418 BREW-USDT is offline currently,all validted symbols in api:/openApi/swap/v2/quote/contracts, pl
- BingX history EPIC-USDT: Error: BingX code 109418 EPIC-USDT is offline currently,all validted symbols in api:/openApi/swap/v2/quote/contracts, pl
- BingX history PTB-USDT: Error: BingX code 109418 PTB-USDT is offline currently,all validted symbols in api:/openApi/swap/v2/quote/contracts, ple
- BingX history PURR-USDT: Error: BingX code 109418 PURR-USDT is offline currently,all validted symbols in api:/openApi/swap/v2/quote/contracts, pl
- BingX history VANRY-USDT: Error: BingX code 109418 VANRY-USDT is offline currently,all validted symbols in api:/openApi/swap/v2/quote/contracts, p
- Binance API returned HTTP 451; remaining cross-exchange retries were skipped and unavailable metrics are marked in missing_metrics.csv.
- CoinGecko evaa-protocol: Error: ENOENT: no such file or directory, open '/home/runner/workspace/reports/.cache/lc-indicators-1127/coingecko/evaa-
- CoinGecko 4-2: Error: ENOENT: no such file or directory, open '/home/runner/workspace/reports/.cache/lc-indicators-1127/coingecko/4-2.j
- CoinGecko 4stock: Error: HTTP 429
- CoinGecko meet48: Error: HTTP 429
- CoinGecko xpin-network: Error: HTTP 429
- CoinGecko akedo: Error: HTTP 429
- CoinGecko tokenbot-2: Error: HTTP 429
- CoinGecko particle-network: Error: HTTP 429
- CoinGecko velvet: Error: HTTP 429
- CoinGecko bluwhale: Error: HTTP 429
- CoinGecko bless-2: Error: HTTP 429
- CoinGecko zilliqa: Error: HTTP 429
- CoinGecko mubarak: Error: HTTP 429
- CoinGecko holotoken: Error: HTTP 429
- CoinGecko okzoo: Error: HTTP 429
- CoinGecko 1inch: Error: HTTP 429
- CoinGecko vaulta: Error: HTTP 429
- CoinGecko aevo-exchange: Error: HTTP 429
- CoinGecko aia: Error: HTTP 429
- CoinGecko stp-network: Error: HTTP 429
- CoinGecko chainopera-ai: Error: HTTP 429
- CoinGecko dexe: Error: HTTP 429
- CoinGecko folks: Error: HTTP 429
- CoinGecko illuvium: Error: HTTP 429
- CoinGecko jasmycoin: Error: HTTP 429
- CoinGecko mantra: Error: ENOENT: no such file or directory, open '/home/runner/workspace/reports/.cache/lc-indicators-1127/coingecko/mantr
- CoinGecko popcat: Error: ENOENT: no such file or directory, open '/home/runner/workspace/reports/.cache/lc-indicators-1127/coingecko/popca
- CoinGecko subsquid: Error: HTTP 429
- CoinGecko useless-3: Error: HTTP 429
- CoinGecko virtual-protocol: Error: HTTP 429
- CoinGecko zksync: Error: HTTP 429
- CoinGecko prometeus: Error: HTTP 429
- CoinGecko bedrock-token: Error: HTTP 429
- CoinGecko waves: Error: HTTP 429
- CoinGecko bulla-3: Error: HTTP 429
- CoinGecko opengradient: Error: HTTP 429
- CoinGecko agrippa: Error: HTTP 429
- CoinGecko immutable-x: Error: HTTP 429
- CoinGecko cash-cat: Error: HTTP 429
- CoinGecko allora: Error: HTTP 429
- CoinGecko brevis: Error: HTTP 429
- CoinGecko pippin: Error: HTTP 429
- CoinGecko boundless: Error: HTTP 429
- CoinGecko irys: Error: HTTP 429
- CoinGecko dacitycoin: Error: HTTP 429
- CoinGecko naoris: Error: HTTP 429
- CoinGecko ni-hao-cat-2: Error: HTTP 429
- CoinGecko lombard-protocol: Error: HTTP 429
- CoinGecko kernel-2: Error: HTTP 429
- CoinGecko carv: Error: ENOENT: no such file or directory, open '/home/runner/workspace/reports/.cache/lc-indicators-1127/coingecko/carv.
- CoinGecko elsa: Error: ENOENT: no such file or directory, open '/home/runner/workspace/reports/.cache/lc-indicators-1127/coingecko/elsa.
- CoinGecko hamster-kombat: Error: HTTP 429
- CoinGecko skyai: Error: HTTP 429
- CoinGecko momentum-3: Error: HTTP 429
- CoinGecko wax: Error: HTTP 429
- CoinGecko movement: Error: HTTP 429
- CoinGecko lista: Error: HTTP 429
- CoinGecko kava: Error: HTTP 429
- CoinGecko XPL-USDT: ambiguous ticker (2 matches)
- CoinGecko ZKP-USDT: ambiguous ticker (2 matches)
- CoinGecko US-USDT: ambiguous ticker (2 matches)
- CoinGecko UAI-USDT: ambiguous ticker (2 matches)
- CoinGecko JCT-USDT: ambiguous ticker (2 matches)
- CoinGecko ON-USDT: ambiguous ticker (2 matches)
- CoinGecko ARIA-USDT: ambiguous ticker (3 matches)
- CoinGecko SOPH-USDT: ambiguous ticker (2 matches)
- CoinGecko BMT-USDT: ambiguous ticker (2 matches)
- CoinGecko AGT-USDT: ambiguous ticker (2 matches)
- CoinGecko Q-USDT: ambiguous ticker (3 matches)
- CoinGecko AIO-USDT: ambiguous ticker (2 matches)
- CoinGecko AIN-USDT: ambiguous ticker (3 matches)
- CoinGecko MARSCOIN-USDT: ambiguous ticker (2 matches)
- CoinGecko STAR-USDT: ambiguous ticker (5 matches)
- CoinGecko TAC-USDT: ambiguous ticker (2 matches)
- CoinGecko GRASS-USDT: ambiguous ticker (3 matches)
- CoinGecko TRADOOR-USDT: ambiguous ticker (2 matches)
- CoinGecko CLAUDIA-USDT: ambiguous ticker (4 matches)
- CoinGecko CYBER-USDT: ambiguous ticker (2 matches)
- CoinGecko ONE-USDT: ambiguous ticker (7 matches)
- CoinGecko ACT-USDT: ambiguous ticker (3 matches)
- CoinGecko LYN-USDT: ambiguous ticker (2 matches)
- CoinGecko TRUST-USDT: ambiguous ticker (5 matches)
- CoinGecko TA-USDT: ambiguous ticker (2 matches)
- CoinGecko STONK-USDT: ambiguous ticker (2 matches)
- CoinGecko SI-USDT: ambiguous ticker (15 matches)
- CoinGecko APEX-USDT: ambiguous ticker (2 matches)
- CoinGecko CP-USDT: ambiguous ticker (3 matches)
- CoinGecko FIL-USDT: ambiguous ticker (2 matches)
- CoinGecko PUMP-USDT: ambiguous ticker (3 matches)
- CoinGecko SEI-USDT: ambiguous ticker (2 matches)
- CoinGecko ZEN-USDT: ambiguous ticker (5 matches)
- CoinGecko HANA-USDT: ambiguous ticker (3 matches)
- CoinGecko DOS-USDT: ambiguous ticker (2 matches)
- CoinGecko KIMCHI-USDT: ambiguous ticker (7 matches)
- CoinGecko CAP-USDT: ambiguous ticker (6 matches)
- CoinGecko ZEC-USDT: ambiguous ticker (5 matches)
- CoinGecko ASTR-USDT: ambiguous ticker (2 matches)
- CoinGecko BIRB-USDT: ambiguous ticker (3 matches)
- CoinGecko BTW-USDT: ambiguous ticker (2 matches)
- CoinGecko INIT-USDT: ambiguous ticker (2 matches)
- CoinGecko RARE-USDT: ambiguous ticker (2 matches)
- CoinGecko ANSEM-USDT: ambiguous ticker (3 matches)
- CoinGecko CFG-USDT: ambiguous ticker (2 matches)
- CoinGecko SENT-USDT: ambiguous ticker (3 matches)
- CoinGecko FLUX-USDT: ambiguous ticker (2 matches)
- CoinGecko DNA-USDT: ambiguous ticker (5 matches)
- CoinGecko XVG-USDT: ambiguous ticker (2 matches)
- CoinGlass API 429 EVAA-USDT; pause 5m before retry
- CoinGlass top ratio 4STOCK-USDT: code 400 The requested pair does not exist on the exchange. Please check the documentation to view supported exchanges and trading pairs: https://docs.coinglass.com/reference/instruments or https://docs.coinglass.com/reference/spot-suported-exchange-pairs
- BingX gate candles AGENCY-USDT: Error: not_in_cache
- BingX gate candles ZCAT-USDT: Error: not_in_cache
- Binance API returned HTTP 451; remaining cross-exchange retries were skipped and unavailable metrics are marked in missing_metrics.csv.
- CoinGecko XPL-USDT: ambiguous ticker (2 matches)
- CoinGecko ZKP-USDT: ambiguous ticker (2 matches)
- CoinGecko US-USDT: ambiguous ticker (2 matches)
- CoinGecko UAI-USDT: ambiguous ticker (2 matches)
- CoinGecko JCT-USDT: ambiguous ticker (2 matches)
- CoinGecko ON-USDT: ambiguous ticker (2 matches)
- CoinGecko ARIA-USDT: ambiguous ticker (3 matches)
- CoinGecko SOPH-USDT: ambiguous ticker (2 matches)
- CoinGecko BMT-USDT: ambiguous ticker (2 matches)
- CoinGecko AGT-USDT: ambiguous ticker (2 matches)
- CoinGecko Q-USDT: ambiguous ticker (3 matches)
- CoinGecko AIO-USDT: ambiguous ticker (2 matches)
- CoinGecko AIN-USDT: ambiguous ticker (3 matches)
- CoinGecko MARSCOIN-USDT: ambiguous ticker (2 matches)
- CoinGecko STAR-USDT: ambiguous ticker (5 matches)
- CoinGecko TAC-USDT: ambiguous ticker (2 matches)
- CoinGecko GRASS-USDT: ambiguous ticker (3 matches)
- CoinGecko TRADOOR-USDT: ambiguous ticker (2 matches)
- CoinGecko CLAUDIA-USDT: ambiguous ticker (4 matches)
- CoinGecko CYBER-USDT: ambiguous ticker (2 matches)
- CoinGecko ONE-USDT: ambiguous ticker (7 matches)
- CoinGecko ACT-USDT: ambiguous ticker (3 matches)
- CoinGecko LYN-USDT: ambiguous ticker (2 matches)
- CoinGecko TRUST-USDT: ambiguous ticker (5 matches)
- CoinGecko TA-USDT: ambiguous ticker (2 matches)
- CoinGecko STONK-USDT: ambiguous ticker (2 matches)
- CoinGecko SI-USDT: ambiguous ticker (15 matches)
- CoinGecko APEX-USDT: ambiguous ticker (2 matches)
- CoinGecko CP-USDT: ambiguous ticker (3 matches)
- CoinGecko FIL-USDT: ambiguous ticker (2 matches)
- CoinGecko PUMP-USDT: ambiguous ticker (3 matches)
- CoinGecko SEI-USDT: ambiguous ticker (2 matches)
- CoinGecko ZEN-USDT: ambiguous ticker (5 matches)
- CoinGecko HANA-USDT: ambiguous ticker (3 matches)
- CoinGecko DOS-USDT: ambiguous ticker (2 matches)
- CoinGecko KIMCHI-USDT: ambiguous ticker (7 matches)
- CoinGecko CAP-USDT: ambiguous ticker (6 matches)
- CoinGecko ZEC-USDT: ambiguous ticker (5 matches)
- CoinGecko ASTR-USDT: ambiguous ticker (2 matches)
- CoinGecko BIRB-USDT: ambiguous ticker (3 matches)
- CoinGecko BTW-USDT: ambiguous ticker (2 matches)
- CoinGecko INIT-USDT: ambiguous ticker (2 matches)
- CoinGecko RARE-USDT: ambiguous ticker (2 matches)
- CoinGecko ANSEM-USDT: ambiguous ticker (3 matches)
- CoinGecko CFG-USDT: ambiguous ticker (2 matches)
- CoinGecko SENT-USDT: ambiguous ticker (3 matches)
- CoinGecko FLUX-USDT: ambiguous ticker (2 matches)
- CoinGecko DNA-USDT: ambiguous ticker (5 matches)
- CoinGecko XVG-USDT: ambiguous ticker (2 matches)
