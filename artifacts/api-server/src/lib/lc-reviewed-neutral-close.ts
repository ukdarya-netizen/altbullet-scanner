import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

export const LC_REVIEWED_NEUTRAL_CLOSE_REASON =
  "lc_owner_reviewed_not_relevant";

// Exact tracker/signal/symbol identity; later XAUT signals stay untouched.
export const LC_REVIEWED_NEUTRAL_CLOSE_TARGETS = [
  [2089, 17082, "XAUT-USDT", "liquidation_cascade"],
  [2141, 17317, "SOON-USDT", "liquidation_cascade"],
  [2142, 17319, "BOME-USDT", "liquidation_cascade"],
  [2143, 17322, "PONS-USDT", "liquidation_cascade"],
  [2144, 17325, "0G-USDT", "liquidation_cascade"],
  // Stealth Range 0G: owner chose neutral close (2026-10-07).
  [2165, 17511, "0G-USDT", "stealth_breakout"],
  // Owner 2026-10-07 (tightened): range 5-10% detection candle (18 rows).
  [2200, 17643, "UAI-USDT", "liquidation_cascade"],
  [2258, 17883, "SAGA-USDT", "liquidation_cascade"],
  [2224, 17725, "HEMI-USDT", "liquidation_cascade"],
  [2184, 17583, "XAI-USDT", "liquidation_cascade"],
  [2171, 17533, "CORE-USDT", "liquidation_cascade"],
  [2218, 17705, "CFG-USDT", "liquidation_cascade"],
  [2197, 17631, "ARIA-USDT", "liquidation_cascade"],
  [2192, 17611, "LA-USDT", "liquidation_cascade"],
  [2254, 17865, "LPT-USDT", "liquidation_cascade"],
  [2238, 17793, "LSK-USDT", "liquidation_cascade"],
  [2208, 17677, "MANTA-USDT", "liquidation_cascade"],
  [2274, 18025, "ONE-USDT", "liquidation_cascade"],
  [2269, 17973, "CYBER-USDT", "liquidation_cascade"],
  [2267, 17957, "ALICE-USDT", "liquidation_cascade"],
  [2194, 17619, "CT-USDT", "liquidation_cascade"],
  [2177, 17563, "MMT-USDT", "liquidation_cascade"],
  [2221, 17713, "VTHO-USDT", "liquidation_cascade"],
  [2166, 17519, "FORM-USDT", "liquidation_cascade"],
  // Owner 2026-10-07: open LC whose detection 15m candle fails the speed gate
  // (range < 8% and lower wick < 4%) are neutral-closed (91 rows).
  [2277, 18058, "XLM-USDT", "liquidation_cascade"],
  [2215, 17699, "S-USDT", "liquidation_cascade"],
  [2225, 17731, "RE-USDT", "liquidation_cascade"],
  [2255, 17869, "GRT-USDT", "liquidation_cascade"],
  [2247, 17829, "WLD-USDT", "liquidation_cascade"],
  [2196, 17629, "AIXBT-USDT", "liquidation_cascade"],
  [2198, 17633, "BANK-USDT", "liquidation_cascade"],
  [2260, 17889, "SKY-USDT", "liquidation_cascade"],
  [2185, 17585, "G-USDT", "liquidation_cascade"],
  [2237, 17791, "USELESS-USDT", "liquidation_cascade"],
  [2207, 17671, "DEXE-USDT", "liquidation_cascade"],
  [2158, 17395, "FARTCOIN-USDT", "liquidation_cascade"],
  [2186, 17587, "ASTER-USDT", "liquidation_cascade"],
  [2188, 17595, "XTZ-USDT", "liquidation_cascade"],
  [2220, 17711, "DASH-USDT", "liquidation_cascade"],
  [2222, 17715, "CRV-USDT", "liquidation_cascade"],
  [2264, 17927, "TIA-USDT", "liquidation_cascade"],
  [2240, 17799, "CAKE-USDT", "liquidation_cascade"],
  [2205, 17659, "KAITO-USDT", "liquidation_cascade"],
  [2210, 17683, "1000PEPE-USDT", "liquidation_cascade"],
  [2151, 17347, "ONDO-USDT", "liquidation_cascade"],
  [2212, 17689, "ZK-USDT", "liquidation_cascade"],
  [2239, 17795, "2Z-USDT", "liquidation_cascade"],
  [2227, 17735, "NEO-USDT", "liquidation_cascade"],
  [2187, 17593, "PEOPLE-USDT", "liquidation_cascade"],
  [2256, 17871, "QTUM-USDT", "liquidation_cascade"],
  [2195, 17627, "BASED-USDT", "liquidation_cascade"],
  [2279, 18079, "SPX-USDT", "liquidation_cascade"],
  [2176, 17553, "REZ-USDT", "liquidation_cascade"],
  [2189, 17597, "ROBO-USDT", "liquidation_cascade"],
  [2193, 17615, "RENDER-USDT", "liquidation_cascade"],
  [2241, 17809, "CHZ-USDT", "liquidation_cascade"],
  [2252, 17859, "STRK-USDT", "liquidation_cascade"],
  [2271, 17999, "FIL-USDT", "liquidation_cascade"],
  [2272, 18001, "MANA-USDT", "liquidation_cascade"],
  [2204, 17651, "SUSHI-USDT", "liquidation_cascade"],
  [2169, 17529, "APT-USDT", "liquidation_cascade"],
  [2243, 17813, "ALT-USDT", "liquidation_cascade"],
  [2170, 17531, "XPL-USDT", "liquidation_cascade"],
  [2265, 17929, "OP-USDT", "liquidation_cascade"],
  [2249, 17833, "TAO-USDT", "liquidation_cascade"],
  [2191, 17605, "ALGO-USDT", "liquidation_cascade"],
  [2209, 17681, "JUP-USDT", "liquidation_cascade"],
  [2211, 17685, "GMT-USDT", "liquidation_cascade"],
  [2178, 17565, "SEI-USDT", "liquidation_cascade"],
  [2179, 17567, "ORDI-USDT", "liquidation_cascade"],
  [2180, 17571, "YGG-USDT", "liquidation_cascade"],
  [2181, 17573, "IOST-USDT", "liquidation_cascade"],
  [2250, 17835, "ARB-USDT", "liquidation_cascade"],
  [2270, 17979, "ZRO-USDT", "liquidation_cascade"],
  [2219, 17709, "ZEN-USDT", "liquidation_cascade"],
  [2199, 17639, "ENA-USDT", "liquidation_cascade"],
  [2201, 17645, "PONS-USDT", "liquidation_cascade"],
  [2213, 17693, "WIF-USDT", "liquidation_cascade"],
  [2214, 17697, "AERO-USDT", "liquidation_cascade"],
  [2216, 17701, "KAVA-USDT", "liquidation_cascade"],
  [2246, 17827, "AR-USDT", "liquidation_cascade"],
  [2248, 17831, "PYTH-USDT", "liquidation_cascade"],
  [2257, 17875, "1000SHIB-USDT", "liquidation_cascade"],
  [2259, 17885, "COTI-USDT", "liquidation_cascade"],
  [2276, 18049, "PUMP-USDT", "liquidation_cascade"],
  [2168, 17523, "DYDX-USDT", "liquidation_cascade"],
  [2223, 17717, "CFX-USDT", "liquidation_cascade"],
  [2232, 17776, "IOTA-USDT", "liquidation_cascade"],
  [2233, 17777, "ESPORTS-USDT", "liquidation_cascade"],
  [2234, 17781, "ME-USDT", "liquidation_cascade"],
  [2228, 17757, "STX-USDT", "liquidation_cascade"],
  [2244, 17815, "1INCH-USDT", "liquidation_cascade"],
  [2245, 17821, "POPCAT-USDT", "liquidation_cascade"],
  [2263, 17909, "UMA-USDT", "liquidation_cascade"],
  [2278, 18065, "TRIA-USDT", "liquidation_cascade"],
  [2261, 17897, "BEAT-USDT", "liquidation_cascade"],
  [2172, 17543, "ZAMA-USDT", "liquidation_cascade"],
  [2173, 17547, "SLX-USDT", "liquidation_cascade"],
  [2175, 17551, "PENDLE-USDT", "liquidation_cascade"],
  [2182, 17577, "EIGEN-USDT", "liquidation_cascade"],
  [2183, 17579, "PTB-USDT", "liquidation_cascade"],
  [2167, 17521, "MEGA-USDT", "liquidation_cascade"],
  [2268, 17968, "1000BONK-USDT", "liquidation_cascade"],
  [2275, 18045, "APE-USDT", "liquidation_cascade"],
  [2226, 17733, "GIGGLE-USDT", "liquidation_cascade"],
  [2280, 18087, "EVAA-USDT", "liquidation_cascade"],
  [2231, 17773, "PNUT-USDT", "liquidation_cascade"],
  [2217, 17703, "VET-USDT", "liquidation_cascade"],
  [2242, 17811, "DGAI-USDT", "liquidation_cascade"],
  [2206, 17661, "POL-USDT", "liquidation_cascade"],
  [2266, 17945, "ENS-USDT", "liquidation_cascade"],
  [2251, 17855, "MARSCOIN-USDT", "liquidation_cascade"],
  [2230, 17771, "BERA-USDT", "liquidation_cascade"],
  [2236, 17789, "SOPH-USDT", "liquidation_cascade"],
  [2273, 18009, "LDO-USDT", "liquidation_cascade"],
] as const;

