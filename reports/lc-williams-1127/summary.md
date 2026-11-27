# Реальные сигналы Liquidation Cascade — индикаторы

Дата снимка: 2026-11-27T18:51:41.622326+00:00 (UTC). Production, только SELECT; BTC исключён.
Выборка: 640 tracked_signals, 284 монет, 2026-07-21T06:57:36.348000Z — 2026-11-27T12:00:17.297000Z.

## Реальный статус и полнота источника

| tracked_signals.status | Количество |
|---|---:|
| bu_stop | 158 |
| cancelled | 66 |
| expired | 41 |
| in_run | 1 |
| profit | 89 |
| reclassified | 187 |
| stop_loss | 98 |

Исход 72 ч по BingX от фактического входа: {'censored': 133, 'bad': 121, 'champion': 190, 'open': 196}.
4-day simulation has numeric result for 507 / 640 signals; incomplete/open paths carry per-signal reasons in `sim_pnl_missing_reason`.
Gate linkage по активным watch на момент создания сигнала: ровно 1 — 556, несколько — 23, отсутствуют — 61. При нескольких выбран ближайший предыдущий действующий watch; число кандидатов оставлено в signals.csv. Без связи gate и каскадные метрики пусты.
У reclassified строк beforeNeutralClose записан у 2 из 187; исходный status там: {'active': 2}. В 185 строках beforeNeutralClose отсутствует; recovered actual PnL не придумывался. Effective actual PnL пуст у 188 строк (имена и причины в signals.csv/thresholds.csv). Rule version в tracked_signals/decision_metrics не обнаружена; колонка оставлена пустой.

## Методика

- Только реальные tracked_signals `sentiment_key=liquidation_cascade`, detected_at ≥ 2026-07-14, symbol ≠ BTC-USDT; один выход на signal id. Сигнальная связь с `liq_cascade_watch` выбрана только когда сигнал был создан в окне watch `detected_at..expires_at`.
- `passes_current_candle_gate` повторяет текущий код `lc-detection-candle-gate.ts`: −3…+1 15m окна, наибольший range ≥5.6%, следующая свеча body ≥−1%, плюс 30-минутное окно выдачи. Проверка привязана к времени и watch, записанным для конкретного сигнала.
- Индикаторы рассчитаны на закрытых BingX-свечах до фактического времени сигнала; OHLCV использует только reports/.cache плюс недостающие нужные окна BingX. используется вся доступная до входа закрытая история из кэша (для недостающих окон запрашивалось не менее 240 баров), EMA200 требует 200; разрыв в последних 120 барах обнуляет метрики этого таймфрейма с причиной. CoinGlass не вызывался.
- Williams fractals: строгий 2-left/2-right с подтверждением двумя правыми свечами; каскадные показатели используют каскадную свечу из gate. Alligator SMMA(13,8,5), shifts 8/5/3; AO SMA5−SMA34; Williams %R(14). RSI/ADX/DI/ATR Wilder, Stoch(14,3,3), StochRSI(14,14,3,3), MACD(12,26,9), Bollinger(20,2, population SD), EMA with SMA seed (EMA50 slope is one-bar % change), CCI(20), Supertrend(10,3), Ichimoku(9,26,52) only 4h/1d with cloud shifted 26 bars back.
- `outcome_72h`: +10% first = champion; −10% first = bad; both in the same 15m bar = ambiguous; neither over a complete 72h path = open; incomplete candle history = censored. Current exit simulation: −10% stop, breakeven activates after +8%, trailing starts at +15% and trails 10 percentage points below the peak, 4-day max; `sim_pnl_pct` subtracts 0.1% fee. Missing/unmatured path stays blank with a reason.
- `thresholds.csv` has full named distributions for champion/bad/open/ambiguous/censored across all signals and the gate-pass subset. Single rules are selected only on 2026-07-14..09-30 and applied unchanged to 2026-10-01..11-27; numeric candidates are 10th–90th percentile cuts in both directions, categorical/boolean states use exact equality. At least 3 champions and 3 bad outcomes must remain in the training candidate. Missing metric values are excluded from rule fitting, reported separately; non-passing sums include missing rows and also list them separately.
- `combos.csv` forms all pairs among the five single metrics with the highest training uplift per cohort; when the gate-pass training subset has fewer than five usable rules, the five full-cohort training thresholds are applied unchanged to that subset and marked in `threshold_training_cohort`. Validation is not used for selection. Recommendations require positive champion-share uplift and minimum counts in both periods; this is exploratory, not causal evidence.
- `thresholds.csv` contains per metric numbers and full names of champions/bads removed by period, and passed/removed sums of recorded actual PnL and `sim_pnl_pct`. The table below is the direct per-indicator verdict; removed names are in the referenced CSV rows.

### Current-gate distribution: {'False': 563, 'True': 16, 'None': 61}

