import { Badge } from "@/components/ui/badge";
import { getPatternTgLabel } from "@/lib/pattern-labels";

const PATTERN_COLORS: Record<string, string> = {
  bullish_accumulation: "bg-green-500/15 text-green-300 border-green-500/30",
  liquidation_cascade: "bg-orange-500/15 text-orange-300 border-orange-500/30",
  whale_watch: "bg-green-500/15 text-green-300 border-green-500/30",
  balanced_grind: "bg-yellow-500/15 text-yellow-300 border-yellow-500/30",
  stealth_breakout: "bg-blue-500/15 text-blue-300 border-blue-500/30",
  neon_support_bounce: "bg-pink-500/15 text-pink-300 border-pink-500/30",
  price_led_momentum: "bg-violet-500/15 text-violet-300 border-violet-500/30",
  impulse_buy: "bg-cyan-500/15 text-cyan-200 border-cyan-500/30",
};

export function SentimentBadge({ sentimentKey }: { sentimentKey: string }) {
  const className =
    PATTERN_COLORS[sentimentKey] ??
    "bg-muted/30 text-muted-foreground border-border";
  return (
    <Badge
      variant="outline"
      className={`font-mono rounded-none text-xs whitespace-nowrap ${className}`}
    >
      {getPatternTgLabel(sentimentKey)}
    </Badge>
  );
}
