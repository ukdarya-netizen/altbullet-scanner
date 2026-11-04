type MemberCandidateData<
  TPrescan extends {
    symbol: string;
    layers?: string[];
    lastPrice24h?: number | null;
    lastPrice?: number | null;
    lastScore?: number | null;
    lastOi30m?: number | null;
    lastOi1h?: number | null;
    lastOi4h?: number | null;
    spotVolCycles?: number | null;
    spotVolMult?: number | null;
  },
  TCycle extends {
    symbol: string;
    layers: string[];
    price24h?: number | null;
    price?: number | null;
    score?: number | null;
    lastOi30m?: number | null;
    lastOi1h?: number | null;
    lastOi4h?: number | null;
  },
  TOiWatch extends {
    symbol: string;
  },
> = {
  prescan: TPrescan[];
  cycleCandidates: TCycle[];
  cycleAt: number | null;
  oiWatch: TOiWatch[];
};

type MemberTokenRow = {
  symbol: string;
  layers: string[];
  price24h: number | null;
  price: number | null;
  score: number | null;
  oi30m: number | null;
  oi1h: number | null;
  oi4h: number | null;
};

function finiteOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function validLayerTags(layers: string[] | undefined): string[] {
  return (layers ?? []).filter((layer) => /^L[1-8][a-z]?$/.test(layer));
}

export function normalizeMemberSearchQuery(query: unknown): string {
  return String(query ?? "")
    .trim()
    .toLowerCase()
    .slice(0, 80);
}

export function getScannerCandidatesCacheKey(
  isOwner: boolean,
  limit: number,
  offset: number,
  normalizedQuery = "",
): string {
  if (isOwner) return `scanner:candidates:${limit}:${offset}`;
  return `scanner:candidates:member:${limit}:${offset}:${normalizedQuery}`;
}

export function buildMemberScannerCandidatesResponse<
  TPrescan extends {
    symbol: string;
    layers?: string[];
    lastPrice24h?: number | null;
    lastPrice?: number | null;
    lastScore?: number | null;
    lastOi30m?: number | null;
    lastOi1h?: number | null;
    lastOi4h?: number | null;
    spotVolCycles?: number | null;
    spotVolMult?: number | null;
  },
  TCycle extends {
    symbol: string;
    layers: string[];
    price24h?: number | null;
    price?: number | null;
    score?: number | null;
    lastOi30m?: number | null;
    lastOi1h?: number | null;
    lastOi4h?: number | null;
  },
  TOiWatch extends {
    symbol: string;
  },
>(
  data: MemberCandidateData<TPrescan, TCycle, TOiWatch>,
  offset: number,
  limit: number,
  liqCascadeSymbols: string[],
  normalizedQuery: string,
) {
  const matchesQuery = (symbol: string) =>
    symbol.toLowerCase().includes(normalizedQuery);
  const prescanCandidates = data.prescan.filter((entry) =>
    matchesQuery(entry.symbol),
  );
  const oiWatchCandidates = data.oiWatch.filter((entry) =>
    matchesQuery(entry.symbol),
  );
  const spotCandidates = data.prescan
    .filter((entry) => (entry.spotVolCycles ?? 0) >= 1)
    .filter((entry) => matchesQuery(entry.symbol));
  const currentBySymbol = new Map<string, TPrescan | TCycle>();
  for (const entry of data.prescan) currentBySymbol.set(entry.symbol, entry);
  // The cycle snapshot is the most direct current entry when both sources exist.
  for (const entry of data.cycleCandidates)
    currentBySymbol.set(entry.symbol, entry);

  const projectEntry = (
    symbol: string,
    entry: TPrescan | TCycle | undefined,
  ): Omit<MemberTokenRow, "layers"> => {
    const isPrescan = entry != null && "lastPrice" in entry;
    return {
      symbol,
      price24h: finiteOrNull(
        isPrescan
          ? (entry as TPrescan).lastPrice24h
          : (entry as TCycle | undefined)?.price24h,
      ),
      price: finiteOrNull(
        isPrescan
          ? (entry as TPrescan).lastPrice
          : (entry as TCycle | undefined)?.price,
      ),
      score: finiteOrNull(
        isPrescan
          ? (entry as TPrescan).lastScore
          : (entry as TCycle | undefined)?.score,
      ),
      oi30m: finiteOrNull(
        isPrescan
          ? (entry as TPrescan).lastOi30m
          : (entry as TCycle | undefined)?.lastOi30m,
      ),
      oi1h: finiteOrNull(
        isPrescan
          ? (entry as TPrescan).lastOi1h
          : (entry as TCycle | undefined)?.lastOi1h,
      ),
      oi4h: finiteOrNull(
        isPrescan
          ? (entry as TPrescan).lastOi4h
          : (entry as TCycle | undefined)?.lastOi4h,
      ),
    };
  };
  const paginate = <T>(rows: T[]) => {
    const pageOffset = Math.max(Math.ceil(rows.length / limit) - 1, 0) * limit;
    const currentOffset = Math.min(offset, pageOffset);
    return {
      rows: rows.slice(currentOffset, currentOffset + limit),
      total: rows.length,
      offset: currentOffset,
      nextOffset:
        currentOffset + limit < rows.length ? currentOffset + limit : null,
    };
  };
  const paginatedPrescan = paginate(prescanCandidates);
  const paginatedOiWatch = paginate(oiWatchCandidates);
  const paginatedSpot = paginate(spotCandidates);
  const fromCurrentEntry = (symbol: string) =>
    projectEntry(symbol, currentBySymbol.get(symbol));

  return {
    cycleCandidates: [],
    cycleAt: data.cycleAt,
    prescan: [],
    totalPrescan: 0,
    oiWatch: [],
    totalOiWatch: 0,
    nextOffset: null,
    memberView: {
      prescan: paginatedPrescan.rows.map((entry) => ({
        ...projectEntry(entry.symbol, entry),
        layers: validLayerTags(entry.layers),
      })),
      totalPrescan: paginatedPrescan.total,
      prescanOffset: paginatedPrescan.offset,
      nextPrescanOffset: paginatedPrescan.nextOffset,
      oiWatch: paginatedOiWatch.rows.map((entry) => {
        const currentEntry = currentBySymbol.get(entry.symbol);
        return {
          ...projectEntry(entry.symbol, currentEntry),
          layers: validLayerTags(currentEntry?.layers),
        };
      }),
      totalOiWatch: paginatedOiWatch.total,
      oiWatchOffset: paginatedOiWatch.offset,
      nextOiWatchOffset: paginatedOiWatch.nextOffset,
      candidates: data.cycleCandidates.map((entry) => ({
        ...projectEntry(entry.symbol, entry),
        layers: validLayerTags(entry.layers),
      })),
      spot: paginatedSpot.rows.map((entry) => ({
        ...projectEntry(entry.symbol, entry),
        layers: validLayerTags(entry.layers),
      })),
      totalSpot: paginatedSpot.total,
      spotOffset: paginatedSpot.offset,
      nextSpotOffset: paginatedSpot.nextOffset,
      layerTokens: {
        L10: [...new Set(liqCascadeSymbols)].map((symbol) => ({
          ...fromCurrentEntry(symbol),
          layers: ["L10"],
        })),
      },
    },
  };
}
