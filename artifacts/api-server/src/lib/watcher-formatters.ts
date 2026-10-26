// ── Watcher message formatters & P&L helpers ─────────────────────────────────
// Pure functions: string formatting, P&L math, Telegram message builders.
// No side effects, no DB calls, no in-memory state.

import type { TrackedSignal } from "@workspace/db";
import { getProtectedBuStopExit } from "./raw-pnl.js";
import {
  MILESTONES,
  getExitProfile,
  getMaxWatchDays,
  getBuStopMilestone,
  hasNoProfitStopPromotion,
  resolveBuStopProtection,
} from "./watcher-config.js";
import { getPatternTgLabel } from "./pattern-labels.js";
import { isBingxExclusive, isBinanceSpotListed } from "./coinglass_listings.js";
import {
  IMPULSE_RUNNER_POLICY_VERSION,
  IMPULSE_RUNNER_TRAILING_ACTIVATION_PCT,
  isImpulseRunnerPolicy,
} from "./impulse-runner-policy.js";

export function fmtImpulseRunnerPolicyLine(signal: {
  sentimentKey?: string | null;
  policyVersion?: string | null;
  entryPolicyVersion?: string | null;
}): string {
  if (!isImpulseRunnerPolicy(signal.policyVersion)) return "";
  return [
    `🧊 <b>Exit policy ${IMPULSE_RUNNER_POLICY_VERSION}</b>`,
    `После стандартного трейлинга core закрывается отдельно, runner продолжает движение.`,
    `После закрытия core: аварийный стоп runner в Б/У от исходного входа.`,
  ].join("\n");
}

export function fmtImpulseRunnerCoreCloseLine(input: {
  coreExitPrice: number;
  corePnlPercent: number;
}): string {
  return `✂️ Core закрыт: ${fmtP(input.coreExitPrice)} (${fmtPct(input.corePnlPercent)}) · runner остаётся открыт, аварийный стоп — Б/У от исходного входа.`;
}

export function fmtImpulseRunnerFinalLine(input: {
  coreExitPrice: number;
  corePnlPercent: number;
  runnerExitPrice: number;
  runnerPnlPercent: number;
}): string {
  return `Core ${fmtP(input.coreExitPrice)} (${fmtPct(input.corePnlPercent)}) · Runner ${fmtP(input.runnerExitPrice)} (${fmtPct(input.runnerPnlPercent)})`;
}

// ── Liquidation cluster context (for follow-up messages) ─────────────────────

/** Ближайшие кластеры ликвидаций относительно текущей цены.
 *  Вычисляется из getLiqLevels(symbol, currentPrice) в момент отправки follow-up. */
export interface LiqContext {
  /** Ближайший кластер ЛОНГ-ликвидаций ниже текущей цены (поддержка/стоп). */
  below?: { pct: number; usd: number };
  /** Ближайший кластер ШОРТ-ликвидаций выше текущей цены (сопротивление/цель). */
  above?: { pct: number; usd: number };
}

/** Форматирует строку кластеров ликвидаций для follow-up сообщений.
 *  Возвращает пустую строку если данных нет. */
export function fmtLiqContextLine(ctx: LiqContext | null | undefined): string {
  if (!ctx) return "";
  const parts: string[] = [];
  if (ctx.below) {
    const usdStr = ctx.below.usd > 0 ? ` (${fmtVolM(ctx.below.usd)})` : "";
    parts.push(`▼ −${ctx.below.pct.toFixed(1)}% лонги${usdStr}`);
  }
  if (ctx.above) {
    const usdStr = ctx.above.usd > 0 ? ` (${fmtVolM(ctx.above.usd)})` : "";
    parts.push(`▲ +${ctx.above.pct.toFixed(1)}% шорты${usdStr}`);
  }
  return parts.length > 0 ? `📍 Кластеры: ${parts.join(" | ")}` : "";
}

/** OB стакан при входе — для отображения в сопроводительных сообщениях.
 *  Возвращает пустую строку если entryObRatio = null (не удалось получить). */
function fmtObLine(t: TrackedSignal): string {
  if (t.entryObRatio == null) return "";
  const emoji =
    t.entryObRatio >= 1.5 ? "🟢" : t.entryObRatio <= 0.7 ? "🔴" : "⚪";
  return `📊 OB стакан: ${t.entryObRatio.toFixed(2)}x${emoji}`;
}

// ─── Live health snapshot (OI + Spot Taker CVD) ───────────────────────────────

/** Snapshot of live market health fetched at the moment a position update fires. */
export interface SpotHealth {
  /** OI change % (30m slice). null = CoinGlass unavailable. */
  oiPct: number | null;
  /** Last 15m candle: taker_buy > taker_sell (Spot Taker). null = unavailable. */
  cvd15m: boolean | null;
  /** Last 30m: taker_buy > taker_sell. null = unavailable. */
  cvd30m: boolean | null;
  /** Last 1h: taker_buy > taker_sell. null = unavailable. */
  cvd1h: boolean | null;
}

/**
 * Formats a compact one-line health snapshot, e.g.:
 *   "📈 OI: +3.2% | CVD15 ↑ | CVD30 ↓ | CVD1h ↓"
 * Returns "" when health is null/undefined or all fields are null.
 */
export function fmtHealthLine(h: SpotHealth | null | undefined): string {
  if (!h) return "";
  const parts: string[] = [];
  if (h.oiPct != null)
    parts.push(`OI: ${h.oiPct >= 0 ? "+" : ""}${h.oiPct.toFixed(1)}%`);
  if (h.cvd15m === true) parts.push("CVD15 ↑");
  else if (h.cvd15m === false) parts.push("CVD15 ↓");
  if (h.cvd30m === true) parts.push("CVD30 ↑");
  else if (h.cvd30m === false) parts.push("CVD30 ↓");
  if (h.cvd1h === true) parts.push("CVD1h ↑");
  else if (h.cvd1h === false) parts.push("CVD1h ↓");
  return parts.length > 0 ? `📈 ${parts.join(" | ")}` : "";
}

// ── Price / number formatters ─────────────────────────────────────────────────

