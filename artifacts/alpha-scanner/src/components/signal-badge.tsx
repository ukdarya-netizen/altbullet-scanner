import { Badge } from "@/components/ui/badge";

export function SignalBadge({ type }: { type: string }) {
  if (type === "super_alpha") {
    return (
      <Badge
        variant="outline"
        className="bg-yellow-400/15 text-yellow-300 border-yellow-400/40 font-mono rounded-none text-xs tracking-wider"
      >
        ⚡⚡ SUPER BULLET
      </Badge>
    );
  }
  if (type === "alpha") {
    return (
      <Badge
        variant="outline"
        className="bg-blue-500/15 text-blue-300 border-blue-500/30 font-mono rounded-none text-xs tracking-wider"
      >
        ⚡ BULLET
      </Badge>
    );
  }
  if (type === "short_sniper") {
    return (
      <Badge
        variant="outline"
        className="bg-red-500/20 text-red-300 border-red-500/50 font-mono rounded-none text-xs tracking-wider"
      >
        📉 SHORT SNIPER
      </Badge>
    );
  }
  if (type === "strict_alpha") {
    return (
      <Badge
        variant="outline"
        className="bg-amber-500/15 text-amber-400 border-amber-500/30 font-mono rounded-none text-xs"
      >
        🔥 STRICT BULLET
      </Badge>
    );
  }
  if (type === "volume_spike") {
    return (
      <Badge
        variant="outline"
        className="bg-blue-500/10 text-blue-500 border-blue-500/20 font-mono rounded-none text-xs"
      >
        VOL_SPIKE
      </Badge>
    );
  }
  if (type === "oi_increase") {
    return (
      <Badge
        variant="outline"
        className="bg-green-500/10 text-green-500 border-green-500/20 font-mono rounded-none text-xs"
      >
        OI_INC
      </Badge>
    );
  }
  if (type === "funding_rate") {
    return (
      <Badge
        variant="outline"
        className="bg-purple-500/10 text-purple-400 border-purple-500/20 font-mono rounded-none text-xs"
      >
        FUNDING
      </Badge>
    );
  }

  return (
    <Badge variant="outline" className="font-mono rounded-none text-xs">
      {type.toUpperCase()}
    </Badge>
  );
}
