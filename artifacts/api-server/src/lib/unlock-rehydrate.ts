export interface UnlockInfo {
  daysUntil: number; // calendar days until unlock (0 = today / imminent)
  pctSupply: number; // % of circulating supply being unlocked
  unlockTime: number; // Unix timestamp (ms)
}

/** Recompute day counts from stored unlock times and drop passed events. */
export function rehydrateUnlocks(
  entries: Array<[string, UnlockInfo]>,
  now: number,
): Map<string, UnlockInfo> {
  const out = new Map<string, UnlockInfo>();
  for (const [sym, info] of entries) {
    if (info.unlockTime < now - 3_600_000) continue;
    out.set(sym, {
      ...info,
      daysUntil: Math.max(0, Math.floor((info.unlockTime - now) / 86_400_000)),
    });
  }
  return out;
}