### Actual PnL missing and reclassified details
- `beforeNeutralClose` status counts: {'active': 2}.
- Reclassified without before-neutral snapshot: 185; names: DOGE-USDT@2026-08-30T19:35:31.734000Z#signal-1384;SOL-USDT@2026-08-31T03:12:06.455000Z#signal-1389;XMR-USDT@2026-09-23T14:14:10.621000Z#signal-1805;ENA-USDT@2026-09-23T15:46:45.378000Z#signal-1825;BSV-USDT@2026-09-23T15:47:26.753000Z#signal-1826;VET-USDT@2026-09-23T15:53:35.771000Z#signal-1827;1000BONK-USDT@2026-09-23T15:54:29.302000Z#signal-1828;ETH-USDT@2026-09-24T12:09:57.493000Z#signal-1902;BNB-USDT@2026-09-26T21:50:01.738000Z#signal-1951;ETC-USDT@2026-09-26T22:49:07.406000Z#signal-1959;BCH-USDT@2026-09-26T23:13:25.385000Z#signal-1961;XAUT-USDT@2026-09-27T23:19:11.477000Z#signal-1977;MELANIA-USDT@2026-09-28T01:08:31.191000Z#signal-1983;VVV-USDT@2026-09-28T02:20:14.738000Z#signal-1986;ASTER-USDT@2026-09-28T03:19:14.603000Z#signal-1989;AR-USDT@2026-09-28T03:38:42.829000Z#signal-1990;ATOM-USDT@2026-09-28T04:51:44.219000Z#signal-1992;UNI-USDT@2026-09-28T05:07:30.824000Z#signal-1996;MORPHO-USDT@2026-09-28T06:09:03.255000Z#signal-1999;ENS-USDT@2026-09-28T08:15:57.457000Z#signal-2004;BEAT-USDT@2026-09-28T08:26:39.658000Z#signal-2007;1000SHIB-USDT@2026-09-28T09:29:33.960000Z#signal-2009;XTZ-USDT@2026-09-28T09:46:53.498000Z#signal-2010;PAXG-USDT@2026-09-28T10:07:01.007000Z#signal-2011;LA-USDT@2026-09-28T10:14:37.764000Z#signal-2012;ONDO-USDT@2026-09-28T10:50:35.091000Z#signal-2014;HYPE-USDT@2026-09-28T12:39:31.585000Z#signal-2019;XPL-USDT@2026-09-28T16:38:19.971000Z#signal-2025;CC-USDT@2026-09-28T20:39:20.408000Z#signal-2029;XRP-USDT@2026-09-29T03:45:28.331000Z#signal-2034;TIA-USDT@2026-09-29T09:52:58.607000Z#signal-2036;PROM-USDT@2026-09-29T12:47:30.286000Z#signal-2038;HBAR-USDT@2026-09-29T19:08:32.253000Z#signal-2045;OP-USDT@2026-09-29T19:19:05.236000Z#signal-2046;CASHCAT-USDT@2026-09-30T00:37:16.925000Z#signal-2049;GRT-USDT@2026-09-30T05:13:00.630000Z#signal-2051;AKE-USDT@2026-09-30T11:11:41.089000Z#signal-2058;PENGU-USDT@2026-09-30T15:48:18.660000Z#signal-2066;AVAX-USDT@2026-09-30T15:51:59.420000Z#signal-2067;ENA-USDT@2026-09-30T16:08:09.583000Z#signal-2068;SUI-USDT@2026-09-30T16:18:26.070000Z#signal-2069;LTC-USDT@2026-09-30T21:37:43.794000Z#signal-2074;APT-USDT@2026-10-01T00:16:45.501000Z#signal-2079;JTO-USDT@2026-10-01T02:48:17.059000Z#signal-2081;LDO-USDT@2026-10-01T07:49:26.073000Z#signal-2083;DASH-USDT@2026-10-01T08:49:25.066000Z#signal-2084;PUMP-USDT@2026-10-01T09:49:47.381000Z#signal-2085;XAUT-USDT@2026-10-01T15:09:54.458000Z#signal-2089;ATOM-USDT@2026-10-02T01:39:53.239000Z#signal-2093;ORDI-USDT@2026-10-02T19:26:19.579000Z#signal-2105;GRT-USDT@2026-10-02T19:41:13.619000Z#signal-2106;XLM-USDT@2026-10-02T19:41:21.921000Z#signal-2107;DASH-USDT@2026-10-02T20:14:24.767000Z#signal-2108;LDO-USDT@2026-10-02T21:58:40.505000Z#signal-2111;1000SHIB-USDT@2026-10-02T22:12:39.635000Z#signal-2112;1000BONK-USDT@2026-10-02T22:57:24.714000Z#signal-2114;CASHCAT-USDT@2026-10-02T23:30:08.309000Z#signal-2115;MARSCOIN-USDT@2026-10-02T23:30:14.849000Z#signal-2116;LAB-USDT@2026-10-03T01:31:54.537000Z#signal-2119;2Z-USDT@2026-10-03T05:14:59.406000Z#signal-2125;ASTER-USDT@2026-10-03T06:50:10.284000Z#signal-2129;BEAT-USDT@2026-10-03T06:50:18.599000Z#signal-2130;WLFI-USDT@2026-10-03T07:03:02.843000Z#signal-2131;USELESS-USDT@2026-10-03T08:27:29.911000Z#signal-2134;ETHFI-USDT@2026-10-03T09:11:10.325000Z#signal-2135;COTI-USDT@2026-10-03T09:17:17.159000Z#signal-2136;RESOLV-USDT@2026-10-03T11:57:25.338000Z#signal-2137;RESOLV-USDT@2026-10-03T16:22:16.344000Z#signal-2138;SOON-USDT@2026-10-04T11:23:03.924000Z#signal-2141;BOME-USDT@2026-10-04T12:21:19.581000Z#signal-2142;PONS-USDT@2026-10-04T15:52:25.890000Z#signal-2143;0G-USDT@2026-10-04T16:41:52.316000Z#signal-2144;MAGMA-USDT@2026-10-05T14:39:43.790000Z#signal-2147;SKYAI-USDT@2026-10-05T15:28:23.238000Z#signal-2148;MAGMA-USDT@2026-10-05T15:28:38.230000Z#signal-2149;ONDO-USDT@2026-10-05T16:01:03.448000Z#signal-2151;STRK-USDT@2026-10-06T00:26:30.795000Z#signal-2156;FARTCOIN-USDT@2026-10-06T04:10:22.110000Z#signal-2158;FORM-USDT@2026-10-07T02:17:32Z#signal-2166;MEGA-USDT@2026-10-07T02:17:41.809000Z#signal-2167;DYDX-USDT@2026-10-07T02:17:49.417000Z#signal-2168;APT-USDT@2026-10-07T02:18:23.289000Z#signal-2169;XPL-USDT@2026-10-07T02:18:35.715000Z#signal-2170;CORE-USDT@2026-10-07T02:18:43.392000Z#signal-2171;ZAMA-USDT@2026-10-07T02:19:18.287000Z#signal-2172;SLX-USDT@2026-10-07T02:19:32.271000Z#signal-2173;PENDLE-USDT@2026-10-07T02:19:46.650000Z#signal-2175;REZ-USDT@2026-10-07T02:19:53.566000Z#signal-2176;MMT-USDT@2026-10-07T02:20:14.369000Z#signal-2177;SEI-USDT@2026-10-07T02:20:21.106000Z#signal-2178;ORDI-USDT@2026-10-07T02:20:28.778000Z#signal-2179;YGG-USDT@2026-10-07T02:20:45.371000Z#signal-2180;IOST-USDT@2026-10-07T02:20:55.001000Z#signal-2181;EIGEN-USDT@2026-10-07T02:21:06.069000Z#signal-2182;PTB-USDT@2026-10-07T02:21:14.354000Z#signal-2183;XAI-USDT@2026-10-07T02:21:29.056000Z#signal-2184;G-USDT@2026-10-07T02:21:40.406000Z#signal-2185;ASTER-USDT@2026-10-07T02:21:56.647000Z#signal-2186;PEOPLE-USDT@2026-10-07T02:22:19.550000Z#signal-2187;XTZ-USDT@2026-10-07T02:22:40.985000Z#signal-2188;ROBO-USDT@2026-10-07T02:22:54.649000Z#signal-2189;ALGO-USDT@2026-10-07T02:23:19.149000Z#signal-2191;LA-USDT@2026-10-07T02:23:40.095000Z#signal-2192;RENDER-USDT@2026-10-07T02:23:54.856000Z#signal-2193;CT-USDT@2026-10-07T02:30:03.192000Z#signal-2194;BASED-USDT@2026-10-07T02:30:43.951000Z#signal-2195;AIXBT-USDT@2026-10-07T02:33:45.418000Z#signal-2196;ARIA-USDT@2026-10-07T02:34:52.473000Z#signal-2197;BANK-USDT@2026-10-07T02:35:13.005000Z#signal-2198;ENA-USDT@2026-10-07T02:42:21.980000Z#signal-2199;UAI-USDT@2026-10-07T02:42:38.755000Z#signal-2200;PONS-USDT@2026-10-07T02:42:53.958000Z#signal-2201;SUSHI-USDT@2026-10-07T02:43:37.220000Z#signal-2204;KAITO-USDT@2026-10-07T02:44:31.721000Z#signal-2205;POL-USDT@2026-10-07T02:44:41.345000Z#signal-2206;DEXE-USDT@2026-10-07T02:45:13.097000Z#signal-2207;MANTA-USDT@2026-10-07T02:45:44.630000Z#signal-2208;JUP-USDT@2026-10-07T02:46:02.236000Z#signal-2209;1000PEPE-USDT@2026-10-07T02:46:11.516000Z#signal-2210;GMT-USDT@2026-10-07T02:46:20.417000Z#signal-2211;ZK-USDT@2026-10-07T02:46:29.365000Z#signal-2212;WIF-USDT@2026-10-07T02:46:42.148000Z#signal-2213;AERO-USDT@2026-10-07T02:46:52.772000Z#signal-2214;S-USDT@2026-10-07T02:47:01.370000Z#signal-2215;KAVA-USDT@2026-10-07T02:47:09.354000Z#signal-2216;VET-USDT@2026-10-07T02:52:09.105000Z#signal-2217;CFG-USDT@2026-10-07T02:53:09.637000Z#signal-2218;ZEN-USDT@2026-10-07T02:53:24.327000Z#signal-2219;DASH-USDT@2026-10-07T02:53:32Z#signal-2220;VTHO-USDT@2026-10-07T02:53:45.557000Z#signal-2221;CRV-USDT@2026-10-07T02:53:52.526000Z#signal-2222;CFX-USDT@2026-10-07T02:54:01.821000Z#signal-2223;HEMI-USDT@2026-10-07T02:54:32.668000Z#signal-2224;RE-USDT@2026-10-07T02:54:59.013000Z#signal-2225;GIGGLE-USDT@2026-10-07T02:55:07.925000Z#signal-2226;NEO-USDT@2026-10-07T02:55:16.994000Z#signal-2227;STX-USDT@2026-10-07T03:04:43.548000Z#signal-2228;BERA-USDT@2026-10-07T03:12:19.948000Z#signal-2230;PNUT-USDT@2026-10-07T03:12:34.283000Z#signal-2231;IOTA-USDT@2026-10-07T03:12:56.050000Z#signal-2232;ESPORTS-USDT@2026-10-07T03:13:04.166000Z#signal-2233;ME-USDT@2026-10-07T03:13:20.356000Z#signal-2234;SOPH-USDT@2026-10-07T03:14:03.375000Z#signal-2236;USELESS-USDT@2026-10-07T03:14:16.389000Z#signal-2237;LSK-USDT@2026-10-07T03:14:32.008000Z#signal-2238;2Z-USDT@2026-10-07T03:14:45.016000Z#signal-2239;CAKE-USDT@2026-10-07T03:15:00.529000Z#signal-2240;CHZ-USDT@2026-10-07T03:19:55.032000Z#signal-2241;DGAI-USDT@2026-10-07T03:20:10.367000Z#signal-2242;ALT-USDT@2026-10-07T03:20:22.443000Z#signal-2243;1INCH-USDT@2026-10-07T03:20:35.195000Z#signal-2244;POPCAT-USDT@2026-10-07T03:20:56.724000Z#signal-2245;AR-USDT@2026-10-07T03:21:23.322000Z#signal-2246;WLD-USDT@2026-10-07T03:21:38.152000Z#signal-2247;PYTH-USDT@2026-10-07T03:22:00.622000Z#signal-2248;TAO-USDT@2026-10-07T03:22:18.069000Z#signal-2249;ARB-USDT@2026-10-07T03:26:52.069000Z#signal-2250;MARSCOIN-USDT@2026-10-07T03:42:34.996000Z#signal-2251;STRK-USDT@2026-10-07T03:42:55.823000Z#signal-2252;LPT-USDT@2026-10-07T03:43:27.719000Z#signal-2254;GRT-USDT@2026-10-07T03:43:59.428000Z#signal-2255;QTUM-USDT@2026-10-07T03:44:39.608000Z#signal-2256;1000SHIB-USDT@2026-10-07T03:49:06.171000Z#signal-2257;SAGA-USDT@2026-10-07T03:49:58.342000Z#signal-2258;COTI-USDT@2026-10-07T03:50:09.781000Z#signal-2259;SKY-USDT@2026-10-07T03:50:42.158000Z#signal-2260;BEAT-USDT@2026-10-07T03:59:40.763000Z#signal-2261;UMA-USDT@2026-10-07T04:09:59.843000Z#signal-2263;TIA-USDT@2026-10-07T04:41:46.944000Z#signal-2264;OP-USDT@2026-10-07T04:45:48.944000Z#signal-2265;ENS-USDT@2026-10-07T05:14:15.997000Z#signal-2266;ALICE-USDT@2026-10-07T05:23:17.708000Z#signal-2267;1000BONK-USDT@2026-10-07T05:38:49.514000Z#signal-2268;CYBER-USDT@2026-10-07T05:40:02.624000Z#signal-2269;ZRO-USDT@2026-10-07T05:45:32.738000Z#signal-2270;FIL-USDT@2026-10-07T06:42:22.802000Z#signal-2271;MANA-USDT@2026-10-07T06:42:33.206000Z#signal-2272;LDO-USDT@2026-10-07T06:43:51.740000Z#signal-2273;ONE-USDT@2026-10-07T07:14:50.344000Z#signal-2274;APE-USDT@2026-10-07T07:30:15.697000Z#signal-2275;PUMP-USDT@2026-10-07T07:48:27.682000Z#signal-2276;XLM-USDT@2026-10-07T07:57:21.550000Z#signal-2277;TRIA-USDT@2026-10-07T08:11:57.237000Z#signal-2278;SPX-USDT@2026-10-07T09:15:36.343000Z#signal-2279;EVAA-USDT@2026-10-07T09:55:23.814000Z#signal-2280
- Reclassified with active before-neutral status and no PnL: 2; names: BR-USDT@2026-11-10T03:16:25.044000Z#signal-3712;RECALL-USDT@2026-11-11T19:18:19.669000Z#signal-3776

## BingX requests and errors