export function fmtP(p: number) {
  return p < 1
    ? `$${p.toFixed(6)}`
    : p < 100
      ? `$${p.toFixed(4)}`
      : `$${p.toFixed(2)}`;
}
export function fmtPct(n: number) {
  return `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;
}

type PositionProtectionOptions = {
  /** Milestone atomically claimed for the notification before its text is sent. */
  milestone?: number;
  /** Current trailing stop for an in-flight milestone notification. */
  trailingStopLevel?: number | null;
  /** Reports: drop the "take not reached yet" text (peak is shown already). */
  omitUnearned?: boolean;
};

function resolvedMilestone(
  signal: TrackedSignal,
  notifiedMilestone?: number,
): number {
  return Math.max(signal.lastMilestone ?? 0, notifiedMilestone ?? 0);
}

function isBitcoinSignal(signal: Pick<TrackedSignal, "symbol">): boolean {
  return signal.symbol === "BTC-USDT" || signal.symbol === "BTCUSDT";
}

/** True after the persisted, pattern-specific protection level has been reached. */
export function hasEarnedBuProtection(
  signal: TrackedSignal,
  notifiedMilestone?: number,
): boolean {
  return resolveBuStopProtection({
    sentimentKey: signal.sentimentKey,
    symbol: signal.symbol,
    lastMilestone: resolvedMilestone(signal, notifiedMilestone),
    persistedPeakPnlPercent: null,
  }).earned;
}

/**
 * User-visible take-profit/protection status for all open-position follow-ups.
 * This is presentation-only: the milestone in tracked_signals remains the source
 * of truth, and a timeout breakeven is intentionally not treated as earned BE.
 */
export function fmtPositionProtectionLine(
  signal: TrackedSignal,
  options: PositionProtectionOptions = {},
): string {
  const milestone = resolvedMilestone(signal, options.milestone);
  const protection = resolveBuStopProtection({
    sentimentKey: signal.sentimentKey,
    symbol: signal.symbol,
    lastMilestone: milestone,
    persistedPeakPnlPercent: null,
  });
  const buMilestone = protection.milestone;
  const protectedProfitPct = protection.protectedProfitPct;
  const protectedExit = getProtectedBuStopExit(
    signal.entryPrice,
    protectedProfitPct,
  );
  const protectedStopLabel =
    protectedProfitPct > 0 ? `PROFIT STOP +${protectedProfitPct}%` : "BE STOP";
  const isBitcoin = isBitcoinSignal(signal);

  if (!hasEarnedBuProtection(signal, options.milestone)) {
    if (isBitcoin) {
      return `₿ Б/У ещё не заработан: нужен пик +${buMilestone}% от входа · трейлинг начнётся только с +2%`;
    }
    // The "take not yet reached" line is redundant next to the next-protection
    // level line; only the reached intermediate target is worth stating.
    return milestone > 0
      ? `🎯 Промежуточная цель +${milestone}% достигнута`
      : "";
  }

  if (signal.status === "bu_stop") {
    if (isBitcoin) {
      return `₿ Уровень +${buMilestone}% достигнут · 🛡 ${protectedStopLabel} сработал на ${fmtP(protectedExit.exitPrice ?? signal.entryPrice)}`;
    }
    return `✅ Тейк +${buMilestone}% достигнут · 🛡 ${protectedStopLabel} сработал на ${fmtP(protectedExit.exitPrice ?? signal.entryPrice)}`;
  }

  const exitProfile = getExitProfile(signal.sentimentKey, signal.symbol);
  const peakPnl =
    signal.peakPrice != null && signal.entryPrice > 0
      ? ((signal.peakPrice - signal.entryPrice) / signal.entryPrice) * 100
      : null;
  const trailingActive =
    milestone >= exitProfile.trailingActivation ||
    (isBitcoin && peakPnl != null && peakPnl >= exitProfile.trailingActivation);
  const trailingStopLevel =
    options.trailingStopLevel ?? signal.trailingStopLevel ?? null;

  if (isBitcoin) {
    if (trailingActive) {
      const stopPrice = Math.max(
        trailingStopLevel ?? 0,
        signal.entryPrice *
          (1 +
            (Math.max(milestone, peakPnl ?? 0) - exitProfile.trailingGap) /
              100),
      );
      const protectedPct =
        ((stopPrice - signal.entryPrice) / signal.entryPrice) * 100;
      return `✅ Б/У активирован при +1% · 🛡 BTC-трейлинг: пик PnL −1 п.п. · стоп ${fmtP(stopPrice)} (защита ${fmtPct(protectedPct)})`;
    }
    return `✅ Б/У активирован при +1% · 🛡 стоп в точке входа ${fmtP(signal.entryPrice)} · трейлинг включится только с +2%`;
  }

  const noProfitLock = hasNoProfitStopPromotion(signal.sentimentKey);
  if (trailingActive) {
    const passed = noProfitLock ? "БУ пройден" : "PROFIT STOP +5% пройден";
    return trailingStopLevel != null
      ? `🛡 ${passed}, трейлинг: ${fmtP(trailingStopLevel)}`
      : `🛡 ${passed}, трейлинг активен`;
  }

  const nextProfitLock =
    !noProfitLock && buMilestone < 10 ? " · при +10% стоп в прибыль +5%" : "";
  return `✅ Тейк +${buMilestone}% достигнут · 🛡 ${protectedStopLabel} → ${fmtP(protectedExit.exitPrice ?? signal.entryPrice)}${nextProfitLock}`;
}

export function fmtVolM(v: number): string {
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `$${(v / 1_000).toFixed(0)}K`;
  return `$${v.toFixed(0)}`;
}

export type SplitFillMarketContext = {
  oi30m?: number | null;
  spotCvdStrength1h?: number | null;
  spotCvd1h?: boolean | null;
  obRatio?: number | null;
};

export function fmtSplitFillMarketContext(
  context: SplitFillMarketContext,
): string[] {
  const flow: string[] = [];
  if (context.oi30m != null && Number.isFinite(context.oi30m)) {
    flow.push(`OI Δ 30m: ${fmtPct(context.oi30m)}`);
  }
  if (
    context.spotCvdStrength1h != null &&
    Number.isFinite(context.spotCvdStrength1h)
  ) {
    const strengthPct = context.spotCvdStrength1h * 100;
    const emoji = strengthPct > 0 ? "🟢" : strengthPct < 0 ? "🔴" : "⚪";
    flow.push(`Spot CVD 1h: ${fmtPct(strengthPct)} ${emoji}`);
  } else if (context.spotCvd1h != null) {
    flow.push(
      `Spot CVD 1h: ${context.spotCvd1h ? "покупки 🟢" : "продажи 🔴"}`,
    );
  }

  const book: string[] = [];
  if (context.obRatio != null && Number.isFinite(context.obRatio)) {
    const emoji =
      context.obRatio >= 1.5 ? "🟢" : context.obRatio <= 0.7 ? "🔴" : "⚪";
    book.push(`OB ${context.obRatio.toFixed(2)}x ${emoji}`);
  }

  return [
    flow.length > 0 ? `📊 ${flow.join(" · ")}` : "",
    book.length > 0 ? `📚 Стакан: ${book.join(" · ")}` : "",
  ].filter(Boolean);
}
export function scoreBar(s: number) {
  const f = Math.round(s);
  return "█".repeat(f) + "░".repeat(10 - f);
}

/** SNF-строка для сообщений сопровождения.
 *  Использует значения на момент входа (entrySpotNetBuy*).
 *  Возвращает пустую строку если все три null — filter(Boolean) уберёт её. */
export function fmtSnfLine(t: TrackedSignal): string {
  const s1h = t.entrySpotNetBuy1h;
  const s4h = t.entrySpotNetBuy4h;
  const s24h = t.entrySpotNetBuy24h;
  if (s1h == null && s4h == null && s24h == null) return "";
  const fmtV = (v: number | null) =>
    v == null ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`;
  const emoji =
    s1h == null
      ? ""
      : s1h >= 3
        ? "🟢"
        : s1h >= 1
          ? "🔵"
          : s1h <= -3
            ? "🔴"
            : s1h <= -1
              ? "🟠"
              : "⚪";
  return `🌊 SNF: 1h ${fmtV(s1h)}${emoji} · 4h ${fmtV(s4h)} · 24h ${fmtV(s24h)}`;
}

