export type ShadowLedgerStatus =
  | "armed"
  | "qualified"
  | "terminal"
  | "firing"
  | "fired";

export type ShadowDetectorMethod =
  | "abneon_support_bounce"
  | "order_block_support_bounce";

export type QualifiedNeonRoutingRow = {
  symbol: string;
  method: ShadowDetectorMethod;
  status: ShadowLedgerStatus;
  liveEligible: boolean;
  frozenLevel: number;
  armCandleTime: number;
  triggerCandleTime: number | null;
  confluence?: string | null;
};

export type QueuedNeonSupportBounce = {
  frozenLevel: number;
  armCandleTime: number;
  triggerCandleTime: number;
  /** Timeframes whose SRv2 zones coincide, e.g. "1H+4H". */
  confluence?: string | null;
};

const TF_ORDER = ["1h", "4h", "1d"];

/** "1H+4H" / "1H+1D" / "4H+1D" from stored detector evidence. */
export function neonConfluenceLabel(evidence: unknown): string | null {
  const e = evidence as {
    timeframe?: unknown;
    confluenceTimeframes?: unknown;
  } | null;
  if (!e || typeof e.timeframe !== "string") return null;
  const others = Array.isArray(e.confluenceTimeframes)
    ? e.confluenceTimeframes.filter((x): x is string => typeof x === "string")
    : [];
  if (others.length === 0) return null;
  return [...new Set([e.timeframe, ...others])]
    .sort((a, b) => TF_ORDER.indexOf(a) - TF_ORDER.indexOf(b))
    .map((x) => x.toUpperCase())
    .join("+");
}

/** Only ABNeon support may enter the live delivery queue. */
export function isLiveEligibleShadowMethod(
  method: ShadowDetectorMethod,
): method is "abneon_support_bounce" {
  return method === "abneon_support_bounce";
}

/**
 * Converts durable shadow rows into the live Neon queue. Keeping this boundary
 * pure makes routing behavior testable without coupling tests to scanner locals.
 */
export function routePersistedNeonSupportBounces(
  rows: readonly QualifiedNeonRoutingRow[],
): Map<string, QueuedNeonSupportBounce> {
  const queued = new Map<string, QueuedNeonSupportBounce>();
  for (const row of rows) {
    if (
      queued.has(row.symbol) ||
      !isLiveEligibleShadowMethod(row.method) ||
      !row.liveEligible ||
      (row.status !== "qualified" && row.status !== "firing") ||
      row.triggerCandleTime === null ||
      !row.confluence
    ) {
      continue;
    }
    queued.set(row.symbol, {
      frozenLevel: row.frozenLevel,
      armCandleTime: row.armCandleTime,
      triggerCandleTime: row.triggerCandleTime,
      confluence: row.confluence ?? null,
    });
  }
  return queued;
}

export function supportBounceQualificationTime(
  triggerCandleTime: number,
): number {
  return triggerCandleTime + 60 * 60 * 1000;
}

/** Mirrors the SQL upsert ordering and remains dependency-free for tests. */
export function monotonicShadowStatus(
  existing: ShadowLedgerStatus,
  incoming: ShadowLedgerStatus,
): ShadowLedgerStatus {
  if (existing === "firing" || existing === "fired") return existing;
  if (existing === "qualified" && incoming !== "qualified") return existing;
  if (
    existing === "terminal" &&
    (incoming === "armed" || incoming === "qualified")
  ) {
    return existing;
  }
  return incoming;
}

/**
 * Live delivery eligibility is introduced as a closed-world boundary:
 * existing non-armed rows never become historical backfill candidates.
 * An armed row may opt in only when the current detector observation moves it
 * to qualified; brand-new armed/qualified rows are eligible immediately.
 */
export function liveEligibilityForShadowUpsert(input: {
  existingStatus: ShadowLedgerStatus | null;
  existingLiveEligible: boolean;
  incomingStatus: ShadowLedgerStatus;
}): boolean {
  if (input.existingStatus === null) {
    return (
      input.incomingStatus === "armed" || input.incomingStatus === "qualified"
    );
  }
  if (input.existingLiveEligible) return true;
  return (
    input.existingStatus === "armed" && input.incomingStatus === "qualified"
  );
}

export function canClaimAbneonSupportBounce(input: {
  status: ShadowLedgerStatus;
  claimExpiresAtMs: number | null;
  nowMs: number;
}): boolean {
  return (
    input.status === "qualified" ||
    (input.status === "firing" &&
      input.claimExpiresAtMs !== null &&
      input.claimExpiresAtMs <= input.nowMs)
  );
}

export function ownsAbneonSupportBounceClaim(input: {
  owner: string;
  token: string;
  expectedOwner: string;
  expectedToken: string;
}): boolean {
  return (
    input.owner === input.expectedOwner && input.token === input.expectedToken
  );
}

/** Pure classification used to keep transient DB failures retryable. */
export function classifyAbneonFirePersistenceFailure(
  error: unknown,
): "retryable" | "nonretryable" {
  const code =
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
      ? error.code
      : null;
  if (
    code === "23505" ||
    code === "23503" ||
    code === "23514" ||
    code?.startsWith("22") ||
    code?.startsWith("42")
  ) {
    return "nonretryable";
  }
  return "retryable";
}