BingX HTTP attempts: 962; API code=0 responses: 750; terminal failed intervals: 41; CoinGlass requests: 0.
- Successful empty-candle intervals (not API errors): 524; by TF: {'15m': 467, '1d': 43, '4h': 11, '1h': 3}; symbols (182): 1000BONK-USDT, 1000CAT-USDT, 1000PEPE-USDT, 1000SHIB-USDT, AAVE-USDT, ACE-USDT, ACH-USDT, ADA-USDT, AIO-USDT, AKE-USDT, ALLO-USDT, APEX-USDT, APR-USDT, APT-USDT, ARB-USDT, ARC-USDT, ASTER-USDT, ATOM-USDT, AVAX-USDT, AXS-USDT, B2-USDT, BANANAS31-USDT, BANK-USDT, BASED-USDT, BB-USDT, BCH-USDT, BEAT-USDT, BERA-USDT, BICO-USDT, BILL-USDT, BIRB-USDT, BLESS-USDT, BLUAI-USDT, BLUR-USDT, BMT-USDT, BNB-USDT, BOME-USDT, BR-USDT, BROCCOLIF3B-USDT, BSB-USDT, BTW-USDT, CAP-USDT, CASHCAT-USDT, CATI-USDT, CELR-USDT, CFG-USDT, CFX-USDT, CHIP-USDT, CHR-USDT, CHZ-USDT, CLO-USDT, CORE-USDT, CRV-USDT, CT-USDT, DASH-USDT, DEXE-USDT, DGAI-USDT, DIA-USDT, DOGE-USDT, DOT-USDT, EIGEN-USDT, ENA-USDT, ENSO-USDT, ERA-USDT, ESP-USDT, ESPORTS-USDT, ETC-USDT, ETH-USDT, ETHFI-USDT, FARTCOIN-USDT, FET-USDT, FHE-USDT, FIL-USDT, G-USDT, GALA-USDT, GENIUS-USDT, GPS-USDT, GRASS-USDT, GRT-USDT, GRVT-USDT, GUA-USDT, GWEI-USDT, H-USDT, HANA-USDT, HBAR-USDT, HEI-USDT, HEMI-USDT, HOME-USDT, HYPE-USDT, ICNT-USDT, ICP-USDT, IDOL-USDT, IN-USDT, INJ-USDT, JASMY-USDT, JTO-USDT, JUP-USDT, KAITO-USDT, KAS-USDT, KERNEL-USDT, KITE-USDT, KOMA-USDT, LA-USDT, LAB-USDT, LDO-USDT, LINK-USDT, LISTA-USDT, LONGXIA-USDT, LPT-USDT, LTC-USDT, MAGMA-USDT, MARSCOIN-USDT, MEGA-USDT, MMT-USDT, MNT-USDT, MORPHO-USDT, MOVE-USDT, MOVR-USDT, MYX-USDT, NAORIS-USDT, NEAR-USDT, NES-USDT, NIL-USDT, O-USDT, OKB-USDT, ON-USDT, ONDO-USDT, OP-USDT, PENGU-USDT, PIEVERSE-USDT, PIPPIN-USDT, POL-USDT, PONS-USDT, PROM-USDT, PUMP-USDT, PYTH-USDT, QTUM-USDT, RAY-USDT, RE-USDT, RENDER-USDT, RIF-USDT, RIVER-USDT, ROBO-USDT, RVN-USDT, SAHARA-USDT, SEI-USDT, SIREN-USDT, SKYAI-USDT, SLX-USDT, SOL-USDT, SQD-USDT, STX-USDT, SUI-USDT, SYN-USDT, TAC-USDT, TAIKO-USDT, TAO-USDT, TIA-USDT, TRIA-USDT, TRX-USDT, TUT-USDT, UB-USDT, UNI-USDT, US-USDT, VANA-USDT, VELVET-USDT, VET-USDT, VTHO-USDT, WIF-USDT, WLD-USDT, WLFI-USDT, XAUT-USDT, XDP-USDT, XLM-USDT, XMR-USDT, XPIN-USDT, XPL-USDT, XRP-USDT, XTZ-USDT, ZAMA-USDT, ZBT-USDT, ZEC-USDT
- BingX reports contract offline (109418) for: 4STOCK-USDT, BEN-USDT, BREW-USDT, EPIC-USDT, PTB-USDT, PURR-USDT, VANRY-USDT
- 4STOCK-USDT: 109418/15m × 1; 109418/1d × 1; 109418/4h × 1
- BEN-USDT: 109418/15m × 1; 109418/1d × 1; 109418/4h × 1
- BREW-USDT: 100410/4h × 1; 109418/15m × 3; 109418/1d × 1; 109418/1h × 1
- EPIC-USDT: 109418/15m × 3; 109418/1d × 1; 109418/1h × 1; 109418/4h × 1
- PTB-USDT: 109418/15m × 6; 109418/1d × 1; 109418/1h × 2; 109418/4h × 2
- PURR-USDT: 109418/15m × 3; 109418/1d × 1; 109418/1h × 1; 109418/4h × 1
- VANRY-USDT: 109418/15m × 3; 109418/1d × 1; 109418/1h × 1; 109418/4h × 1

| TF | HTTP requests | HTTP/API errors | Bars added |
|---|---:|---:|---:|
| 1h | 179 | 6 | 32056 |
| 15m | 653 | 20 | 535 |
| 1d | 78 | 7 | 0 |
| 4h | 52 | 8 | 0 |

## Вывод по каждому индикатору

`train/validation Δpp` — изменение доли champions среди прошедших относительно исходного metric-present cohort; дальше — число удалённых champion/bad по правилу. Полные имена удалённых и PnL суммы лежат в `thresholds.csv`.

