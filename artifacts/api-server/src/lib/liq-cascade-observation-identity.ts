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
    // Preserve the recovery-gate decision even if an earlier cycle already
    // recorded a different rejection for the same watch.
    if (input.reason === "weak_liq_continued_decline") {
      return `liq-watch-observation:${input.watchId}:rejected:weak_liq_continued_decline`;
    }
    return `liq-watch-observation:${input.watchId}:rejected`;
  }
  const bucket = liqCascadeObservationBucket(input.observedAt).toISOString();
  return `liq-watch-observation:${input.watchId}:${bucket}:${input.stage}:${input.reason ?? "none"}`;
}
