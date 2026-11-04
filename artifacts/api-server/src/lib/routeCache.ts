interface CacheEntry {
  data: unknown;
  expiresAt: number;
}

const _cache = new Map<string, CacheEntry>();

export function getCached<T>(key: string): T | undefined {
  const entry = _cache.get(key);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) {
    _cache.delete(key);
    return undefined;
  }
  return entry.data as T;
}

export function setCached(key: string, data: unknown, ttlMs: number): void {
  _cache.set(key, { data, expiresAt: Date.now() + ttlMs });
}

export function invalidateByPrefix(prefix: string): void {
  for (const key of _cache.keys()) {
    if (key.startsWith(prefix)) _cache.delete(key);
  }
}
