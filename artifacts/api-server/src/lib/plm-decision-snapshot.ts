export const PLM_ENTRY_PRICE_3H_PROVENANCE = {
  scannerDecision: "scanner_decision_snapshot",
  missingAtSignalFire: "missing_at_signal_fire",
  legacyPrimaryMissing: "legacy_primary_missing_snapshot",
} as const;

export type PlmEntryPrice3hProvenance =
  (typeof PLM_ENTRY_PRICE_3H_PROVENANCE)[keyof typeof PLM_ENTRY_PRICE_3H_PROVENANCE];

export const PLM_FUT_TAKER_SHADOW = {
  below20: "below_20",
  atOrAbove20: "at_or_above_20",
  unavailable: "unavailable",
} as const;

export type PlmFutTakerShadow =
  (typeof PLM_FUT_TAKER_SHADOW)[keyof typeof PLM_FUT_TAKER_SHADOW];

export const PLM_OI30M_SHADOW = {
  below2: "below_2",
  atOrAbove2: "at_or_above_2",
  unavailable: "unavailable",
} as const;

export type PlmOi30mShadow =
  (typeof PLM_OI30M_SHADOW)[keyof typeof PLM_OI30M_SHADOW];

export interface PlmOi30mDecisionSnapshot {
  shadow: PlmOi30mShadow | null;
  value: number | null;
}

export const PLM_OI30M_FIRE_FETCH_OPTIONS = Object.freeze({
  bypassCache: true,
});

export type PlmFutTakerSnapshotSource =
  | "batch"
  | "per_symbol_fallback"
  | "unavailable"
  | "not_plm";

export interface PlmFutTakerDecisionSnapshot {
  shadow: PlmFutTakerShadow | null;
  value: number | null;
  source: PlmFutTakerSnapshotSource;
}

export interface PlmEntryPrice3hSnapshot {
  entryPrice3h: number | null;
  entryPrice3hProvenance: PlmEntryPrice3hProvenance | null;
}

function finiteOrNull(value: number | null | undefined): number | null {
  return value != null && Number.isFinite(value) ? value : null;
}

export function capturePlmFutTakerShadow(
  sentimentKey: string | null | undefined,
  futTakerNetBuyPct: number | null | undefined,
): PlmFutTakerShadow | null {
  if (sentimentKey !== "price_led_momentum") return null;
  const value = finiteOrNull(futTakerNetBuyPct);
  if (value === null) return PLM_FUT_TAKER_SHADOW.unavailable;
  return value >= 20
    ? PLM_FUT_TAKER_SHADOW.atOrAbove20
    : PLM_FUT_TAKER_SHADOW.below20;
}

export function capturePlmOi30mShadow(
  sentimentKey: string | null | undefined,
  oi30mPct: number | null | undefined,
): PlmOi30mShadow | null {
  if (sentimentKey !== "price_led_momentum") return null;
  const value = finiteOrNull(oi30mPct);
  if (value === null) return PLM_OI30M_SHADOW.unavailable;
  return value >= 2 ? PLM_OI30M_SHADOW.atOrAbove2 : PLM_OI30M_SHADOW.below2;
}

export async function capturePlmOi30mShadowAtFire(input: {
  sentimentKey: string | null | undefined;
  loadFresh: () => Promise<number | null | undefined>;
}): Promise<PlmOi30mDecisionSnapshot> {
  if (input.sentimentKey !== "price_led_momentum") {
    return { shadow: null, value: null };
  }
  try {
    const value = finiteOrNull(await input.loadFresh());
    return {
      shadow: capturePlmOi30mShadow(input.sentimentKey, value),
      value,
    };
  } catch {
    return {
      shadow: PLM_OI30M_SHADOW.unavailable,
      value: null,
    };
  }
}