/** Точная длительность: «43м», «2ч 15м», «1д 3ч». Без «0ч». */
export function formatActiveDuration(ms: number): string {
  const totalMin = Math.max(0, Math.floor(ms / 60_000));
  const d = Math.floor(totalMin / 1440);
  const h = Math.floor((totalMin % 1440) / 60);
  const m = totalMin % 60;
  if (d > 0) return m > 0 ? `${d}д ${h}ч ${m}м` : `${d}д ${h}ч`;
  if (h > 0) return `${h}ч ${m}м`;
  return `${m}м`;
}

/** Строка «Был активен: …» от входа до closedAt (по умолчанию — сейчас). */
export function activeForLine(
  detectedAt: Date | null | undefined,
  closedAt: Date = new Date(),
): string | null {
  if (!detectedAt) return null;
  return `⏱ Был активен: ${formatActiveDuration(closedAt.getTime() - detectedAt.getTime())}`;
}

export function hoursAndDays(from: Date): {
  h: number;
  d: number;
  str: string;
} {
  const ms = Date.now() - from.getTime();
  const h = ms / 3_600_000;
  const d = Math.floor(h / 24);
  const rem = Math.round(h % 24);
  return { h, d, str: d > 0 ? `${d}д ${rem}ч` : `${Math.round(h)}ч` };
}

// ── Hashtag helpers ───────────────────────────────────────────────────────────
/** "BTC-USDT" → "#BTC" */
export function tickerTag(symbol: string): string {
  return `#${symbol.replace("-USDT", "").replace(/[^A-Za-z0-9]/g, "")}`;
}

function currentOpenPriceLine(
  signal: TrackedSignal,
  currentPrice: number | undefined,
): string {
  const hasCurrentPrice =
    currentPrice != null && Number.isFinite(currentPrice) && currentPrice > 0;

  if (!hasCurrentPrice) {
    return ` | Вход: ${fmtP(signal.entryPrice)} | Сейчас: недоступна`;
  }

  const pnl =
    ((signal.isShort
      ? signal.entryPrice - currentPrice
      : currentPrice - signal.entryPrice) /
      signal.entryPrice) *
    100;
  return ` | Вход: ${fmtP(signal.entryPrice)} | Сейчас: ${fmtP(currentPrice)} (${fmtPct(pnl)})`;
}

function openPositionPeakPnl(signal: TrackedSignal): number | null {
  if (!signal.peakPrice || !signal.entryPrice) return null;
  return ((signal.peakPrice - signal.entryPrice) / signal.entryPrice) * 100;
}

/**
 * Formats live open positions for every Telegram report that lists them.
 * The caller supplies the just-fetched ticker map, keeping this formatter pure.
 */
export function formatOpenPositionLines(
  allOpen: readonly TrackedSignal[],
  priceMap: ReadonlyMap<string, number>,
  includeTickerTag = true,
): string[] {
  const lines: string[] = [];
  const inRun = allOpen.filter((signal) => signal.status === "in_run");
  const watching = allOpen.filter((signal) => signal.status === "active");

  const formatRow = (signal: TrackedSignal, includeTrailingStop: boolean) => {
    const peak = openPositionPeakPnl(signal);
    const peakStr =
      peak != null && peak > 0 ? ` | Пик: +${peak.toFixed(1)}%` : "";
    const trailingStop =
      includeTrailingStop && signal.trailingStopLevel
        ? ` | Trailing: ${fmtP(signal.trailingStopLevel)}`
        : "";
    const pattern = signal.sentimentKey
      ? ` [${getPatternTgLabel(signal.sentimentKey)}]`
      : "";
    const ticker = includeTickerTag ? ` ${tickerTag(signal.symbol)}` : "";
    const age = hoursAndDays(signal.detectedAt).str;
    return [
      `  • <b>${signal.symbol.replace("-USDT", "")}</b>${pattern}${ticker}${currentOpenPriceLine(signal, priceMap.get(signal.symbol))}${peakStr}${trailingStop} | ${age}`,
      (() => {
        const line = fmtPositionProtectionLine(signal, {
          omitUnearned: true,
        });
        return line ? `    ${line}` : "";
      })(),
    ]
      .filter(Boolean)
      .join("\n");
  };

  if (inRun.length > 0) {
    lines.push(`🚀 <b>В полёте (Moonshot) — ${inRun.length}:</b>`);
    lines.push(...inRun.map((signal) => formatRow(signal, true)), ``);
  }

  if (watching.length > 0) {
    lines.push(`👁 <b>В наблюдении — ${watching.length}:</b>`);
    lines.push(...watching.map((signal) => formatRow(signal, false)), ``);
  }

  return lines;
}

