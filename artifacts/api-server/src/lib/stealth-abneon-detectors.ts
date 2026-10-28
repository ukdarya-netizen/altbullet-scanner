/**
 * Event-time, shadow-only ABNeon detectors.
 *
 * Every function accepts candles in oldest-first order and never inspects a
 * candle that was not closed at observedAt. A level is frozen at arm time;
 * subsequent calls may only evaluate later candles and cannot recalculate it.
 * These helpers deliberately return evidence, not a trading decision.
 */
import type { StealthDetectionMethod } from "@workspace/db";
import {
  meetsTurnover,
  NEON_MIN_TURNOVER_PCT_OF_MCAP,
} from "./turnover-threshold.js";

export type AbneonShadowMethod = Exclude<
  StealthDetectionMethod,
  "quiet_zone_breakout" | "fresh_24h_high_breakout"
>;
export type OrderBlockShadowMethod = "order_block_support_bounce";
export type ShadowDetectorMethod = AbneonShadowMethod | OrderBlockShadowMethod;

export type ClosedDetectorCandle = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  /** Aggregated (CoinGlass, multi-exchange) USD volume; the only gate volume. */
  volumeUsd?: number;
};

export type ShadowDetectorResult<
  Method extends ShadowDetectorMethod = ShadowDetectorMethod,
> = {
  method: Method;
  status: "armed" | "qualified" | "terminal";
  reason: string;
  frozenLevel: number | null;
  armCandleTime: number | null;
  triggerCandleTime: number | null;
  volumeEvidence: {
    triggerVolume: number | null;
    baselineVolume: number | null;
    ratio: number | null;
  };
  /** Additional immutable explanation for shadow-only detector variants. */
  evidence?: Record<string, unknown>;
};

const H1 = 60 * 60_000;
const H4 = 4 * H1;
const M15 = 15 * 60_000;
const VOLUME_LOOKBACK = 20;
/** Owner 2026-10-22: 4x (peak>=10% share 34% vs 27% at 1.5x on 865 zones). */
const SUPPORT_VOLUME_RATIO = 4;

const SHADOW_ARM_TTL_MS = 24 * H1;
function closed<T extends ClosedDetectorCandle>(
  candles: readonly T[],
  timeframe: number,
  observedAt: number,
): T[] {
  return candles
    .filter((c) => Number.isFinite(c.time) && c.time + timeframe <= observedAt)
    .sort((a, b) => a.time - b.time);
}

/** Aggregated USD volume; NaN (never BingX volume) when unavailable. */
const usd = (c: ClosedDetectorCandle): number => c.volumeUsd ?? Number.NaN;

function volumeEvidence(
  candles: readonly ClosedDetectorCandle[],
  index: number,
) {
  const trigger = candles[index];
  const prior = candles.slice(Math.max(0, index - VOLUME_LOOKBACK), index);
  const baseline =
    prior.length === VOLUME_LOOKBACK
      ? prior.reduce((sum, c) => sum + usd(c), 0) / VOLUME_LOOKBACK
      : null;
  const ratio =
    trigger && baseline && baseline > 0 ? usd(trigger) / baseline : null;
  return {
    triggerVolume: trigger ? usd(trigger) : null,
    baselineVolume: baseline,
    ratio,
  };
}

function latest<T>(values: readonly T[]): T | undefined {
  return values[values.length - 1];
}

function isExpired(observedAt: number, armedAt: number): boolean {
  return observedAt - armedAt > SHADOW_ARM_TTL_MS;
}

function empty<Method extends ShadowDetectorMethod>(
  method: Method,
  reason: string,
): ShadowDetectorResult<Method> {
  return {
    method,
    status: "terminal",
    reason,
    frozenLevel: null,
    armCandleTime: null,
    triggerCandleTime: null,
    volumeEvidence: { triggerVolume: null, baselineVolume: null, ratio: null },
  };
}

/**
 * Support zones — identical algorithm to the AltBullet Neon Pine indicator
 * ("levels are always the same on any timeframe"): 4H pivots (length 6),
 * 600-bar lookback, ATR(14)-sized histogram bins, up to 6 zones with a
 * 1.2 ATR minimum gap. A zone spans the extreme pivots of its cluster.
 */
const SR_PIVOT_LENGTH = 6;
const SR_LOOKBACK = 600;
const SR_BIN_ATR = 0.35;
const SR_GAP_ATR = 1.2;
const SR_MAX_ZONES = 6;
const ATR_PERIOD = 14;
/**
 * Owner 2026-10-27: a wick below a support zone, or closes below it reclaimed
 * within 3 closed 4H candles, is a sweep — the zone stays support. Only 3
 * consecutive 4H closes >1% below the bottom break it. Backtest 15.09–27.10
 * (all BingX symbols, +5% / −8% rule): 772 vs 563 signals, expectancy
 * +2.28% vs +2.07% and −1.13% vs −1.63% in the two halves.
 */
export const NEON_SWEEP_RECLAIM_BARS = 3;