export async function capturePlmFutTakerShadowWithFallback(input: {
  sentimentKey: string | null | undefined;
  batchValue: number | null | undefined;
  loadFallback: () => Promise<number | null | undefined>;
}): Promise<PlmFutTakerDecisionSnapshot> {
  if (input.sentimentKey !== "price_led_momentum") {
    return {
      shadow: null,
      value: finiteOrNull(input.batchValue),
      source: "not_plm",
    };
  }

  const batchValue = finiteOrNull(input.batchValue);
  if (batchValue !== null) {
    return {
      shadow: capturePlmFutTakerShadow(input.sentimentKey, batchValue),
      value: batchValue,
      source: "batch",
    };
  }

  try {
    const fallbackValue = finiteOrNull(await input.loadFallback());
    if (fallbackValue !== null) {
      return {
        shadow: capturePlmFutTakerShadow(input.sentimentKey, fallbackValue),
        value: fallbackValue,
        source: "per_symbol_fallback",
      };
    }
  } catch {
    // A failed observational fetch must never block a spot-led signal.
  }

  return {
    shadow: PLM_FUT_TAKER_SHADOW.unavailable,
    value: null,
    source: "unavailable",
  };
}

export function recoverPlmFutTakerShadow(input: {
  sentimentKey: string | null | undefined;
  plmFutTakerShadow: string | null | undefined;
}): PlmFutTakerShadow | null {
  if (input.sentimentKey !== "price_led_momentum") return null;
  return Object.values(PLM_FUT_TAKER_SHADOW).includes(
    input.plmFutTakerShadow as PlmFutTakerShadow,
  )
    ? (input.plmFutTakerShadow as PlmFutTakerShadow)
    : PLM_FUT_TAKER_SHADOW.unavailable;
}

export function recoverPlmOi30mShadow(input: {
  sentimentKey: string | null | undefined;
  plmOi30mShadow: string | null | undefined;
}): PlmOi30mShadow | null {
  if (input.sentimentKey !== "price_led_momentum") return null;
  return Object.values(PLM_OI30M_SHADOW).includes(
    input.plmOi30mShadow as PlmOi30mShadow,
  )
    ? (input.plmOi30mShadow as PlmOi30mShadow)
    : PLM_OI30M_SHADOW.unavailable;
}

export function capturePlmEntryPrice3hSnapshot(
  sentimentKey: string | null | undefined,
  decisionPrice3h: number | null | undefined,
): PlmEntryPrice3hSnapshot {
  if (sentimentKey !== "price_led_momentum") {
    return {
      entryPrice3h: finiteOrNull(decisionPrice3h),
      entryPrice3hProvenance: null,
    };
  }

  const entryPrice3h = finiteOrNull(decisionPrice3h);
  return {
    entryPrice3h,
    entryPrice3hProvenance:
      entryPrice3h === null
        ? PLM_ENTRY_PRICE_3H_PROVENANCE.missingAtSignalFire
        : PLM_ENTRY_PRICE_3H_PROVENANCE.scannerDecision,
  };
}

export function recoverPlmEntryPrice3hSnapshot(input: {
  sentimentKey: string | null | undefined;
  entryPrice3h: number | null | undefined;
  entryPrice3hProvenance: string | null | undefined;
}): PlmEntryPrice3hSnapshot {
  const entryPrice3h = finiteOrNull(input.entryPrice3h);
  if (input.sentimentKey !== "price_led_momentum") {
    return { entryPrice3h, entryPrice3hProvenance: null };
  }

  if (entryPrice3h !== null) {
    return {
      entryPrice3h,
      entryPrice3hProvenance: PLM_ENTRY_PRICE_3H_PROVENANCE.scannerDecision,
    };
  }

  return {
    entryPrice3h: null,
    entryPrice3hProvenance:
      input.entryPrice3hProvenance ===
      PLM_ENTRY_PRICE_3H_PROVENANCE.missingAtSignalFire
        ? PLM_ENTRY_PRICE_3H_PROVENANCE.missingAtSignalFire
        : PLM_ENTRY_PRICE_3H_PROVENANCE.legacyPrimaryMissing,
  };
}