/** "hidden_accumulation" → "#hidden_accumulation" */
export function patternTag(sentimentKey: string | null | undefined): string {
  if (!sentimentKey) return "";
  return `#${sentimentKey}`;
}

/**
 * Возвращает метку типа листинга токена:
 *   [BingX] — только на BingX (нет кросс-биржевых данных)
 *   [Spot]  — есть на Binance spot (SpBW/SpSW работают)
 *   [Multi] — на нескольких фьючерсных биржах
 */
export function fmtCoverageBadge(symbol: string): string {
  if (isBingxExclusive(symbol)) return "[BingX]";
  if (isBinanceSpotListed(symbol)) return "[Spot]";
  return "[Multi]";
}

/** Returns "🏷 {patternLabel} · {coverageBadge}" line for follow-up messages, or empty string if unknown. */
export function fmtPattern(t: TrackedSignal): string {
  const label = t.sentimentKey
    ? getPatternTgLabel(t.sentimentKey)
    : (t.sentiment ?? null);
  if (!label) return "";
  return `🏷 <b>${label}</b> · ${fmtCoverageBadge(t.symbol)}`;
}

// Lifecycle messages deliberately share these two layouts.  Keep optional
// market observations in their fixed slots; filter only removes unavailable
// observations, never changes the relative order of the remaining blocks.
type LifecycleOptions = {
  event: string;
  price: string;
  context?: readonly string[];
  health?: SpotHealth | null;
  liqCtx?: LiqContext | null;
  tags: string;
  showRunnerPolicy?: boolean;
};

function lifecycleEvidence(
  t: TrackedSignal,
  liqCtx?: LiqContext | null,
): string[] {
  return [fmtObLine(t), fmtSnfLine(t), fmtLiqContextLine(liqCtx)];
}

function lifecycleTags(t: TrackedSignal, suffix: string): string {
  return `${tickerTag(t.symbol)} ${patternTag(t.sentimentKey)} ${suffix}`;
}

function buildPositionUpdate(
  t: TrackedSignal,
  options: LifecycleOptions,
): string {
  const sym = t.symbol.replace("-USDT", "");
  return [
    `🟣📊 <b>POSITION UPDATE — ${sym}</b>`,
    `<b>${options.event}</b>`,
    options.price,
    ``,
    // Exit policy text only for the Core-close message (and the IB signal).
    options.showRunnerPolicy ? fmtImpulseRunnerPolicyLine(t) : "",
    ...(options.context ?? []),
    fmtHealthLine(options.health),
    ...lifecycleEvidence(t, options.liqCtx),
    ``,
    // Owner 2026-10-23: the hashtag carries the pattern; no pattern-name line.
    options.tags,
  ]
    .filter(Boolean)
    .join("\n");
}

function buildPositionClosed(
  t: TrackedSignal,
  options: LifecycleOptions,
): string {
  const sym = t.symbol.replace("-USDT", "");
  return [
    `🏁 <b>POSITION CLOSED — ${sym}</b>`,
    `<b>${options.event}</b>`,
    options.price,
    ``,
    ...(options.context ?? []),
    // Owner 2026-10-23: closure messages carry no OI/CVD, OB or SNF metrics.
    // Stop-loss keeps its liquidation context line only.
    ...(/STOP LOSS/i.test(options.event)
      ? [fmtLiqContextLine(options.liqCtx)]
      : []),
    ``,
    options.tags,
  ]
    .filter(Boolean)
    .join("\n");
}

// ── P&L math ──────────────────────────────────────────────────────────────────

export function computePnl(t: TrackedSignal, price: number): number {
  return ((price - t.entryPrice) / t.entryPrice) * 100;
}

export function computePeakPnl(t: TrackedSignal): number {
  if (!t.peakPrice) return 0;
  return ((t.peakPrice - t.entryPrice) / t.entryPrice) * 100;
}

function fmtPeakLine(t: TrackedSignal): string {
  return t.peakPrice != null
    ? `📈 Пик позиции: ${fmtPct(computePeakPnl(t))} (${fmtP(t.peakPrice)})`
    : `📈 Пик позиции: нет данных`;
}

function fmtBreakevenContext(
  t: TrackedSignal,
  fallbackTake?: number,
): string[] {
  const peakLine =
    t.peakPrice != null
      ? `📈 Пик позиции: ${fmtPct(computePeakPnl(t))} (${fmtP(t.peakPrice)})`
      : `📈 Пик позиции: нет данных`;
  const take =
    t.lastMilestone != null && t.lastMilestone > 0
      ? t.lastMilestone
      : (fallbackTake ?? null);
  const takeLine =
    take != null && take > 0
      ? isBitcoinSignal(t)
        ? `₿ Уровень сопровождения +${take}% достигнут (частичная продажа не подтверждена)`
        : `🎯 Тейк: +${take}% достигнут`
      : isBitcoinSignal(t)
        ? `₿ Уровень сопровождения не достигнут`
        : `🎯 Тейк: не достигнут`;
  return [peakLine, takeLine];
}

export function nextMilestone(
  lastMilestone: number | null,
  currentPnl: number,
): number | null {
  // Возвращаем НАИВЫСШИЙ достигнутый milestone выше lastMilestone.
  // Старая логика возвращала наименьший → слала "+20%" когда сигнал уже на +42%,
  // потом "+25%", "+30%" тремя отдельными сообщениями. Теперь одно сообщение
  // за скачок, показывающее самый высокий пройденный порог.
  const last = lastMilestone ?? 0;
  let highest: number | null = null;
  for (const m of MILESTONES) {
    if (m > last && currentPnl >= m) highest = m;
  }
  return highest;
}

export function nextBitcoinMilestone(
  lastMilestone: number | null,
  currentPnl: number,
  ceiling = Number.POSITIVE_INFINITY,
): number | null {
  const last = Math.max(0, Math.floor(lastMilestone ?? 0));
  const highestReached = Math.min(Math.floor(currentPnl), Math.floor(ceiling));
  const next = last + 1;
  return next <= highestReached ? next : null;
}

// ── Telegram message builders ─────────────────────────────────────────────────

