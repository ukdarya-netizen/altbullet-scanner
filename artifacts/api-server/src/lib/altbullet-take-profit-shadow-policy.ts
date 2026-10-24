export type AltBulletTpVariant =
  | "exact_resistance"
  | "before_0_10_atr"
  | "before_0_20_atr";

export type AltBulletTpCandidate = {
  variant: AltBulletTpVariant;
  status: "tracking" | "not_eligible";
  eligibilityReason: string | null;
  targetPrice: number | null;
  targetPct: number | null;
  targetAtr: number | null;
};

function finitePositive(value: unknown): number | null {
  const numeric =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value)
        : Number.NaN;
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

export function buildAltBulletTpCandidates(input: {
  entryPrice: number | null | undefined;
  resistancePrice: number | null | undefined;
  atr14: number | null | undefined;
  isShort: boolean;
}): AltBulletTpCandidate[] {
  const entryPrice = finitePositive(input.entryPrice);
  const resistancePrice = finitePositive(input.resistancePrice);
  const atr14 = finitePositive(input.atr14);
  const definitions: Array<{
    variant: AltBulletTpVariant;
    atrBuffer: number;
  }> = [
    { variant: "exact_resistance", atrBuffer: 0 },
    { variant: "before_0_10_atr", atrBuffer: 0.1 },
    { variant: "before_0_20_atr", atrBuffer: 0.2 },
  ];

  return definitions.map(({ variant, atrBuffer }) => {
    if (input.isShort) {
      return {
        variant,
        status: "not_eligible",
        eligibilityReason: "short_direction_not_supported",
        targetPrice: null,
        targetPct: null,
        targetAtr: null,
      };
    }
    if (entryPrice == null) {
      return {
        variant,
        status: "not_eligible",
        eligibilityReason: "entry_price_unavailable",
        targetPrice: null,
        targetPct: null,
        targetAtr: null,
      };
    }
    if (resistancePrice == null) {
      return {
        variant,
        status: "not_eligible",
        eligibilityReason: "resistance_unavailable",
        targetPrice: null,
        targetPct: null,
        targetAtr: null,
      };
    }
    if (atrBuffer > 0 && atr14 == null) {
      return {
        variant,
        status: "not_eligible",
        eligibilityReason: "atr_unavailable",
        targetPrice: null,
        targetPct: null,
        targetAtr: null,
      };
    }
    const targetPrice = resistancePrice - (atr14 ?? 0) * atrBuffer;
    if (targetPrice <= entryPrice) {
      return {
        variant,
        status: "not_eligible",
        eligibilityReason: "target_at_or_below_entry",
        targetPrice,
        targetPct: ((targetPrice - entryPrice) / entryPrice) * 100,
        targetAtr: atr14 == null ? null : (targetPrice - entryPrice) / atr14,
      };
    }
    return {
      variant,
      status: "tracking",
      eligibilityReason: null,
      targetPrice,
      targetPct: ((targetPrice - entryPrice) / entryPrice) * 100,
      targetAtr: atr14 == null ? null : (targetPrice - entryPrice) / atr14,
    };
  });
}