/** True when `candles` contain `bars` consecutive closes >1% below `bottom`. */
export function hasConsecutiveClosesBelow(
  candles: readonly { close: number }[],
  bottom: number,
  bars: number,
): boolean {
  let run = 0;
  for (const c of candles) {
    run = c.close < bottom * 0.99 ? run + 1 : 0;
    if (run >= bars) return true;
  }
  return false;
}

/** Owner 2026-10-18: touch / bounce tolerance around a support zone. */
const SUPPORT_TOUCH_TOLERANCE = 0.01;
/**
 * Owner 2026-10-22: a zone is not support when price already traded below its
 * bottom after the zone's latest pivot low (SOPH: the zone was the fall's own
 * low and price kept dropping through it).
 */
function zoneUndercutAfterPivot(
  candles: readonly ClosedDetectorCandle[],
  zone: SupportZone,
): boolean {
  let pivotAt = -1;
  for (let i = SR_PIVOT_LENGTH; i + SR_PIVOT_LENGTH < candles.length; i++) {
    const c = candles[i]!;
    if (c.low < zone.bottom || c.low > zone.top) continue;
    let isLow = true;
    for (let j = i - SR_PIVOT_LENGTH; j <= i + SR_PIVOT_LENGTH; j++) {
      if (j !== i && candles[j]!.low < c.low) isLow = false;
    }
    if (isLow) pivotAt = i;
  }
  if (pivotAt < 0) return false;
  return candles.slice(pivotAt + 1).some((c) => c.low < zone.bottom);
}

/**
 * Research variant (off by default, live behaviour unchanged): a zone dies only
 * on a breakdown — `reclaimBars` consecutive closed 4H candles closing more than
 * 1% below its bottom. A wick below, or closes below that are reclaimed within
 * `reclaimBars` candles, is a sweep and the zone stays support.
 */
function zoneBrokenAfterPivot(
  candles: readonly ClosedDetectorCandle[],
  zone: SupportZone,
  reclaimBars: number,
): boolean {
  let pivotAt = -1;
  for (let i = SR_PIVOT_LENGTH; i + SR_PIVOT_LENGTH < candles.length; i++) {
    const c = candles[i]!;
    if (c.low < zone.bottom || c.low > zone.top) continue;
    let isLow = true;
    for (let j = i - SR_PIVOT_LENGTH; j <= i + SR_PIVOT_LENGTH; j++) {
      if (j !== i && candles[j]!.low < c.low) isLow = false;
    }
    if (isLow) pivotAt = i;
  }
  if (pivotAt < 0) return false;
  return hasBreakdownRun(candles.slice(pivotAt + 1), zone, reclaimBars);
}

function hasBreakdownRun(
  candles: readonly ClosedDetectorCandle[],
  zone: SupportZone,
  reclaimBars: number,
): boolean {
  const below = zone.bottom * (1 - SUPPORT_TOUCH_TOLERANCE);
  let run = 0;
  for (const c of candles) {
    run = c.close < below ? run + 1 : 0;
    if (run >= reclaimBars) return true;
  }
  return false;
}

/** Sweep touch: dipped to/through the zone and closed back at/above its bottom. */
function sweepTouchesZone(candle: ClosedDetectorCandle, zone: SupportZone): boolean {
  return (
    candle.low <= zone.top * (1 + SUPPORT_TOUCH_TOLERANCE) &&
    candle.close >= zone.bottom * (1 - SUPPORT_TOUCH_TOLERANCE)
  );
}

export type SupportZone = {
  center: number;
  top: number;
  bottom: number;
  count: number;
};

function wilderAtr(candles: readonly ClosedDetectorCandle[]): number | null {
  if (candles.length <= ATR_PERIOD) return null;
  const tr = candles.map((c, i) =>
    i === 0
      ? c.high - c.low
      : Math.max(
          c.high - c.low,
          Math.abs(c.high - candles[i - 1]!.close),
          Math.abs(c.low - candles[i - 1]!.close),
        ),
  );
  let atr = tr.slice(0, ATR_PERIOD).reduce((a, b) => a + b, 0) / ATR_PERIOD;
  for (let i = ATR_PERIOD; i < tr.length; i++) {
    atr = (atr * (ATR_PERIOD - 1) + tr[i]!) / ATR_PERIOD;
  }
  return atr > 0 && Number.isFinite(atr) ? atr : null;
}

