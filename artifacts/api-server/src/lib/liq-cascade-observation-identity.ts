const BUCKET_MS = 15 * 60_000;

export type LiqCascadeObservationStage =
  | "watching"
  | "rejected"
  | "fired"
  | "expired";

export function liqCascadeObservationBucket(observedAt: Date): Date {
  return new Date(Math.floor(observedAt.getTime() / BUCKET_MS) * BUCKET_MS);
}

export function liqCascadeObservationEventKey(input: {
  watchId: number;
  stage: LiqCascadeObservationStage;
  reason?: string | null;
  observedAt: Date;
}): string {
  if (input.stage === "fired" || input.stage === "expired") {
    return `liq-watch-observation:${input.watchId}:terminal:${input.stage}`;
  }
  if (input.stage === "rejected") {
    // Owner 2026-11-26 (reports/lc-final-1126): one row per watch froze the FIRST rejection —
    // the non-terminal "detection_candle_pending" — so the real verdict after the candle closed
    // (too_small / not_capitulation / window passed / later gates) was never stored for ~1 600
    // watches. Every distinct rejection reason now gets its own row (first occurrence kept).
    return `liq-watch-observation:${input.watchId}:rejected:${input.reason ?? "none"}`;
  }
  const bucket = liqCascadeObservationBucket(input.observedAt).toISOString();
  return `liq-watch-observation:${input.watchId}:${bucket}:${input.stage}:${input.reason ?? "none"}`;
}
