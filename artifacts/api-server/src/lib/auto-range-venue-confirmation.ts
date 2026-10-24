import { LC_OB_SPOT_VENUES, type LcObVenue } from "./lc-ob-wait.js";

export const AUTO_RANGE_VENUE_PRIORITY: readonly LcObVenue[] =
  LC_OB_SPOT_VENUES;
export const AUTO_RANGE_BREAKOUT_WINDOW_MS = 24 * 60 * 60 * 1_000;

export interface AutoRangeVenueConfirmation {
  venue: LcObVenue;
  symbol: string;
  upper: number;
  lower: number;
  breakoutCloseTime: number;
  /** Previously frozen provenance rehydrated from the active durable arm. */
  previouslyConfirmedVenues?: readonly LcObVenue[];
}

export type AutoRangeVenueEvaluation =
  | { venue: LcObVenue; status: "unknown"; reason: string }
  | { venue: LcObVenue; status: "no_signal"; reason?: string }
  | ({
      status: "confirmed";
    } & AutoRangeVenueConfirmation);

export interface SelectedAutoRangeConfirmation {
  /** Canonical durable family/window identity, independent of exchange. */
  lifecycleKey: string;
  selectedVenue: LcObVenue;
  confirmingVenues: LcObVenue[];
  confirmation: AutoRangeVenueConfirmation;
}

function venuePriority(venue: LcObVenue): number {
  const index = AUTO_RANGE_VENUE_PRIORITY.indexOf(venue);
  return index < 0 ? Number.MAX_SAFE_INTEGER : index;
}

function quantizeRangeLevel(value: number, step: number): number {
  return Math.round(value / step);
}

/**
 * A Range lifecycle is deduplicated by symbol, the UTC day containing the
 * canonical breakout close, and both frozen boundaries rounded to 0.5% of
 * the upper boundary. This groups small cross-venue level deviations without
 * merging materially different ranges or separate breakout windows.
 */
export function buildAutoRangeLifecycleKey(
  symbol: string,
  confirmation: Pick<
    AutoRangeVenueConfirmation,
    "upper" | "lower" | "breakoutCloseTime"
  >,
): string | null {
  if (
    !symbol ||
    !Number.isFinite(confirmation.upper) ||
    !Number.isFinite(confirmation.lower) ||
    !Number.isFinite(confirmation.breakoutCloseTime) ||
    !(confirmation.upper > confirmation.lower) ||
    confirmation.upper <= 0
  ) {
    return null;
  }
  const levelStep = confirmation.upper * 0.005;
  const breakoutWindow = Math.floor(
    confirmation.breakoutCloseTime / AUTO_RANGE_BREAKOUT_WINDOW_MS,
  );
  return [
    symbol.toUpperCase(),
    breakoutWindow,
    quantizeRangeLevel(confirmation.upper, levelStep),
    quantizeRangeLevel(confirmation.lower, levelStep),
  ].join(":");
}

/**
 * Chooses one trading candidate from independent venue evaluations. Unknown
 * venues are deliberately ignored: they cannot veto another venue's signal.
 */
export function selectAutoRangeVenueConfirmation(
  evaluations: readonly AutoRangeVenueEvaluation[],
): SelectedAutoRangeConfirmation | null {
  const confirmed = evaluations
    .filter(
      (
        evaluation,
      ): evaluation is Extract<
        AutoRangeVenueEvaluation,
        { status: "confirmed" }
      > => evaluation.status === "confirmed",
    )
    .map((evaluation) => ({
      evaluation,
      lifecycleKey: buildAutoRangeLifecycleKey(evaluation.symbol, evaluation),
    }))
    .filter(
      (
        item,
      ): item is {
        evaluation: Extract<AutoRangeVenueEvaluation, { status: "confirmed" }>;
        lifecycleKey: string;
      } => item.lifecycleKey !== null,
    )
    .sort(
      (left, right) =>
        venuePriority(left.evaluation.venue) -
          venuePriority(right.evaluation.venue) ||
        left.evaluation.breakoutCloseTime - right.evaluation.breakoutCloseTime,
    );
  const selected = confirmed[0];
  if (!selected) return null;
  const sameLifecycle = confirmed.filter(
    (item) => item.lifecycleKey === selected.lifecycleKey,
  );
  const confirmingVenues = [
    ...new Set(
      sameLifecycle.flatMap((item) => [
        item.evaluation.venue,
        ...(item.evaluation.previouslyConfirmedVenues ?? []),
      ]),
    ),
  ].sort((left, right) => venuePriority(left) - venuePriority(right));
  const confirmation: AutoRangeVenueConfirmation = {
    venue: selected.evaluation.venue,
    symbol: selected.evaluation.symbol,
    upper: selected.evaluation.upper,
    lower: selected.evaluation.lower,
    breakoutCloseTime: selected.evaluation.breakoutCloseTime,
  };
  return {
    lifecycleKey: selected.lifecycleKey,
    selectedVenue: selected.evaluation.venue,
    confirmingVenues,
    confirmation,
  };
}