export function computeSupportZones(
  candles: readonly ClosedDetectorCandle[],
): SupportZone[] {
  const n = candles.length;
  const atr = wilderAtr(candles);
  if (atr === null || n < 2 * SR_PIVOT_LENGTH + 1) return [];
  const prices: number[] = [];
  const first = Math.max(SR_PIVOT_LENGTH, n - 1 - SR_LOOKBACK);
  for (let i = first; i + SR_PIVOT_LENGTH < n; i++) {
    let isHigh = true;
    let isLow = true;
    for (let j = i - SR_PIVOT_LENGTH; j <= i + SR_PIVOT_LENGTH; j++) {
      if (j === i) continue;
      const c = candles[j]!;
      const left = j < i;
      if (left ? c.high >= candles[i]!.high : c.high > candles[i]!.high)
        isHigh = false;
      if (left ? c.low <= candles[i]!.low : c.low < candles[i]!.low)
        isLow = false;
    }
    if (isHigh) prices.push(candles[i]!.high);
    if (isLow) prices.push(candles[i]!.low);
  }
  if (prices.length === 0) return [];
  const gLow = Math.min(...prices);
  const gHigh = Math.max(...prices);
  const binW = Math.max(atr * SR_BIN_ATR, candles[n - 1]!.close * 1e-8);
  const nb = Math.min(400, Math.max(1, Math.ceil((gHigh - gLow) / binW) + 1));
  const counts = Array.from({ length: nb }, () => 0);
  for (const px of prices) {
    const ix = Math.min(nb - 1, Math.max(0, Math.floor((px - gLow) / binW)));
    counts[ix]! += 1;
  }
  const gapBins = Math.max(1, Math.ceil((atr * SR_GAP_ATR) / binW));
  const zones: SupportZone[] = [];
  for (let picks = 0; picks < SR_MAX_ZONES; picks++) {
    const mx = Math.max(...counts);
    if (mx <= 0) break;
    const best = counts.indexOf(mx);
    const lo = gLow + (best - 1) * binW;
    const hi = gLow + (best + 2) * binW;
    let inCluster = prices.filter((px) => px >= lo && px < hi);
    // Owner 2026-10-20: a neighbouring cluster inside the suppression gap with
    // exactly as many pivots is not suppressed; both merge into one zone
    // (bottom of the lower, top of the upper). Unequal neighbours stay
    // suppressed as before.
    let bestNeighbour = -1;
    let neighbourCount = 0;
    for (
      let b = Math.max(0, best - gapBins);
      b <= Math.min(nb - 1, best + gapBins);
      b++
    ) {
      if (Math.abs(b - best) < 3 || counts[b]! <= 0) continue;
      if (counts[b]! > neighbourCount) {
        neighbourCount = counts[b]!;
        bestNeighbour = b;
      }
    }
    if (bestNeighbour >= 0) {
      const nLo = gLow + (bestNeighbour - 1) * binW;
      const nHi = gLow + (bestNeighbour + 2) * binW;
      const neighbour = prices.filter(
        (px) => px >= nLo && px < nHi && !(px >= lo && px < hi),
      );
      if (neighbour.length === inCluster.length) {
        inCluster = [...inCluster, ...neighbour];
      }
    }
    if (inCluster.length > 0) {
      const center = inCluster.reduce((a, b) => a + b, 0) / inCluster.length;
      zones.push({
        center,
        top: Math.max(Math.max(...inCluster), center + binW / 2),
        bottom: Math.min(Math.min(...inCluster), center - binW / 2),
        count: inCluster.length,
      });
    }
    for (
      let b = Math.max(0, best - gapBins);
      b <= Math.min(nb - 1, best + gapBins);
      b++
    ) {
      counts[b] = -1;
    }
  }
  return zones;
}

function touchesZone(low: number, zone: SupportZone): boolean {
  return (
    low <= zone.top * (1 + SUPPORT_TOUCH_TOLERANCE) &&
    low >= zone.bottom * (1 - SUPPORT_TOUCH_TOLERANCE)
  );
}

function nearestTouchedZone(
  zones: readonly SupportZone[],
  low: number,
  accept: (zone: SupportZone) => boolean,
): SupportZone | undefined {
  return zones
    .filter((z) => touchesZone(low, z) && accept(z))
    .sort(
      (a, b) =>
        Math.abs(low - a.center) / a.center -
        Math.abs(low - b.center) / b.center,
    )[0];
}

/** Re-derive the frozen zone from the 4H candles that existed at arm time. */
export function resolveFrozenZone(
  h4: readonly ClosedDetectorCandle[],
  armTime: number,
  frozenTop: number,
  /** Research only: timeframe of the zone candles (default 4H). */
  zoneTimeframeMs: number = H4,
): SupportZone {
  for (const through of [armTime, armTime + H1]) {
    const zones = computeSupportZones(h4.filter((c) => c.time + zoneTimeframeMs <= through));
    const hit = zones.find(
      (z) => Math.abs(z.top - frozenTop) / frozenTop <= 1e-6,
    );
    if (hit) return hit;
  }
  // Rows armed before the zone algorithm existed froze a pivot low.
  return {
    center: frozenTop,
    top: frozenTop,
    bottom: frozenTop * 0.97,
    count: 1,
  };
}