export function msgFirstTarget(
  t: TrackedSignal,
  currentPrice: number,
  liqCtx?: LiqContext | null,
  health?: SpotHealth | null,
): string {
  const pnl = computePnl(t, currentPrice);
  const dur = hoursAndDays(t.detectedAt);
  const exitProfile = getExitProfile(t.sentimentKey, t.symbol);
  const isBitcoin = isBitcoinSignal(t);
  return buildPositionUpdate(t, {
    event: isBitcoin
      ? `₿ BTC: Б/У после +${exitProfile.firstTarget}%`
      : `🎯 TARGET HIT +${exitProfile.firstTarget}%`,
    price: `${fmtP(t.entryPrice)} → ${fmtP(currentPrice)} (${fmtPct(pnl)}) | ${dur.str}`,
    context: isBitcoin
      ? [
          fmtPositionProtectionLine(t, {
            milestone: Math.max(exitProfile.firstTarget, Math.floor(pnl)),
          }),
          pnl >= exitProfile.trailingActivation
            ? `📈 BTC-трейлинг уже активен: пик минус ${exitProfile.trailingGap} п.п.`
            : `⏳ BTC: трейлинг включится только при +${exitProfile.trailingActivation}% от входа; дальнейший стоп — пик минус ${exitProfile.trailingGap} п.п.`,
          `ℹ️ Уровень сопровождения, не подтверждение частичного исполнения`,
        ]
      : [
          `✂️ Фиксируй 20-25%`,
          fmtPositionProtectionLine(t, {
            milestone: exitProfile.firstTarget,
          }),
          `⏳ Следующий уровень: +${exitProfile.trailingActivation}% (трейлинг)`,
        ],
    health,
    liqCtx,
    tags: lifecycleTags(t, "#in_run"),
  });
}

export function msgTrailingActivated(
  t: TrackedSignal,
  currentPrice: number,
  trailingStopLevel: number,
  liqCtx?: LiqContext | null,
  health?: SpotHealth | null,
): string {
  const pnl = computePnl(t, currentPrice);
  const dur = hoursAndDays(t.detectedAt);
  const exitProfile = getExitProfile(t.sentimentKey, t.symbol);
  const isBitcoin = isBitcoinSignal(t);
  return buildPositionUpdate(t, {
    event: isBitcoin
      ? `₿ BTC: ТРЕЙЛИНГ С +${exitProfile.trailingActivation}%`
      : `🎯 TARGET HIT +${exitProfile.trailingActivation}%`,
    price: `${fmtP(t.entryPrice)} → ${fmtP(currentPrice)} (${fmtPct(pnl)}) | ${dur.str}`,
    context: [
      isBitcoin
        ? `📈 BTC-трейлинг активирован при +${exitProfile.trailingActivation}% от входа`
        : `📈 Достигнут уровень активации трейлинга`,
      fmtPositionProtectionLine(t, {
        milestone: exitProfile.trailingActivation,
        trailingStopLevel,
      }),
      isBitcoin
        ? `🛡 Стоп отстоит от пика на ${exitProfile.trailingGap} п.п.; при новом максимуме +1% он подтянется на +1 п.п.`
        : `Текущий уровень трейлинга защищает ${fmtPct(computePnl(t, trailingStopLevel))} и тянется вверх автоматически`,
    ],
    health,
    liqCtx,
    tags: lifecycleTags(t, "#in_run #trailing"),
  });
}

export function msgMilestone(
  t: TrackedSignal,
  milestone: number,
  currentPrice: number,
  trailingStopLevel: number,
  liqCtx?: LiqContext | null,
  health?: SpotHealth | null,
): string {
  const pnl = computePnl(t, currentPrice);
  const stopPnl = ((trailingStopLevel - t.entryPrice) / t.entryPrice) * 100;
  const dur = hoursAndDays(t.detectedAt);
  const btcContext = isBitcoinSignal(t)
    ? `₿ Пик BTC достиг +${milestone}% · трейлинг защищает ${fmtPct(stopPnl)} от входа; частичное исполнение не подтверждено`
    : `🛡 Трейлинг-стоп: ${fmtP(trailingStopLevel)} (${fmtPct(stopPnl)} от входа)`;
  // Заголовок показывает реальный текущий PnL, не порог milestone.
  // Milestone определяет когда отправить сообщение и какую картинку выбрать,
  // но пользователю важно видеть фактический рост, а не пороговое значение.
  return buildPositionUpdate(t, {
    event: isBitcoinSignal(t)
      ? `₿ BTC: уровень +${milestone}%`
      : `🚀 MOONSHOT ${fmtPct(pnl)}`,
    price: `${fmtP(t.entryPrice)} → ${fmtP(currentPrice)} (${fmtPct(pnl)}) | ${dur.str}`,
    context: [btcContext],
    health,
    liqCtx,
    tags: lifecycleTags(t, "#moonshot"),
  });
}

export function msgTrailingStopHit(
  t: TrackedSignal,
  currentPrice: number,
  peakPnl: number,
  finalPnl: number,
  health?: SpotHealth | null,
): string {
  const dur = hoursAndDays(t.detectedAt);
  const alphaScoreLine = t.alphaScore
    ? `🎯 Bullet Score был: ${t.alphaScore}/10  <code>${scoreBar(t.alphaScore)}</code>`
    : "";
  return buildPositionClosed(t, {
    event: isBitcoinSignal(t)
      ? "🟢 BTC: стоп по трейлингу"
      : "🟢 PROFIT (трейлинг)",
    price: `${fmtP(t.entryPrice)} → ${fmtP(currentPrice)} (${fmtPct(finalPnl)}) | ${dur.str}`,
    context: [`📈 Пик позиции: ${fmtPct(peakPnl)}`, alphaScoreLine],
    health,
    tags: lifecycleTags(t, "#profit"),
  });
}

export function msgImpulseRunnerCoreClose(
  t: TrackedSignal,
  corePrice: number,
  corePnl: number,
  peakPnl: number,
  health?: SpotHealth | null,
): string {
  const dur = hoursAndDays(t.detectedAt);
  return buildPositionUpdate(t, {
    showRunnerPolicy: true,
    event: "🟡 CORE CLOSED — standard trailing exit",
    price: `${fmtP(t.entryPrice)} → ${fmtP(corePrice)} (${fmtPct(corePnl)}) | ${dur.str}`,
    context: [
      `📈 Пик позиции: ${fmtPct(peakPnl)}`,
      fmtImpulseRunnerCoreCloseLine({
        coreExitPrice: corePrice,
        corePnlPercent: corePnl,
      }),
    ],
    health,
    tags: lifecycleTags(t, "#impulse_runner #core_closed"),
  });
}

