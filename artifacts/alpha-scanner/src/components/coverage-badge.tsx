/** Compact exchange-coverage badge — mirrors Telegram message labels [Spot]/[BingX]/[Multi]. */
export function CoverageBadge({
  isBingxExclusive,
  isBinanceSpotListed,
}: {
  isBingxExclusive?: boolean | null;
  isBinanceSpotListed?: boolean | null;
}) {
  if (isBingxExclusive) {
    return (
      <span
        title="BingX-exclusive: нет данных Binance spot / CoinGlass futures"
        className="text-[9px] font-mono px-1 py-0.5 rounded border bg-zinc-500/20 text-zinc-400 border-zinc-500/30 whitespace-nowrap leading-none"
      >
        [BingX]
      </span>
    );
  }
  if (isBinanceSpotListed) {
    return (
      <span
        title="Листингован на Binance spot"
        className="text-[9px] font-mono px-1 py-0.5 rounded border bg-green-500/20 text-green-400 border-green-500/30 whitespace-nowrap leading-none"
      >
        [Spot]
      </span>
    );
  }
  // Neither exclusive nor Binance spot → multi-exchange futures token
  return (
    <span
      title="Несколько фьючерсных бирж — без Binance spot"
      className="text-[9px] font-mono px-1 py-0.5 rounded border bg-blue-500/20 text-blue-400 border-blue-500/30 whitespace-nowrap leading-none"
    >
      [Multi]
    </span>
  );
}
