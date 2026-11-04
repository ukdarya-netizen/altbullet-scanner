type PrescanObservation = {
  ts: Date;
  score: number | null;
  price24h: number | null;
  oi30m: number | null;
  oi1h: number | null;
  oi4h: number | null;
};

type OiWatchObservation = {
  id: number;
  status: string;
  triggerTf: string;
  addedAt: Date;
  expiresAt: Date;
  firedAt: Date | null;
};

// Deliberately allowlist member fields rather than forwarding owner diagnostic rows.
export function buildMemberSymbolStatusHistory(
  symbol: string,
  prescanRows: readonly PrescanObservation[],
  oiWatchRows: readonly OiWatchObservation[],
) {
  return {
    symbol,
    prescanHistory: prescanRows.map((row) => ({
      ts: row.ts.toISOString(),
      score: row.score,
      price24h: row.price24h,
      oi30m: row.oi30m,
      oi1h: row.oi1h,
      oi4h: row.oi4h,
    })),
    oiWatchHistory: oiWatchRows.map((row) => ({
      id: row.id,
      status: row.status,
      triggerTf: row.triggerTf,
      addedAt: row.addedAt.toISOString(),
      expiresAt: row.expiresAt.toISOString(),
      firedAt: row.firedAt?.toISOString() ?? null,
    })),
  };
}