export function msgImpulseRunnerFinalClose(
  t: TrackedSignal,
  runnerPrice: number,
  corePrice: number,
  corePnl: number,
  runnerPnl: number,
  finalStatus: "profit" | "stop_loss" | "expired" | "bu_stop",
  health?: SpotHealth | null,
  closeNote?: "age_expired" | "operator_take_profit",
): string {
  const dur = hoursAndDays(t.detectedAt);
  const runnerEntryPrice = t.originalEntryPrice ?? t.entryPrice;
  return buildPositionClosed(t, {
    event:
      finalStatus === "expired"
        ? "⏳ IMPULSE RUNNER EXPIRED"
        : finalStatus === "bu_stop"
          ? "🔵 IMPULSE RUNNER BE STOP"
          : closeNote === "age_expired" && finalStatus === "profit"
            ? "🟢 IMPULSE RUNNER TAKE PROFIT"
            : closeNote === "operator_take_profit" && finalStatus === "profit"
              ? "🟢 IMPULSE RUNNER TAKE PROFIT"
              : finalStatus === "profit"
                ? "🟢 IMPULSE RUNNER CLOSED"
                : "🔴 IMPULSE RUNNER STOPPED",
    price: `${fmtP(runnerEntryPrice)} → ${fmtP(runnerPrice)} (${fmtPct(runnerPnl)}) | ${dur.str}`,
    context: [
      fmtImpulseRunnerFinalLine({
        coreExitPrice: corePrice,
        corePnlPercent: corePnl,
        runnerExitPrice: runnerPrice,
        runnerPnlPercent: runnerPnl,
      }),
      ...(finalStatus === "bu_stop"
        ? fmtBreakevenContext(
            {
              ...t,
              peakPrice:
                t.runnerPeakPrice == null
                  ? t.peakPrice
                  : Math.max(t.peakPrice ?? t.entryPrice, t.runnerPeakPrice),
            },
            t.lastMilestone ?? undefined,
          )
        : []),
      ...(closeNote === "age_expired"
        ? [
            finalStatus === "bu_stop"
              ? "5 суток от исходного входа: оставшийся runner закрыт по защищённому Б/У."
              : "5 суток от исходного входа: закрыт по наблюдаемой цене или заработанному трейлинг-уровню с фактическим PNL.",
          ]
        : closeNote === "operator_take_profit"
          ? ["Принудительное закрытие старого runner по Take Profit."]
          : []),
    ],
    health,
    tags: lifecycleTags(t, `#impulse_runner #${finalStatus}`),
  });
}

export function msgImpulseRunnerAccountingCorrection(
  t: TrackedSignal,
  runnerPrice: number,
  corePrice: number,
  corePnl: number,
  runnerPnl: number,
  priorPnl: number | null,
  finalStatus: "profit" | "stop_loss" | "expired",
): string {
  const priorLine =
    priorPnl == null
      ? "Предыдущий итог был рассчитан неполно."
      : `Предыдущий итог: ${fmtPct(priorPnl)}.`;
  return [
    "⚠️ <b>ИСПРАВЛЕНИЕ ИТОГА IMPULSE RUNNER</b>",
    priorLine,
    `Правильный итог: <b>${fmtPct(runnerPnl)}</b>.`,
    "",
    msgImpulseRunnerFinalClose(
      t,
      runnerPrice,
      corePrice,
      corePnl,
      runnerPnl,
      finalStatus,
    ),
  ].join("\n");
}

export function msgStopLoss(
  t: TrackedSignal,
  currentPrice: number,
  pnl: number,
  health?: SpotHealth | null,
): string {
  const dur = hoursAndDays(t.detectedAt);
  return buildPositionClosed(t, {
    event: "🔴 STOP LOSS",
    price: `${fmtP(t.entryPrice)} → ${fmtP(currentPrice)} (${fmtPct(pnl)}) | ${dur.str}`,
    context: [fmtPeakLine(t)],
    health,
    tags: lifecycleTags(t, "#stop_loss"),
  });
}

export function msgBUStop(
  t: TrackedSignal,
  currentPrice: number,
  pnl: number,
  health?: SpotHealth | null,
): string {
  const actualExitPrice =
    Number.isFinite(currentPrice) && currentPrice > 0
      ? currentPrice
      : t.entryPrice;
  const actualPnl = Number.isFinite(pnl)
    ? Math.max(0, pnl)
    : Math.max(0, computePnl(t, actualExitPrice));
  const isProfitStop = actualPnl > 0.001;
  const profitStopLabel = Number.isInteger(actualPnl)
    ? actualPnl.toFixed(0)
    : actualPnl.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
  const protection = resolveBuStopProtection({
    sentimentKey: t.sentimentKey,
    symbol: t.symbol,
    lastMilestone: t.lastMilestone,
    persistedPeakPnlPercent: t.peakPrice != null ? computePeakPnl(t) : null,
  });
  const dur = hoursAndDays(t.detectedAt);
  const breakevenContext = fmtBreakevenContext(t, protection.milestone);
  return buildPositionClosed(t, {
    event: `🔵 ${isProfitStop ? `PROFIT STOP +${profitStopLabel}%` : "BE STOP"}`,
    price: `${fmtP(t.entryPrice)} → ${fmtP(actualExitPrice)} (${fmtPct(actualPnl)}) | ${dur.str}`,
    context: breakevenContext,
    health,
    tags: lifecycleTags(t, "#be_stop"),
  });
}

export function msgPartialTakeProfit(
  t: TrackedSignal,
  currentPrice: number,
  pnl: number,
  health?: SpotHealth | null,
): string {
  const dur = hoursAndDays(t.detectedAt);
  const milestone = getBuStopMilestone(t.sentimentKey, t.symbol);
  const isBitcoin = isBitcoinSignal(t);
  return buildPositionUpdate(t, {
    event: isBitcoin
      ? `₿ BTC: уровень Б/У +${milestone}%`
      : `🎯 TARGET HIT +${milestone}%`,
    price: `${fmtP(t.entryPrice)} → ${fmtP(currentPrice)} (${fmtPct(pnl)}) | ${dur.str}`,
    context: [
      fmtPositionProtectionLine(t, { milestone }),
      isBitcoin
        ? `₿ BTC: достигнут уровень Б/У +1%; частичное исполнение не подтверждено`
        : `✂️ Фиксируй 20-25%`,
    ],
    health,
    tags: lifecycleTags(t, "#partial"),
  });
}