/**
 * Support is a zone from the Neon indicator algorithm. It is frozen (by its
 * upper edge) when a closed 4H candle's low reaches the zone ±1%. It stays
 * valid until a closed 4H candle closes more than 1% below the zone bottom.
 * A later closed bullish 1H candle that touches the zone ±1%, closes back
 * inside/above it (≤ +1% above the top) with volume >= 4x the preceding 20
 * closed 1H candles and the minimum turnover qualifies the bounce.
 */
export function evaluateAbneonSupportBounce(input: {
  candles4h: readonly ClosedDetectorCandle[];
  candles1h: readonly ClosedDetectorCandle[];
  /** Owner 2026-10-22: fast confirmation on a closed 15m candle (aggregated volume). */
  candles15m?: readonly ClosedDetectorCandle[];
  candles1d?: readonly ClosedDetectorCandle[];
  marketCapUsd?: number | null;
  observedAt: number;
  frozenLevel?: number;
  armCandleTime?: number;
  /** Research only (backtest): treat wicks/short closes below a zone as sweeps. */
  sweepReclaimBars?: number;
  /**
   * Research only (backtest): timeframe of `candles4h` when zones are built
   * from another timeframe (1H horizontal levels). Production omits it (4H).
   */
  zoneTimeframeMs?: number;
}): ShadowDetectorResult<AbneonShadowMethod> {
  const sweep = input.sweepReclaimBars;
  const ZONE_TF = input.zoneTimeframeMs ?? H4;
  const h4 = closed(input.candles4h, ZONE_TF, input.observedAt);
  const h1 = closed(input.candles1h, H1, input.observedAt);
  if (h1.length < VOLUME_LOOKBACK + 1)
    return empty("abneon_support_bounce", "insufficient_closed_candles");
  if (input.frozenLevel != null) {
    const frozenLevel = input.frozenLevel;
    const arm = input.armCandleTime ?? 0;
    if (!arm || isExpired(input.observedAt, arm)) {
      return {
        method: "abneon_support_bounce",
        status: "terminal",
        reason: "reaction_window_expired",
        frozenLevel,
        armCandleTime: arm || null,
        triggerCandleTime: null,
        volumeEvidence: volumeEvidence(h1, h1.length - 1),
      };
    }
    const zone = resolveFrozenZone(h4, arm, frozenLevel, ZONE_TF);
    const brokenBelow = zone.bottom * (1 - SUPPORT_TOUCH_TOLERANCE);
    if (
      sweep != null
        ? hasBreakdownRun(
            h4.filter((c) => c.time >= arm),
            zone,
            sweep,
          )
        : h4.some((c) => c.time >= arm && c.close < brokenBelow)
    ) {
      return {
        method: "abneon_support_bounce",
        status: "terminal",
        reason: "support_invalidated_before_reaction",
        frozenLevel,
        armCandleTime: arm,
        triggerCandleTime: null,
        volumeEvidence: volumeEvidence(h1, h1.length - 1),
      };
    }
    const reaction = latest(h1);
    const reactionIndex = h1.length - 1;
    const isLater = reaction != null && reaction.time + H1 > arm;
    const reactionVolumeEvidence = volumeEvidence(h1, reactionIndex);
    const reactionVolumeUsd = reaction == null ? 0 : usd(reaction);
    // Owner 2026-10-21: touch and volume confirmation are separate candles.
    // Touch: any closed 1H in the window with low in [zone bottom, top + 1×ATR(4H)].
    // Confirmation: bullish latest closed 1H (same or later than the touch) with
    // close ≥ bottom and low ≤ top + 2×ATR(4H); volume/turnover gates below.
    const atr4h = wilderAtr(h4);
    const touchSeen =
      atr4h != null &&
      h1.some(
        (k) =>
          k.time + H1 > arm &&
          k.time <= (reaction?.time ?? -1) &&
          (sweep != null
            ? k.low <= zone.top + atr4h && k.close >= zone.bottom * (1 - SUPPORT_TOUCH_TOLERANCE)
            : k.low >= zone.bottom && k.low <= zone.top + atr4h),
      );
    const qualified =
      isLater &&
      reaction.close > reaction.open &&
      atr4h != null &&
      touchSeen &&
      reaction.low <= zone.top + 2 * atr4h &&
      reaction.close >= zone.bottom &&
      (reactionVolumeEvidence.ratio ?? 0) >= SUPPORT_VOLUME_RATIO &&
      meetsTurnover(
        reactionVolumeUsd,
        input.marketCapUsd,
        NEON_MIN_TURNOVER_PCT_OF_MCAP,
      );
    // Owner 2026-10-22 (BTR): the volume reaction may itself be the move; wait
    // for the closed 15m candle instead of the closed 1H candle. Same touch,
    // volume (>= 4x of preceding 20 candles, aggregated) and turnover rules.
    if (!qualified && input.candles15m && atr4h != null) {
      const h15 = closed(input.candles15m, M15, input.observedAt);
      const r15 = latest(h15);
      if (r15 && r15.time + M15 > arm && r15.close > r15.open) {
        const ev15 = volumeEvidence(h15, h15.length - 1);
        const touch15 =
          touchSeen ||
          h15.some(
            (k) =>
              k.time + M15 > arm &&
              (sweep != null
                ? k.low <= zone.top + atr4h &&
                  k.close >= zone.bottom * (1 - SUPPORT_TOUCH_TOLERANCE)
                : k.low >= zone.bottom && k.low <= zone.top + atr4h),
          );
        if (
          touch15 &&
          r15.low <= zone.top + 2 * atr4h &&
          r15.close >= zone.bottom &&
          (ev15.ratio ?? 0) >= SUPPORT_VOLUME_RATIO &&
          meetsTurnover(
            usd(r15),
            input.marketCapUsd,
            NEON_MIN_TURNOVER_PCT_OF_MCAP,
          )
        ) {
          return {
            method: "abneon_support_bounce",
            status: "qualified",
            reason: "later_closed_15m_bullish_reaction",
            frozenLevel,
            armCandleTime: arm,
            triggerCandleTime: r15.time,
            volumeEvidence: ev15,
          };
        }
      }
    }
    return {
      method: "abneon_support_bounce",
      status: qualified ? "qualified" : "armed",
      reason: qualified
        ? "later_closed_1h_bullish_reaction"
        : "awaiting_later_1h_reaction",
      frozenLevel,
      armCandleTime: arm,
      triggerCandleTime: qualified ? reaction.time : null,
      volumeEvidence: qualified
        ? reactionVolumeEvidence
        : volumeEvidence(h1, h1.length - 1),
    };
  }
  if (h4.length < 5)
    return empty("abneon_support_bounce", "insufficient_closed_candles");
  const arm = latest(h4);
  if (!arm)
    return empty("abneon_support_bounce", "insufficient_closed_candles");
  // Owner 2026-10-22 (SOPH): no support under a falling price — drop zones
  // that price has already traded through after their latest pivot.
  const zones = computeSupportZones(h4).filter((z) =>
    sweep != null
      ? !zoneBrokenAfterPivot(h4, z, sweep)
      : !zoneUndercutAfterPivot(h4, z),
  );
  if (zones.length === 0)
    return empty("abneon_support_bounce", "no_retested_support");
  // Sweep-and-reclaim inside the arming 4H candle: a closed bullish 1H candle
  // that dips into the support zone and closes back inside/above it is the
  // reaction itself; waiting for the next 4H close would enter far too late.
  const lastH1 = latest(h1);
  if (lastH1 && lastH1.close > lastH1.open) {
    const direct = (
      sweep != null
        ? zones
            .filter((z) => sweepTouchesZone(lastH1, z))
            .sort(
              (a, b) =>
                Math.abs(lastH1.low - a.center) / a.center -
                Math.abs(lastH1.low - b.center) / b.center,
            )
            .filter(
              (z) =>
                lastH1.close <= z.top * (1 + SUPPORT_TOUCH_TOLERANCE) &&
                lastH1.open >= z.bottom * (1 - SUPPORT_TOUCH_TOLERANCE),
            )[0]
        : undefined
    ) ?? (sweep != null ? undefined : nearestTouchedZone(
      zones,
      lastH1.low,
      (z) =>
        lastH1.close >= z.bottom &&
        lastH1.close <= z.top * (1 + SUPPORT_TOUCH_TOLERANCE) &&
        lastH1.open >= z.bottom * (1 - SUPPORT_TOUCH_TOLERANCE),
    ));
    if (direct) {
      const evidence = volumeEvidence(h1, h1.length - 1);
      const volUsd = usd(lastH1);
      if (Number.isNaN(volUsd)) {
        return empty("abneon_support_bounce", "srv2_touch_without_reaction");
      }
      if (
        (evidence.ratio ?? 0) >= SUPPORT_VOLUME_RATIO &&
        meetsTurnover(volUsd, input.marketCapUsd, NEON_MIN_TURNOVER_PCT_OF_MCAP)
      ) {
        return {
          method: "abneon_support_bounce",
          status: "qualified",
          reason: "later_closed_1h_bullish_reaction",
          frozenLevel: direct.top,
          armCandleTime: lastH1.time,
          triggerCandleTime: lastH1.time,
          volumeEvidence: evidence,
        };
      }
    }
  }
  // A close below the zone is a breakdown, not a tested zone.
  const zone =
    sweep != null
      ? zones
          .filter((z) => sweepTouchesZone(arm, z))
          .sort(
            (a, b) =>
              Math.abs(arm.low - a.center) / a.center -
              Math.abs(arm.low - b.center) / b.center,
          )[0]
      : nearestTouchedZone(
          zones,
          arm.low,
          (z) => arm.close >= z.bottom * (1 - SUPPORT_TOUCH_TOLERANCE),
        );
  if (!zone) {
    return empty("abneon_support_bounce", "support_not_reached");
  }
  return {
    method: "abneon_support_bounce",
    status: "armed",
    reason: "awaiting_later_1h_reaction",
    frozenLevel: zone.top,
    armCandleTime: arm.time + ZONE_TF,
    triggerCandleTime: null,
    volumeEvidence: volumeEvidence(h1, h1.length - 1),
  };
}

