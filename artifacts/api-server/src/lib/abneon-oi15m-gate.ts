/**
 * ABNeon entry gate: new money (owner 2026-11-13). The aggregated OI change of the 15m candle at the fire must be
 * above +0.18%. On 45 closed ABNeon with the fire-time OI 15m (since 2026-10-21): OI ≤ +0.18% — 27 signals, 11 stops,
 * 3 reached +8% (INIT, MARSCOIN, ZEST); OI > +0.18% — 18 signals, 2 stops, 13 reached +8%. After the exit the
 * stops did not turn up (2 of 18 later traded 8% above the entry). Unknown OI = no signal (aggregated data rule).
 * Open signals are not touched; review with the owner on 2026-11-30.
 */
export const ABNEON_OI15M_MIN_PCT = 0.18;

export type AbneonOi15mGate = { pass: boolean; oi15mPct: number | null; reason: "ok" | "oi15m_unknown" | "oi15m_no_new_money" };

export function evaluateAbneonOi15mGate(oi15mPct: number | null): AbneonOi15mGate {
  if (oi15mPct === null || !Number.isFinite(oi15mPct)) return { pass: false, oi15mPct: null, reason: "oi15m_unknown" };
  return oi15mPct > ABNEON_OI15M_MIN_PCT
    ? { pass: true, oi15mPct, reason: "ok" }
    : { pass: false, oi15mPct, reason: "oi15m_no_new_money" };
}
