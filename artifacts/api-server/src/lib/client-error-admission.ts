export type ClientErrorAdmission = "accept" | "duplicate" | "rate_limited";

const DEDUP_WINDOW_MS = 5 * 60_000;
const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT = 30;
const MAX_KEYS = 2_000;

export function createClientErrorAdmission(
  now: () => number = Date.now,
): (key: string) => ClientErrorAdmission {
  const seen = new Map<string, number>();
  let rateWindowStartedAt = now();
  let acceptedInWindow = 0;

  return (key) => {
    const timestamp = now();
    if (timestamp - rateWindowStartedAt >= RATE_WINDOW_MS) {
      rateWindowStartedAt = timestamp;
      acceptedInWindow = 0;
    }

    const previous = seen.get(key);
    if (previous !== undefined && timestamp - previous < DEDUP_WINDOW_MS) {
      return "duplicate";
    }
    if (acceptedInWindow >= RATE_LIMIT) return "rate_limited";

    if (seen.size >= MAX_KEYS) {
      for (const [storedKey, storedAt] of seen) {
        if (timestamp - storedAt >= DEDUP_WINDOW_MS) seen.delete(storedKey);
      }
      if (seen.size >= MAX_KEYS)
        seen.delete(seen.keys().next().value as string);
    }
    seen.set(key, timestamp);
    acceptedInWindow += 1;
    return "accept";
  };
}