| metric | cohort | verdict | train Δpp | validation Δpp | removed C/B train | removed C/B validation |
|---|---|---|---:|---:|---:|---:|
| `15m_williams_fractal_lower_distance_entry_pct` | all_signals | helps in both | 2.456140351 | 0.5604635699 | 10/9 | 13/21 |
| `15m_williams_fractal_cascade_broke_last_lower` | all_signals | does not hold in both | 2.672568728 | -2.089370139 | 7/8 | 3/1 |
| `15m_williams_fractal_cascade_lower_broken_count` | all_signals | does not hold in both | 6.318681319 | -3.734939759 | 92/34 | 13/20 |
| `15m_williams_fractal_entry_recovered_above_broken_lower` | all_signals | helps in both | 0.8046170697 | 3.137039075 | 17/6 | 1/9 |
| `15m_williams_fractal_upper_distance_entry_pct` | all_signals | does not hold in both | 9.078251184 | -4.886812792 | 94/38 | 40/58 |
| `15m_williams_fractal_rising_lows` | all_signals | helps in both | 0.2775609333 | 6.276524458 | 96/32 | 31/53 |
| `15m_alligator_state` | all_signals | does not hold in both | 5 | -0.5889617175 | 17/16 | 14/20 |
| `15m_alligator_lips_jaw_distance_pct` | all_signals | helps in both | 5 | 3.18772137 | 21/17 | 18/33 |
| `15m_alligator_state_bars_ago` | all_signals | does not hold in both | 12.93103448 | -2.632384451 | 90/40 | 38/56 |
| `15m_alligator_entry_vs_jaw_pct` | all_signals | does not hold in both | 3.070175439 | -1.07293026 | 52/22 | 26/38 |
| `15m_alligator_entry_vs_teeth_pct` | all_signals | does not hold in both | 6.052631579 | -0.1345377667 | 64/29 | 31/47 |
| `15m_alligator_entry_vs_lips_pct` | all_signals | helps in both | 7.105263158 | 1.239669421 | 63/30 | 30/47 |
| `15m_ao_sign` | all_signals | does not hold in both | 3.048780488 | -0.2463445645 | 13/11 | 7/10 |
| `15m_ao_rising` | all_signals | helps in both | 2.165354331 | 6.672041927 | 43/18 | 29/51 |
| `15m_ao_saucer_last3` | all_signals | does not hold in both | 6.481481481 | 35.33057851 | 119/42 | 45/72 |
| `15m_ao_zero_cross_last3` | all_signals | does not hold in both | -0.4143646409 | -0.9306827489 | 6/1 | 5/5 |
| `15m_williams_r14` | all_signals | does not hold in both | 6.919006919 | -18.24085006 | 110/40 | 45/62 |
| `15m_rsi14` | all_signals | does not hold in both | 6.446672236 | -4.18555052 | 111/40 | 26/33 |
| `15m_rsi14_bull_divergence` | all_signals | helps in both | 9.848484848 | 4.080578512 | 113/42 | 41/64 |
| `15m_adx14` | all_signals | helps in both | 14.65517241 | 14.87603306 | 89/41 | 36/63 |
| `15m_di_plus14` | all_signals | does not hold in both | 11.70983013 | -3.305785124 | 109/42 | 28/38 |
| `15m_di_minus14` | all_signals | does not hold in both | 6.685906686 | -4.226383513 | 79/33 | 20/22 |
| `15m_atr14_pct` | all_signals | helps in both | 3.815093289 | 3.18772137 | 127/43 | 45/69 |
| `15m_stoch14_3_3_k` | all_signals | does not hold in both | 4.354904355 | -18.61678991 | 111/39 | 44/58 |
| `15m_stoch14_3_3_d` | all_signals | helps in both | 3.815093289 | 10.33057851 | 127/43 | 41/66 |
| `15m_stoch14_3_3_k_gt_d` | all_signals | does not hold in both | 3.439153439 | -5.383707202 | 43/20 | 24/27 |
| `15m_stochrsi14_14_3_3_k` | all_signals | does not hold in both | 12.17948718 | -13.00275482 | 107/42 | 44/62 |
| `15m_stochrsi14_14_3_3_d` | all_signals | does not hold in both | 11.20689655 | -0.538986705 | 91/39 | 39/59 |
| `15m_macd12_26_9_hist_pct` | all_signals | helps in both | 6.052631579 | 4.233017537 | 64/29 | 30/50 |
| `15m_macd12_26_9_hist_sign` | all_signals | does not hold in both | 5.769230769 | -2.169421488 | 78/32 | 36/53 |
| `15m_macd12_26_9_hist_rising` | all_signals | helps in both | 1.315789474 | 3.966942149 | 25/11 | 24/42 |
| `15m_bb20_2_percent_b` | all_signals | helps in both | 3.070175439 | 2.191043629 | 52/22 | 30/48 |
| `15m_bb20_2_width_pct` | all_signals | helps in both | 11.84210526 | 13.27175498 | 108/42 | 39/65 |
| `15m_ema20_distance_pct` | all_signals | does not hold in both | 2.192982456 | -1.89164371 | 53/21 | 31/45 |
| `15m_ema50_distance_pct` | all_signals | helps in both | 3.106508876 | 1.772019954 | 9/10 | 2/8 |
| `15m_ema200_distance_pct` | all_signals | helps in both | 3.678551217 | 30.33057851 | 125/42 | 41/70 |
| `15m_ema50_slope_pct` | all_signals | helps in both | 3.106508876 | 1.772019954 | 9/10 | 2/8 |
| `15m_cci20` | all_signals | does not hold in both | 2.631578947 | -4.375303841 | 82/30 | 36/51 |
| `15m_supertrend10_3_direction` | all_signals | helps in both | 4.404262189 | 1.239669421 | 13/14 | 3/8 |
| `15m_supertrend10_3_distance_pct` | all_signals | helps in both | 4.210526316 | 2.266062383 | 37/20 | 9/19 |
| `1h_williams_fractal_lower_distance_entry_pct` | all_signals | helps in both | 8.386350492 | 14.16666667 | 106/38 | 31/59 |
| `1h_williams_fractal_cascade_broke_last_lower` | all_signals | does not hold in both | 2.593768905 | -3.068273092 | 13/9 | 5/3 |
| `1h_williams_fractal_cascade_lower_broken_count` | all_signals | helps in both | 6.761904762 | 0.640060241 | 104/35 | 17/34 |
| `1h_williams_fractal_entry_recovered_above_broken_lower` | all_signals | does not hold in both | 5.579922027 | -7.58974359 | 98/27 | 20/42 |
| `1h_williams_fractal_upper_distance_entry_pct` | all_signals | helps in both | 5.697563306 | 16.09649123 | 63/27 | 26/56 |
| `1h_williams_fractal_rising_lows` | all_signals | does not hold in both | 0.4053323725 | -0.4166666667 | 45/15 | 16/24 |
| `1h_alligator_state` | all_signals | helps in both | 2.489077188 | 0.5392156863 | 73/26 | 20/32 |
| `1h_alligator_lips_jaw_distance_pct` | all_signals | helps in both | 5.994005994 | 4.166666667 | 93/34 | 34/56 |
| `1h_alligator_state_bars_ago` | all_signals | does not hold in both | 6.934444865 | -4.683908046 | 90/34 | 37/54 |
| `1h_alligator_entry_vs_jaw_pct` | all_signals | helps in both | 2.258015957 | 13.00724638 | 81/28 | 23/51 |
| `1h_alligator_entry_vs_teeth_pct` | all_signals | does not hold in both | 2.258015957 | -2.718068536 | 24/12 | 8/5 |
| `1h_alligator_entry_vs_lips_pct` | all_signals | does not hold in both | 3.523650263 | -3.317610063 | 65/25 | 28/39 |
| `1h_ao_sign` | all_signals | does not hold in both | 3.608448289 | -1.388888889 | 26/15 | 13/17 |
| `1h_ao_rising` | all_signals | does not hold in both | 4.050038012 | -2.996453901 | 11/12 | 13/13 |
| `1h_ao_saucer_last3` | all_signals | does not hold in both | 0.5071851226 | -0.6345565749 | 9/4 | 5/6 |
| `1h_ao_zero_cross_last3` | all_signals | does not hold in both | 1.953601954 | -19.16666667 | 117/38 | 43/57 |
| `1h_williams_r14` | all_signals | does not hold in both | 3.123192597 | -3.452380952 | 123/40 | 32/46 |
| `1h_rsi14` | all_signals | does not hold in both | 7.95960796 | -6.557971014 | 107/38 | 32/42 |
| `1h_rsi14_bull_divergence` | all_signals | does not hold in both | 0.5394605395 | -0.2777777778 | 12/5 | 5/7 |
| `1h_adx14` | all_signals | helps in both | 6.318681319 | 10.83333333 | 92/34 | 35/61 |
| `1h_di_plus14` | all_signals | does not hold in both | 16.06771607 | -10.5952381 | 104/41 | 43/63 |
| `1h_di_minus14` | all_signals | does not hold in both | 9.175824176 | -0.7051282051 | 121/41 | 37/57 |
| `1h_atr14_pct` | all_signals | does not hold in both | 2.357642358 | -10.78828829 | 95/32 | 26/20 |
| `1h_stoch14_3_3_k` | all_signals | does not hold in both | 3.62787897 | -2.12962963 | 80/29 | 27/39 |
| `1h_stoch14_3_3_d` | all_signals | helps in both | 7.812187812 | 9.404761905 | 92/35 | 30/55 |
| `1h_stoch14_3_3_k_gt_d` | all_signals | does not hold in both | 2.436693741 | -0.1422764228 | 84/29 | 31/48 |
| `1h_stochrsi14_14_3_3_k` | all_signals | does not hold in both | 6.744631515 | -0.8333333333 | 48/25 | 24/36 |
| `1h_stochrsi14_14_3_3_d` | all_signals | helps in both | 11.44855145 | 5.277777778 | 90/37 | 39/63 |
| `1h_macd12_26_9_hist_pct` | all_signals | helps in both | 6.593406593 | 14.16666667 | 63/28 | 31/59 |
| `1h_macd12_26_9_hist_sign` | all_signals | does not hold in both | 2.300824176 | -2.324561404 | 13/9 | 12/13 |
| `1h_macd12_26_9_hist_rising` | all_signals | helps in both | 2.300824176 | 3.69047619 | 88/30 | 35/57 |
| `1h_bb20_2_percent_b` | all_signals | does not hold in both | 4.395604396 | -4.880952381 | 65/26 | 23/27 |
| `1h_bb20_2_width_pct` | all_signals | does not hold in both | 8.386350492 | -5.833333333 | 122/41 | 38/55 |
| `1h_ema20_distance_pct` | all_signals | helps in both | 3.074906745 | 4.772727273 | 52/21 | 18/36 |
| `1h_ema50_distance_pct` | all_signals | helps in both | 2.915981656 | 2.406367041 | 38/17 | 10/21 |
| `1h_ema200_distance_pct` | all_signals | helps in both | 3.256760686 | 21.01694915 | 122/40 | 40/68 |
| `1h_ema50_slope_pct` | all_signals | helps in both | 2.915981656 | 2.406367041 | 38/17 | 10/21 |
| `1h_cci20` | all_signals | does not hold in both | 4.490784806 | -4.166666667 | 36/19 | 19/21 |
| `1h_supertrend10_3_direction` | all_signals | helps in both | 3.486169003 | 1.649659864 | 23/14 | 7/15 |
| `1h_supertrend10_3_distance_pct` | all_signals | helps in both | 5.827200323 | 17.1969697 | 49/24 | 16/49 |
| `4h_williams_fractal_lower_distance_entry_pct` | all_signals | helps in both | 9.867724868 | 14.87603306 | 125/44 | 42/68 |
| `4h_williams_fractal_cascade_broke_last_lower` | all_signals | helps in both | 1.756906077 | 1.148781171 | 60/21 | 13/27 |
| `4h_williams_fractal_cascade_lower_broken_count` | all_signals | helps in both | 11.67582418 | 10.70950469 | 89/37 | 16/40 |
| `4h_williams_fractal_entry_recovered_above_broken_lower` | all_signals | does not hold in both | 7.714285714 | -4.88372093 | 60/19 | 12/21 |
| `4h_williams_fractal_upper_distance_entry_pct` | all_signals | helps in both | 9.867724868 | 33.05785124 | 125/44 | 40/70 |
| `4h_williams_fractal_rising_lows` | all_signals | does not hold in both | 2.937900306 | -8.521880504 | 53/22 | 29/31 |
| `4h_alligator_state` | all_signals | helps in both | 4.508196721 | 3.808839382 | 44/22 | 28/47 |
| `4h_alligator_lips_jaw_distance_pct` | all_signals | helps in both | 3.947368421 | 7.552800735 | 51/23 | 31/54 |
| `4h_alligator_state_bars_ago` | all_signals | does not hold in both | 18.33333333 | -4.375303841 | 99/44 | 42/62 |
| `4h_alligator_entry_vs_jaw_pct` | all_signals | helps in both | 2.894736842 | 1.071319253 | 67/26 | 37/57 |
| `4h_alligator_entry_vs_teeth_pct` | all_signals | helps in both | 3.625954198 | 0.1264968797 | 38/19 | 9/14 |
| `4h_alligator_entry_vs_lips_pct` | all_signals | helps in both | 3.947368421 | 26.99724518 | 126/43 | 40/69 |
| `4h_ao_sign` | all_signals | does not hold in both | 1.691729323 | -0.3448275862 | 39/16 | 25/37 |
| `4h_ao_rising` | all_signals | does not hold in both | 2.205882353 | -0.8108108108 | 36/16 | 19/27 |
| `4h_ao_saucer_last3` | all_signals | does not hold in both | 1.129032258 | -1.403508772 | 23/10 | 4/2 |
| `4h_ao_zero_cross_last3` | all_signals | does not hold in both | 6.25 | -20 | 128/44 | 46/64 |
| `4h_williams_r14` | all_signals | helps in both | 9.078251184 | 14.87603306 | 126/44 | 42/68 |
| `4h_rsi14` | all_signals | helps in both | 11.70983013 | 3.808839382 | 109/42 | 38/60 |
| `4h_rsi14_bull_divergence` | all_signals | does not hold in both | 1.836158192 | -2.054742589 | 5/6 | 7/5 |
| `4h_adx14` | all_signals | helps in both | 17.30769231 | 10.33057851 | 105/44 | 42/67 |
| `4h_di_plus14` | all_signals | helps in both | 9.078251184 | 10.33057851 | 126/44 | 39/64 |
| `4h_di_minus14` | all_signals | does not hold in both | 9.867724868 | -0.7805325987 | 125/44 | 41/62 |
| `4h_atr14_pct` | all_signals | does not hold in both | 7.323865219 | -10.68391424 | 95/37 | 28/24 |
| `4h_stoch14_3_3_k` | all_signals | does not hold in both | 2.351168576 | -0.417085039 | 25/13 | 6/8 |
| `4h_stoch14_3_3_d` | all_signals | helps in both | 3.815093289 | 1.997245179 | 37/19 | 23/38 |
| `4h_stoch14_3_3_k_gt_d` | all_signals | helps in both | 4.201058201 | 0.3305785124 | 23/16 | 14/22 |
| `4h_stochrsi14_14_3_3_k` | all_signals | helps in both | 9.210526316 | 1.025641026 | 93/38 | 32/49 |
| `4h_stochrsi14_14_3_3_d` | all_signals | helps in both | 10 | 1.666666667 | 124/44 | 43/65 |
| `4h_macd12_26_9_hist_pct` | all_signals | helps in both | 6.333333333 | 10 | 80/33 | 32/56 |
| `4h_macd12_26_9_hist_sign` | all_signals | helps in both | 1 | 2.666666667 | 46/17 | 16/29 |
| `4h_macd12_26_9_hist_rising` | all_signals | helps in both | 3.205128205 | 1.379310345 | 19/13 | 12/21 |
| `4h_bb20_2_percent_b` | all_signals | helps in both | 14.34140908 | 7.389402042 | 108/43 | 40/64 |
| `4h_bb20_2_width_pct` | all_signals | does not hold in both | 7.323865219 | -10.0919567 | 95/37 | 27/23 |
| `4h_ema20_distance_pct` | all_signals | helps in both | 4.513742567 | 8.717675287 | 52/24 | 18/41 |
| `4h_ema50_distance_pct` | all_signals | does not hold in both | 4.646017699 | -3.940242764 | 51/24 | 15/14 |
| `4h_ema200_distance_pct` | all_signals | helps in both | 11.57328806 | 6.495726496 | 107/41 | 33/54 |
| `4h_ema50_slope_pct` | all_signals | does not hold in both | 4.646017699 | -3.940242764 | 51/24 | 15/14 |
| `4h_cci20` | all_signals | helps in both | 9.078251184 | 5.330578512 | 110/41 | 39/62 |
| `4h_supertrend10_3_direction` | all_signals | does not hold in both | 1.338313103 | -0.2754820937 | 90/31 | 22/33 |
| `4h_supertrend10_3_distance_pct` | all_signals | helps in both | 4.867724868 | 3.573821756 | 66/28 | 16/31 |
| `4h_ichimoku_price_vs_cloud` | all_signals | helps in both | 1.991150442 | 1.044742221 | 54/21 | 32/50 |
| `4h_ichimoku_tenkan_gt_kijun` | all_signals | does not hold in both | 2.142857143 | -9.160946911 | 60/23 | 30/32 |
| `1d_williams_fractal_lower_distance_entry_pct` | all_signals | does not hold in both | 7.051282051 | -3.764934704 | 109/40 | 25/32 |
| `1d_williams_fractal_cascade_broke_last_lower` | all_signals | helps in both | 5.707070707 | 10.82317073 | 119/39 | 20/46 |
| `1d_williams_fractal_cascade_lower_broken_count` | all_signals | helps in both | 11.16161616 | 7.644370586 | 89/36 | 16/38 |
| `1d_williams_fractal_entry_recovered_above_broken_lower` | all_signals | helps in both | 0.5347593583 | 2.916666667 | 4/1 | 0/1 |
| `1d_williams_fractal_upper_distance_entry_pct` | all_signals | does not hold in both | 3.947368421 | -11.42857143 | 126/43 | 46/67 |
| `1d_williams_fractal_rising_lows` | all_signals | does not hold in both | 3.494623656 | -3.933072577 | 68/27 | 33/46 |
| `1d_alligator_state` | all_signals | does not hold in both | 8.783783784 | -14.83050847 | 110/41 | 42/56 |
| `1d_alligator_lips_jaw_distance_pct` | all_signals | does not hold in both | 5.916030534 | -5.163841808 | 35/22 | 21/22 |
| `1d_alligator_state_bars_ago` | all_signals | does not hold in both | 15.90909091 | -6.497175141 | 111/44 | 45/67 |
| `1d_alligator_entry_vs_jaw_pct` | all_signals | does not hold in both | 5.85106383 | -3.245142621 | 65/29 | 17/19 |
| `1d_alligator_entry_vs_teeth_pct` | all_signals | helps in both | 9.210526316 | 3.026634383 | 125/44 | 41/63 |
| `1d_alligator_entry_vs_lips_pct` | all_signals | helps in both | 5 | 10.16949153 | 125/43 | 42/66 |
| `1d_ao_sign` | all_signals | does not hold in both | 0.890123193 | -1.01106854 | 25/10 | 15/20 |
| `1d_ao_rising` | all_signals | helps in both | 2.250562641 | 2.075351213 | 40/17 | 24/38 |
| `1d_ao_saucer_last3` | all_signals | helps in both | 0.1697792869 | 0.04879635654 | 11/4 | 4/6 |
| `1d_ao_zero_cross_last3` | all_signals | does not hold in both | 7.339878448 | -40.51724138 | 121/42 | 47/62 |
| `1d_williams_r14` | all_signals | does not hold in both | 11.20689655 | -19.83050847 | 91/39 | 46/67 |
| `1d_rsi14` | all_signals | helps in both | 7.75862069 | 17.31234867 | 93/37 | 39/65 |
| `1d_rsi14_bull_divergence` | all_signals | does not hold in both | 0.03982477101 | -0.5482986615 | 18/6 | 5/6 |
| `1d_adx14` | all_signals | helps in both | 3.678551217 | 4.482758621 | 110/38 | 38/58 |
| `1d_di_plus14` | all_signals | does not hold in both | 11.84210526 | -2.988403211 | 108/42 | 26/35 |
| `1d_di_minus14` | all_signals | does not hold in both | 7.105263158 | -4.536390828 | 63/30 | 23/27 |
| `1d_atr14_pct` | all_signals | does not hold in both | 16.22807018 | -8.251561106 | 89/42 | 41/58 |
| `1d_stoch14_3_3_k` | all_signals | does not hold in both | 9.210526316 | -1.368970013 | 77/35 | 42/63 |
| `1d_stoch14_3_3_d` | all_signals | does not hold in both | 14.74358974 | 26.83615819 | 106/43 | 43/69 |
| `1d_stoch14_3_3_k_gt_d` | all_signals | does not hold in both | 5.733944954 | -11.56963891 | 53/26 | 34/38 |
| `1d_stochrsi14_14_3_3_k` | all_signals | helps in both | 14.20486701 | 16.62561576 | 89/40 | 43/66 |
| `1d_stochrsi14_14_3_3_d` | all_signals | does not hold in both | 14.20486701 | -0.5172413793 | 89/40 | 43/63 |
| `1d_macd12_26_9_hist_pct` | all_signals | does not hold in both | 3.302611367 | -3.56071964 | 52/22 | 13/11 |
| `1d_macd12_26_9_hist_sign` | all_signals | does not hold in both | 1.475368842 | -5.132625995 | 107/36 | 24/27 |
| `1d_macd12_26_9_hist_rising` | all_signals | does not hold in both | 5.403451703 | -3.931875526 | 44/23 | 32/43 |
| `1d_bb20_2_percent_b` | all_signals | helps in both | 5.263157895 | 18.50282486 | 80/32 | 40/66 |
| `1d_bb20_2_width_pct` | all_signals | does not hold in both | 10.10638298 | -10.52016365 | 61/33 | 30/30 |
| `1d_ema20_distance_pct` | all_signals | does not hold in both | 7.666666667 | -2.330508475 | 79/34 | 14/16 |
| `1d_ema50_distance_pct` | all_signals | does not hold in both | 6.467181467 | -4.153605016 | 94/35 | 27/34 |
| `1d_ema200_distance_pct` | all_signals | helps in both | 11.72927002 | 13.00539084 | 97/35 | 28/50 |
| `1d_ema50_slope_pct` | all_signals | does not hold in both | 6.467181467 | -4.153605016 | 94/35 | 27/34 |
| `1d_cci20` | all_signals | helps in both | 3.947368421 | 12.80107047 | 66/27 | 37/62 |
| `1d_supertrend10_3_direction` | all_signals | helps in both | 2.142857143 | 1.54880187 | 114/39 | 35/54 |
| `1d_supertrend10_3_distance_pct` | all_signals | does not hold in both | 3.761061947 | -4.946787544 | 52/23 | 17/15 |
| `1d_ichimoku_price_vs_cloud` | all_signals | does not hold in both | 4.137931034 | -7.01754386 | 120/39 | 43/62 |
| `1d_ichimoku_tenkan_gt_kijun` | all_signals | does not hold in both | 5.812263877 | -1.282051282 | 80/32 | 33/48 |
| `price_growth_24h_before_cascade_pct` | all_signals | helps in both | 4.285604959 | 22.78679937 | 78/28 | 15/45 |
| `price_growth_7d_before_cascade_pct` | all_signals | helps in both | 10.98978514 | 13.22701689 | 69/30 | 21/48 |
| `price_growth_30d_before_cascade_pct` | all_signals | does not hold in both | 7.724574084 | -1.075268817 | 27/18 | 7/12 |
| `15m_williams_fractal_lower_distance_entry_pct` | passes_current_candle_gate | no threshold (minimum sample not met) | — | — | — | names unavailable |
| `15m_williams_fractal_cascade_broke_last_lower` | passes_current_candle_gate | no threshold (minimum sample not met) | — | — | — | names unavailable |
| `15m_williams_fractal_cascade_lower_broken_count` | passes_current_candle_gate | no threshold (minimum sample not met) | — | — | — | names unavailable |
| `15m_williams_fractal_entry_recovered_above_broken_lower` | passes_current_candle_gate | no threshold (minimum sample not met) | — | — | — | names unavailable |
| `15m_williams_fractal_upper_distance_entry_pct` | passes_current_candle_gate | no threshold (minimum sample not met) | — | — | — | names unavailable |
| `15m_williams_fractal_rising_lows` | passes_current_candle_gate | no threshold (minimum sample not met) | — | — | — | names unavailable |
| `15m_alligator_state` | passes_current_candle_gate | no threshold (minimum sample not met) | — | — | — | names unavailable |
| `15m_alligator_lips_jaw_distance_pct` | passes_current_candle_gate | no threshold (minimum sample not met) | — | — | — | names unavailable |
| `15m_alligator_state_bars_ago` | passes_current_candle_gate | no threshold (minimum sample not met) | — | — | — | names unavailable |
| `15m_alligator_entry_vs_jaw_pct` | passes_current_candle_gate | no threshold (minimum sample not met) | — | — | — | names unavailable |
| `15m_alligator_entry_vs_teeth_pct` | passes_current_candle_gate | no threshold (minimum sample not met) | — | — | — | names unavailable |
| `15m_alligator_entry_vs_lips_pct` | passes_current_candle_gate | no threshold (minimum sample not met) | — | — | — | names unavailable |
| `15m_ao_sign` | passes_current_candle_gate | no threshold (minimum sample not met) | — | — | — | names unavailable |
| `15m_ao_rising` | passes_current_candle_gate | no threshold (minimum sample not met) | — | — | — | names unavailable |
| `15m_ao_saucer_last3` | passes_current_candle_gate | no threshold (minimum sample not met) | — | — | — | names unavailable |
| `15m_ao_zero_cross_last3` | passes_current_candle_gate | no threshold (minimum sample not met) | — | — | — | names unavailable |
| `15m_williams_r14` | passes_current_candle_gate | no threshold (minimum sample not met) | — | — | — | names unavailable |
| `15m_rsi14` | passes_current_candle_gate | no threshold (minimum sample not met) | — | — | — | names unavailable |
| `15m_rsi14_bull_divergence` | passes_current_candle_gate | no threshold (minimum sample not met) | — | — | — | names unavailable |
| `15m_adx14` | passes_current_candle_gate | no threshold (minimum sample not met) | — | — | — | names unavailable |
| `15m_di_plus14` | passes_current_candle_gate | no threshold (minimum sample not met) | — | — | — | names unavailable |
| `15m_di_minus14` | passes_current_candle_gate | no threshold (minimum sample not met) | — | — | — | names unavailable |
| `15m_atr14_pct` | passes_current_candle_gate | no threshold (minimum sample not met) | — | — | — | names unavailable |
| `15m_stoch14_3_3_k` | passes_current_candle_gate | no threshold (minimum sample not met) | — | — | — | names unavailable |
| `15m_stoch14_3_3_d` | passes_current_candle_gate | no threshold (minimum sample not met) | — | — | — | names unavailable |
| `15m_stoch14_3_3_k_gt_d` | passes_current_candle_gate | no threshold (minimum sample not met) | — | — | — | names unavailable |
| `15m_stochrsi14_14_3_3_k` | passes_current_candle_gate | no threshold (minimum sample not met) | — | — | — | names unavailable |
| `15m_stochrsi14_14_3_3_d` | passes_current_candle_gate | no threshold (minimum sample not met) | — | — | — | names unavailable |
| `15m_macd12_26_9_hist_pct` | passes_current_candle_gate | no threshold (minimum sample not met) | — | — | — | names unavailable |
| `15m_macd12_26_9_hist_sign` | passes_current_candle_gate | no threshold (minimum sample not met) | — | — | — | names unavailable |
| `15m_macd12_26_9_hist_rising` | passes_current_candle_gate | no threshold (minimum sample not met) | — | — | — | names unavailable |
| `15m_bb20_2_percent_b` | passes_current_candle_gate | no threshold (minimum sample not met) | — | — | — | names unavailable |
| `15m_bb20_2_width_pct` | passes_current_candle_gate | no threshold (minimum sample not met) | — | — | — | names unavailable |
| `15m_ema20_distance_pct` | passes_current_candle_gate | no threshold (minimum sample not met) | — | — | — | names unavailable |
| `15m_ema50_distance_pct` | passes_current_candle_gate | no threshold (minimum sample not met) | — | — | — | names unavailable |
| `15m_ema200_distance_pct` | passes_current_candle_gate | no threshold (minimum sample not met) | — | — | — | names unavailable |
| `15m_ema50_slope_pct` | passes_current_candle_gate | no threshold (minimum sample not met) | — | — | — | names unavailable |
| `15m_cci20` | passes_current_candle_gate | no threshold (minimum sample not met) | — | — | — | names unavailable |
| `15m_supertrend10_3_direction` | passes_current_candle_gate | no threshold (minimum sample not met) | — | — | — | names unavailable |
| `15m_supertrend10_3_distance_pct` | passes_current_candle_gate | no threshold (minimum sample not met) | — | — | — | names unavailable |
| `1h_williams_fractal_lower_distance_entry_pct` | passes_current_candle_gate | no threshold (minimum sample not met) | — | — | — | names unavailable |
| `1h_williams_fractal_cascade_broke_last_lower` | passes_current_candle_gate | no threshold (minimum sample not met) | — | — | — | names unavailable |
| `1h_williams_fractal_cascade_lower_broken_count` | passes_current_candle_gate | no threshold (minimum sample not met) | — | — | — | names unavailable |
| `1h_williams_fractal_entry_recovered_above_broken_lower` | passes_current_candle_gate | no threshold (minimum sample not met) | — | — | — | names unavailable |
| `1h_williams_fractal_upper_distance_entry_pct` | passes_current_candle_gate | no threshold (minimum sample not met) | — | — | — | names unavailable |
| `1h_williams_fractal_rising_lows` | passes_current_candle_gate | no threshold (minimum sample not met) | — | — | — | names unavailable |
| `1h_alligator_state` | passes_current_candle_gate | no threshold (minimum sample not met) | — | — | — | names unavailable |
| `1h_alligator_lips_jaw_distance_pct` | passes_current_candle_gate | no threshold (minimum sample not met) | — | — | — | names unavailable |
| `1h_alligator_state_bars_ago` | passes_current_candle_gate | no threshold (minimum sample not met) | — | — | — | names unavailable |
| `1h_alligator_entry_vs_jaw_pct` | passes_current_candle_gate | no threshold (minimum sample not met) | — | — | — | names unavailable |
| `1h_alligator_entry_vs_teeth_pct` | passes_current_candle_gate | no threshold (minimum sample not met) | — | — | — | names unavailable |
| `1h_alligator_entry_vs_lips_pct` | passes_current_candle_gate | no threshold (minimum sample not met) | — | — | — | names unavailable |
| `1h_ao_sign` | passes_current_candle_gate | no threshold (minimum sample not met) | — | — | — | names unavailable |
| `1h_ao_rising` | passes_current_candle_gate | no threshold (minimum sample not met) | — | — | — | names unavailable |
| `1h_ao_saucer_last3` | passes_current_candle_gate | no threshold (minimum sample not met) | — | — | — | names unavailable |
| `1h_ao_zero_cross_last3` | passes_current_candle_gate | no threshold (minimum sample not met) | — | — | — | names unavailable |
| `1h_williams_r14` | passes_current_candle_gate | no threshold (minimum sample not met) | — | — | — | names unavailable |
| `1h_rsi14` | passes_current_candle_gate | no threshold (minimum sample not met) | — | — | — | names unavailable |
| `1h_rsi14_bull_divergence` | passes_current_candle_gate | no threshold (minimum sample not met) | — | — | — | names unavailable |
| `1h_adx14` | passes_current_candle_gate | no threshold (minimum sample not met) | — | — | — | names unavailable |
| `1h_di_plus14` | passes_current_candle_gate | no threshold (minimum sample not met) | — | — | — | names unavailable |
| `1h_di_minus14` | passes_current_candle_gate | no threshold (minimum sample not met) | — | — | — | names unavailable |
| `1h_atr14_pct` | passes_current_candle_gate | no threshold (minimum sample not met) | — | — | — | names unavailable |
| `1h_stoch14_3_3_k` | passes_current_candle_gate | no threshold (minimum sample not met) | — | — | — | names unavailable |
| `1h_stoch14_3_3_d` | passes_current_candle_gate | no threshold (minimum sample not met) | — | — | — | names unavailable |
| `1h_stoch14_3_3_k_gt_d` | passes_current_candle_gate | no threshold (minimum sample not met) | — | — | — | names unavailable |
| `1h_stochrsi14_14_3_3_k` | passes_current_candle_gate | no threshold (minimum sample not met) | — | — | — | names unavailable |
| `1h_stochrsi14_14_3_3_d` | passes_current_candle_gate | no threshold (minimum sample not met) | — | — | — | names unavailable |
| `1h_macd12_26_9_hist_pct` | passes_current_candle_gate | no threshold (minimum sample not met) | — | — | — | names unavailable |
| `1h_macd12_26_9_hist_sign` | passes_current_candle_gate | no threshold (minimum sample not met) | — | — | — | names unavailable |
| `1h_macd12_26_9_hist_rising` | passes_current_candle_gate | no threshold (minimum sample not met) | — | — | — | names unavailable |
| `1h_bb20_2_percent_b` | passes_current_candle_gate | no threshold (minimum sample not met) | — | — | — | names unavailable |
| `1h_bb20_2_width_pct` | passes_current_candle_gate | no threshold (minimum sample not met) | — | — | — | names unavailable |
| `1h_ema20_distance_pct` | passes_current_candle_gate | no threshold (minimum sample not met) | — | — | — | names unavailable |
| `1h_ema50_distance_pct` | passes_current_candle_gate | no threshold (minimum sample not met) | — | — | — | names unavailable |
| `1h_ema200_distance_pct` | passes_current_candle_gate | no threshold (minimum sample not met) | — | — | — | names unavailable |
| `1h_ema50_slope_pct` | passes_current_candle_gate | no threshold (minimum sample not met) | — | — | — | names unavailable |
| `1h_cci20` | passes_current_candle_gate | no threshold (minimum sample not met) | — | — | — | names unavailable |
| `1h_supertrend10_3_direction` | passes_current_candle_gate | no threshold (minimum sample not met) | — | — | — | names unavailable |
| `1h_supertrend10_3_distance_pct` | passes_current_candle_gate | no threshold (minimum sample not met) | — | — | — | names unavailable |
| `4h_williams_fractal_lower_distance_entry_pct` | passes_current_candle_gate | no threshold (minimum sample not met) | — | — | — | names unavailable |
| `4h_williams_fractal_cascade_broke_last_lower` | passes_current_candle_gate | no threshold (minimum sample not met) | — | — | — | names unavailable |
| `4h_williams_fractal_cascade_lower_broken_count` | passes_current_candle_gate | no threshold (minimum sample not met) | — | — | — | names unavailable |
| `4h_williams_fractal_entry_recovered_above_broken_lower` | passes_current_candle_gate | no threshold (minimum sample not met) | — | — | — | names unavailable |
| `4h_williams_fractal_upper_distance_entry_pct` | passes_current_candle_gate | no threshold (minimum sample not met) | — | — | — | names unavailable |
| `4h_williams_fractal_rising_lows` | passes_current_candle_gate | no threshold (minimum sample not met) | — | — | — | names unavailable |
| `4h_alligator_state` | passes_current_candle_gate | no threshold (minimum sample not met) | — | — | — | names unavailable |
| `4h_alligator_lips_jaw_distance_pct` | passes_current_candle_gate | no threshold (minimum sample not met) | — | — | — | names unavailable |
| `4h_alligator_state_bars_ago` | passes_current_candle_gate | no threshold (minimum sample not met) | — | — | — | names unavailable |
| `4h_alligator_entry_vs_jaw_pct` | passes_current_candle_gate | no threshold (minimum sample not met) | — | — | — | names unavailable |
| `4h_alligator_entry_vs_teeth_pct` | passes_current_candle_gate | no threshold (minimum sample not met) | — | — | — | names unavailable |
| `4h_alligator_entry_vs_lips_pct` | passes_current_candle_gate | no threshold (minimum sample not met) | — | — | — | names unavailable |
| `4h_ao_sign` | passes_current_candle_gate | no threshold (minimum sample not met) | — | — | — | names unavailable |
| `4h_ao_rising` | passes_current_candle_gate | no threshold (minimum sample not met) | — | — | — | names unavailable |
| `4h_ao_saucer_last3` | passes_current_candle_gate | no threshold (minimum sample not met) | — | — | — | names unavailable |
| `4h_ao_zero_cross_last3` | passes_current_candle_gate | no threshold (minimum sample not met) | — | — | — | names unavailable |
| `4h_williams_r14` | passes_current_candle_gate | no threshold (minimum sample not met) | — | — | — | names unavailable |
| `4h_rsi14` | passes_current_candle_gate | no threshold (minimum sample not met) | — | — | — | names unavailable |
| `4h_rsi14_bull_divergence` | passes_current_candle_gate | no threshold (minimum sample not met) | — | — | — | names unavailable |
| `4h_adx14` | passes_current_candle_gate | no threshold (minimum sample not met) | — | — | — | names unavailable |
| `4h_di_plus14` | passes_current_candle_gate | no threshold (minimum sample not met) | — | — | — | names unavailable |
| `4h_di_minus14` | passes_current_candle_gate | no threshold (minimum sample not met) | — | — | — | names unavailable |
| `4h_atr14_pct` | passes_current_candle_gate | no threshold (minimum sample not met) | — | — | — | names unavailable |
| `4h_stoch14_3_3_k` | passes_current_candle_gate | no threshold (minimum sample not met) | — | — | — | names unavailable |
| `4h_stoch14_3_3_d` | passes_current_candle_gate | no threshold (minimum sample not met) | — | — | — | names unavailable |
| `4h_stoch14_3_3_k_gt_d` | passes_current_candle_gate | no threshold (minimum sample not met) | — | — | — | names unavailable |
| `4h_stochrsi14_14_3_3_k` | passes_current_candle_gate | no threshold (minimum sample not met) | — | — | — | names unavailable |
| `4h_stochrsi14_14_3_3_d` | passes_current_candle_gate | no threshold (minimum sample not met) | — | — | — | names unavailable |
| `4h_macd12_26_9_hist_pct` | passes_current_candle_gate | no threshold (minimum sample not met) | — | — | — | names unavailable |
| `4h_macd12_26_9_hist_sign` | passes_current_candle_gate | no threshold (minimum sample not met) | — | — | — | names unavailable |
| `4h_macd12_26_9_hist_rising` | passes_current_candle_gate | no threshold (minimum sample not met) | — | — | — | names unavailable |
| `4h_bb20_2_percent_b` | passes_current_candle_gate | no threshold (minimum sample not met) | — | — | — | names unavailable |
| `4h_bb20_2_width_pct` | passes_current_candle_gate | no threshold (minimum sample not met) | — | — | — | names unavailable |
| `4h_ema20_distance_pct` | passes_current_candle_gate | no threshold (minimum sample not met) | — | — | — | names unavailable |
| `4h_ema50_distance_pct` | passes_current_candle_gate | no threshold (minimum sample not met) | — | — | — | names unavailable |
| `4h_ema200_distance_pct` | passes_current_candle_gate | no threshold (minimum sample not met) | — | — | — | names unavailable |
| `4h_ema50_slope_pct` | passes_current_candle_gate | no threshold (minimum sample not met) | — | — | — | names unavailable |
| `4h_cci20` | passes_current_candle_gate | no threshold (minimum sample not met) | — | — | — | names unavailable |
| `4h_supertrend10_3_direction` | passes_current_candle_gate | no threshold (minimum sample not met) | — | — | — | names unavailable |
| `4h_supertrend10_3_distance_pct` | passes_current_candle_gate | no threshold (minimum sample not met) | — | — | — | names unavailable |
| `4h_ichimoku_price_vs_cloud` | passes_current_candle_gate | no threshold (minimum sample not met) | — | — | — | names unavailable |
| `4h_ichimoku_tenkan_gt_kijun` | passes_current_candle_gate | no threshold (minimum sample not met) | — | — | — | names unavailable |
| `1d_williams_fractal_lower_distance_entry_pct` | passes_current_candle_gate | no threshold (minimum sample not met) | — | — | — | names unavailable |
| `1d_williams_fractal_cascade_broke_last_lower` | passes_current_candle_gate | no threshold (minimum sample not met) | — | — | — | names unavailable |
| `1d_williams_fractal_cascade_lower_broken_count` | passes_current_candle_gate | no threshold (minimum sample not met) | — | — | — | names unavailable |
| `1d_williams_fractal_entry_recovered_above_broken_lower` | passes_current_candle_gate | no threshold (minimum sample not met) | — | — | — | names unavailable |
| `1d_williams_fractal_upper_distance_entry_pct` | passes_current_candle_gate | no threshold (minimum sample not met) | — | — | — | names unavailable |
| `1d_williams_fractal_rising_lows` | passes_current_candle_gate | no threshold (minimum sample not met) | — | — | — | names unavailable |
| `1d_alligator_state` | passes_current_candle_gate | no threshold (minimum sample not met) | — | — | — | names unavailable |
| `1d_alligator_lips_jaw_distance_pct` | passes_current_candle_gate | no threshold (minimum sample not met) | — | — | — | names unavailable |
| `1d_alligator_state_bars_ago` | passes_current_candle_gate | no threshold (minimum sample not met) | — | — | — | names unavailable |
| `1d_alligator_entry_vs_jaw_pct` | passes_current_candle_gate | no threshold (minimum sample not met) | — | — | — | names unavailable |
| `1d_alligator_entry_vs_teeth_pct` | passes_current_candle_gate | no threshold (minimum sample not met) | — | — | — | names unavailable |
| `1d_alligator_entry_vs_lips_pct` | passes_current_candle_gate | no threshold (minimum sample not met) | — | — | — | names unavailable |
| `1d_ao_sign` | passes_current_candle_gate | no threshold (minimum sample not met) | — | — | — | names unavailable |
| `1d_ao_rising` | passes_current_candle_gate | no threshold (minimum sample not met) | — | — | — | names unavailable |
| `1d_ao_saucer_last3` | passes_current_candle_gate | no threshold (minimum sample not met) | — | — | — | names unavailable |
| `1d_ao_zero_cross_last3` | passes_current_candle_gate | no threshold (minimum sample not met) | — | — | — | names unavailable |
| `1d_williams_r14` | passes_current_candle_gate | no threshold (minimum sample not met) | — | — | — | names unavailable |
| `1d_rsi14` | passes_current_candle_gate | no threshold (minimum sample not met) | — | — | — | names unavailable |
| `1d_rsi14_bull_divergence` | passes_current_candle_gate | no threshold (minimum sample not met) | — | — | — | names unavailable |
| `1d_adx14` | passes_current_candle_gate | no threshold (minimum sample not met) | — | — | — | names unavailable |
| `1d_di_plus14` | passes_current_candle_gate | no threshold (minimum sample not met) | — | — | — | names unavailable |
| `1d_di_minus14` | passes_current_candle_gate | no threshold (minimum sample not met) | — | — | — | names unavailable |
| `1d_atr14_pct` | passes_current_candle_gate | no threshold (minimum sample not met) | — | — | — | names unavailable |
| `1d_stoch14_3_3_k` | passes_current_candle_gate | no threshold (minimum sample not met) | — | — | — | names unavailable |
| `1d_stoch14_3_3_d` | passes_current_candle_gate | no threshold (minimum sample not met) | — | — | — | names unavailable |
| `1d_stoch14_3_3_k_gt_d` | passes_current_candle_gate | no threshold (minimum sample not met) | — | — | — | names unavailable |
| `1d_stochrsi14_14_3_3_k` | passes_current_candle_gate | no threshold (minimum sample not met) | — | — | — | names unavailable |
| `1d_stochrsi14_14_3_3_d` | passes_current_candle_gate | no threshold (minimum sample not met) | — | — | — | names unavailable |
| `1d_macd12_26_9_hist_pct` | passes_current_candle_gate | no threshold (minimum sample not met) | — | — | — | names unavailable |
| `1d_macd12_26_9_hist_sign` | passes_current_candle_gate | no threshold (minimum sample not met) | — | — | — | names unavailable |
| `1d_macd12_26_9_hist_rising` | passes_current_candle_gate | no threshold (minimum sample not met) | — | — | — | names unavailable |
| `1d_bb20_2_percent_b` | passes_current_candle_gate | no threshold (minimum sample not met) | — | — | — | names unavailable |
| `1d_bb20_2_width_pct` | passes_current_candle_gate | no threshold (minimum sample not met) | — | — | — | names unavailable |
| `1d_ema20_distance_pct` | passes_current_candle_gate | no threshold (minimum sample not met) | — | — | — | names unavailable |
| `1d_ema50_distance_pct` | passes_current_candle_gate | no threshold (minimum sample not met) | — | — | — | names unavailable |
| `1d_ema200_distance_pct` | passes_current_candle_gate | no threshold (minimum sample not met) | — | — | — | names unavailable |
| `1d_ema50_slope_pct` | passes_current_candle_gate | no threshold (minimum sample not met) | — | — | — | names unavailable |
| `1d_cci20` | passes_current_candle_gate | no threshold (minimum sample not met) | — | — | — | names unavailable |
| `1d_supertrend10_3_direction` | passes_current_candle_gate | no threshold (minimum sample not met) | — | — | — | names unavailable |
| `1d_supertrend10_3_distance_pct` | passes_current_candle_gate | no threshold (minimum sample not met) | — | — | — | names unavailable |
| `1d_ichimoku_price_vs_cloud` | passes_current_candle_gate | no threshold (minimum sample not met) | — | — | — | names unavailable |
| `1d_ichimoku_tenkan_gt_kijun` | passes_current_candle_gate | no threshold (minimum sample not met) | — | — | — | names unavailable |
| `price_growth_24h_before_cascade_pct` | passes_current_candle_gate | no threshold (minimum sample not met) | — | — | — | names unavailable |
| `price_growth_7d_before_cascade_pct` | passes_current_candle_gate | no threshold (minimum sample not met) | — | — | — | names unavailable |
| `price_growth_30d_before_cascade_pct` | passes_current_candle_gate | no threshold (minimum sample not met) | — | — | — | names unavailable |