/**
 * One-time production correction: owner-reviewed open LC positions become
 * neutral (no PnL, close time or outcome). Only rows still open are touched.
 */
export async function neutralCloseReviewedLcPositions(): Promise<number> {
  if (process.env.NODE_ENV !== "production") return 0;
  return db.transaction(async (tx) => {
    for (const [trackedId] of LC_REVIEWED_NEUTRAL_CLOSE_TARGETS) {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext('lc_reviewed_milestone'), ${trackedId})`,
      );
    }
    const reason = LC_REVIEWED_NEUTRAL_CLOSE_REASON;
    let count = 0;
    for (const [
      trackedId,
      signalId,
      symbol,
      sentimentKey,
    ] of LC_REVIEWED_NEUTRAL_CLOSE_TARGETS) {
      const updated = await tx.execute(sql`
        UPDATE tracked_signals
           SET status = 'reclassified', cancel_reason = ${reason},
               exit_price = NULL, pnl_percent = NULL, closed_at = NULL,
               trailing_stop_level = NULL,
               trailing_stop_armed_at = NULL,
               pending_milestone = NULL, pending_milestone_kind = NULL,
               pending_milestone_price = NULL,
               pending_milestone_trailing_stop = NULL,
               pending_milestone_status = NULL,
               pending_milestone_lease_until = NULL,
               last_smart_cancel_check_at = NULL, updated_at = NOW()
         WHERE id = ${trackedId} AND signal_id = ${signalId}
           AND symbol = ${symbol} AND sentiment_key = ${sentimentKey}
           AND status IN ('active', 'in_run')
         RETURNING id
      `);
      if (updated.rows.length === 0) continue;
      count += 1;
      await tx.execute(sql`
        UPDATE milestone_notification_deliveries
           SET status = 'abandoned', lease_until = NULL, claim_token = NULL,
               last_error = ${reason}
         WHERE tracked_signal_id = ${trackedId}
           AND status IN ('ready', 'failed')
      `);
    }
    return count;
  });
}