/** Early progress before a pattern's own breakeven milestone.
 * Keeps the normal target context but never claims that the stop moved to BE. */
export function msgPreTargetMilestone(
  t: TrackedSignal,
  milestone: number,
  currentPrice: number,
  liqCtx?: LiqContext | null,
  health?: SpotHealth | null,
): string {
  const pnl = computePnl(t, currentPrice);
  const dur = hoursAndDays(t.detectedAt);
  const isBitcoin = isBitcoinSignal(t);
  const nextTarget = isBitcoin
    ? milestone + 1
    : milestone < 8
      ? 8
      : getBuStopMilestone(t.sentimentKey, t.symbol);
  return buildPositionUpdate(t, {
    event: isBitcoin
      ? `₿ BTC: уровень +${milestone}%`
      : `🎯 TARGET HIT +${milestone}%`,
    price: `${fmtP(t.entryPrice)} → ${fmtP(currentPrice)} (${fmtPct(pnl)}) | ${dur.str}`,
    context: isBitcoin
      ? [
          fmtPositionProtectionLine(t, { milestone }),
          `⏳ Следующий BTC-уровень: +${nextTarget}%`,
          `ℹ️ Это уровень сопровождения; частичное исполнение не подтверждено`,
        ]
      : [
          `✂️ Фиксируй 20-25%`,
          fmtPositionProtectionLine(t, { milestone }),
          `⏳ Следующий уровень защиты: +${nextTarget}%`,
        ],
    health,
    liqCtx,
    tags: lifecycleTags(t, `#target_${milestone}`),
  });
}

export function msg8PercentHit(
  t: TrackedSignal,
  currentPrice: number,
  liqCtx?: LiqContext | null,
  health?: SpotHealth | null,
): string {
  const pnl = computePnl(t, currentPrice);
  const dur = hoursAndDays(t.detectedAt);
  const exitProfile = getExitProfile(t.sentimentKey, t.symbol);
  return buildPositionUpdate(t, {
    event: "🎯 TARGET HIT +8%",
    price: `${fmtP(t.entryPrice)} → ${fmtP(currentPrice)} (${fmtPct(pnl)}) | ${dur.str}`,
    context: [
      `✂️ Фиксируй 20-25%`,
      fmtPositionProtectionLine(t, { milestone: 8 }),
      `⏳ Следующее событие: активация трейлинга на +${exitProfile.trailingActivation}%`,
    ],
    health,
    liqCtx,
    tags: lifecycleTags(t, "#target_8"),
  });
}

export function msgAccumVolumeBuilding(
  t: TrackedSignal,
  currentPrice: number,
  pnl: number,
  volMult: number,
  _spotVol24h: number | null,
  spotVolMult?: number | null,
  health?: SpotHealth | null,
): string {
  const dur = hoursAndDays(t.detectedAt);
  const displayMult = (spotVolMult ?? volMult).toFixed(1);
  return buildPositionUpdate(t, {
    event: `🔄 НАКОПЛЕНИЕ`,
    price: `${fmtP(t.entryPrice)} → ${fmtP(currentPrice)} (${fmtPct(pnl)}) | ${dur.str}`,
    context: [
      `📡 Спот-активность ${displayMult}x нормы — первый признак пробуждения`,
      fmtPositionProtectionLine(t),
    ],
    health,
    tags: lifecycleTags(t, "#accumulation"),
  });
}

export function msgAccumOiBuilding(
  t: TrackedSignal,
  currentPrice: number,
  pnl: number,
  oiChange: number,
  health?: SpotHealth | null,
): string {
  const dur = hoursAndDays(t.detectedAt);
  return buildPositionUpdate(t, {
    event: `🔄 НАКОПЛЕНИЕ`,
    price: `${fmtP(t.entryPrice)} → ${fmtP(currentPrice)} (${fmtPct(pnl)}) | ${dur.str}`,
    context: [
      `📈 OI +${oiChange.toFixed(1)}% за 30м — крупный игрок набирает`,
      fmtPositionProtectionLine(t),
    ],
    health,
    tags: lifecycleTags(t, "#accumulation"),
  });
}

export function msgAccumulationReminder(
  t: TrackedSignal,
  currentPrice: number,
  pnl: number,
  health?: SpotHealth | null,
): string {
  const dur = hoursAndDays(t.detectedAt);
  return buildPositionUpdate(t, {
    event: `🔄 НАКОПЛЕНИЕ`,
    price: `${fmtP(t.entryPrice)} → ${fmtP(currentPrice)} (${fmtPct(pnl)}) | ${dur.str}`,
    context: [
      `👁 Без изменений, наблюдаю до ${getMaxWatchDays(t.sentimentKey)} ${getMaxWatchDays(t.sentimentKey) === 1 ? "дня" : "дней"}`,
      fmtPositionProtectionLine(t),
    ],
    health,
    tags: lifecycleTags(t, "#accumulation"),
  });
}

export function msgAccumulation(
  t: TrackedSignal,
  currentPrice: number,
  pnl: number,
  health?: SpotHealth | null,
): string {
  const dur = hoursAndDays(t.detectedAt);
  return buildPositionUpdate(t, {
    event: `🔄 НАКОПЛЕНИЕ`,
    price: `${fmtP(t.entryPrice)} → ${fmtP(currentPrice)} (${fmtPct(pnl)}) | ${dur.str}`,
    context: [fmtPositionProtectionLine(t)],
    health,
    tags: lifecycleTags(t, "#accumulation"),
  });
}