const ORDER_BLOCK_VERSION = "ob-support-v1";
const ORDER_BLOCK_ATR_LOOKBACK = 14;
const ORDER_BLOCK_DISPLACEMENT_ATR = 0.75;
const ORDER_BLOCK_REACTION_TTL_MS = 24 * H1;

function averageRange(candles: readonly ClosedDetectorCandle[]): number | null {
  if (candles.length < ORDER_BLOCK_ATR_LOOKBACK) return null;
  const sample = candles.slice(-ORDER_BLOCK_ATR_LOOKBACK);
  const value =
    sample.reduce((sum, candle) => sum + candle.high - candle.low, 0) /
    sample.length;
  return value > 0 && Number.isFinite(value) ? value : null;
}

/**
 * Shadow-only bullish order-block detector. The frozen zone is the body of
 * the last closed bearish 4H candle before a closed upward displacement.
 * It deliberately cannot qualify a live signal: persistence marks this
 * method non-live-eligible.
 */
export function evaluateOrderBlockSupportBounce(input: {
  candles4h: readonly ClosedDetectorCandle[];
  candles1h: readonly ClosedDetectorCandle[];
  marketCapUsd?: number | null;
  observedAt: number;
  frozen?: {
    level: number;
    armedAt: number;
    evidence?: Record<string, unknown> | null;
  };
}): ShadowDetectorResult<OrderBlockShadowMethod> {
  const h4 = closed(input.candles4h, H4, input.observedAt);
  const h1 = closed(input.candles1h, H1, input.observedAt);
  const baseEvidence = {
    version: ORDER_BLOCK_VERSION,
    orderBlock: null,
    displacement: null,
    reaction: null,
  };
  if (
    h4.length < ORDER_BLOCK_ATR_LOOKBACK + 2 ||
    h1.length < VOLUME_LOOKBACK + 1
  ) {
    return {
      ...empty("order_block_support_bounce", "insufficient_closed_candles"),
      evidence: baseEvidence,
    };
  }
  let candidate:
    | { index: number; atr: number; zoneLow: number; zoneHigh: number }
    | undefined;
  if (input.frozen) {
    const frozenEvidence = input.frozen.evidence;
    if (frozenEvidence?.version !== ORDER_BLOCK_VERSION) {
      return {
        method: "order_block_support_bounce",
        status: "terminal",
        reason: "missing_frozen_order_block_evidence",
        frozenLevel: input.frozen.level,
        armCandleTime: input.frozen.armedAt,
        triggerCandleTime: null,
        volumeEvidence: volumeEvidence(h1, h1.length - 1),
        evidence: frozenEvidence ?? baseEvidence,
      };
    }
    const stored = input.frozen.evidence?.orderBlock as
      | {
          candleTime?: number;
          zoneLow?: number;
          zoneHigh?: number;
          atr?: number;
          open?: number;
          close?: number;
          high?: number;
          low?: number;
          volume?: number;
          body?: number;
          requiredBody?: number;
        }
      | undefined;
    const storedDisplacement = input.frozen.evidence?.displacement as
      | {
          candleTime?: number;
          open?: number;
          close?: number;
          high?: number;
          low?: number;
          volume?: number;
          body?: number;
          requiredBody?: number;
        }
      | undefined;
    const snapshot = input.frozen.evidence?.snapshot as
      | {
          version?: string;
          armCloseTime?: number;
          deadline?: number;
          ttlMs?: number;
          thresholds?: { displacementAtr?: number; atrLookback?: number };
          atrWindow?: Array<{
            time: number;
            open: number;
            high: number;
            low: number;
            close: number;
            volume: number;
          }>;
        }
      | undefined;
    const index =
      stored?.candleTime == null
        ? -1
        : h4.findIndex((candle) => candle.time === stored.candleTime);
    const displacementIndex =
      storedDisplacement?.candleTime == null
        ? -1
        : h4.findIndex(
            (candle) => candle.time === storedDisplacement.candleTime,
          );
    const frozenAtrWindow = snapshot?.atrWindow ?? [];
    const recomputedAtr =
      frozenAtrWindow.length === ORDER_BLOCK_ATR_LOOKBACK
        ? frozenAtrWindow.reduce(
            (sum, candle) => sum + candle.high - candle.low,
            0,
          ) / ORDER_BLOCK_ATR_LOOKBACK
        : null;
    const baseCandle = index >= 0 ? h4[index] : undefined;
    const displacementCandle =
      displacementIndex >= 0 ? h4[displacementIndex] : undefined;
    const displacementBody =
      displacementCandle == null
        ? null
        : displacementCandle.close - displacementCandle.open;
    const requiredBody =
      recomputedAtr == null
        ? null
        : recomputedAtr * ORDER_BLOCK_DISPLACEMENT_ATR;
    const derivedSnapshotValid =
      baseCandle != null &&
      displacementCandle != null &&
      recomputedAtr != null &&
      recomputedAtr > 0 &&
      baseCandle.close < baseCandle.open &&
      displacementCandle.close > displacementCandle.open &&
      displacementBody != null &&
      requiredBody != null &&
      displacementBody >= requiredBody &&
      displacementCandle.close > baseCandle.open + requiredBody &&
      typeof stored?.atr === "number" &&
      typeof storedDisplacement?.body === "number" &&
      typeof storedDisplacement.requiredBody === "number" &&
      Math.abs(stored.atr - recomputedAtr) <= 1e-12 &&
      Math.abs(storedDisplacement.body - displacementBody) <= 1e-12 &&
      Math.abs(storedDisplacement.requiredBody - requiredBody) <= 1e-12;
    if (
      index < ORDER_BLOCK_ATR_LOOKBACK ||
      displacementIndex !== index + 1 ||
      !Number.isFinite(stored?.zoneLow) ||
      !Number.isFinite(stored?.zoneHigh) ||
      typeof stored?.zoneLow !== "number" ||
      typeof stored.zoneHigh !== "number" ||
      !Number.isFinite(stored?.atr) ||
      stored?.high == null ||
      stored?.low == null ||
      stored?.volume == null ||
      h4[index]?.open !== stored?.open ||
      h4[index]?.close !== stored?.close ||
      h4[index]?.high !== stored?.high ||
      h4[index]?.low !== stored?.low ||
      h4[index]?.volume !== stored?.volume ||
      stored?.zoneLow !== h4[index]?.close ||
      stored?.zoneHigh !== h4[index]?.open ||
      input.frozen.level !== (stored.zoneLow + stored.zoneHigh) / 2 ||
      !derivedSnapshotValid ||
      h4[displacementIndex]?.open !== storedDisplacement?.open ||
      h4[displacementIndex]?.close !== storedDisplacement?.close ||
      h4[displacementIndex]?.high !== storedDisplacement?.high ||
      h4[displacementIndex]?.low !== storedDisplacement?.low ||
      h4[displacementIndex]?.volume !== storedDisplacement?.volume ||
      snapshot?.version !== ORDER_BLOCK_VERSION ||
      snapshot.armCloseTime !== input.frozen.armedAt ||
      snapshot.deadline !==
        input.frozen.armedAt + ORDER_BLOCK_REACTION_TTL_MS ||
      snapshot.ttlMs !== ORDER_BLOCK_REACTION_TTL_MS ||
      snapshot.thresholds?.displacementAtr !== ORDER_BLOCK_DISPLACEMENT_ATR ||
      snapshot.thresholds?.atrLookback !== ORDER_BLOCK_ATR_LOOKBACK ||
      snapshot.atrWindow?.length !== ORDER_BLOCK_ATR_LOOKBACK ||
      snapshot.atrWindow?.some((windowCandle, windowIndex) => {
        const candle = h4[index - ORDER_BLOCK_ATR_LOOKBACK + windowIndex];
        return (
          !candle ||
          candle.time !== windowCandle.time ||
          candle.open !== windowCandle.open ||
          candle.high !== windowCandle.high ||
          candle.low !== windowCandle.low ||
          candle.close !== windowCandle.close ||
          candle.volume !== windowCandle.volume
        );
      })
    ) {
      return {
        method: "order_block_support_bounce",
        status: "terminal",
        reason: "missing_frozen_order_block_evidence",
        frozenLevel: input.frozen.level,
        armCandleTime: input.frozen.armedAt,
        triggerCandleTime: null,
        volumeEvidence: volumeEvidence(h1, h1.length - 1),
        evidence: input.frozen.evidence ?? baseEvidence,
      };
    }
    const frozenStored = stored!;
    candidate = {
      index,
      atr: frozenStored.atr!,
      zoneLow: frozenStored.zoneLow!,
      zoneHigh: frozenStored.zoneHigh!,
    };
  } else {
    for (
      let index = ORDER_BLOCK_ATR_LOOKBACK;
      index < h4.length - 1;
      index += 1
    ) {
      const base = h4[index]!;
      const displacement = h4[index + 1]!;
      const atr = averageRange(h4.slice(0, index));
      if (!atr || base.close >= base.open) continue;
      const bodyHigh = base.open;
      const bodyLow = base.close;
      const impulseBody = displacement.close - displacement.open;
      if (
        displacement.close <= bodyHigh + atr * ORDER_BLOCK_DISPLACEMENT_ATR ||
        impulseBody < atr * ORDER_BLOCK_DISPLACEMENT_ATR
      )
        continue;
      candidate = { index, atr, zoneLow: bodyLow, zoneHigh: bodyHigh };
    }
  }
  if (!candidate) {
    return {
      ...empty("order_block_support_bounce", "no_displacement"),
      evidence: baseEvidence,
    };
  }
  const base = h4[candidate.index]!;
  const displacement = h4[candidate.index + 1]!;
  const armCandleTime = input.frozen?.armedAt ?? displacement.time + H4;
  const frozenLevel =
    input.frozen?.level ?? (candidate.zoneLow + candidate.zoneHigh) / 2;
  const orderBlock = {
    candleTime: base.time,
    zoneLow: candidate.zoneLow,
    zoneHigh: candidate.zoneHigh,
    open: base.open,
    close: base.close,
    volume: base.volume,
    high: base.high,
    low: base.low,
    atr: candidate.atr,
  };
  const displacementEvidence = {
    candleTime: displacement.time,
    open: displacement.open,
    close: displacement.close,
    body: displacement.close - displacement.open,
    requiredBody: candidate.atr * ORDER_BLOCK_DISPLACEMENT_ATR,
    high: displacement.high,
    low: displacement.low,
    volume: displacement.volume,
  };
  const snapshot = {
    version: ORDER_BLOCK_VERSION,
    armCloseTime: armCandleTime,
    deadline: armCandleTime + ORDER_BLOCK_REACTION_TTL_MS,
    ttlMs: ORDER_BLOCK_REACTION_TTL_MS,
    thresholds: {
      displacementAtr: ORDER_BLOCK_DISPLACEMENT_ATR,
      atrLookback: ORDER_BLOCK_ATR_LOOKBACK,
    },
    atrWindow: h4.slice(
      candidate.index - ORDER_BLOCK_ATR_LOOKBACK,
      candidate.index,
    ),
  };
  const evidence = {
    version: ORDER_BLOCK_VERSION,
    snapshot,
    orderBlock,
    displacement: displacementEvidence,
    reaction: null,
  };
  const deadline = armCandleTime + ORDER_BLOCK_REACTION_TTL_MS;
  const through = Math.min(input.observedAt, deadline);
  const events: Array<
    | { kind: "reaction"; closeTime: number; index: number }
    | { kind: "invalidation"; closeTime: number; index: number }
  > = [];
  h1.forEach((reaction, index) => {
    const closeTime = reaction.time + H1;
    if (closeTime > armCandleTime && closeTime <= through) {
      events.push({ kind: "reaction", closeTime, index });
    }
  });
  h4.forEach((candle, index) => {
    const closeTime = candle.time + H4;
    if (
      index > candidate!.index + 1 &&
      closeTime > armCandleTime &&
      closeTime <= through &&
      candle.close < candidate!.zoneLow
    ) {
      events.push({ kind: "invalidation", closeTime, index });
    }
  });
  events.sort(
    (left, right) =>
      left.closeTime - right.closeTime ||
      (left.kind === "invalidation"
        ? -1
        : right.kind === "invalidation"
          ? 1
          : 0),
  );
  let latestObservation: Record<string, unknown> | null = null;
  for (const event of events) {
    if (event.kind === "invalidation") {
      return {
        method: "order_block_support_bounce",
        status: "terminal",
        reason: "order_block_invalidated_below_zone",
        frozenLevel,
        armCandleTime,
        triggerCandleTime: null,
        volumeEvidence: volumeEvidence(h1, event.index),
        evidence: { ...evidence, latestObservation },
      };
    }
    const reaction = h1[event.index]!;
    const volume = volumeEvidence(h1, event.index);
    const turnover = usd(reaction);
    const retested =
      reaction.low <= candidate.zoneHigh &&
      reaction.low >= candidate.zoneLow &&
      reaction.close >= frozenLevel;
    latestObservation = {
      reactionCandleTime: reaction.time,
      closeTime: event.closeTime,
      turnover,
      retested,
      ratio: volume.ratio,
    };
    if (
      retested &&
      reaction.close > reaction.open &&
      (volume.ratio ?? 0) >= SUPPORT_VOLUME_RATIO &&
      meetsTurnover(turnover, input.marketCapUsd, NEON_MIN_TURNOVER_PCT_OF_MCAP)
    ) {
      return {
        method: "order_block_support_bounce",
        status: "qualified",
        reason: "later_closed_1h_order_block_reaction",
        frozenLevel,
        armCandleTime,
        triggerCandleTime: reaction.time,
        volumeEvidence: volume,
        evidence: { ...evidence, latestObservation },
      };
    }
  }
  if (input.observedAt >= deadline) {
    return {
      method: "order_block_support_bounce",
      status: "terminal",
      reason: "reaction_window_expired",
      frozenLevel,
      armCandleTime,
      triggerCandleTime: null,
      volumeEvidence: volumeEvidence(h1, h1.length - 1),
      evidence: { ...evidence, latestObservation },
    };
  }
  return {
    method: "order_block_support_bounce",
    status: "armed",
    reason: "awaiting_later_1h_order_block_reaction",
    frozenLevel,
    armCandleTime,
    triggerCandleTime: null,
    volumeEvidence: volumeEvidence(h1, h1.length - 1),
    evidence: { ...evidence, latestObservation },
  };
}
