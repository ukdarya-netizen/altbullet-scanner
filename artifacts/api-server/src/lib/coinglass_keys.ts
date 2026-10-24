/**
 * Round-robin ротация CoinGlass API ключей.
 * Единственный ключ — секрет CoinGlassAPI. Другие переменные COINGLASS_API_KEY* игнорируются:
 * устаревший ключ давал прерывистый "Invalid API key" в проде.
 * При rate-limit 429 — ключ логируется и ротация продолжается.
 */
import { logger } from "./logger.js";

const CG_API_KEYS = [process.env.CoinGlassAPI]
  .map((key) => key?.trim())
  .filter((key): key is string => Boolean(key))
  .filter((key, index, all) => all.indexOf(key) === index);

let _cgKeyIndex = 0;

/** Возвращает следующий CG ключ по round-robin. null если ключей нет. */
export function getNextCgKey(): string | null {
  if (CG_API_KEYS.length === 0) return null;
  const key = CG_API_KEYS[_cgKeyIndex % CG_API_KEYS.length];
  _cgKeyIndex++;
  return key;
}

/** Логирует 429 rate-limit с суффиксом ключа. */
export function logCg429(key: string, context?: Record<string, unknown>): void {
  logger.warn(
    { ...context, key: key.slice(-4), totalKeys: CG_API_KEYS.length },
    "CoinGlass rate limit 429 — ключ исчерпан",
  );
}