## Пороги, сохранившие uplift в обоих периодах

- 15m_williams_fractal_lower_distance_entry_pct (all_signals, train Δ 2.456140351 pp, validation Δ 0.5604635699 pp)
- 15m_williams_fractal_entry_recovered_above_broken_lower (all_signals, train Δ 0.8046170697 pp, validation Δ 3.137039075 pp)
- 15m_williams_fractal_rising_lows (all_signals, train Δ 0.2775609333 pp, validation Δ 6.276524458 pp)
- 15m_alligator_lips_jaw_distance_pct (all_signals, train Δ 5 pp, validation Δ 3.18772137 pp)
- 15m_alligator_entry_vs_lips_pct (all_signals, train Δ 7.105263158 pp, validation Δ 1.239669421 pp)
- 15m_ao_rising (all_signals, train Δ 2.165354331 pp, validation Δ 6.672041927 pp)
- 15m_rsi14_bull_divergence (all_signals, train Δ 9.848484848 pp, validation Δ 4.080578512 pp)
- 15m_adx14 (all_signals, train Δ 14.65517241 pp, validation Δ 14.87603306 pp)
- 15m_atr14_pct (all_signals, train Δ 3.815093289 pp, validation Δ 3.18772137 pp)
- 15m_stoch14_3_3_d (all_signals, train Δ 3.815093289 pp, validation Δ 10.33057851 pp)
- 15m_macd12_26_9_hist_pct (all_signals, train Δ 6.052631579 pp, validation Δ 4.233017537 pp)
- 15m_macd12_26_9_hist_rising (all_signals, train Δ 1.315789474 pp, validation Δ 3.966942149 pp)
- 15m_bb20_2_percent_b (all_signals, train Δ 3.070175439 pp, validation Δ 2.191043629 pp)
- 15m_bb20_2_width_pct (all_signals, train Δ 11.84210526 pp, validation Δ 13.27175498 pp)
- 15m_ema50_distance_pct (all_signals, train Δ 3.106508876 pp, validation Δ 1.772019954 pp)
- 15m_ema200_distance_pct (all_signals, train Δ 3.678551217 pp, validation Δ 30.33057851 pp)
- 15m_ema50_slope_pct (all_signals, train Δ 3.106508876 pp, validation Δ 1.772019954 pp)
- 15m_supertrend10_3_direction (all_signals, train Δ 4.404262189 pp, validation Δ 1.239669421 pp)
- 15m_supertrend10_3_distance_pct (all_signals, train Δ 4.210526316 pp, validation Δ 2.266062383 pp)
- 1h_williams_fractal_lower_distance_entry_pct (all_signals, train Δ 8.386350492 pp, validation Δ 14.16666667 pp)
- 1h_williams_fractal_cascade_lower_broken_count (all_signals, train Δ 6.761904762 pp, validation Δ 0.640060241 pp)
- 1h_williams_fractal_upper_distance_entry_pct (all_signals, train Δ 5.697563306 pp, validation Δ 16.09649123 pp)
- 1h_alligator_state (all_signals, train Δ 2.489077188 pp, validation Δ 0.5392156863 pp)
- 1h_alligator_lips_jaw_distance_pct (all_signals, train Δ 5.994005994 pp, validation Δ 4.166666667 pp)
- 1h_alligator_entry_vs_jaw_pct (all_signals, train Δ 2.258015957 pp, validation Δ 13.00724638 pp)
- 1h_adx14 (all_signals, train Δ 6.318681319 pp, validation Δ 10.83333333 pp)
- 1h_stoch14_3_3_d (all_signals, train Δ 7.812187812 pp, validation Δ 9.404761905 pp)
- 1h_stochrsi14_14_3_3_d (all_signals, train Δ 11.44855145 pp, validation Δ 5.277777778 pp)
- 1h_macd12_26_9_hist_pct (all_signals, train Δ 6.593406593 pp, validation Δ 14.16666667 pp)
- 1h_macd12_26_9_hist_rising (all_signals, train Δ 2.300824176 pp, validation Δ 3.69047619 pp)
- 1h_ema20_distance_pct (all_signals, train Δ 3.074906745 pp, validation Δ 4.772727273 pp)
- 1h_ema50_distance_pct (all_signals, train Δ 2.915981656 pp, validation Δ 2.406367041 pp)
- 1h_ema200_distance_pct (all_signals, train Δ 3.256760686 pp, validation Δ 21.01694915 pp)
- 1h_ema50_slope_pct (all_signals, train Δ 2.915981656 pp, validation Δ 2.406367041 pp)
- 1h_supertrend10_3_direction (all_signals, train Δ 3.486169003 pp, validation Δ 1.649659864 pp)
- 1h_supertrend10_3_distance_pct (all_signals, train Δ 5.827200323 pp, validation Δ 17.1969697 pp)
- 4h_williams_fractal_lower_distance_entry_pct (all_signals, train Δ 9.867724868 pp, validation Δ 14.87603306 pp)
- 4h_williams_fractal_cascade_broke_last_lower (all_signals, train Δ 1.756906077 pp, validation Δ 1.148781171 pp)
- 4h_williams_fractal_cascade_lower_broken_count (all_signals, train Δ 11.67582418 pp, validation Δ 10.70950469 pp)
- 4h_williams_fractal_upper_distance_entry_pct (all_signals, train Δ 9.867724868 pp, validation Δ 33.05785124 pp)
- 4h_alligator_state (all_signals, train Δ 4.508196721 pp, validation Δ 3.808839382 pp)
- 4h_alligator_lips_jaw_distance_pct (all_signals, train Δ 3.947368421 pp, validation Δ 7.552800735 pp)
- 4h_alligator_entry_vs_jaw_pct (all_signals, train Δ 2.894736842 pp, validation Δ 1.071319253 pp)
- 4h_alligator_entry_vs_teeth_pct (all_signals, train Δ 3.625954198 pp, validation Δ 0.1264968797 pp)
- 4h_alligator_entry_vs_lips_pct (all_signals, train Δ 3.947368421 pp, validation Δ 26.99724518 pp)
- 4h_williams_r14 (all_signals, train Δ 9.078251184 pp, validation Δ 14.87603306 pp)
- 4h_rsi14 (all_signals, train Δ 11.70983013 pp, validation Δ 3.808839382 pp)
- 4h_adx14 (all_signals, train Δ 17.30769231 pp, validation Δ 10.33057851 pp)
- 4h_di_plus14 (all_signals, train Δ 9.078251184 pp, validation Δ 10.33057851 pp)
- 4h_stoch14_3_3_d (all_signals, train Δ 3.815093289 pp, validation Δ 1.997245179 pp)
- 4h_stoch14_3_3_k_gt_d (all_signals, train Δ 4.201058201 pp, validation Δ 0.3305785124 pp)
- 4h_stochrsi14_14_3_3_k (all_signals, train Δ 9.210526316 pp, validation Δ 1.025641026 pp)
- 4h_stochrsi14_14_3_3_d (all_signals, train Δ 10 pp, validation Δ 1.666666667 pp)
- 4h_macd12_26_9_hist_pct (all_signals, train Δ 6.333333333 pp, validation Δ 10 pp)
- 4h_macd12_26_9_hist_sign (all_signals, train Δ 1 pp, validation Δ 2.666666667 pp)
- 4h_macd12_26_9_hist_rising (all_signals, train Δ 3.205128205 pp, validation Δ 1.379310345 pp)
- 4h_bb20_2_percent_b (all_signals, train Δ 14.34140908 pp, validation Δ 7.389402042 pp)
- 4h_ema20_distance_pct (all_signals, train Δ 4.513742567 pp, validation Δ 8.717675287 pp)
- 4h_ema200_distance_pct (all_signals, train Δ 11.57328806 pp, validation Δ 6.495726496 pp)
- 4h_cci20 (all_signals, train Δ 9.078251184 pp, validation Δ 5.330578512 pp)
- 4h_supertrend10_3_distance_pct (all_signals, train Δ 4.867724868 pp, validation Δ 3.573821756 pp)
- 4h_ichimoku_price_vs_cloud (all_signals, train Δ 1.991150442 pp, validation Δ 1.044742221 pp)
- 1d_williams_fractal_cascade_broke_last_lower (all_signals, train Δ 5.707070707 pp, validation Δ 10.82317073 pp)
- 1d_williams_fractal_cascade_lower_broken_count (all_signals, train Δ 11.16161616 pp, validation Δ 7.644370586 pp)
- 1d_williams_fractal_entry_recovered_above_broken_lower (all_signals, train Δ 0.5347593583 pp, validation Δ 2.916666667 pp)
- 1d_alligator_entry_vs_teeth_pct (all_signals, train Δ 9.210526316 pp, validation Δ 3.026634383 pp)
- 1d_alligator_entry_vs_lips_pct (all_signals, train Δ 5 pp, validation Δ 10.16949153 pp)
- 1d_ao_rising (all_signals, train Δ 2.250562641 pp, validation Δ 2.075351213 pp)
- 1d_ao_saucer_last3 (all_signals, train Δ 0.1697792869 pp, validation Δ 0.04879635654 pp)
- 1d_rsi14 (all_signals, train Δ 7.75862069 pp, validation Δ 17.31234867 pp)
- 1d_adx14 (all_signals, train Δ 3.678551217 pp, validation Δ 4.482758621 pp)
- 1d_stochrsi14_14_3_3_k (all_signals, train Δ 14.20486701 pp, validation Δ 16.62561576 pp)
- 1d_bb20_2_percent_b (all_signals, train Δ 5.263157895 pp, validation Δ 18.50282486 pp)
- 1d_ema200_distance_pct (all_signals, train Δ 11.72927002 pp, validation Δ 13.00539084 pp)
- 1d_cci20 (all_signals, train Δ 3.947368421 pp, validation Δ 12.80107047 pp)
- 1d_supertrend10_3_direction (all_signals, train Δ 2.142857143 pp, validation Δ 1.54880187 pp)
- price_growth_24h_before_cascade_pct (all_signals, train Δ 4.285604959 pp, validation Δ 22.78679937 pp)
- price_growth_7d_before_cascade_pct (all_signals, train Δ 10.98978514 pp, validation Δ 13.22701689 pp)