export function msgReEntry(
  t: TrackedSignal,
  currentPrice: number,
  volMult: number,
  _spotVol24h: number | null,
  health?: SpotHealth | null,
): string {
  const { str } = hoursAndDays(t.detectedAt);
  const pnl = computePnl(t, currentPrice);
  return buildPositionUpdate(t, {
    event: `🔁 RE-ENTRY`,
    price: `${fmtP(t.entryPrice)} → ${fmtP(currentPrice)} (${fmtPct(pnl)}) | ${str}`,
    context: [
      `Спот-активность ${volMult.toFixed(1)}x нормы вернулась спустя ${str} — накопление завершено, ожидается импульс`,
      fmtPositionProtectionLine(t),
    ],
    health,
    tags: lifecycleTags(t, "#re_entry"),
  });
}

export function msgLateSignal(
  t: TrackedSignal,
  currentPrice: number,
  pnl: number,
  health?: SpotHealth | null,
): string {
  const exitProfile = getExitProfile(t.sentimentKey, t.symbol);
  const isBitcoin = isBitcoinSignal(t);
  return buildPositionUpdate(t, {
    event: `⚠️ ЗАПОЗДАЛЫЙ СИГНАЛ`,
    price: `${fmtP(t.entryPrice)} → ${fmtP(currentPrice)} (${fmtPct(pnl)}) | ${hoursAndDays(t.detectedAt).str}`,
    context: [
      `Цена уже ${fmtPct(pnl)} к моменту обнаружения`,
      isBitcoin
        ? pnl >= exitProfile.trailingActivation
          ? `Входить не рекомендуется. BTC: трейлинг активен с +${exitProfile.trailingActivation}% (пик минус ${exitProfile.trailingGap} п.п.).`
          : `Входить не рекомендуется. BTC: Б/У с +1%; трейлинг ещё не активен до +${exitProfile.trailingActivation}% (пик минус ${exitProfile.trailingGap} п.п.).`
        : `Входить не рекомендуется, момент пропущен. Трейлинг-стоп ${exitProfile.trailingGap}% включён.`,
      fmtPositionProtectionLine(t, {
        milestone: exitProfile.firstTarget,
      }),
    ],
    health,
    tags: lifecycleTags(t, "#late_signal #in_run"),
  });
}

export function msgExpired(
  t: TrackedSignal,
  currentPrice: number,
  pnl: number,
  health?: SpotHealth | null,
): string {
  const dur = hoursAndDays(t.detectedAt);
  const peakPct = t.entryPrice
    ? ((Math.max(t.peakPrice ?? t.entryPrice, t.entryPrice) - t.entryPrice) /
        t.entryPrice) *
      100
    : null;
  return buildPositionClosed(t, {
    event: "⏳ EXPIRED",
    price: `${fmtP(t.entryPrice)} → ${fmtP(currentPrice)} (${fmtPct(pnl)}) | ${dur.str}`,
    context: [
      peakPct != null ? `📈 Максимальный пик позиции: ${fmtPct(peakPct)}` : "",
      `Срок действия позиции ${getMaxWatchDays(t.sentimentKey)} ${getMaxWatchDays(t.sentimentKey) === 1 ? "день" : "дня"} завершён.`,
      `Позиция закрыта по текущей цене с фактическим P&amp;L.`,
    ],
    health,
    tags: lifecycleTags(t, "#expired"),
  });
}

/** Timeout after profit is secured. The quote is observed, not a trailing-stop fill. */
export function msgTimeoutTakeProfit(
  t: TrackedSignal,
  currentPrice: number,
  pnl: number,
  health?: SpotHealth | null,
  trailingFloorUsed = false,
): string {
  const dur = hoursAndDays(t.detectedAt);
  return buildPositionClosed(t, {
    event: `🟢 TAKE PROFIT (срок ${getMaxWatchDays(t.sentimentKey)}д)`,
    price: `${fmtP(t.entryPrice)} → ${fmtP(currentPrice)} (${fmtPct(pnl)}) | ${dur.str}`,
    context: [
      trailingFloorUsed
        ? "Срок сопровождения истёк; закрыто по ранее заработанному трейлинг-уровню."
        : "Срок сопровождения истёк; закрыто по наблюдаемой цене с фактическим P&amp;L.",
    ],
    health,
    tags: lifecycleTags(t, "#profit"),
  });
}

/** Lifetime close below entry: stop-loss regardless of loss size. */
export function msgBreakevenAsStopLoss(
  t: TrackedSignal,
  currentPrice: number,
  pnl: number,
  health?: SpotHealth | null,
): string {
  const dur = hoursAndDays(t.detectedAt);
  return buildPositionClosed(t, {
    event: `🔴 STOP LOSS (EXPIRED — ${getMaxWatchDays(t.sentimentKey)}д)`,
    price: `${fmtP(t.entryPrice)} → ${fmtP(currentPrice)} (${fmtPct(pnl)}) | ${dur.str}`,
    context: [
      fmtPeakLine(t),
      "⚠️ Срок сопровождения истёк; цена ниже входа, поэтому исход засчитан как STOP LOSS.",
    ],
    health,
    tags: lifecycleTags(t, "#stop_loss"),
  });
}

export function msgInvalidated(
  t: TrackedSignal,
  currentPrice: number,
  pnl: number,
  reason: "oi_drop" | "vol_drop",
  oiDrop?: number,
  _volMult?: number,
  health?: SpotHealth | null,
): string {
  const dur = hoursAndDays(t.detectedAt);

  const reasonText =
    reason === "oi_drop"
      ? `📉 OI ${oiDrop?.toFixed(1)}% за 30м, крупный игрок закрыл позиции`
      : `📭 Спот-объём упал, катализатор не подтвердился`;

  const hint = `Импульс выдохся, закрываем`;

  return buildPositionClosed(t, {
    event: "🚫 SIGNAL CANCELLED",
    price: `${fmtP(t.entryPrice)} → ${fmtP(currentPrice)} (${fmtPct(pnl)}) | ${dur.str}`,
    context: [reasonText, hint, activeForLine(t.detectedAt) ?? ""],
    health,
    tags: lifecycleTags(t, "#cancelled"),
  });
}

export function msgHealthUpdate(
  t: TrackedSignal,
  currentPrice: number,
  pnl: number,
  event: string,
  context: readonly string[],
): string {
  return buildPositionUpdate(t, {
    event,
    price: `${fmtP(t.entryPrice)} → ${fmtP(currentPrice)} (${fmtPct(pnl)}) | ${hoursAndDays(t.detectedAt).str}`,
    context,
    tags: lifecycleTags(t, "#position_update"),
  });
}
