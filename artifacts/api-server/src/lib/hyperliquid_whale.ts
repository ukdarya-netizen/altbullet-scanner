/**
 * CoinGlass — Hyperliquid Whale Positions.
 *
 * Endpoints:
 *   GET /api/hyperliquid/whale-position  — текущие открытые позиции китов
 *
 * Семантика полей (доки CoinGlass не рендерятся, проверено по живым данным):
 *   position_size   — размер в токенах, знак = сторона (отриц. = шорт)
 *   position_action — 1 = открытие, 2 = закрытие (действуем только на 1)
 *   create_time     — unix ms
 */

/**
 * Маппинг HL base symbol → BingX pair.
 * HL использует k-префикс для 1000-контрактов (kPEPE = 1000 PEPE),
 * BingX — префикс "1000" (1000PEPE-USDT).
 * Возвращает BingX pair если торгуется, иначе null.
 *
 * @param hlBase        HL base symbol, напр. "HYPE" / "kPEPE"
 * @param bingxSymbols  Set всех BingX пар вида "XXX-USDT"
 */
export function mapHlSymbolToBingx(
  hlBase: string,
  bingxSymbols: Set<string>,
): string | null {
  const base = hlBase.trim();
  if (!base) return null;

  // k-префикс: kPEPE → 1000PEPE-USDT (fallback: PEPE-USDT)
  if (/^k[A-Z0-9]+$/.test(base)) {
    const rest = base.slice(1);
    const k1000 = `1000${rest}-USDT`;
    if (bingxSymbols.has(k1000)) return k1000;
    const plain = `${rest}-USDT`;
    if (bingxSymbols.has(plain)) return plain;
    return null;
  }

  const direct = `${base.toUpperCase()}-USDT`;
  if (bingxSymbols.has(direct)) return direct;
  return null;
}
