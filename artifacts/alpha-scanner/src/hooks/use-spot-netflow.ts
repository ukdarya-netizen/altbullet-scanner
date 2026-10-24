import { useQuery } from "@tanstack/react-query";

const API_BASE = import.meta.env.BASE_URL.replace(/\/$/, "");
const SPOT_NETFLOW_REFRESH_MS = 5 * 60 * 1000;

export interface SnfEntry {
  netPct1h: number | null;
  netPct4h: number | null;
  netPct24h: number | null;
  netPct7d: number | null;
}

interface SpotNetflowResponse {
  entries: Record<string, SnfEntry>;
}

async function fetchSpotNetflow(): Promise<SpotNetflowResponse> {
  const response = await fetch(`${API_BASE}/api/scanner/spot-netflow`, {
    cache: "no-store",
  });
  if (!response.ok) {
    throw new Error(`Spot NetFlow request failed (${response.status})`);
  }
  return response.json();
}

/**
 * All dashboard tabs share one React Query entry and one bounded five-minute
 * refresh. The API only exposes the watcher-owned server cache.
 */
export function useSpotNetflow(): Map<string, SnfEntry> {
  const { data } = useQuery({
    queryKey: ["spot-netflow"],
    queryFn: fetchSpotNetflow,
    staleTime: SPOT_NETFLOW_REFRESH_MS,
    refetchInterval: SPOT_NETFLOW_REFRESH_MS,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: false,
    retry: 1,
  });

  return new Map(Object.entries(data?.entries ?? {}));
}