## Pairwise combinations of top five

- Нет пар с положительным сдвигом и минимум 3 champion/3 bad в обеих частях.

## SQL, реально выполненные (PRODUCTION; все READ-ONLY)

1. Cohort count: `SELECT COUNT(*) AS lc_total, COUNT(DISTINCT symbol) AS symbols, MIN(detected_at) AS first_detected, MAX(detected_at) AS last_detected, COUNT(*) FILTER (WHERE status = 'reclassified') AS reclassified FROM tracked_signals WHERE sentiment_key = 'liquidation_cascade' AND detected_at >= '2026-07-14' AND upper(symbol) NOT LIKE 'BTC%';`
2. Status counts: `SELECT status::text AS status, COUNT(*) AS n FROM tracked_signals WHERE sentiment_key='liquidation_cascade' AND detected_at >= '2026-07-14' AND upper(symbol) NOT LIKE 'BTC%' GROUP BY status ORDER BY status;`
3. JSON keys: `SELECT k.key, COUNT(*) AS n FROM tracked_signals t CROSS JOIN LATERAL jsonb_object_keys(COALESCE(t.decision_metrics,'{}'::jsonb)) AS k(key) WHERE t.sentiment_key='liquidation_cascade' AND t.detected_at >= '2026-07-14' AND upper(t.symbol) NOT LIKE 'BTC%' GROUP BY k.key ORDER BY n DESC,k.key;`
4. Reclassified snapshot/version coverage: `SELECT status::text, COUNT(*) AS n, COUNT(*) FILTER (WHERE decision_metrics ? 'beforeNeutralClose') AS has_before_neutral_close, COUNT(*) FILTER (WHERE decision_metrics ?| ARRAY['ruleVersion','rule_version','version','sourceVersion']) AS has_version_key FROM tracked_signals WHERE sentiment_key='liquidation_cascade' AND detected_at >= '2026-07-14' AND upper(symbol) NOT LIKE 'BTC%' GROUP BY status::text ORDER BY status::text;`
5. Schema reads: tracked_signals columns: `SELECT column_name,data_type FROM information_schema.columns WHERE table_schema='public' AND table_name='tracked_signals' AND column_name IN ('id','symbol','detected_at','entry_price','status','pnl_percent','cancel_reason','decision_metrics','decision_reason','rule_version','source_version','exit_price','peak_price') ORDER BY ordinal_position;`; liq_cascade_watch columns: `SELECT column_name,data_type FROM information_schema.columns WHERE table_schema='public' AND table_name='liq_cascade_watch' ORDER BY ordinal_position;`
6. Watch linkage by candidate count and status: `SELECT COALESCE(x.n,0) AS candidate_watches,t.status::text AS status,COUNT(*) AS signals FROM tracked_signals t LEFT JOIN LATERAL (SELECT COUNT(*)::int AS n FROM liq_cascade_watch w WHERE w.signal_id=t.id AND w.detected_at<=t.detected_at AND w.expires_at>=t.detected_at) x ON true WHERE t.sentiment_key='liquidation_cascade' AND t.detected_at>='2026-07-14' AND upper(t.symbol)<>'BTC-USDT' GROUP BY 1,2 ORDER BY 1,2;`
7. Signal data export (five monthly parameter windows): `SELECT row_to_json(x) FROM (SELECT t.id,t.symbol,t.detected_at,t.entry_price,t.status::text AS status,t.pnl_percent,t.cancel_reason,t.decision_metrics->'beforeNeutralClose' AS before_neutral_close,NULL::text AS rule_version,w.id AS watch_id,w.detected_at AS watch_detected_at,w.expires_at AS watch_expires_at,w.candidate_count AS linked_watch_candidates FROM tracked_signals t LEFT JOIN LATERAL (SELECT id,detected_at,expires_at,COUNT(*) OVER() AS candidate_count FROM liq_cascade_watch WHERE signal_id=t.id AND detected_at<=t.detected_at AND expires_at>=t.detected_at ORDER BY detected_at DESC,id DESC LIMIT 1) w ON true WHERE t.sentiment_key='liquidation_cascade' AND t.detected_at >= $1::timestamp AND t.detected_at < $2::timestamp AND upper(t.symbol)<>'BTC-USDT' ORDER BY t.detected_at,t.id) x;`
   Parameters: [2026-07-14, 2026-08-01), [2026-08-01, 2026-09-01), [2026-09-01, 2026-10-01), [2026-10-01, 2026-11-01), [2026-11-01, 2026-12-01).

No non-SELECT query was run; no schema or bot code changed, no tests were run, and no CoinGlass request was made.
