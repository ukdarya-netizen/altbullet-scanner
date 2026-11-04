export const HISTORICAL_ENTRY_SNAPSHOT_MAX_AGE_MS = 15 * 60_000;

export type EntryMetricProvenanceSource = "signal_fire" | "prescan_snapshot";

export interface EntryMetricProvenance {
  source: EntryMetricProvenanceSource;
  observedAt: string;
}

export type EntryMetricsProvenance = Record<string, EntryMetricProvenance>;

export interface HistoricalPrescanSnapshot {
  cycleAt: Date;
  p24h: number | null;
  p1h: number | null;
  oi30m: number | null;
  oi1h: number | null;
  oi4h: number | null;
  volMult: number | null;
  spotVolUsd24h: number | null;
  whaleIndex: number | null;
  fundingRate: number | null;
  obRatio: number | null;
  cvd30m: boolean | null;
  cvd1h: boolean | null;
  cvd4h: boolean | null;
}

export interface HistoricalEntryMetricCandidate {
  price24hAtFire: number | null;
  entryPrice1h: number | null;
  entryOi30m: number | null;
  entryOi1h: number | null;
  entryOi4h: number | null;
  entryFutVolMult: number | null;
  entrySpotVol24h: number | null;
  entryWhaleIndex: number | null;
  entryFundingRate: number | null;
  entryObRatio: number | null;
  entryCvd30m: boolean | null;
  entryCvd1h: boolean | null;
  entryCvd4h: boolean | null;
}

export type HistoricalEntryMetricPatch =
  Partial<HistoricalEntryMetricCandidate>;

export function buildEntryMetricsProvenance(
  values: Record<string, unknown>,
  source: EntryMetricProvenanceSource,
  observedAt: Date,
): EntryMetricsProvenance {
  const provenance: EntryMetricsProvenance = {};
  for (const [field, value] of Object.entries(values)) {
    if (value !== null && value !== undefined) {
      provenance[field] = { source, observedAt: observedAt.toISOString() };
    }
  }
  return provenance;
}

/**
 * Maps only metrics preserved by the durable per-cycle snapshot. A snapshot
 * taken after the signal, or too far before it, is deliberately rejected:
 * NULL is more truthful than a later/current market value labelled as entry.
 */
export function buildHistoricalEntryMetricPatch(
  candidate: HistoricalEntryMetricCandidate,
  snapshot: HistoricalPrescanSnapshot | undefined,
  detectedAt: Date,
): {
  patch: HistoricalEntryMetricPatch;
  provenance: EntryMetricsProvenance;
} {
  if (
    !snapshot ||
    snapshot.cycleAt.getTime() > detectedAt.getTime() ||
    detectedAt.getTime() - snapshot.cycleAt.getTime() >
      HISTORICAL_ENTRY_SNAPSHOT_MAX_AGE_MS
  ) {
    return { patch: {}, provenance: {} };
  }

  const patch: HistoricalEntryMetricPatch = {};
  const assign = <K extends keyof HistoricalEntryMetricCandidate>(
    field: K,
    value: HistoricalEntryMetricCandidate[K],
  ) => {
    if (candidate[field] === null && value !== null) patch[field] = value;
  };

  assign("price24hAtFire", snapshot.p24h);
  assign("entryPrice1h", snapshot.p1h);
  assign("entryOi30m", snapshot.oi30m);
  assign("entryOi1h", snapshot.oi1h);
  assign("entryOi4h", snapshot.oi4h);
  assign("entryFutVolMult", snapshot.volMult);
  assign("entrySpotVol24h", snapshot.spotVolUsd24h);
  assign("entryWhaleIndex", snapshot.whaleIndex);
  assign("entryFundingRate", snapshot.fundingRate);
  assign("entryObRatio", snapshot.obRatio);
  assign("entryCvd30m", snapshot.cvd30m);
  assign("entryCvd1h", snapshot.cvd1h);
  assign("entryCvd4h", snapshot.cvd4h);

  return {
    patch,
    provenance: buildEntryMetricsProvenance(
      patch,
      "prescan_snapshot",
      snapshot.cycleAt,
    ),
  };
}
