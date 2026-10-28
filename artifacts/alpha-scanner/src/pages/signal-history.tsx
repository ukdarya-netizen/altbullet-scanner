import { ScoreCell } from "@/components/score-cell";
import React, { useEffect, useState } from "react";
import { Link, useLocation, useSearch } from "wouter";
import { TokenChartLink } from "@/components/token-chart-link";
import { useQuery } from "@tanstack/react-query";
import {
  History,
  Search,
  ChevronDown,
  ChevronRight,
  Activity,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { ACTIVE_PATTERN_KEYS, getPatternTgLabel } from "@/lib/pattern-labels";
import { CoverageBadge } from "@/components/coverage-badge";
import { DrawdownRiskAnalysis } from "@/components/drawdown-risk-analysis";
import {
  TrailingAnalysisPanel,
  type TrailingAnalysisResponse,
} from "@/components/trailing-analysis-panel";
import {
  BeThresholdAnalysisPanel,
  type BeThresholdAnalysisResponse,
} from "@/components/be-threshold-analysis-panel";
import { StatusExplanation } from "@/components/status-explanation";
import {
  CLOSED_USER_STATUS_KEYS,
  getStatusLabel,
  STATUS_LABELS,
} from "@/lib/status-labels";

const API_BASE = import.meta.env.BASE_URL.replace(/\/$/, "");
const PAGE_SIZE = 100;
const BG_NEUTRAL_CLOSE_REASON = "balanced_grind_dashboard_neutral_close";
const STEALTH_NEUTRAL_CLOSE_REASON =
  "stealth_resistance_dashboard_neutral_close";

// ── Types ──────────────────────────────────────────────────────────────────────

interface SignalRow {
  id: number;
  alphaScore?: number | null;
  prescanCycles?: number | null;
  symbol: string;
  sentimentKey: string | null;
  stealthLevelSource:
    | "auto_range_4h"
    | "auto_range_1h"
    | "stealth_legacy"
    | "continuation_shelf"
    | "fresh_24h_high"
    | null;
  stealthRangeConfirmingVenues?: string[] | null;
  stealthEntryPath?: string | null;
  whaleObTimeframe?: "4h" | "1d" | null;
  status: string;
  entryPrice: number | null;
  exitPrice: number | null;
  pnlPercent: number | null;
  buStopTakePct: number | null;
  peakPct: number | null;
  detectedAt: string;
  closedAt: string | null;
  cancelReason: string | null;
  /** price24h в момент срабатывания сигнала — используем как «вход» для Price 24h */
  price24hAtFire: number | null;

  // ── Entry metrics ──
  entryOi15m: number | null;
  entryOi30m: number | null;
  entryOi1h: number | null;
  entryOi4h: number | null;
  entryOi24h: number | null;
  entryCvd15m: boolean | null;
  entryCvd30m: boolean | null;
  entryCvd1h: boolean | null;
  entryCvd4h: boolean | null;
  entrySpotVolMult: number | null;
  entryFutVolMult: number | null;
  entryFutTakerNetBuy: number | null;
  entrySpotTakerNetBuy: number | null;
  entrySpotNetBuy1h: number | null;
  entryPrice1h: number | null;
  /** уже в процентах (API умножает на 100) */
  entryFundingRate: number | null;
  entryBtc24h: number | null;
  entryBtcPrice?: number | null;
  closeBtc24h?: number | null;
  closeBtcPrice?: number | null;
  entryWhaleIndex: number | null;
  entryObRatio: number | null;
  marketCapUsd: number | null;

  // ── Exit metrics (новые — у старых закрытых сигналов null) ──
  exitOi30m: number | null;
  exitOi1h: number | null;
  exitOi4h: number | null;
  exitOi24h: number | null;
  exitCvd15m: boolean | null;
  exitCvd30m: boolean | null;
  exitCvd1h: boolean | null;
  exitCvd4h: boolean | null;
  exitWhaleIndex: number | null;
  exitSpotTakerNetBuy: number | null;
  exitFutTakerNetBuy: number | null;
  exitSpotNetBuy1h: number | null;
  exitSpotVol1h: number | null;
  exitSpotVolMult: number | null;
  exitFutVolMult: number | null;
  /** уже в процентах (API умножает на 100) */
  exitFundingRate: number | null;
  exitPrice1h: number | null;
  exitPrice24h: number | null;
  exitFutSpotRatio: number | null;

  // ── Intraday adverse excursion ──
  drawdownMinPct: number | null;
  drawdownMinPrice: number | null;
  drawdownMinObservedAt: string | null;
  drawdownMinElapsedMs: number | null;
  drawdownSource: string | null;
  drawdownStatusAtMin: string | null;

  // ── Custom AltBullet Neon 4H indicator (observation only) ──
  altBulletStatus: "ready" | "unavailable" | null;
  altBulletIndicatorVersion: string | null;
  altBulletCapturedAt: string | null;
  altBulletContext: Record<string, number | string | boolean | null> | null;
  altBulletAudit: {
    dataSource: string;
    lastClosed4hAt: string | null;
    lastClosed1hAt: string | null;
    isClosed: boolean;
    requestedAt?: string;
    freshness1hMs?: number | null;
    freshness4hMs?: number | null;
    checks: Record<
      string,
      {
        passed: boolean;
        state?: "pass" | "fail" | "unknown";
        reason?: string;
        actual: number | string | null;
        threshold: number | string | null;
        actualLabel: string;
        thresholdLabel: string;
      }
    >;
  } | null;
  altBulletError: string | null;

  // ── Coverage ──
  isBingxExclusive: boolean | null;
  isBinanceSpotListed: boolean | null;
  hasCgFutures: boolean | null;
}

interface SignalHistoryResponse {
  total: number;
  signals: SignalRow[];
}

function WhaleObTimeframeBadge({
  sentimentKey,
  timeframe,
}: {
  sentimentKey: string | null | undefined;
  timeframe: "4h" | "1d" | null | undefined;
}) {
  if (sentimentKey !== "whale_watch" || !timeframe) return null;
  return (
    <span
      className="inline-flex rounded border border-cyan-400/30 bg-cyan-400/10 px-1 py-0.5 text-[9px] font-medium leading-none text-cyan-300"
      title="Таймфрейм, на котором сработал отскок"
    >
      OB Bounce {timeframe === "1d" ? "1D" : "4H"}
    </span>
  );
}

function StealthLevelSourceBadge({
  sentimentKey,
  source,
  confirmingVenues,
  entryPath,
}: {
  sentimentKey: string | null;
  source: SignalRow["stealthLevelSource"];
  confirmingVenues?: SignalRow["stealthRangeConfirmingVenues"];
  entryPath?: string | null;
}) {
  if (sentimentKey !== "stealth_breakout") return null;
  if (source === "fresh_24h_high") {
    return (
      <span
        className="mt-1 inline-flex rounded border border-amber-400/40 bg-amber-400/10 px-1 py-0.5 text-[9px] font-medium leading-none text-amber-300"
        title="Экспериментальный паттерн: свежий пробой 24ч-хая на закрытой 1H свече; стоп под уровнем, Б/У на +1R, трейлинг 1R"
      >
        🧪 Эксперимент · пробой 24ч-хая 1H
      </span>
    );
  }
  const isRange = source === "auto_range_4h" || source === "auto_range_1h";
  if (
    !isRange &&
    source !== "stealth_legacy" &&
    source !== "continuation_shelf"
  )
    return null;
  const venueLabels: Record<string, string> = {
    bingx: "BingX",
    binance: "Binance",
    okx: "OKX",
    bybit: "Bybit",
    gate: "Gate.io",
    kucoin: "KuCoin",
    mexc: "MEXC",
    bitget: "Bitget",
    htx: "HTX",
    kraken: "Kraken",
  };
  const exchangeList =
    source === "auto_range_4h"
      ? [
          ...new Set(
            (confirmingVenues ?? [])
              .map((venue) => venueLabels[venue])
              .filter(Boolean),
          ),
        ]
      : [];
  const exchangeText = exchangeList.length
    ? ` · Биржи: ${exchangeList.join(", ")}`
    : "";
  return (
    <span
      className={`inline-flex rounded border px-1 py-0.5 text-[9px] font-medium leading-none ${
        isRange
          ? "border-blue-400/30 bg-blue-400/10 text-blue-300"
          : "border-zinc-400/25 bg-zinc-400/10 text-zinc-300"
      }`}
      title="Источник уровня пробоя Stealth Breakout и подтвердившие биржи"
    >
      {isRange
        ? `Range Breakout ${source === "auto_range_1h" ? "1H" : "4H"}${exchangeText}${
            entryPath === "fast_volume"
              ? " · ⚡ Быстрый путь: объём ≥10×"
              : entryPath === "hold_30m"
                ? " · Путь: удержание 30m"
                : ""
          }`
        : "Resistance Breakout"}
    </span>
  );
}

type RelationProvenanceCohort =
  | "fire_time"
  | "prescan_snapshot"
  | "reconstructed"
  | "unknown";

const RELATION_PROVENANCE_LABELS: Record<RelationProvenanceCohort, string> = {
  fire_time: "На момент сигнала",
  prescan_snapshot: "Предскан-снимок",
  reconstructed: "Реконструкция",
  unknown: "Источник неизвестен",
};

interface IndicatorRelationsResponse {
  observationOnly: boolean;
  decisionUse: boolean;
  rangeCohorts: Array<{
    pattern: string;
    version: string;
    oneHour: string;
    fourHour: string;
    open: number;
    closed: number;
    unknownOutcome: number;
    atLeast10Pct: number;
    averageRawPnlPercent: number | null;
    lowSample: boolean;
  }>;
  data: Array<{
    pattern: string;
    version: string;
    indicator: string;
    provenanceCohort: RelationProvenanceCohort;
    unit: string;
    bucket: string;
    supportProximityBand: string;
    resistanceProximityBand: string;
    eligibleCount: number;
    unknownCount: number;
    unknownEntryCount: number;
    unknownOutcomeCount: number;
    averageRawPnlPercent: number | null;
    outcomesAtLeast10Pct: number;
    lowSample: boolean;
  }>;
  targetAudit: Array<{
    version: string;
    pattern: string;
    variant: string;
    eligibleClosed: number;
    measuredClosed: number;
    unknownOutcome: number;
    confirmedHits: number;
    unknownTouch: number;
    actualStrong: number;
    confirmedStrongClipped: number;
    actualAverageRawPnl: number | null;
    confirmedHitDeltaPp: number | null;
    sufficient: boolean;
  }>;
  metadata: {
    cohort: {
      readySnapshotsReturned: number;
      measurableClosedOutcomes: number;
      unknownClosedOutcomes: number;
      lowSampleThreshold: number;
    };
    indicatorAvailability: Array<{
      pattern: string;
      version: string;
      indicator: string;
      provenanceCohort: RelationProvenanceCohort;
      unit: string;
      availableCount: number;
      missingCount: number;
    }>;
    indicatorKeys: string[];
    grouping: unknown;
    unavailable: string;
  };
}

interface ProfitLockAnalysisGroup {
  sentimentKey: string;
  activationPct: number;
  lockedProfitPct: number;
  virtualHits: number;
  followUps6h: number;
  followUps24h: number;
  followUps72h: number;
  actualCloses: number;
  averageVirtualExitPnl: number | null;
  averagePeakPnl: number | null;
  averagePnlAt6h: number | null;
  averagePnlAt24h: number | null;
  averagePnlAt72h: number | null;
  newPeakAfter24hRate: number | null;
  averageActualClosePnl: number | null;
  averageActualVsLockDelta: number | null;
  sufficient: boolean;
}

interface ProfitLockEvGroup {
  sentimentKey: string;
  activated: number;
  closed: number;
  open: number;
  virtualHits: number;
  completedVirtualHits: number;
  closedWithoutHit: number;
  followUps6h: number;
  followUps24h: number;
  followUps72h: number;
  trajectoryCoveragePct: number | null;
  averageActualPnl: number | null;
  averageCandidatePnl: number | null;
  totalActualPnl: number;
  totalCandidatePnl: number;
  totalDeltaPp: number;
  averageDeltaPp: number | null;
  helped: number;
  hurt: number;
  unchanged: number;
  lostUpsideCount: number;
  totalLostUpsidePp: number;
  averageLostUpsidePp: number | null;
  minimumCompletedHits: number;
  sufficient: boolean;
  recommendation:
    | "insufficient_sample"
    | "candidate_improves"
    | "candidate_hurts"
    | "neutral";
}

interface ProfitLockAnalysisResponse {
  observationOnly: boolean;
  sample: {
    activated: number;
    virtualHits: number;
    minimumHits: number;
    sufficient: boolean;
  };
  definition: string;
  groups: ProfitLockAnalysisGroup[];
  counterfactual: {
    minimumCompletedHits: number;
    summary: ProfitLockEvGroup;
    byPattern: ProfitLockEvGroup[];
    definition: string;
  };
}

interface PlmCalibrationResponse {
  observationOnly: boolean;
  livePolicy: {
    active: boolean;
    thresholds: {
      p24hMin: number;
      p24hMax: number;
      p3hMin: number;
      p3hMax: number;
      spotVolMin: number;
      missingSpotVol: "reject";
    };
  };
  liveEvaluation: {
    evaluatedTotal: number;
    evaluatedTerminal: number;
    retained: {
      total: number;
      terminal: number;
      outcomes: Record<string, number>;
      averagePnl: number | null;
    };
    excluded: {
      total: number;
      terminal: number;
      outcomes: Record<string, number>;
      averagePnl: number | null;
    };
    chronologicalHalves: Array<{
      retained: number;
      terminal: number;
      stops: number;
      averagePnl: number | null;
    }>;
    analysisCutoff: string | null;
    methodology: string;
    comparableBaseline: {
      measuredSignals: number;
      openAtCutoff: number;
      maxConcurrent: number;
      averageConcurrent: number;
    };
    retainedLoad: {
      measuredSignals: number;
      openAtCutoff: number;
      maxConcurrent: number;
      averageConcurrent: number;
    };
  };
  shadow: Omit<
    PlmCalibrationResponse,
    "shadow" | "livePolicy" | "liveEvaluation"
  >;
  threshold: {
    p24hCap: number;
    liveGateChanged: boolean;
    p3hMax: number;
    p3hLiveGateChanged: boolean;
  };
  sample: {
    totalSignals: number;
    allHistoryCompletedOutcomes: number;
    completedOutcomes: number;
    minimumCompletedOutcomes: number;
    sufficient: boolean;
    p3hCaptured: number;
    p3hCoverageRate: number | null;
    capEvaluated: number;
  };
  capCost: {
    excludedCompleted: number;
    stopsRemoved: number;
    profitsLost: number;
    protectedExitsLost: number;
  };
  candidateFilters: Array<{
    key:
      | "p24h_above_18"
      | "fut_taker_at_or_above_20"
      | "oi30m_below_0"
      | "oi1h_below_0"
      | "oi4h_below_0"
      | "price1h_below_0";
    label: string;
    evaluatedCompleted: number;
    unavailableCompleted: number;
    excludedCompleted: number;
    retainedCompleted: number;
    stopsRemoved: number;
    profitsLost: number;
    hit10Lost: number;
    hit20Lost: number;
    peakCoverage: { measured: number; excluded: number };
    rawPnl: {
      baseline: { count: number; net: number; average: number | null };
      excluded: { count: number; net: number; average: number | null };
      retained: { count: number; net: number; average: number | null };
    };
    criteria: {
      minimumCompletedOutcomes: number;
      sufficient: boolean;
      completeRawPnlCoverage: boolean;
      completePeakCoverage: boolean;
      removesStopLoss: boolean;
      noStrongDealsLost: boolean;
      improvesAverageRawPnl: boolean;
      qualifiesForLiveChange: boolean;
    };
    liveGateChanged: boolean;
  }>;
  decision: {
    action:
      | "observation_only"
      | "keep_current_live_thresholds"
      | "candidate_requires_separate_live_change";
    liveGateChanged: boolean;
    qualifyingCandidateKeys: string[];
    criteria: string;
    detail: string;
  };
  grades: {
    alpha: {
      completed: number;
      profits: number;
      stops: number;
      negativeOi30m: number;
    };
    superAlpha: {
      completed: number;
      profits: number;
      stops: number;
      negativeOi30m: number;
    };
    superAlphaReasons: Array<{ key: string; count: number }>;
    superAlphaScoreBreakdowns: Array<{ key: string; count: number }>;
  };
  negativeOi30mRisk: {
    observedCompleted: number;
    stops: number;
    profits: number;
    isGate: boolean;
  };
  futTakerShadow: {
    liveGateChanged: boolean;
    thresholdPct: number;
    captured: number;
    coverageRate: number | null;
    cohorts: Array<{
      key: "below_20" | "at_or_above_20" | "unavailable";
      total: number;
      open: number;
      completed: number;
      other: number;
      outcomes: {
        profit: number;
        stopLoss: number;
        buStop: number;
        breakeven: number;
        expired: number;
        cancelled: number;
      };
      rawPnlCount: number;
      netRawPnl: number;
      averageRawPnl: number | null;
      minimumCompletedOutcomes: number;
      sufficient: boolean;
    }>;
    ranges: {
      numericCaptured: number;
      minimumCompletedPerRange: number;
      sufficientForComparison: boolean;
      cohorts: Array<{
        key: "from_20_to_30" | "above_30";
        total: number;
        open: number;
        completed: number;
        other: number;
        outcomes: {
          profit: number;
          stopLoss: number;
          buStop: number;
          breakeven: number;
          expired: number;
          cancelled: number;
        };
        rawPnlCount: number;
        netRawPnl: number;
        averageRawPnl: number | null;
        minimumCompletedOutcomes: number;
        sufficient: boolean;
      }>;
      comparison: {
        action:
          | "insufficient_sample"
          | "above_30_worse"
          | "from_20_to_30_worse"
          | "no_clear_difference";
        sufficient: boolean;
        averageRawPnlDelta: number | null;
        stopRateDelta: number | null;
        detail: string;
        liveGateChanged: boolean;
      };
      note: string;
    };
    recommendation: {
      action: "observation_only" | "limited_experiment" | "live_veto";
      title: string;
      detail: string;
      measurableCompleted: number;
      minimumCompletedOutcomes: number;
      sufficient: boolean;
      liveGateChanged: boolean;
    };
  };
  definition: string;
}

// ── Fetch ──────────────────────────────────────────────────────────────────────

async function fetchSignalHistory(
  status: string,
  page: number,
  pattern: string,
  symbol: string,
  sort: string,
  from = "",
  to = "",
  dateBasis = "detected",
  pnlSign = "",
  metric = "",
): Promise<SignalHistoryResponse> {
  const offset = (page - 1) * PAGE_SIZE;
  const params = new URLSearchParams({
    status,
    limit: String(PAGE_SIZE),
    offset: String(offset),
  });
  if (pattern.trim()) params.set("pattern", pattern.trim());
  if (symbol.trim()) params.set("symbol", symbol.trim());
  if (sort.trim()) params.set("sort", sort.trim());
  if (from) params.set("from", from);
  if (to) params.set("to", to);
  if (dateBasis) params.set("dateBasis", dateBasis);
  if (pnlSign) params.set("pnlSign", pnlSign);
  if (metric) params.set("metric", metric);
  const res = await fetch(`${API_BASE}/api/tracker/signal-history?${params}`, {
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function fetchIndicatorRelations(
  pattern: string,
  version = "",
): Promise<IndicatorRelationsResponse> {
  const params = new URLSearchParams();
  if (pattern.trim()) params.set("pattern", pattern.trim());
  if (version) params.set("version", version);
  const suffix = params.size ? `?${params}` : "";
  const res = await fetch(
    `${API_BASE}/api/tracker/altbullet-indicator-relations${suffix}`,
    { cache: "no-store" },
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function fetchTrailingAnalysis(
  pattern: string,
): Promise<TrailingAnalysisResponse> {
  const params = new URLSearchParams();
  if (pattern.trim()) params.set("pattern", pattern.trim());
  const suffix = params.size ? `?${params}` : "";
  const res = await fetch(
    `${API_BASE}/api/tracker/trailing-analysis${suffix}`,
    {
      cache: "no-store",
    },
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function fetchBeThresholdAnalysis(): Promise<BeThresholdAnalysisResponse> {
  const res = await fetch(`${API_BASE}/api/tracker/be-threshold-analysis`, {
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function fetchProfitLockAnalysis(
  pattern: string,
): Promise<ProfitLockAnalysisResponse> {
  const params = new URLSearchParams();
  if (pattern.trim()) params.set("pattern", pattern.trim());
  const suffix = params.size ? `?${params}` : "";
  const res = await fetch(
    `${API_BASE}/api/tracker/profit-lock-analysis${suffix}`,
    { cache: "no-store" },
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function fetchPlmCalibration(): Promise<PlmCalibrationResponse> {
  const res = await fetch(`${API_BASE}/api/tracker/plm-calibration`, {
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// ── Formatters ─────────────────────────────────────────────────────────────────

const DASH = <span className="text-border/40">—</span>;

function apiNum(v: number | string | null | undefined): number | null {
  if (v == null) return null;
  const value = Number(v);
  return Number.isFinite(value) ? value : null;
}

function fmtPct(v: number | null | undefined, dec = 1) {
  if (v == null) return DASH;
  const c =
    v > 0 ? "text-green-400" : v < 0 ? "text-red-400" : "text-muted-foreground";
  return (
    <span className={c}>
      {v >= 0 ? "+" : ""}
      {v.toFixed(dec)}%
    </span>
  );
}

function fmtNum(v: number | null | undefined, dec = 2, suffix = "") {
  if (v == null) return DASH;
  return (
    <span className="text-foreground/80">
      {v.toFixed(dec)}
      {suffix}
    </span>
  );
}

function fmtMult(v: number | null | undefined) {
  if (v == null) return DASH;
  const c =
    v >= 3
      ? "text-orange-400"
      : v >= 1.5
        ? "text-yellow-400"
        : "text-muted-foreground";
  return <span className={c}>{v.toFixed(2)}x</span>;
}

function fmtBool(v: boolean | null | undefined) {
  if (v == null) return DASH;
  return v ? (
    <span className="text-green-400">✓</span>
  ) : (
    <span className="text-red-400">✗</span>
  );
}

function fmtPrice(v: number | null | undefined) {
  if (v == null) return "—";
  if (v < 0.0001) return v.toExponential(2);
  if (v < 0.01) return v.toFixed(6);
  if (v < 1) return v.toFixed(4);
  return v.toFixed(3);
}

function pnlForMonetaryDisplay(s: SignalRow): number | null {
  return s.status === "bu_stop" || s.status === "breakeven"
    ? null
    : s.pnlPercent;
}

function protectedExitPrice(s: SignalRow): number | null {
  return s.status === "bu_stop" ? s.entryPrice : s.exitPrice;
}

function BuStopOutcome({ takePct }: { takePct: number | null | undefined }) {
  return (
    <div
      className="mt-1 text-[9px] leading-snug text-emerald-300/80"
      title="BE STOP не входит в денежный PnL и средние; он учитывается только в счётчике и win rate."
    >
      {takePct != null
        ? `Тейк +${takePct}% · BE STOP исключён из PnL`
        : "BE STOP исключён из PnL"}
    </div>
  );
}

function fmtUsd(v: number | null | undefined) {
  if (v == null || v <= 0) return DASH;
  if (v >= 1_000_000_000)
    return (
      <span className="text-muted-foreground">
        ${(v / 1_000_000_000).toFixed(2)}B
      </span>
    );
  if (v >= 1_000_000)
    return (
      <span className="text-muted-foreground">
        ${(v / 1_000_000).toFixed(1)}M
      </span>
    );
  if (v >= 1_000)
    return (
      <span className="text-muted-foreground">${(v / 1_000).toFixed(0)}K</span>
    );
  return <span className="text-muted-foreground">${v.toFixed(0)}</span>;
}

function fmtDatetime(v: string | null | undefined): string {
  if (v == null) return "—";
  const d = new Date(v);
  const dd = String(d.getDate()).padStart(2, "0");
  const mo = String(d.getMonth() + 1).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${dd}.${mo} ${hh}:${mm}`;
}

function fmtElapsedMs(v: number | null | undefined): string {
  if (v == null || v < 0) return "—";
  const minutes = Math.round(v / 60_000);
  if (minutes < 60) return `${minutes}м`;
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  if (hours < 24)
    return restMinutes ? `${hours}ч ${restMinutes}м` : `${hours}ч`;
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours ? `${days}д ${restHours}ч` : `${days}д`;
}

function fmtAge(v: string | null | undefined): string {
  if (v == null) return "";
  const m = Math.round((Date.now() - new Date(v).getTime()) / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

// ── Status ─────────────────────────────────────────────────────────────────────

const STATUS_CFG: Record<string, { label: string; cls: string }> = {
  profit: {
    label: STATUS_LABELS.profit,
    cls: "bg-green-500/15 text-green-300 border-green-500/30",
  },
  stop_loss: {
    label: STATUS_LABELS.stop_loss,
    cls: "bg-red-500/15 text-red-300 border-red-500/30",
  },
  cancelled: {
    label: STATUS_LABELS.cancelled,
    cls: "bg-zinc-500/15 text-zinc-300 border-zinc-500/30",
  },
  bu_stop: {
    label: STATUS_LABELS.bu_stop,
    cls: "bg-yellow-500/15 text-yellow-300 border-yellow-500/30",
  },
  expired: {
    label: STATUS_LABELS.expired,
    cls: "bg-slate-500/15 text-slate-300 border-slate-500/30",
  },
};

function StatusBadge({
  status,
  sentimentKey,
  cancelReason,
}: {
  status: string;
  sentimentKey: string | null;
  cancelReason: string | null;
}) {
  const cfg =
    status === "reclassified" &&
    ((sentimentKey === "balanced_grind" &&
      cancelReason === BG_NEUTRAL_CLOSE_REASON) ||
      (sentimentKey === "stealth_breakout" &&
        cancelReason === STEALTH_NEUTRAL_CLOSE_REASON))
      ? {
          label: "Закрыто без PnL",
          cls: "bg-slate-500/15 text-slate-300 border-slate-500/30",
        }
      : (STATUS_CFG[status] ?? {
          label: getStatusLabel(status),
          cls: "bg-muted/30 text-muted-foreground border-border/40",
        });
  return (
    <span
      className={cn(
        "inline-block text-[9px] font-mono px-1.5 py-0.5 rounded border leading-none whitespace-nowrap",
        cfg.cls,
      )}
    >
      {cfg.label}
    </span>
  );
}

const STATUS_FILTERS: { id: string; label: string }[] = [
  { id: "closed", label: "все" },
  { id: "neutral_close", label: "без PnL" },
  ...CLOSED_USER_STATUS_KEYS.map((status) => ({
    id: status,
    label: getStatusLabel(status),
  })),
];

// ── Entry → Exit comparison ────────────────────────────────────────────────────

type MetricKind = "pct" | "bool" | "mult" | "num";

interface MetricDef {
  label: string;
  kind: MetricKind;
  entry: number | boolean | null;
  exit: number | boolean | null;
}

function renderMetric(kind: MetricKind, v: number | boolean | null) {
  if (v == null) return DASH;
  if (kind === "bool") return fmtBool(v as boolean);
  if (kind === "mult") return fmtMult(v as number);
  if (kind === "num") return fmtNum(v as number, 1);
  return fmtPct(v as number, 2);
}

function renderDelta(kind: MetricKind, m: MetricDef) {
  if (kind === "bool") return null;
  if (typeof m.entry !== "number" || typeof m.exit !== "number") return null;
  const d = m.exit - m.entry;
  const c =
    d > 0 ? "text-green-400/70" : d < 0 ? "text-red-400/70" : "text-border/40";
  return (
    <span className={cn("text-[9px] font-mono", c)}>
      Δ{d >= 0 ? "+" : ""}
      {d.toFixed(2)}
      {kind === "mult" ? "x" : kind === "num" ? "" : "%"}
    </span>
  );
}

function MetricCompare({ m }: { m: MetricDef }) {
  return (
    <div className="flex flex-col gap-0.5 border border-border/30 rounded-sm px-2 py-1.5 bg-muted/10">
      <span className="text-[9px] text-muted-foreground/50 uppercase tracking-wide">
        {m.label}
      </span>
      <div className="flex items-center gap-1.5 font-mono text-[11px]">
        <span className="min-w-[42px] text-right">
          {renderMetric(m.kind, m.entry)}
        </span>
        <span className="text-border/50 text-[10px]">→</span>
        <span className="min-w-[42px] text-right">
          {renderMetric(m.kind, m.exit)}
        </span>
      </div>
      {renderDelta(m.kind, m)}
    </div>
  );
}

function buildMetrics(s: SignalRow): MetricDef[] {
  return [
    { label: "OI 15m", kind: "pct", entry: s.entryOi15m, exit: null },
    { label: "OI 30m", kind: "pct", entry: s.entryOi30m, exit: s.exitOi30m },
    { label: "OI 1h", kind: "pct", entry: s.entryOi1h, exit: s.exitOi1h },
    { label: "OI 4h", kind: "pct", entry: s.entryOi4h, exit: s.exitOi4h },
    { label: "OI 24h", kind: "pct", entry: s.entryOi24h, exit: s.exitOi24h },
    {
      label: "CVD 15m",
      kind: "bool",
      entry: s.entryCvd15m,
      exit: s.exitCvd15m,
    },
    {
      label: "CVD 30m",
      kind: "bool",
      entry: s.entryCvd30m,
      exit: s.exitCvd30m,
    },
    { label: "CVD 1h", kind: "bool", entry: s.entryCvd1h, exit: s.exitCvd1h },
    { label: "CVD 4h", kind: "bool", entry: s.entryCvd4h, exit: s.exitCvd4h },
    {
      label: "Whale Index",
      kind: "num",
      entry: s.entryWhaleIndex,
      exit: s.exitWhaleIndex,
    },
    {
      label: "Spot Taker",
      kind: "pct",
      entry: s.entrySpotTakerNetBuy,
      exit: s.exitSpotTakerNetBuy,
    },
    {
      label: "Fut Taker",
      kind: "pct",
      entry: s.entryFutTakerNetBuy,
      exit: s.exitFutTakerNetBuy,
    },
    {
      label: "Spot NetBuy 1h",
      kind: "pct",
      entry: s.entrySpotNetBuy1h,
      exit: s.exitSpotNetBuy1h,
    },
    {
      label: "SpotVol Mult",
      kind: "mult",
      entry: s.entrySpotVolMult,
      exit: s.exitSpotVolMult,
    },
    {
      label: "FutVol Mult",
      kind: "mult",
      entry: s.entryFutVolMult,
      exit: s.exitFutVolMult,
    },
    {
      label: "Funding %",
      kind: "pct",
      entry: s.entryFundingRate,
      exit: s.exitFundingRate,
    },
    {
      label: "Price 1h",
      kind: "pct",
      entry: s.entryPrice1h,
      exit: s.exitPrice1h,
    },
    {
      label: "Price 24h",
      kind: "pct",
      entry: s.price24hAtFire ?? null,
      exit: s.exitPrice24h,
    },
  ];
}

function AltBulletReading({ s }: { s: SignalRow }) {
  const context = s.altBulletStatus === "ready" ? s.altBulletContext : null;
  const rangeRecorded = typeof context?.rangeObservationVersion === "string";
  const entry = apiNum(s.entryPrice);
  const entryPrice = entry != null && entry > 0 ? entry : null;
  const formatLevelPrice = (value: number) =>
    value.toLocaleString("en-US", {
      useGrouping: false,
      maximumFractionDigits: value >= 1 ? 6 : 10,
    });
  const levels = [
    {
      key: "nearestSupport",
      label: "Ближайшая поддержка",
      accent: "text-cyan-100",
    },
    {
      key: "nearestResistance",
      label: "Ближайшее сопротивление",
      accent: "text-cyan-100",
    },
  ] as const;
  const telemetry: {
    label: string;
    value: number | boolean | null;
    kind: MetricKind;
  }[] = [
    { label: "OI 15m", value: s.entryOi15m, kind: "pct" },
    { label: "OI 30m", value: s.entryOi30m, kind: "pct" },
    { label: "OI 1h", value: s.entryOi1h, kind: "pct" },
    { label: "OI 4h", value: s.entryOi4h, kind: "pct" },
    { label: "OI 24h", value: s.entryOi24h, kind: "pct" },
    { label: "Spot Vol", value: s.entrySpotVolMult, kind: "mult" },
    { label: "Fut Vol", value: s.entryFutVolMult, kind: "mult" },
    { label: "Spot Taker", value: s.entrySpotTakerNetBuy, kind: "pct" },
    { label: "Fut Taker", value: s.entryFutTakerNetBuy, kind: "pct" },
    { label: "Spot NetBuy 1h", value: s.entrySpotNetBuy1h, kind: "pct" },
    { label: "CVD 15m", value: s.entryCvd15m, kind: "bool" },
    { label: "CVD 30m", value: s.entryCvd30m, kind: "bool" },
    { label: "CVD 1h", value: s.entryCvd1h, kind: "bool" },
    { label: "CVD 4h", value: s.entryCvd4h, kind: "bool" },
  ];
  // The snapshot can carry oscillator readings under timeframe-specific keys.
  // Show only numeric readings actually present; do not infer values from checks.
  const oscillators = Object.entries(context ?? {}).filter(
    ([key, value]) =>
      /^(?:rsi|williams)/i.test(key) &&
      typeof value === "number" &&
      Number.isFinite(value),
  );

  return (
    <div
      className="mt-3 rounded-sm border border-cyan-400/20 bg-cyan-400/[0.03] px-2.5 py-2.5"
      data-testid={`panel-altbullet-observation-${s.id}`}
    >
      <div className="flex items-baseline justify-between gap-x-3 gap-y-1 flex-wrap">
        <span className="text-[10px] text-cyan-200/85 font-medium tracking-wide">
          ABNeon · уровни 4H
        </span>
        <span className="text-[9px] text-muted-foreground/60">
          Снимок при сигнале
          {s.altBulletCapturedAt
            ? ` · ${fmtDatetime(s.altBulletCapturedAt)}`
            : ""}{" "}
          · не live · не торговая рекомендация
        </span>
      </div>
      {s.altBulletStatus !== "ready" && (
        <div
          className="mt-2 text-[10px] text-amber-300/75"
          data-testid={`status-altbullet-snapshot-${s.id}`}
        >
          {s.altBulletStatus === "unavailable"
            ? `Снимок ABNeon недоступен${s.altBulletError ? `: ${s.altBulletError}` : ""}`
            : "Снимок ABNeon не сохранён для этого сигнала"}
        </div>
      )}
      <div className="mt-2 grid grid-cols-1 gap-1.5 sm:grid-cols-2">
        {levels.map(({ key, label, accent }) => {
          const raw = context?.[key];
          const level =
            typeof raw === "number" && Number.isFinite(raw) && raw > 0
              ? raw
              : null;
          const distance =
            level != null && entryPrice != null
              ? ((level - entryPrice) / entryPrice) * 100
              : null;
          return (
            <div
              key={key}
              className="rounded-sm border border-cyan-400/15 bg-cyan-400/[0.035] px-2.5 py-2"
              data-testid={`reading-altbullet-${key}-${s.id}`}
            >
              <div className="text-[9px] text-muted-foreground/70">{label}</div>
              <div
                className={cn(
                  "mt-0.5 font-mono text-[12px]",
                  level == null ? "text-muted-foreground/60" : accent,
                )}
              >
                {level == null ? "Не зафиксировано" : formatLevelPrice(level)}
              </div>
              <div className="mt-0.5 text-[9px] font-mono text-muted-foreground/65">
                {distance != null
                  ? `${distance >= 0 ? "+" : ""}${distance.toFixed(2)}% от цены входа`
                  : level != null
                    ? "Цена входа недоступна · расстояние не рассчитано"
                    : "Расстояние не определено"}
              </div>
            </div>
          );
        })}
      </div>
      {rangeRecorded && (
        <div
          className="mt-2 border-t border-cyan-400/10 pt-2"
          data-testid={`abneon-ranges-${s.id}`}
        >
          <div className="text-[9px] text-muted-foreground/70">
            Диапазоны 1H / 4H · отдельная оценка по закрытым свечам, не
            оригинальный TradingView · только наблюдение
          </div>
          <div className="mt-1.5 grid grid-cols-1 gap-1.5 sm:grid-cols-2">
            {(["1h", "4h"] as const).map((tf) => {
              const state = context?.[`range${tf}State`];
              const upper = context?.[`range${tf}Upper`];
              const lower = context?.[`range${tf}Lower`];
              const at = context?.[`range${tf}EventAt`];
              const reason = context?.[`range${tf}Reason`];
              const labels: Record<string, string> = {
                active: "Диапазон активен",
                break_up: "Пробой вверх",
                break_down: "Пробой вниз",
                reentered: "Возврат после пробоя",
                none: "Диапазона нет",
                unknown: "Нет данных",
              };
              return (
                <div
                  key={tf}
                  className="rounded-sm border border-cyan-400/15 bg-cyan-400/[0.035] px-2.5 py-2"
                  data-testid={`abneon-range-${tf}-${s.id}`}
                >
                  <div className="text-[10px] text-cyan-100">
                    {tf.toUpperCase()} ·{" "}
                    {typeof state === "string"
                      ? (labels[state] ?? "Нет данных")
                      : "Нет данных"}
                  </div>
                  <div className="mt-0.5 font-mono text-[11px] text-muted-foreground">
                    {typeof lower === "number" && typeof upper === "number"
                      ? `${formatLevelPrice(lower)} – ${formatLevelPrice(upper)}`
                      : "Границы не зафиксированы"}
                  </div>
                  <div className="mt-0.5 text-[9px] text-muted-foreground/65">
                    {typeof at === "string" ? `${fmtDatetime(at)} · ` : ""}
                    {typeof reason === "string" ? reason : ""}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
      <div className="mt-3 border-t border-cyan-400/10 pt-2">
        <div className="text-[9px] uppercase tracking-wider text-muted-foreground/60">
          Телеметрия при входе · сохранённые значения, не текущие
        </div>
        <div className="mt-1.5 flex flex-wrap gap-1">
          {telemetry
            .filter(
              ({ value }) =>
                value != null &&
                (typeof value !== "number" || Number.isFinite(value)),
            )
            .map(({ label, value, kind }) => (
              <span
                key={label}
                className="rounded-sm border border-border/30 bg-muted/10 px-2 py-1 text-[10px]"
                data-testid={`reading-entry-${label.replace(/\W+/g, "-").toLowerCase()}-${s.id}`}
              >
                <span className="text-muted-foreground/70">{label} </span>
                <span className="font-mono">
                  {kind === "bool"
                    ? value
                      ? "да"
                      : "нет"
                    : renderMetric(kind, value)}
                </span>
              </span>
            ))}
          {oscillators.map(([key, value]) => (
            <span
              key={key}
              className="rounded-sm border border-border/30 bg-muted/10 px-2 py-1 text-[10px]"
              data-testid={`reading-snapshot-${key}-${s.id}`}
            >
              <span className="text-muted-foreground/70">{key} </span>
              <span className="font-mono text-foreground/80">
                {(value as number).toFixed(1)}
              </span>
            </span>
          ))}
          {telemetry.every(
            ({ value }) =>
              value == null ||
              (typeof value === "number" && !Number.isFinite(value)),
          ) &&
            oscillators.length === 0 && (
              <span className="text-[10px] text-muted-foreground/60">
                Телеметрия не сохранена
              </span>
            )}
        </div>
      </div>
      {context?.btcRegime != null && (
        <div className="mt-2 text-[9px] text-muted-foreground/65">
          BTC при снимке: {String(context.btcRegime)}
          {typeof context.btcReason === "string"
            ? ` · ${context.btcReason}`
            : ""}
        </div>
      )}
      {s.altBulletStatus === "ready" && s.altBulletAudit && (
        <details className="mt-2 text-[10px]">
          <summary className="cursor-pointer text-cyan-200/75 hover:text-cyan-100">
            Источник снимка · {s.altBulletAudit.dataSource} · 4H{" "}
            {s.altBulletAudit.lastClosed4hAt
              ? new Date(s.altBulletAudit.lastClosed4hAt).toLocaleString(
                  "ru-RU",
                )
              : "—"}
            {s.altBulletAudit.freshness4hMs != null &&
              ` · 4H ${Math.round(s.altBulletAudit.freshness4hMs / 60000)}м ${s.altBulletAudit.freshness4hMs <= 245 * 60_000 ? "fresh" : "stale"}`}
            {s.altBulletAudit.freshness1hMs != null &&
              ` · 1H ${Math.round(s.altBulletAudit.freshness1hMs / 60000)}м ${s.altBulletAudit.freshness1hMs <= 65 * 60_000 ? "fresh" : "stale"}`}
            {s.altBulletAudit.requestedAt &&
              ` · as-of ${new Date(s.altBulletAudit.requestedAt).toLocaleString("ru-RU")}`}
            {s.altBulletCapturedAt &&
              ` · captured ${new Date(s.altBulletCapturedAt).toLocaleString("ru-RU")}`}
          </summary>
          <div className="mt-1 text-muted-foreground/65">
            Версия: {s.altBulletIndicatorVersion ?? "не указана"} · закрытые
            свечи: {s.altBulletAudit.isClosed ? "да" : "нет"}
          </div>
        </details>
      )}
    </div>
  );
}

function ExpandedRow({ s }: { s: SignalRow }) {
  const metrics = buildMetrics(s);
  const hasExit = metrics.some((m) => m.exit != null);

  return (
    <tr className="bg-muted/5 border-b border-border/30">
      <td colSpan={12} className="px-4 py-3">
        <div className="flex items-center gap-3 mb-2 flex-wrap text-[10px] text-muted-foreground/70 font-mono">
          <span className="text-muted-foreground/50">Вход → Выход</span>
          <StealthLevelSourceBadge
            sentimentKey={s.sentimentKey}
            source={s.stealthLevelSource}
            entryPath={s.stealthEntryPath}
            confirmingVenues={s.stealthRangeConfirmingVenues}
          />
          <WhaleObTimeframeBadge
            sentimentKey={s.sentimentKey}
            timeframe={s.whaleObTimeframe}
          />
          <span>
            Цена: ${fmtPrice(s.entryPrice)} → ${fmtPrice(protectedExitPrice(s))}
          </span>
          {s.status === "bu_stop" && (
            <span className="text-emerald-300/90">
              {s.buStopTakePct != null
                ? `Тейк +${s.buStopTakePct}%: частичная фиксация · остаток по BE`
                : "Тейк достигнут: уровень не зафиксирован · остаток по BE"}
            </span>
          )}
          {s.entryBtc24h != null && (
            <span>BTC 24h: {s.entryBtc24h.toFixed(1)}%</span>
          )}
          {s.entryObRatio != null && (
            <span>OB ratio: {s.entryObRatio.toFixed(2)}</span>
          )}
          {s.exitFutSpotRatio != null && (
            <span>F/S ratio (выход): {s.exitFutSpotRatio.toFixed(2)}x</span>
          )}
          {s.exitSpotVol1h != null && (
            <span>Спот объём 1h (выход): {fmtUsd(s.exitSpotVol1h)}</span>
          )}
          <span>MCap: {fmtUsd(s.marketCapUsd)}</span>
        </div>

        <div className="mb-2 rounded-sm border border-red-400/15 bg-red-400/[0.03] px-2.5 py-2 text-[10px]">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-red-200/80">Фактическая просадка</span>
            {s.drawdownMinPct != null ? (
              <>
                <span className="font-mono font-semibold">
                  {fmtPct(s.drawdownMinPct, 2)}
                </span>
                <span className="text-muted-foreground/60">
                  минимум FastCycle
                  {s.drawdownMinObservedAt
                    ? ` · ${fmtDatetime(s.drawdownMinObservedAt)}`
                    : ""}
                </span>
                <span className="text-muted-foreground/50">
                  · цена: ${fmtPrice(s.drawdownMinPrice)}
                  {s.drawdownMinElapsedMs != null
                    ? ` · через ${fmtElapsedMs(s.drawdownMinElapsedMs)}`
                    : ""}
                </span>
                {s.drawdownStatusAtMin && (
                  <span className="text-muted-foreground/50">
                    · статус: {s.drawdownStatusAtMin}
                  </span>
                )}
                {s.drawdownSource && (
                  <span className="text-muted-foreground/50">
                    · {s.drawdownSource}
                  </span>
                )}
              </>
            ) : (
              <span className="text-muted-foreground/50">
                ещё не накоплена для этого сигнала
              </span>
            )}
          </div>
          <div className="mt-1 text-[9px] text-muted-foreground/50">
            Наблюдаемый минимум цены во время жизни позиции; не реконструирует
            пропущенные тики и не изменяет стоп.
          </div>
        </div>

        {!hasExit && (
          <div className="mb-2 text-[10px] text-amber-400/70">
            {s.status === "reclassified" &&
            ((s.sentimentKey === "balanced_grind" &&
              s.cancelReason === BG_NEUTRAL_CLOSE_REASON) ||
              (s.sentimentKey === "stealth_breakout" &&
                s.cancelReason === STEALTH_NEUTRAL_CLOSE_REASON))
              ? "Перенесено в архив по дате обнаружения: без исполнения выхода, цены закрытия и PnL. Биржевая позиция здесь не закрывается."
              : "Метрики выхода не записаны — сигнал закрыт до внедрения exit-снапшота"}
          </div>
        )}

        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-1.5">
          {metrics.map((m) => (
            <MetricCompare key={m.label} m={m} />
          ))}
        </div>
        <AltBulletReading s={s} />
      </td>
    </tr>
  );
}

// ── Row ────────────────────────────────────────────────────────────────────────

function SignalHistoryRow({
  s,
  expanded,
  onToggle,
}: {
  s: SignalRow;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <>
      <tr
        onClick={onToggle}
        className={cn(
          "border-b border-border/25 text-xs cursor-pointer transition-colors hover:bg-muted/20",
          expanded && "bg-muted/15",
        )}
      >
        <td className="px-2 py-2 align-top w-8 text-muted-foreground/40">
          {expanded ? (
            <ChevronDown className="w-3.5 h-3.5" />
          ) : (
            <ChevronRight className="w-3.5 h-3.5" />
          )}
        </td>
        <td className="px-3 py-2 align-top font-mono font-semibold text-primary whitespace-nowrap">
          <TokenChartLink symbol={s.symbol} />
        </td>
        <td className="px-3 py-2 align-top text-[10px] text-muted-foreground max-w-[220px] truncate">
          <div className="flex flex-col items-start gap-1">
            <span>{getPatternTgLabel(s.sentimentKey)}</span>
            <StealthLevelSourceBadge
              sentimentKey={s.sentimentKey}
              source={s.stealthLevelSource}
              entryPath={s.stealthEntryPath}
              confirmingVenues={s.stealthRangeConfirmingVenues}
            />
            <WhaleObTimeframeBadge
              sentimentKey={s.sentimentKey}
              timeframe={s.whaleObTimeframe}
            />
          </div>
        </td>
        <td className="px-3 py-2 align-top">
          <StatusBadge
            status={s.status}
            sentimentKey={s.sentimentKey}
            cancelReason={s.cancelReason}
          />
        </td>
        <td className="px-3 py-2 align-top text-right font-mono text-[11px] text-muted-foreground">
          {s.prescanCycles ?? "—"}
        </td>
        <td className="px-3 py-2 align-top text-right font-mono text-[10px]">
          <ScoreCell s={s} />
        </td>
        <td className="px-3 py-2 align-top text-right font-mono">
          <span
            title={
              s.status === "bu_stop" || s.status === "breakeven"
                ? "BE STOP и BREAKEVEN не входят в денежный PnL и средние."
                : undefined
            }
          >
            {fmtPct(pnlForMonetaryDisplay(s), 2)}
          </span>
          {s.status === "bu_stop" && (
            <BuStopOutcome takePct={s.buStopTakePct} />
          )}
        </td>
        <td className="px-3 py-2 align-top text-right font-mono">
          {fmtPct(s.peakPct, 2)}
        </td>
        <td className="px-3 py-2 align-top whitespace-nowrap">
          <div className="flex flex-col gap-0.5">
            <span className="font-mono text-foreground/70">
              {fmtDatetime(s.detectedAt)}
            </span>
            <span className="text-[9px] text-muted-foreground/40">
              {fmtAge(s.detectedAt)} назад
            </span>
          </div>
        </td>
        <td className="px-3 py-2 align-top whitespace-nowrap font-mono text-foreground/70">
          {fmtDatetime(s.closedAt)}
        </td>
        <td className="px-3 py-2 align-top text-[10px] text-muted-foreground/70 max-w-[180px] truncate">
          {s.cancelReason ?? "—"}
        </td>
        <td className="px-3 py-2 align-top">
          <CoverageBadge
            isBingxExclusive={s.isBingxExclusive}
            isBinanceSpotListed={s.isBinanceSpotListed}
          />
        </td>
      </tr>
      {expanded && <ExpandedRow s={s} />}
    </>
  );
}

// ── Main ───────────────────────────────────────────────────────────────────────

export default function SignalHistory({
  initialSymbol,
}: {
  initialSymbol?: string;
} = {}) {
  const search = useSearch();
  const [, setLocation] = useLocation();
  const urlParams = new URLSearchParams(search);
  const [status, setStatus] = useState(urlParams.get("status") ?? "closed");
  const [patternInput, setPatternInput] = useState(
    urlParams.get("pattern") ?? "",
  );
  const [pattern, setPattern] = useState(urlParams.get("pattern") ?? "");
  const [symbolInput, setSymbolInput] = useState(
    urlParams.get("symbol") ?? initialSymbol ?? "",
  );
  const [symbol, setSymbol] = useState(
    urlParams.get("symbol") ?? initialSymbol ?? "",
  );
  const [sort, setSort] = useState(urlParams.get("sort") ?? "");
  const from = urlParams.get("from") ?? "";
  const to = urlParams.get("to") ?? "";
  const dateBasis = urlParams.get("dateBasis") ?? "detected";
  const pnlSign = urlParams.get("pnlSign") ?? "";
  const metric = urlParams.get("metric") ?? "";
  const title = urlParams.get("title") ?? "История сигналов";
  const description =
    urlParams.get("description") ?? "Фильтрованные tracked-сигналы";
  const backTab = urlParams.get("tab");
  const updateUrlFilters = (
    patch: Record<string, string>,
    deleteKeys: string[] = [],
  ) => {
    const params = new URLSearchParams(search);
    for (const [key, value] of Object.entries(patch)) {
      if (value) params.set(key, value);
      else params.delete(key);
    }
    for (const key of deleteKeys) params.delete(key);
    setLocation(`/analytics?${params.toString()}`, { replace: true });
  };

  useEffect(() => {
    const params = new URLSearchParams(search);
    setStatus(params.get("status") ?? "closed");
    setPatternInput(params.get("pattern") ?? "");
    setPattern(params.get("pattern") ?? "");
    setSymbolInput(params.get("symbol") ?? initialSymbol ?? "");
    setSymbol(params.get("symbol") ?? initialSymbol ?? "");
    setSort(params.get("sort") ?? "");
    setPage(1);
  }, [search, initialSymbol]);
  const [page, setPage] = useState(1);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [relationVersion, setRelationVersion] = useState("");
  const [relationIndicator, setRelationIndicator] = useState("");
  const [relationProvenance, setRelationProvenance] =
    useState<RelationProvenanceCohort>("fire_time");

  useEffect(() => {
    setRelationVersion("");
    setRelationIndicator("");
    setRelationProvenance("fire_time");
  }, [pattern]);

  // When initialSymbol changes (e.g. navigating from Missed Movers), sync filter
  useEffect(() => {
    if (initialSymbol) {
      setSymbolInput(initialSymbol);
      setSymbol(initialSymbol);
      setPage(1);
    }
  }, [initialSymbol]);

  // Дебаунс 350ms — не спамим запросами при быстрой печати
  useEffect(() => {
    const t = setTimeout(() => {
      setPattern(patternInput.trim());
      setSymbol(symbolInput.trim().toUpperCase());
      updateUrlFilters({
        pattern: patternInput.trim(),
        symbol: symbolInput.trim().toUpperCase(),
      });
      setPage(1);
    }, 350);
    return () => clearTimeout(t);
  }, [patternInput, symbolInput]);

  const { data, isLoading, isError } = useQuery({
    queryKey: [
      "signal-history",
      status,
      page,
      pattern,
      symbol,
      sort,
      from,
      to,
      dateBasis,
      pnlSign,
      metric,
    ],
    queryFn: () =>
      fetchSignalHistory(
        status,
        page,
        pattern,
        symbol,
        sort,
        from,
        to,
        dateBasis,
        pnlSign,
        metric,
      ),
    refetchInterval: 60_000,
  });

  const signals = data?.signals ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const {
    data: relationCatalog,
    isLoading: isRelationCatalogLoading,
    isError: isRelationCatalogError,
    refetch: refetchRelationCatalog,
  } = useQuery({
    queryKey: ["altbullet-indicator-relations-catalog", pattern],
    queryFn: () => fetchIndicatorRelations(pattern),
    refetchInterval: 60_000,
  });
  const versions = Array.from(
    new Set(
      relationCatalog?.metadata.indicatorAvailability.map(
        ({ version }) => version,
      ) ??
        relationCatalog?.data.map(({ version }) => version) ??
        [],
    ),
  ).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  const selectedVersion = versions.includes(relationVersion)
    ? relationVersion
    : (versions[0] ?? "");
  const availableIndicators = Array.from(
    new Set(
      relationCatalog?.metadata.indicatorAvailability
        .filter(
          ({ version, provenanceCohort }) =>
            version === selectedVersion &&
            provenanceCohort === relationProvenance,
        )
        .map(({ indicator }) => indicator) ?? [],
    ),
  );
  const indicatorOptions = Array.from(
    new Set([
      ...availableIndicators,
      ...(relationCatalog?.metadata.indicatorKeys ?? []),
    ]),
  );
  const selectedIndicator = indicatorOptions.includes(relationIndicator)
    ? relationIndicator
    : (availableIndicators[0] ?? indicatorOptions[0] ?? "");
  const {
    data: versionRelations,
    isLoading: isVersionRelationsLoading,
    isError: isVersionRelationsError,
    refetch: refetchVersionRelations,
  } = useQuery({
    queryKey: ["altbullet-indicator-relations", pattern, selectedVersion],
    queryFn: () => fetchIndicatorRelations(pattern, selectedVersion),
    enabled: !!selectedVersion,
    refetchInterval: 60_000,
  });
  const relationRows = (versionRelations?.data ?? [])
    .filter(
      ({ version, indicator, provenanceCohort }) =>
        version === selectedVersion &&
        indicator === selectedIndicator &&
        provenanceCohort === relationProvenance,
    )
    .sort(
      (a, b) =>
        a.pattern.localeCompare(b.pattern) ||
        a.bucket.localeCompare(b.bucket, undefined, { numeric: true }) ||
        a.supportProximityBand.localeCompare(b.supportProximityBand) ||
        a.resistanceProximityBand.localeCompare(b.resistanceProximityBand),
    );
  const relationAvailability =
    relationCatalog?.metadata.indicatorAvailability.filter(
      ({ version, indicator, provenanceCohort }) =>
        version === selectedVersion &&
        indicator === selectedIndicator &&
        provenanceCohort === relationProvenance,
    ) ?? [];
  const {
    data: trailingAnalysis,
    isLoading: isTrailingAnalysisLoading,
    isError: isTrailingAnalysisError,
  } = useQuery({
    queryKey: ["trailing-analysis", pattern],
    queryFn: () => fetchTrailingAnalysis(pattern),
    refetchInterval: 60_000,
  });
  const {
    data: beThresholdAnalysis,
    isLoading: isBeThresholdAnalysisLoading,
    isError: isBeThresholdAnalysisError,
  } = useQuery({
    queryKey: ["be-threshold-analysis"],
    queryFn: fetchBeThresholdAnalysis,
    refetchInterval: 60_000,
  });
  const {
    data: profitLockAnalysis,
    isLoading: isProfitLockAnalysisLoading,
    isError: isProfitLockAnalysisError,
  } = useQuery({
    queryKey: ["profit-lock-analysis", pattern],
    queryFn: () => fetchProfitLockAnalysis(pattern),
    refetchInterval: 60_000,
  });
  const {
    data: plmCalibration,
    isLoading: isPlmCalibrationLoading,
    isError: isPlmCalibrationError,
  } = useQuery({
    queryKey: ["plm-calibration"],
    queryFn: fetchPlmCalibration,
    refetchInterval: 60_000,
  });

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <History className="w-5 h-5 text-cyan-400" />
            {title}
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">{description}</p>
          <p className="mt-1 text-[10px] text-muted-foreground/70">
            Период: {from || "начало"} — {to || "сейчас"} · basis: {dateBasis}
          </p>
          <p
            data-testid="text-signal-history-metrics-note"
            className="mt-1.5 max-w-3xl border-l-2 border-cyan-400/50 bg-cyan-400/[0.04] px-2.5 py-1.5 text-xs leading-relaxed text-muted-foreground"
          >
            <span className="font-medium text-cyan-200">
              Что сохранено в метриках:
            </span>{" "}
            «Вход» — значения на момент открытия сигнала; «Выход» — снапшот на
            момент закрытия позиции. PnL%, Peak%, цена и причина — итоговые
            значения сделки. У старых закрытых сигналов метрики выхода могут
            отсутствовать.
          </p>
          <StatusExplanation
            title="Что означает статус сигнала"
            scope="closed"
            className="mt-3 max-w-5xl"
          />
        </div>
        <Link
          href={`/overview${backTab ? `?tab=${encodeURIComponent(backTab)}` : ""}`}
          className="rounded border border-border px-2.5 py-1.5 text-xs text-muted-foreground transition-colors hover:border-primary hover:text-primary"
          data-testid="link-history-back"
        >
          ← Назад
        </Link>
        <div className="text-xs text-muted-foreground">
          Всего: <span className="text-foreground font-mono">{total}</span>
        </div>
      </div>

      <DrawdownRiskAnalysis pattern={pattern} />

      <div className="rounded-sm border border-fuchsia-400/20 bg-fuchsia-400/[0.03] p-3">
        <div className="flex items-start gap-2">
          <Activity className="mt-0.5 h-4 w-4 shrink-0 text-fuchsia-300" />
          <div>
            <div className="text-xs font-medium text-fuchsia-100">
              Price Led Momentum Lab · live p24h 5–15% · p3h 1.5–4% · Spot
              Volume ≥1.1x
            </div>
            <p className="mt-0.5 text-[10px] text-muted-foreground/75">
              Live-политика требует immutable decision-time Spot Volume; missing
              или non-finite значение отклоняется. Futures Taker, OI и старый
              p24h cap остаются observation-only и не меняют scanner.
            </p>
          </div>
        </div>
        {isPlmCalibrationLoading ? (
          <div className="mt-3 text-[10px] text-muted-foreground">
            Расчёт PLM-выборки…
          </div>
        ) : isPlmCalibrationError ? (
          <div className="mt-3 text-[10px] text-amber-300">
            Не удалось загрузить PLM-анализ. История сигналов продолжает
            работать.
          </div>
        ) : plmCalibration ? (
          <>
            <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
              <div className="rounded border border-emerald-400/30 bg-emerald-400/[0.05] p-2 text-[10px]">
                <div className="text-muted-foreground">Live retained</div>
                <div className="mt-1 font-mono text-foreground">
                  {plmCalibration.liveEvaluation.retained.total} total ·{" "}
                  {plmCalibration.liveEvaluation.retained.terminal} terminal
                </div>
              </div>
              <div className="rounded border border-emerald-400/30 bg-emerald-400/[0.05] p-2 text-[10px]">
                <div className="text-muted-foreground">Retained outcomes</div>
                <div className="mt-1 font-mono text-foreground">
                  stop{" "}
                  {plmCalibration.liveEvaluation.retained.outcomes.stop_loss ??
                    0}{" "}
                  · profit{" "}
                  {plmCalibration.liveEvaluation.retained.outcomes.profit ?? 0}{" "}
                  · avg{" "}
                  {plmCalibration.liveEvaluation.retained.averagePnl == null
                    ? "—"
                    : `${plmCalibration.liveEvaluation.retained.averagePnl.toFixed(2)}%`}
                </div>
              </div>
              <div className="rounded border border-border/40 bg-background/20 p-2 text-[10px]">
                <div className="text-muted-foreground">
                  Excluded by live policy
                </div>
                <div className="mt-1 font-mono text-foreground">
                  {plmCalibration.liveEvaluation.excluded.total} total ·{" "}
                  {plmCalibration.liveEvaluation.excluded.terminal} terminal
                </div>
              </div>
              <div className="rounded border border-border/40 bg-background/20 p-2 text-[10px]">
                <div className="text-muted-foreground">
                  Concurrent load · baseline → retained
                </div>
                <div className="mt-1 font-mono text-foreground">
                  max{" "}
                  {
                    plmCalibration.liveEvaluation.comparableBaseline
                      .maxConcurrent
                  }{" "}
                  → {plmCalibration.liveEvaluation.retainedLoad.maxConcurrent} ·
                  avg{" "}
                  {plmCalibration.liveEvaluation.comparableBaseline.averageConcurrent.toFixed(
                    2,
                  )}{" "}
                  →{" "}
                  {plmCalibration.liveEvaluation.retainedLoad.averageConcurrent.toFixed(
                    2,
                  )}
                </div>
                <div className="mt-0.5 text-[8px] text-muted-foreground/60">
                  measured{" "}
                  {
                    plmCalibration.liveEvaluation.comparableBaseline
                      .measuredSignals
                  }{" "}
                  → {plmCalibration.liveEvaluation.retainedLoad.measuredSignals}
                  ; open at cutoff{" "}
                  {
                    plmCalibration.liveEvaluation.comparableBaseline
                      .openAtCutoff
                  }{" "}
                  → {plmCalibration.liveEvaluation.retainedLoad.openAtCutoff}
                </div>
              </div>
            </div>
            <div className="mt-1 text-[8px] text-muted-foreground/60">
              Derived methodology: {plmCalibration.liveEvaluation.methodology}{" "}
              Cutoff:{" "}
              {plmCalibration.liveEvaluation.analysisCutoff ??
                "no valid detectedAt"}
              .
            </div>
            <div className="mt-2 text-[9px] text-muted-foreground">
              Chronological retained halves:{" "}
              {plmCalibration.liveEvaluation.chronologicalHalves
                .map(
                  (half, index) =>
                    `${index === 0 ? "1st" : "2nd"} n${half.retained}, stop ${half.stops}, avg ${half.averagePnl == null ? "—" : `${half.averagePnl.toFixed(2)}%`}`,
                )
                .join(" · ")}
            </div>
            <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
              <div className="rounded border border-border/40 bg-background/20 p-2 text-[10px]">
                <div className="text-muted-foreground">p3h coverage</div>
                <div className="mt-1 font-mono text-foreground">
                  {plmCalibration.sample.p3hCaptured}/
                  {plmCalibration.sample.totalSignals}
                  {" · "}
                  {plmCalibration.sample.p3hCoverageRate == null
                    ? "—"
                    : `${plmCalibration.sample.p3hCoverageRate.toFixed(1)}%`}
                </div>
              </div>
              <div className="rounded border border-border/40 bg-background/20 p-2 text-[10px]">
                <div className="text-muted-foreground">Shadow cap &gt;18%</div>
                <div className="mt-1 font-mono text-foreground">
                  {plmCalibration.shadow.capCost.stopsRemoved} стопов
                </div>
              </div>
              <div className="rounded border border-border/40 bg-background/20 p-2 text-[10px]">
                <div className="text-muted-foreground">Shadow cap cost</div>
                <div className="mt-1 font-mono text-foreground">
                  {plmCalibration.shadow.capCost.profitsLost} прибылей ·{" "}
                  {plmCalibration.shadow.capCost.protectedExitsLost} защитных
                  выходов
                </div>
              </div>
              <div className="rounded border border-border/40 bg-background/20 p-2 text-[10px]">
                <div className="text-muted-foreground">Shadow sample</div>
                <div
                  className={cn(
                    "mt-1 font-mono",
                    plmCalibration.sample.sufficient
                      ? "text-emerald-300"
                      : "text-amber-300",
                  )}
                >
                  {plmCalibration.sample.completedOutcomes}/
                  {plmCalibration.sample.minimumCompletedOutcomes}
                </div>
                <div className="mt-0.5 text-[8px] text-muted-foreground/50">
                  вся история:{" "}
                  {plmCalibration.sample.allHistoryCompletedOutcomes}
                </div>
              </div>
            </div>
            <div className="mt-2 grid gap-2 sm:grid-cols-2">
              {(["alpha", "superAlpha"] as const).map((key) => {
                const grade = plmCalibration.shadow.grades[key];
                return (
                  <div
                    key={key}
                    className="rounded border border-border/30 px-2 py-1.5 text-[9px] text-muted-foreground"
                  >
                    <span className="font-mono text-foreground">
                      {key === "superAlpha" ? "super_alpha" : "alpha"}
                    </span>
                    : n={grade.completed} · profit {grade.profits} · stop{" "}
                    {grade.stops} · OI30m&lt;0 {grade.negativeOi30m}
                  </div>
                );
              })}
            </div>
            <div className="mt-3">
              <div className="mb-1.5 text-[10px] font-medium text-fuchsia-100">
                Observation-only shadow candidate gates · immutable completed
                only
              </div>
              <div className="overflow-x-auto rounded border border-fuchsia-400/15">
                <table className="w-full min-w-[760px] text-left text-[9px]">
                  <thead className="bg-fuchsia-400/[0.06] text-muted-foreground">
                    <tr>
                      <th className="px-2 py-1.5 font-medium">Кандидат</th>
                      <th className="px-2 py-1.5 font-medium">
                        n / нет данных
                      </th>
                      <th className="px-2 py-1.5 font-medium">Убрал</th>
                      <th className="px-2 py-1.5 font-medium">
                        Потеря сильных
                      </th>
                      <th className="px-2 py-1.5 font-medium">raw PnL</th>
                      <th className="px-2 py-1.5 font-medium">Решение</th>
                    </tr>
                  </thead>
                  <tbody>
                    {plmCalibration.shadow.candidateFilters.map((candidate) => (
                      <tr
                        key={candidate.key}
                        className="border-t border-border/25 text-muted-foreground"
                      >
                        <td className="px-2 py-1.5 font-mono text-fuchsia-200">
                          {candidate.label}
                        </td>
                        <td className="px-2 py-1.5 font-mono">
                          {candidate.evaluatedCompleted} /{" "}
                          {candidate.unavailableCompleted}
                        </td>
                        <td className="px-2 py-1.5">
                          stop {candidate.stopsRemoved} · всего{" "}
                          {candidate.excludedCompleted}
                        </td>
                        <td className="px-2 py-1.5">
                          profit {candidate.profitsLost} · hit10{" "}
                          {candidate.hit10Lost} · hit20 {candidate.hit20Lost}
                          {candidate.peakCoverage.measured <
                          candidate.peakCoverage.excluded
                            ? ` · peak ${candidate.peakCoverage.measured}/${candidate.peakCoverage.excluded}`
                            : ""}
                        </td>
                        <td className="px-2 py-1.5 font-mono text-foreground/80">
                          kept{" "}
                          {candidate.rawPnl.retained.average == null
                            ? "—"
                            : `${candidate.rawPnl.retained.average.toFixed(2)}%`}
                          {" · "}net{" "}
                          {candidate.rawPnl.retained.net >= 0 ? "+" : ""}
                          {candidate.rawPnl.retained.net.toFixed(2)}%{" · "}
                          removed{" "}
                          {candidate.rawPnl.excluded.net >= 0 ? "+" : ""}
                          {candidate.rawPnl.excluded.net.toFixed(2)}%
                        </td>
                        <td
                          className={cn(
                            "px-2 py-1.5 font-medium",
                            candidate.criteria.qualifiesForLiveChange
                              ? "text-emerald-300"
                              : "text-amber-300",
                          )}
                        >
                          {candidate.criteria.qualifiesForLiveChange
                            ? "к отдельному change"
                            : !candidate.criteria.sufficient
                              ? `observation n<${candidate.criteria.minimumCompletedOutcomes}`
                              : !candidate.criteria.completeRawPnlCoverage ||
                                  !candidate.criteria.completePeakCoverage
                                ? "неполное покрытие"
                                : "observation-only"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="mt-1.5 text-[8px] leading-relaxed text-muted-foreground/55">
                {plmCalibration.shadow.decision.criteria}
              </p>
              <p className="mt-1 text-[9px] font-medium text-foreground/85">
                Итог: {plmCalibration.shadow.decision.detail}
              </p>
            </div>
            <div className="mt-3">
              <div className="mb-1.5 text-[10px] font-medium text-fuchsia-100">
                Futures Taker shadow · immutable на fire
              </div>
              <div className="grid gap-2 md:grid-cols-3">
                {plmCalibration.shadow.futTakerShadow.cohorts.map((cohort) => {
                  const label =
                    cohort.key === "below_20"
                      ? "<20%"
                      : cohort.key === "at_or_above_20"
                        ? "≥20%"
                        : "unavailable";
                  return (
                    <div
                      key={cohort.key}
                      className="rounded border border-fuchsia-400/15 bg-background/20 p-2 text-[9px] text-muted-foreground"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-mono text-fuchsia-200">
                          {label}
                        </span>
                        <span
                          className={cn(
                            "font-mono",
                            cohort.sufficient
                              ? "text-emerald-300"
                              : "text-amber-300",
                          )}
                        >
                          n={cohort.completed}/{cohort.minimumCompletedOutcomes}
                        </span>
                      </div>
                      <div className="mt-1">
                        всего {cohort.total} · открыто {cohort.open} · profit{" "}
                        {cohort.outcomes.profit} · stop{" "}
                        {cohort.outcomes.stopLoss}
                      </div>
                      <div className="mt-0.5">
                        BE STOP {cohort.outcomes.buStop} · B.E.{" "}
                        {cohort.outcomes.breakeven} · expired{" "}
                        {cohort.outcomes.expired} · cancelled{" "}
                        {cohort.outcomes.cancelled}
                      </div>
                      <div className="mt-0.5 font-mono text-foreground/80">
                        raw PnL: net{" "}
                        {`${cohort.netRawPnl >= 0 ? "+" : ""}${cohort.netRawPnl.toFixed(2)}%`}
                        {" · "}avg{" "}
                        {cohort.averageRawPnl == null
                          ? "—"
                          : `${cohort.averageRawPnl.toFixed(2)}%`}
                        {" · "}n={cohort.rawPnlCount}
                      </div>
                    </div>
                  );
                })}
              </div>
              <div className="mt-1.5 text-[9px] text-muted-foreground/60">
                coverage: {plmCalibration.shadow.futTakerShadow.captured}/
                {plmCalibration.sample.totalSignals} ·{" "}
                {plmCalibration.shadow.futTakerShadow.coverageRate == null
                  ? "—"
                  : `${plmCalibration.shadow.futTakerShadow.coverageRate.toFixed(1)}%`}
                . Метка не участвует в live-fire, cancellation или очереди.
              </div>
            </div>
            <div className="mt-2">
              <div className="mb-1.5 text-[10px] font-medium text-fuchsia-100">
                Перегрев: 20–30% против &gt;30%
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                {plmCalibration.shadow.futTakerShadow.ranges.cohorts.map(
                  (cohort) => (
                    <div
                      key={cohort.key}
                      className="rounded border border-fuchsia-400/15 bg-background/20 p-2 text-[9px] text-muted-foreground"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-mono text-fuchsia-200">
                          {cohort.key === "from_20_to_30" ? "20–30%" : ">30%"}
                        </span>
                        <span
                          className={cn(
                            "font-mono",
                            cohort.sufficient
                              ? "text-emerald-300"
                              : "text-amber-300",
                          )}
                        >
                          n={cohort.completed}/{cohort.minimumCompletedOutcomes}
                        </span>
                      </div>
                      <div className="mt-1">
                        всего {cohort.total} · открыто {cohort.open} · profit{" "}
                        {cohort.outcomes.profit} · stop{" "}
                        {cohort.outcomes.stopLoss}
                      </div>
                      <div className="mt-0.5">
                        BE STOP {cohort.outcomes.buStop} · B.E.{" "}
                        {cohort.outcomes.breakeven} · expired{" "}
                        {cohort.outcomes.expired} · cancelled{" "}
                        {cohort.outcomes.cancelled}
                      </div>
                      <div className="mt-0.5 font-mono text-foreground/80">
                        raw PnL: net{" "}
                        {`${cohort.netRawPnl >= 0 ? "+" : ""}${cohort.netRawPnl.toFixed(2)}%`}
                        {" · "}avg{" "}
                        {cohort.averageRawPnl == null
                          ? "—"
                          : `${cohort.averageRawPnl.toFixed(2)}%`}
                      </div>
                    </div>
                  ),
                )}
              </div>
              <div className="mt-1.5 text-[8px] text-muted-foreground/50">
                {plmCalibration.shadow.futTakerShadow.ranges.note}
              </div>
              <div className="mt-1 rounded border border-border/30 bg-background/20 px-2 py-1.5 text-[9px] text-muted-foreground/75">
                <span className="font-medium text-foreground/90">
                  Вывод по диапазонам:{" "}
                </span>
                {plmCalibration.shadow.futTakerShadow.ranges.comparison.detail}
              </div>
            </div>
            <div
              className={cn(
                "mt-2 rounded border px-2.5 py-2",
                plmCalibration.shadow.futTakerShadow.recommendation.action ===
                  "live_veto"
                  ? "border-red-400/30 bg-red-400/[0.06]"
                  : plmCalibration.shadow.futTakerShadow.recommendation
                        .action === "limited_experiment"
                    ? "border-amber-400/30 bg-amber-400/[0.06]"
                    : "border-fuchsia-400/20 bg-background/20",
              )}
            >
              <div className="text-[10px] font-medium text-foreground">
                Решение:{" "}
                {plmCalibration.shadow.futTakerShadow.recommendation.title}
              </div>
              <p className="mt-0.5 text-[9px] leading-relaxed text-muted-foreground/75">
                {plmCalibration.shadow.futTakerShadow.recommendation.detail}
              </p>
            </div>
            <div className="mt-2 text-[9px] leading-relaxed text-muted-foreground/70">
              Причины перевода в super_alpha:{" "}
              {plmCalibration.shadow.grades.superAlphaReasons.length
                ? plmCalibration.shadow.grades.superAlphaReasons
                    .map(({ key, count }) => `${key} (${count})`)
                    .join(" · ")
                : "пока нет завершённых super_alpha с новым decision snapshot"}
            </div>
            {plmCalibration.shadow.grades.superAlphaScoreBreakdowns.length >
            0 ? (
              <div className="mt-1 text-[9px] leading-relaxed text-muted-foreground/60">
                Score context:{" "}
                {plmCalibration.shadow.grades.superAlphaScoreBreakdowns
                  .map(({ key, count }) => `${key} (${count})`)
                  .join(" · ")}
              </div>
            ) : null}
            {!plmCalibration.sample.sufficient ? (
              <p className="mt-2 text-[9px] font-medium text-amber-300/90">
                Подтверждение пока невозможно: требуется минимум{" "}
                {plmCalibration.sample.minimumCompletedOutcomes} завершённых PLM
                с новым decision snapshot.
              </p>
            ) : null}
            <p className="mt-2 text-[9px] text-muted-foreground/55">
              {plmCalibration.definition}
            </p>
          </>
        ) : null}
      </div>

      {/* Frozen entry indicator relations: descriptive cohorts, never a trade gate. */}
      <section
        className="rounded-sm border border-cyan-400/20 bg-cyan-400/[0.03] p-3"
        aria-labelledby="abneon-relations-title"
        data-testid="panel-abneon-relations"
      >
        <div className="flex items-start gap-2">
          <Activity
            className="mt-0.5 h-4 w-4 shrink-0 text-cyan-300"
            aria-hidden="true"
          />
          <div>
            <h3
              id="abneon-relations-title"
              className="text-xs font-medium text-cyan-100"
            >
              ABNeon · связи входных индикаторов с исходом
            </h3>
            <p className="mt-0.5 text-[10px] leading-relaxed text-muted-foreground/75">
              Только наблюдение по сохранённым входным данным и закрытым
              исходам. Версии не смешиваются. Уровни S/R — расстояния от входа,
              не цели и не действующие TP.
            </p>
          </div>
        </div>
        {isRelationCatalogLoading ? (
          <div
            className="mt-3 space-y-2"
            role="status"
            aria-label="Загрузка связей индикаторов"
          >
            <div className="h-8 w-2/3 animate-pulse rounded-sm bg-muted/30" />
            <div className="h-20 animate-pulse rounded-sm bg-muted/20" />
          </div>
        ) : isRelationCatalogError ? (
          <div
            className="mt-3 rounded-sm border border-amber-400/20 bg-amber-400/5 p-2.5 text-[10px] text-amber-300/90"
            role="alert"
          >
            Не удалось загрузить связи ABNeon. История сигналов доступна.
            <button
              type="button"
              onClick={() => void refetchRelationCatalog()}
              className="ml-2 underline underline-offset-2 hover:text-amber-100"
              data-testid="button-retry-abneon-relations"
            >
              Повторить
            </button>
          </div>
        ) : !versions.length ? (
          <div
            className="mt-3 rounded-sm border border-border/40 bg-background/20 p-3 text-[10px] text-muted-foreground"
            data-testid="status-abneon-relations-empty"
          >
            Нет сохранённых готовых снимков ABNeon для выбранного паттерна.
            Сравнение появится, когда будут данные.
          </div>
        ) : (
          <>
            <div className="mt-3 flex flex-wrap items-end gap-2.5">
              <label
                htmlFor="abneon-version"
                className="flex min-w-[170px] flex-col gap-1 text-[9px] text-muted-foreground/75"
              >
                Версия снимка
                <select
                  id="abneon-version"
                  value={selectedVersion}
                  onChange={(e) => {
                    setRelationVersion(e.target.value);
                    setRelationIndicator("");
                  }}
                  className="h-8 rounded-sm border border-border/50 bg-background px-2 font-mono text-[11px] text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-400"
                  data-testid="select-abneon-version"
                >
                  {versions.map((version) => (
                    <option value={version} key={version}>
                      {version}
                    </option>
                  ))}
                </select>
              </label>
              <label
                htmlFor="abneon-indicator"
                className="flex min-w-[180px] max-w-full flex-col gap-1 text-[9px] text-muted-foreground/75"
              >
                Индикатор при входе
                <select
                  id="abneon-indicator"
                  value={selectedIndicator}
                  onChange={(e) => setRelationIndicator(e.target.value)}
                  className="h-8 max-w-full rounded-sm border border-border/50 bg-background px-2 font-mono text-[11px] text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-400"
                  data-testid="select-abneon-indicator"
                >
                  {indicatorOptions.map((indicator) => (
                    <option value={indicator} key={indicator}>
                      {indicator}
                    </option>
                  ))}
                </select>
              </label>
              <label
                htmlFor="abneon-provenance"
                className="flex min-w-[180px] flex-col gap-1 text-[9px] text-muted-foreground/75"
              >
                Происхождение значения
                <select
                  id="abneon-provenance"
                  value={relationProvenance}
                  onChange={(e) => {
                    setRelationProvenance(
                      e.target.value as RelationProvenanceCohort,
                    );
                    setRelationIndicator("");
                  }}
                  className="h-8 rounded-sm border border-border/50 bg-background px-2 text-[11px] text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-400"
                  data-testid="select-abneon-provenance"
                >
                  {(
                    Object.keys(
                      RELATION_PROVENANCE_LABELS,
                    ) as RelationProvenanceCohort[]
                  ).map((cohort) => (
                    <option value={cohort} key={cohort}>
                      {RELATION_PROVENANCE_LABELS[cohort]}
                    </option>
                  ))}
                </select>
              </label>
              <span
                className="pb-1 text-[9px] text-muted-foreground/65"
                data-testid="text-abneon-cohort"
              >
                Каталог, {pattern || "все паттерны"}, все версии:{" "}
                {relationCatalog?.metadata.cohort.readySnapshotsReturned ?? 0}{" "}
                готовых снимков ·{" "}
                {relationCatalog?.metadata.cohort.measurableClosedOutcomes ?? 0}{" "}
                измеримых закрытых исходов ·{" "}
                {relationCatalog?.metadata.cohort.unknownClosedOutcomes ?? 0}{" "}
                без измеримого исхода
              </span>
            </div>
            {(relationCatalog?.rangeCohorts ?? []).filter(
              ({ version }) => version === selectedVersion,
            ).length > 0 && (
              <div
                className="mt-3 rounded-sm border border-cyan-400/15 p-2.5"
                data-testid="abneon-range-outcomes"
              >
                <div className="text-[10px] font-medium text-cyan-100">
                  Диапазоны 1H / 4H и исходы · {selectedVersion}
                </div>
                <div className="mt-0.5 text-[9px] text-muted-foreground/70">
                  Отдельная оценка по закрытым свечам. Открытые позиции не
                  считаются исходами; менее 20 закрытых — малая выборка.
                </div>
                <div className="mt-2 space-y-1">
                  {relationCatalog?.rangeCohorts
                    .filter(({ version }) => version === selectedVersion)
                    .map((group) => (
                      <div
                        key={`${group.pattern}-${group.oneHour}-${group.fourHour}`}
                        className="flex flex-wrap gap-x-3 gap-y-0.5 border-t border-border/20 pt-1 text-[10px]"
                      >
                        <span className="font-mono text-cyan-100">
                          {group.pattern}
                        </span>
                        <span>
                          1H: {group.oneHour} · 4H: {group.fourHour}
                        </span>
                        <span>открыты: {group.open}</span>
                        <span>закрыты: {group.closed}</span>
                        <span>≥10%: {group.atLeast10Pct}</span>
                        <span>
                          средний PnL:{" "}
                          {group.averageRawPnlPercent == null
                            ? "н/д"
                            : `${group.averageRawPnlPercent.toFixed(2)}%`}
                        </span>
                        {group.unknownOutcome > 0 && (
                          <span>без PnL: {group.unknownOutcome}</span>
                        )}
                        {group.lowSample && (
                          <span className="text-amber-300/80">
                            малая выборка
                          </span>
                        )}
                      </div>
                    ))}
                </div>
              </div>
            )}
            {relationAvailability.length > 0 && (
              <div
                className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[9px] text-muted-foreground/70"
                data-testid="text-abneon-availability"
              >
                {relationAvailability.map((availability) => (
                  <span
                    key={[
                      availability.pattern,
                      availability.version,
                      availability.indicator,
                      availability.provenanceCohort,
                    ].join("|")}
                  >
                    {availability.pattern} ·{" "}
                    {RELATION_PROVENANCE_LABELS[availability.provenanceCohort]}:
                    входное значение есть у {availability.availableCount},
                    отсутствует у {availability.missingCount} ·{" "}
                    {availability.unit}
                  </span>
                ))}
              </div>
            )}
            {relationAvailability.length === 0 && (
              <div
                className="mt-2 text-[9px] text-muted-foreground/70"
                data-testid="status-abneon-provenance-availability-empty"
              >
                Для выбранного происхождения и индикатора нет сохранённых
                значений в этой версии.
              </div>
            )}
            {isVersionRelationsLoading ? (
              <div
                className="mt-3 space-y-1.5"
                role="status"
                aria-label="Загрузка версии ABNeon"
              >
                <div className="h-7 animate-pulse rounded-sm bg-muted/25" />
                <div className="h-12 animate-pulse rounded-sm bg-muted/15" />
              </div>
            ) : isVersionRelationsError ? (
              <div
                className="mt-3 rounded-sm border border-amber-400/20 bg-amber-400/5 p-2.5 text-[10px] text-amber-300/90"
                role="alert"
              >
                Не удалось загрузить исходы для этой версии.
                <button
                  type="button"
                  onClick={() => void refetchVersionRelations()}
                  className="ml-2 underline underline-offset-2 hover:text-amber-100"
                  data-testid="button-retry-abneon-version"
                >
                  Повторить
                </button>
              </div>
            ) : relationRows.length === 0 ? (
              <div
                className="mt-3 rounded-sm border border-border/40 bg-background/20 p-3 text-[10px] text-muted-foreground"
                data-testid="status-abneon-version-empty"
              >
                Для версии {selectedVersion}, индикатора {selectedIndicator} и
                происхождения «{RELATION_PROVENANCE_LABELS[relationProvenance]}»
                нет закрытых наблюдений.{" "}
                {relationProvenance === "fire_time"
                  ? "Это не означает, что реконструированные или другие исторические данные являются значениями на момент сигнала."
                  : "Другие группы происхождения показаны отдельно."}
              </div>
            ) : (
              <div className="mt-3 overflow-x-auto rounded-sm border border-border/35">
                <div
                  className="border-b border-border/35 bg-background/20 px-2 py-1.5 text-[10px] text-cyan-100/80"
                  data-testid="text-abneon-selected-group"
                >
                  {selectedVersion} · {selectedIndicator} ·{" "}
                  {RELATION_PROVENANCE_LABELS[relationProvenance]} · закрытые
                  исходы
                </div>
                <table
                  className="w-full min-w-[1150px] text-left text-[10px]"
                  data-testid="table-abneon-relations"
                >
                  <caption className="sr-only">
                    Исходы закрытых сигналов по входному индикатору, корзине и
                    близости поддержки и сопротивления к цене входа
                  </caption>
                  <thead className="border-b border-border/40 bg-background/25 text-[9px] text-muted-foreground/75">
                    <tr>
                      <th scope="col" className="px-2 py-2 font-medium">
                        Паттерн
                      </th>
                      <th scope="col" className="px-2 py-2 font-medium">
                        Происхождение
                      </th>
                      <th scope="col" className="px-2 py-2 font-medium">
                        Корзина · {relationAvailability[0]?.unit ?? ""}
                      </th>
                      <th scope="col" className="px-2 py-2 font-medium">
                        Поддержка от входа
                      </th>
                      <th scope="col" className="px-2 py-2 font-medium">
                        Сопротивление от входа
                      </th>
                      <th
                        scope="col"
                        className="px-2 py-2 text-right font-medium"
                      >
                        Измеримые / unknown
                      </th>
                      <th
                        scope="col"
                        className="px-2 py-2 text-right font-medium"
                      >
                        Средний факт. PnL
                      </th>
                      <th
                        scope="col"
                        className="px-2 py-2 text-right font-medium"
                      >
                        Факт. PnL ≥+10%
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border/25">
                    {relationRows.map((row) => (
                      <tr
                        key={[
                          row.pattern,
                          row.version,
                          row.indicator,
                          row.provenanceCohort,
                          row.bucket,
                          row.supportProximityBand,
                          row.resistanceProximityBand,
                        ].join("|")}
                        className="hover:bg-cyan-400/[0.035]"
                      >
                        <th
                          scope="row"
                          className="px-2 py-2 font-medium text-foreground/85"
                        >
                          {row.pattern}
                        </th>
                        <td className="px-2 py-2">
                          <span
                            className={cn(
                              "inline-block rounded-sm border px-1.5 py-0.5 text-[9px]",
                              row.provenanceCohort === "fire_time"
                                ? "border-cyan-400/25 text-cyan-200"
                                : "border-amber-400/20 text-amber-200/80",
                            )}
                          >
                            {RELATION_PROVENANCE_LABELS[row.provenanceCohort]}
                          </span>
                        </td>
                        <td className="px-2 py-2 font-mono text-cyan-100/85">
                          {row.bucket === "unknown"
                            ? "нет значения"
                            : row.bucket}
                        </td>
                        <td className="px-2 py-2 font-mono">
                          {row.supportProximityBand === "unknown"
                            ? "неизвестно"
                            : row.supportProximityBand}
                        </td>
                        <td className="px-2 py-2 font-mono">
                          {row.resistanceProximityBand === "unknown"
                            ? "неизвестно"
                            : row.resistanceProximityBand}
                        </td>
                        <td className="px-2 py-2 text-right font-mono">
                          {row.eligibleCount} / {row.unknownCount}
                          <div className="text-[9px] text-muted-foreground/60">
                            вход {row.unknownEntryCount} · исход{" "}
                            {row.unknownOutcomeCount}
                          </div>
                          {row.lowSample && (
                            <span className="text-[9px] text-amber-300/75">
                              мало: &lt;
                              {relationCatalog?.metadata.cohort
                                .lowSampleThreshold ?? 10}
                            </span>
                          )}
                        </td>
                        <td className="px-2 py-2 text-right font-mono">
                          {row.averageRawPnlPercent == null
                            ? "—"
                            : `${row.averageRawPnlPercent >= 0 ? "+" : ""}${row.averageRawPnlPercent.toFixed(2)}%`}
                        </td>
                        <td className="px-2 py-2 text-right font-mono">
                          {row.outcomesAtLeast10Pct}/{row.eligibleCount}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {versionRelations && (
              <div className="mt-4" data-testid="abneon-target-audit">
                <h4 className="text-[11px] font-medium text-cyan-100">
                  Исторические альтернативные тейки · только аудит
                </h4>
                <p className="mt-1 text-[9px] leading-relaxed text-muted-foreground/75">
                  По версиям и паттернам отдельно. Подтверждение — только
                  сохранённое касание после снимка и до закрытия. Без такого
                  события исход цели неизвестен, не промах. Δ PnL — модель
                  полного выхода по цели только среди подтверждённых касаний, не
                  доходность всей стратегии. Сравнение с фактическим raw PnL и
                  сохранением исходов ≥10% не даёт основания менять действующие
                  тейки и стопы без отдельного решения.
                </p>
                <div className="mt-2 overflow-x-auto">
                  <table className="w-full min-w-[800px] text-left text-[10px]">
                    <thead>
                      <tr className="border-b border-border/40 text-muted-foreground">
                        <th className="py-1">Паттерн / вариант</th>
                        <th>Закрыто / измеримо</th>
                        <th>Касаний / неизвестно</th>
                        <th>Факт ≥10% / срезано целью</th>
                        <th>Факт. ср. raw PnL</th>
                        <th>Δ на касаниях, п.п.</th>
                      </tr>
                    </thead>
                    <tbody>
                      {versionRelations.targetAudit
                        .filter((group) => group.version === selectedVersion)
                        .map((group) => (
                          <tr
                            key={`${group.version}|${group.pattern}|${group.variant}`}
                            className="border-b border-border/20"
                          >
                            <td className="py-1 font-mono">
                              {group.pattern} · {group.variant}
                              {!group.sufficient && (
                                <span className="ml-1 text-amber-300">
                                  мало данных (&lt;20)
                                </span>
                              )}
                            </td>
                            <td>
                              {group.eligibleClosed} / {group.measuredClosed}
                            </td>
                            <td>
                              {group.confirmedHits} / {group.unknownTouch}
                            </td>
                            <td>
                              {group.actualStrong} /{" "}
                              {group.confirmedStrongClipped}
                            </td>
                            <td>
                              {group.actualAverageRawPnl == null
                                ? "—"
                                : `${group.actualAverageRawPnl.toFixed(2)}%`}
                            </td>
                            <td>
                              {group.confirmedHitDeltaPp == null
                                ? "—"
                                : group.confirmedHitDeltaPp.toFixed(2)}
                            </td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
            <p className="mt-2 text-[9px] leading-relaxed text-muted-foreground/65">
              По умолчанию показаны только значения, сохранённые на момент
              сигнала (fire_time). Предскан-снимки, реконструкция и неизвестное
              происхождение отделены: реконструированные и unknown нельзя
              считать проверенным решением на момент сигнала. Измеримые —
              закрытые позиции с фактическим PnL; unknown в счётчике строки
              означает отсутствующее входное значение и/или неизмеримый исход, а
              не группу происхождения. Цели оцениваются только по сохранённому
              времени касания до закрытия; отсутствие события не доказывает
              промах. Малая выборка — менее{" "}
              {relationCatalog?.metadata.cohort.lowSampleThreshold ?? 10}{" "}
              измеримых исходов в строке. Ни одно сравнение не меняет торговую
              логику.
            </p>
          </>
        )}
      </section>

      <TrailingAnalysisPanel
        data={trailingAnalysis}
        isLoading={isTrailingAnalysisLoading}
        isError={isTrailingAnalysisError}
      />

      <BeThresholdAnalysisPanel
        data={beThresholdAnalysis}
        isLoading={isBeThresholdAnalysisLoading}
        isError={isBeThresholdAnalysisError}
      />

      {/* Fixed +5% profit lock after +10% peak — observational only. */}
      <div className="rounded-sm border border-emerald-400/20 bg-emerald-400/[0.03] p-3">
        <div className="flex items-start gap-2">
          <Activity className="mt-0.5 h-4 w-4 shrink-0 text-emerald-300" />
          <div className="min-w-0">
            <div className="text-xs font-medium text-emerald-100">
              Защита прибыли Lab · +10% → виртуальный стоп +5%
            </div>
            <p className="mt-0.5 text-[10px] leading-relaxed text-muted-foreground/75">
              Проверяется фиксированный уровень +5% от входа после пика +10%.
              Это не меняет текущий BE или трейлинг.
            </p>
          </div>
        </div>
        {isProfitLockAnalysisLoading ? (
          <div className="mt-3 rounded-sm border border-border/40 bg-background/20 px-2.5 py-2 text-[10px] text-muted-foreground">
            Загружается выборка защиты прибыли…
          </div>
        ) : isProfitLockAnalysisError ? (
          <div className="mt-3 rounded-sm border border-amber-400/20 bg-amber-400/5 px-2.5 py-2 text-[10px] text-amber-300/80">
            Не удалось загрузить анализ защиты прибыли. История сигналов
            продолжает работать.
          </div>
        ) : profitLockAnalysis ? (
          <>
            <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 rounded-sm border border-border/40 bg-background/20 px-2.5 py-2 text-[10px] text-muted-foreground">
              <span>
                Достигли +10%:{" "}
                <span className="font-mono text-foreground">
                  {apiNum(profitLockAnalysis.sample.activated) ?? 0}
                </span>
              </span>
              <span>
                Виртуальных hit +5%:{" "}
                <span className="font-mono text-foreground">
                  {apiNum(profitLockAnalysis.sample.virtualHits) ?? 0}
                </span>
              </span>
              <span>
                Выборка:{" "}
                <span
                  className={cn(
                    "font-mono",
                    profitLockAnalysis.sample.sufficient
                      ? "text-emerald-300"
                      : "text-amber-300",
                  )}
                >
                  {profitLockAnalysis.sample.sufficient
                    ? "достаточно"
                    : `нужно ≥${apiNum(profitLockAnalysis.sample.minimumHits) ?? 20}`}
                </span>
              </span>
            </div>
            {profitLockAnalysis.counterfactual ? (
              <div className="mt-3 rounded-sm border border-emerald-400/15 bg-background/20 p-2.5">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <div className="text-[10px] font-medium text-emerald-100">
                      Полный EV · все достигшие +10%
                    </div>
                    <p className="mt-0.5 text-[9px] text-muted-foreground/65">
                      При hit считается выход +5%; без hit сохраняется
                      фактический результат.
                    </p>
                  </div>
                  <span
                    className={cn(
                      "rounded border px-1.5 py-0.5 text-[9px]",
                      profitLockAnalysis.counterfactual.summary.sufficient
                        ? profitLockAnalysis.counterfactual.summary
                            .recommendation === "candidate_improves"
                          ? "border-emerald-400/25 text-emerald-300"
                          : "border-red-400/25 text-red-300"
                        : "border-amber-400/25 text-amber-300",
                    )}
                  >
                    {profitLockAnalysis.counterfactual.summary.sufficient
                      ? profitLockAnalysis.counterfactual.summary
                          .recommendation === "candidate_improves"
                        ? "кандидат улучшает EV"
                        : profitLockAnalysis.counterfactual.summary
                              .recommendation === "candidate_hurts"
                          ? "кандидат ухудшает EV"
                          : "эффект нейтрален"
                      : `вывод заблокирован: ${profitLockAnalysis.counterfactual.summary.completedVirtualHits}/${profitLockAnalysis.counterfactual.minimumCompletedHits} закрытых hit`}
                  </span>
                </div>

                <div className="mt-2 overflow-x-auto rounded-sm border border-border/30">
                  <table className="w-full min-w-[1080px] text-left text-[9px]">
                    <thead className="border-b border-border/40 text-muted-foreground/60">
                      <tr>
                        <th className="px-2 py-1.5 font-medium">Паттерн</th>
                        <th className="px-2 py-1.5 text-right font-medium">
                          +10% / open
                        </th>
                        <th className="px-2 py-1.5 text-right font-medium">
                          Закрыто
                        </th>
                        <th className="px-2 py-1.5 text-right font-medium">
                          hit +5%
                        </th>
                        <th className="px-2 py-1.5 text-right font-medium">
                          Факт avg
                        </th>
                        <th className="px-2 py-1.5 text-right font-medium">
                          +5% avg
                        </th>
                        <th className="px-2 py-1.5 text-right font-medium">
                          Δ avg / total
                        </th>
                        <th className="px-2 py-1.5 text-right font-medium">
                          лучше / хуже
                        </th>
                        <th className="px-2 py-1.5 text-right font-medium">
                          lost upside
                        </th>
                        <th className="px-2 py-1.5 text-right font-medium">
                          путь 72ч
                        </th>
                        <th className="px-2 py-1.5 font-medium">Вывод</th>
                      </tr>
                    </thead>
                    <tbody>
                      {[
                        profitLockAnalysis.counterfactual.summary,
                        ...profitLockAnalysis.counterfactual.byPattern,
                      ].map((group) => (
                        <tr
                          key={group.sentimentKey}
                          className={cn(
                            "border-b border-border/20 last:border-0",
                            group.sentimentKey === "all" &&
                              "bg-emerald-400/[0.035]",
                          )}
                        >
                          <td className="px-2 py-1.5 font-medium text-foreground/90">
                            {group.sentimentKey === "all"
                              ? "Все активные"
                              : getPatternTgLabel(group.sentimentKey)}
                          </td>
                          <td className="px-2 py-1.5 text-right font-mono">
                            {group.activated} / {group.open}
                          </td>
                          <td className="px-2 py-1.5 text-right font-mono">
                            {group.closed}
                          </td>
                          <td className="px-2 py-1.5 text-right font-mono">
                            {group.completedVirtualHits}/
                            {group.minimumCompletedHits}
                          </td>
                          <td className="px-2 py-1.5 text-right font-mono">
                            {fmtPct(apiNum(group.averageActualPnl))}
                          </td>
                          <td className="px-2 py-1.5 text-right font-mono text-emerald-300">
                            {fmtPct(apiNum(group.averageCandidatePnl))}
                          </td>
                          <td
                            className={cn(
                              "px-2 py-1.5 text-right font-mono",
                              group.totalDeltaPp > 0.05
                                ? "text-emerald-300"
                                : group.totalDeltaPp < -0.05
                                  ? "text-red-300"
                                  : "",
                            )}
                          >
                            {fmtPct(apiNum(group.averageDeltaPp))} /{" "}
                            {fmtPct(apiNum(group.totalDeltaPp))}
                          </td>
                          <td className="px-2 py-1.5 text-right font-mono">
                            <span className="text-emerald-300">
                              {group.helped}
                            </span>{" "}
                            / <span className="text-red-300">{group.hurt}</span>
                          </td>
                          <td className="px-2 py-1.5 text-right font-mono text-amber-200">
                            {group.lostUpsideCount} /{" "}
                            {fmtPct(apiNum(group.totalLostUpsidePp))}
                          </td>
                          <td className="px-2 py-1.5 text-right font-mono">
                            {group.trajectoryCoveragePct == null
                              ? "—"
                              : `${group.trajectoryCoveragePct.toFixed(0)}%`}
                          </td>
                          <td
                            className={cn(
                              "px-2 py-1.5",
                              group.sufficient
                                ? group.recommendation === "candidate_improves"
                                  ? "text-emerald-300"
                                  : "text-red-300"
                                : "text-amber-200",
                            )}
                          >
                            {!group.sufficient
                              ? "мало hit"
                              : group.recommendation === "candidate_improves"
                                ? "улучшает"
                                : group.recommendation === "candidate_hurts"
                                  ? "ухудшает"
                                  : "нейтрально"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="mt-1.5 text-[9px] leading-relaxed text-muted-foreground/55">
                  {profitLockAnalysis.counterfactual.definition}
                </p>
              </div>
            ) : null}
            {(profitLockAnalysis.groups ?? []).length === 0 ? (
              <p className="mt-2 text-[10px] text-amber-200/80">
                Данных для вывода пока нет: сбор начнётся с новых позиций,
                достигших +10%, и их первого возврата к виртуальному +5%.
              </p>
            ) : (
              <div className="mt-3 grid gap-2 md:grid-cols-2 xl:grid-cols-3">
                {profitLockAnalysis.groups.map((group) => {
                  const hitCount = apiNum(group.virtualHits) ?? 0;
                  const enough =
                    hitCount >=
                    (apiNum(profitLockAnalysis.sample.minimumHits) ?? 20);
                  return (
                    <div
                      key={`${group.sentimentKey}:${group.activationPct}:${group.lockedProfitPct}`}
                      className={cn(
                        "rounded-sm border bg-background/20 p-2",
                        enough ? "border-emerald-400/25" : "border-border/35",
                      )}
                    >
                      <div className="flex items-center justify-between gap-2 text-[10px]">
                        <span className="font-medium text-foreground/90">
                          {getPatternTgLabel(group.sentimentKey)}
                        </span>
                        <span
                          className={cn(
                            "rounded border px-1 py-0.5 font-mono text-[9px]",
                            enough
                              ? "border-emerald-400/25 text-emerald-300"
                              : "border-amber-400/25 text-amber-300",
                          )}
                        >
                          n={hitCount}
                        </span>
                      </div>
                      <div className="mt-1 font-mono text-[11px] text-emerald-200">
                        +{apiNum(group.activationPct) ?? "?"}% → +
                        {apiNum(group.lockedProfitPct) ?? "?"}%
                      </div>
                      <div className="mt-1 grid grid-cols-2 gap-x-2 gap-y-0.5 text-[9px] text-muted-foreground/80">
                        <span>
                          virtual: {fmtPct(apiNum(group.averageVirtualExitPnl))}
                        </span>
                        <span>
                          факт: {fmtPct(apiNum(group.averageActualClosePnl))}
                        </span>
                        <span>
                          Δ факт−вирт:{" "}
                          {fmtPct(apiNum(group.averageActualVsLockDelta))}
                        </span>
                        <span>
                          24ч: {fmtPct(apiNum(group.averagePnlAt24h))}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
            <p className="mt-2 text-[9px] leading-relaxed text-muted-foreground/55">
              {profitLockAnalysis.definition}
            </p>
          </>
        ) : null}
      </div>

      {/* Filters */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex gap-1 border border-border/50 rounded-sm p-0.5">
          {STATUS_FILTERS.map((f) => (
            <button
              key={f.id}
              onClick={() => {
                setStatus(f.id);
                setPage(1);
                updateUrlFilters(
                  {
                    status: f.id,
                    ...(f.id === "neutral_close"
                      ? { dateBasis: "detected" }
                      : {}),
                  },
                  ["metric", "pnlSign"],
                );
              }}
              className={cn(
                "px-2.5 py-1 text-xs rounded-sm transition-colors",
                status === f.id
                  ? "bg-primary/15 text-primary"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {f.label}
            </button>
          ))}
        </div>

        <input
          list="signal-history-patterns"
          value={patternInput}
          onChange={(e) => setPatternInput(e.target.value)}
          placeholder="паттерн (название или ключ)"
          className="h-7 w-full sm:w-[210px] px-2 bg-card border border-border/50 rounded-sm text-xs font-mono placeholder:text-muted-foreground/40 focus:outline-none focus:border-primary/40"
        />
        <datalist id="signal-history-patterns">
          {ACTIVE_PATTERN_KEYS.map((k) => (
            <option key={k} value={k} label={getPatternTgLabel(k)}>
              {getPatternTgLabel(k)}
            </option>
          ))}
        </datalist>

        <div className="relative">
          <Search className="w-3 h-3 absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground/40" />
          <input
            value={symbolInput}
            onChange={(e) => setSymbolInput(e.target.value)}
            placeholder="BTC, ETH…"
            className="h-7 w-full sm:w-[130px] pl-6 pr-2 bg-card border border-border/50 rounded-sm text-xs font-mono placeholder:text-muted-foreground/40 focus:outline-none focus:border-primary/40"
          />
        </div>
        <label className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
          <span>Сортировка</span>
          <select
            aria-label="Сортировка истории сигналов"
            value={sort}
            onChange={(e) => {
              setSort(e.target.value);
              setPage(1);
              updateUrlFilters({ sort: e.target.value });
            }}
            className="h-7 bg-card border border-border/50 rounded-sm px-1.5 text-xs text-foreground focus:outline-none focus:border-primary/40"
          >
            <option value="">по дате</option>
            <option value="pattern">по паттерну</option>
          </select>
        </label>
      </div>

      {/* Table */}
      {isLoading ? (
        <div className="text-xs text-muted-foreground py-8 text-center">
          Загрузка…
        </div>
      ) : isError ? (
        <div className="text-xs text-red-400 py-8 text-center">
          Ошибка загрузки истории сигналов
        </div>
      ) : signals.length === 0 ? (
        <div className="text-xs text-muted-foreground py-8 text-center">
          Нет сигналов по текущим фильтрам
        </div>
      ) : (
        <div className="border border-border/50 rounded-sm overflow-x-auto">
          <table className="w-full text-left">
            <thead className="bg-muted/20 text-[10px] uppercase tracking-wider">
              <tr className="border-b border-border/50">
                <th className="px-2 py-2.5 w-8" />
                <th className="px-3 py-2.5 font-medium text-muted-foreground">
                  Символ
                </th>
                <th className="px-3 py-2.5 font-medium text-muted-foreground">
                  Паттерн
                </th>
                <th className="px-3 py-2.5 font-medium text-muted-foreground">
                  Статус
                </th>
                <th
                  className="px-3 py-2.5 font-medium text-muted-foreground text-right"
                  title="Количество скан-циклов токена на момент входа"
                >
                  Циклы
                </th>
                <th
                  className="px-3 py-2.5 font-medium text-muted-foreground text-right"
                  title="Bullet Score при детекте"
                >
                  Скор
                </th>
                <th className="px-3 py-2.5 font-medium text-muted-foreground text-right">
                  PnL%
                </th>
                <th className="px-3 py-2.5 font-medium text-muted-foreground text-right">
                  Peak%
                </th>
                <th className="px-3 py-2.5 font-medium text-muted-foreground">
                  Открыт
                </th>
                <th className="px-3 py-2.5 font-medium text-muted-foreground">
                  Закрыт
                </th>
                <th className="px-3 py-2.5 font-medium text-muted-foreground">
                  Причина
                </th>
                <th
                  className="px-3 py-2.5 font-medium text-muted-foreground"
                  title="CG futures / Binance spot coverage"
                >
                  Покрытие
                </th>
              </tr>
            </thead>
            <tbody>
              {signals.map((s) => (
                <SignalHistoryRow
                  key={s.id}
                  s={s}
                  expanded={expandedId === s.id}
                  onToggle={() =>
                    setExpandedId((cur) => (cur === s.id ? null : s.id))
                  }
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>
            Страница <span className="text-foreground">{page}</span> из{" "}
            <span className="text-foreground">{totalPages}</span>
          </span>
          <div className="flex gap-1">
            <button
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page <= 1}
              className="px-3 py-1 border border-border/50 rounded-sm hover:text-foreground disabled:opacity-30 disabled:hover:text-muted-foreground"
            >
              ← Назад
            </button>
            <button
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={page >= totalPages}
              className="px-3 py-1 border border-border/50 rounded-sm hover:text-foreground disabled:opacity-30 disabled:hover:text-muted-foreground"
            >
              Вперёд →
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
