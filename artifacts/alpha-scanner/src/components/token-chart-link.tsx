import { Link } from "wouter";
import { CandlestickChart } from "lucide-react";

export function TokenChartLink({
  symbol,
  className = "font-mono font-semibold text-primary",
}: {
  symbol: string;
  className?: string;
}) {
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap">
      <span className={className}>{symbol.replace("-USDT", "")}</span>
      <Link
        href={`/charts/${encodeURIComponent(symbol)}`}
        onClick={(event) => event.stopPropagation()}
        className="inline-flex h-6 w-6 items-center justify-center rounded-sm text-muted-foreground hover:bg-muted hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        title={`Открыть наш график ${symbol}`}
        aria-label={`Открыть наш график ${symbol}`}
      >
        <CandlestickChart className="h-4 w-4" aria-hidden="true" />
      </Link>
    </span>
  );
}
