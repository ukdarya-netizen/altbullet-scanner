import { useSearch } from "wouter";
import SignalHistory from "@/pages/signal-history";
import LcRepeatWatchPanel from "@/components/lc-repeat-watch-panel";
import LcWaitingShadowPanel from "@/components/lc-waiting-shadow-panel";
import LcRapidReboundPanel from "@/components/lc-rapid-rebound-panel";
import TradingCommandsPanel from "@/components/trading-commands-panel";
import { getStoredUser } from "@/hooks/useAuth";

export default function Analytics() {
  const search = useSearch();
  const params = new URLSearchParams(search);
  const symbolFromUrl = params.get("symbol") ?? undefined;

  return (
    <div className="space-y-8">
      <SignalHistory initialSymbol={symbolFromUrl} />
      {getStoredUser()?.role === "owner" && (
        <>
          <LcRepeatWatchPanel />
          <LcWaitingShadowPanel />
          <LcRapidReboundPanel />
          <TradingCommandsPanel />
        </>
      )}
    </div>
  );
}
