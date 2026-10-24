import { useEffect, useState } from "react";
import { Link } from "wouter";
import { TokenChartLink } from "@/components/token-chart-link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectGroup,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { SignalBadge } from "@/components/signal-badge";
import { SentimentBadge } from "@/components/sentiment-badge";
import { CoverageBadge } from "@/components/coverage-badge";
import { useToast } from "@/hooks/use-toast";
import {
  RefreshCw,
  ExternalLink,
  ChevronLeft,
  ChevronRight,
  History,
  Wallet,
  Settings2,
  Archive,
  Save,
  TrendingUp,
} from "lucide-react";
import { SymbolHistorySheet } from "@/components/symbol-history-sheet";
import { ACTIVE_PATTERN_KEYS, getPatternTgLabel } from "@/lib/pattern-labels";
import { ScoreCell } from "@/components/score-cell";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { type SnfEntry, useSpotNetflow } from "@/hooks/use-spot-netflow";
import { useIsMobile } from "@/hooks/use-mobile";
import { formatActiveDuration, signalEndTime } from "@/lib/position-age";
import { StatusExplanation } from "@/components/status-explanation";
import {
  STATUS_ICONS,
  STATUS_LABELS,
  USER_STATUS_KEYS,
  getStatusIcon,
  getStatusLabel,
} from "@/lib/status-labels";

const API_BASE = import.meta.env.BASE_URL.replace(/\/$/, "");
const PAGE_SIZE = 50;

async function fetchTracked() {
  const res = await fetch(`${API_BASE}/api/tracker?status=open&limit=200`, {
    cache: "no-store",
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new Error(body?.error ?? `Ошибка загрузки позиций (${res.status})`);
  }
  return res.json();
}

async function fetchRecentClosed() {
  const res = await fetch(
    `${API_BASE}/api/tracker/signal-history?status=closed&sort=closedAt&limit=5&offset=0`,
    {
      cache: "no-store",
    },
  );
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new Error(
      body?.error ?? `Ошибка загрузки закрытых позиций (${res.status})`,
    );
  }
  return res.json();
}

async function fetchSignalHistory(
  status: string,
  page: number,
  pattern: string,
  symbol: string,
) {
  const offset = (page - 1) * PAGE_SIZE;
  const params = new URLSearchParams({
    limit: String(PAGE_SIZE),
    offset: String(offset),
  });
  if (status !== "all") params.set("status", status);
  if (pattern !== "all") params.set("pattern", pattern);
  if (symbol.trim()) params.set("symbol", symbol.trim());
  const res = await fetch(`${API_BASE}/api/tracker/signal-history?${params}`, {
    cache: "no-store",
  });
  return res.json();
}

async function fetchStats() {
  const res = await fetch(`${API_BASE}/api/tracker/stats`, {
    cache: "no-store",
  });
  return res.json();
}

type CalculatorSettings = {
  depositUsdt: number;
  leverage: number;
  allocationPercent: number;
  commissionPercent: number;
};

type CalculatorSummary = {
  month: string;
  label: string;
  marginPerTradeUsdt: number;
  notionalPerTradeUsdt: number;
  grossPnlUsdt: number;
  netPnlUsdt: number;
  netPnlPercent: number;
  closedTrades: number;
  profitTrades: number;
  lossTrades: number;
  breakevenTrades: number;
  cancelledSignals: number;
};

type CalculatorArchiveRow = Omit<
  CalculatorSummary,
  "marginPerTradeUsdt" | "notionalPerTradeUsdt"
> &
  CalculatorSettings;

type CalculatorData = {
  timeZone: string;
  settings: CalculatorSettings;
  current: CalculatorSummary;
  archive: CalculatorArchiveRow[];
};

function calculatorAuthHeaders(contentType = false): HeadersInit {
  const token = localStorage.getItem("authToken") ?? "";
  return {
    Authorization: `Bearer ${token}`,
    ...(contentType ? { "Content-Type": "application/json" } : {}),
  };
}

async function _fetchCalculator(): Promise<CalculatorData> {
  const res = await fetch(`${API_BASE}/api/tracker/calculator`, {
    cache: "no-store",
    headers: calculatorAuthHeaders(),
  });
  const data = (await res.json()) as CalculatorData & { error?: string };
  if (!res.ok) throw new Error(data.error ?? "Не удалось загрузить расчёт");
  return data;
}

async function saveCalculatorSettings(
  settings: CalculatorSettings,
): Promise<{ settings: CalculatorSettings }> {
  const res = await fetch(`${API_BASE}/api/tracker/calculator`, {
    method: "PUT",
    headers: calculatorAuthHeaders(true),
    body: JSON.stringify(settings),
  });
  const data = (await res.json()) as {
    settings?: CalculatorSettings;
    error?: string;
  };
  if (!res.ok || !data.settings) {
    throw new Error(data.error ?? "Не удалось сохранить настройки");
  }
  return { settings: data.settings };
}

function formatUsdt(value: number): string {
  const sign = value > 0 ? "+" : "";
  return `${sign}${new Intl.NumberFormat("ru-RU", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value)} USDT`;
}

async function fetchCancelledToday() {
  const res = await fetch(`${API_BASE}/api/tracker/cancelled-today`, {
    cache: "no-store",
  });
  return res.json();
}

function fmtPrice(p: number | null | undefined): string {
  if (p == null) return "—";
  if (p >= 100) return `$${p.toFixed(2)}`;
  if (p >= 1) return `$${p.toFixed(4)}`;
  if (p >= 0.01) return `$${p.toFixed(5)}`;
  return `$${p.toFixed(6)}`;
}

function protectedStopProfitPct(
  entryPrice: number | null | undefined,
  stopPrice: number | null | undefined,
  isShort: boolean,
): number | null {
  if (
    entryPrice == null ||
    stopPrice == null ||
    !Number.isFinite(entryPrice) ||
    !Number.isFinite(stopPrice) ||
    entryPrice <= 0
  ) {
    return null;
  }
  return (
    ((isShort ? entryPrice - stopPrice : stopPrice - entryPrice) / entryPrice) *
    100
  );
}

function pnlForMonetaryDisplay(
  status: string | null | undefined,
  pnl: number | null | undefined,
): number | null | undefined {
  return status === "bu_stop" || status === "breakeven" ? null : pnl;
}

function protectedExitPrice(signal: {
  status: string | null | undefined;
  entryPrice: number | null | undefined;
  exitPrice: number | null | undefined;
}): number | null | undefined {
  return signal.status === "bu_stop" ? signal.entryPrice : signal.exitPrice;
}

function BuStopOutcome({ takePct }: { takePct: number | null | undefined }) {
  return (
    <div
      className="mt-1 text-[9px] leading-snug text-emerald-300/80"
      title="BE STOP исключён из денежных PnL и средних; он учитывается только в счётчике и win rate."
    >
      {takePct != null
        ? `Тейк +${takePct}% · BE STOP исключён из PnL`
        : "BE STOP исключён из PnL"}
    </div>
  );
}

function ImpulseRunnerOutcome({ signal }: { signal: any }) {
  if (signal.policyVersion !== "impulse_runner_v1") return null;
  return (
    <div
      className="mt-1 text-[9px] leading-snug text-cyan-300/80"
      title="Canonical final PnL is the runner return from the immutable original entry; core and runner values are component telemetry."
    >
      🧊 runner policy ·{" "}
      {signal.runnerState === "open" ? "runner открыт" : "runner закрыт"}
      {signal.corePnlPercent != null
        ? ` · core ${Number(signal.corePnlPercent).toFixed(1)}%`
        : ""}
      {signal.runnerPnlPercent != null
        ? ` · runner ${Number(signal.runnerPnlPercent).toFixed(1)}%`
        : ""}
    </div>
  );
}

function impulseRunnerExitLabel(signal: any): string | null {
  if (signal.policyVersion !== "impulse_runner_v1") return null;
  if (signal.runnerState === "open") return "core closed · runner live";
  return signal.runnerExitPrice != null ? "runner final" : "—";
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
  sentimentKey: string | null | undefined;
  source: string | null | undefined;
  confirmingVenues?: string[] | null;
  entryPath?: string | null;
}) {
  if (sentimentKey !== "stealth_breakout") return null;
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
  const exchangeText =
    source === "auto_range_4h" && confirmingVenues?.length
      ? ` · Биржи: ${[
          ...new Set(
            confirmingVenues.map((venue) => venueLabels[venue]).filter(Boolean),
          ),
        ].join(", ")}`
      : "";
  return (
    <span
      className={`mt-1 inline-flex rounded border px-1 py-0.5 text-[9px] font-medium leading-none ${
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

function fmtDT(date: string | Date): string {
  return new Date(date).toLocaleString("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function formatNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return n.toFixed(0);
}

const STATUS_CFG: Record<
  string,
  {
    label: string;
    icon: string;
    textCls: string;
    rowCls: string;
    borderCls: string;
  }
> = {
  active: {
    label: STATUS_LABELS.active,
    icon: STATUS_ICONS.active,
    textCls: "text-zinc-300",
    rowCls: "",
    borderCls: "border-zinc-700/50",
  },
  in_run: {
    label: STATUS_LABELS.in_run,
    icon: STATUS_ICONS.in_run,
    textCls: "text-green-400",
    rowCls: "bg-green-950/10",
    borderCls: "border-l-2 border-l-green-500",
  },
  profit: {
    label: STATUS_LABELS.profit,
    icon: STATUS_ICONS.profit,
    textCls: "text-green-400",
    rowCls: "bg-green-950/10",
    borderCls: "border-zinc-700/50",
  },
  stop_loss: {
    label: STATUS_LABELS.stop_loss,
    icon: STATUS_ICONS.stop_loss,
    textCls: "text-red-400",
    rowCls: "bg-red-950/10",
    borderCls: "border-zinc-700/50",
  },
  bu_stop: {
    label: STATUS_LABELS.bu_stop,
    icon: STATUS_ICONS.bu_stop,
    textCls: "text-emerald-300",
    rowCls: "bg-emerald-950/10",
    borderCls: "border-zinc-700/50",
  },
  expired: {
    label: STATUS_LABELS.expired,
    icon: STATUS_ICONS.expired,
    textCls: "text-slate-300",
    rowCls: "bg-slate-950/20",
    borderCls: "border-slate-700/50",
  },
  cancelled: {
    label: STATUS_LABELS.cancelled,
    icon: STATUS_ICONS.cancelled,
    textCls: "text-zinc-500",
    rowCls: "bg-zinc-900/30 opacity-60",
    borderCls: "border-zinc-700/50",
  },
};

function StatusBadge({
  status,
  runnerState,
  coreClosedAt,
}: {
  status: string | null;
  runnerState?: string | null;
  coreClosedAt?: string | null;
}) {
  if (status === "in_run" && runnerState === "open" && coreClosedAt != null) {
    return (
      <Badge
        variant="outline"
        className="font-mono rounded-none text-[10px] font-bold border-cyan-700/60 text-cyan-300"
      >
        🧊 RUNNER COMPONENT
      </Badge>
    );
  }
  const cfg =
    (status ? STATUS_CFG[status] : null) ??
    (status
      ? {
          label: getStatusLabel(status),
          icon: "",
          textCls: "text-zinc-400",
          rowCls: "",
          borderCls: "border-zinc-700/50",
        }
      : STATUS_CFG.active);
  return (
    <Badge
      variant="outline"
      className={`font-mono rounded-none text-[10px] font-bold border-zinc-700/50 ${cfg.textCls}`}
    >
      {cfg.icon} {cfg.label}
    </Badge>
  );
}

function PnlCell({
  value,
  bold,
}: {
  value: number | null | undefined;
  bold?: boolean;
}) {
  if (value == null) return <span className="text-muted-foreground">—</span>;
  const cls = value >= 0 ? "text-green-400" : "text-red-400";
  return (
    <span
      className={`font-mono ${bold ? "font-bold text-sm" : "text-xs"} ${cls}`}
    >
      {value > 0 ? "+" : ""}
      {value.toFixed(2)}%
    </span>
  );
}

function OiCell({ value }: { value: number | null | undefined }) {
  if (value == null) return <span className="text-border text-[10px]">—</span>;
  const cls =
    value >= 5
      ? "text-green-400 font-semibold"
      : value > 0
        ? "text-green-400/70"
        : value < -3
          ? "text-red-400 font-semibold"
          : "text-red-400/60";
  return (
    <span className={`font-mono text-[10px] ${cls}`}>
      {value >= 0 ? "+" : ""}
      {value.toFixed(1)}%
    </span>
  );
}

function BtcContextCell({
  entryPrice,
  entryChange,
  closePrice,
  closeChange,
}: {
  entryPrice?: number | null;
  entryChange?: number | null;
  closePrice?: number | null;
  closeChange?: number | null;
}) {
  const line = (
    label: string,
    price: number | null | undefined,
    change: number | null | undefined,
  ) => (
    <div className="flex items-center justify-end gap-1 whitespace-nowrap">
      <span className="text-muted-foreground text-[9px]">{label}</span>
      {price != null ? (
        <span className="font-mono text-[10px] text-foreground/80">
          {Math.round(price).toLocaleString("en-US")}
        </span>
      ) : null}
      <OiCell value={change} />
    </div>
  );
  return (
    <div>
      {line("вх", entryPrice, entryChange)}
      {line("зак", closePrice, closeChange)}
    </div>
  );
}

function CvdDot({ value }: { value: boolean | null | undefined }) {
  if (value == null) return <span className="text-border text-[10px]">—</span>;
  return value ? (
    <span className="text-green-400 font-bold text-xs">✓</span>
  ) : (
    <span className="text-red-400/60 text-xs">✗</span>
  );
}

function LiqCell({ value }: { value: number | null | undefined }) {
  if (value == null) return <span className="text-border text-[10px]">—</span>;
  return (
    <span className="font-mono text-[10px] text-orange-300/80">
      ${formatNum(value)}
    </span>
  );
}

function LiqRCell({ value }: { value: number | null | undefined }) {
  if (value == null) return <span className="text-border text-[10px]">—</span>;
  const pct = value * 100;
  const cls =
    pct >= 25 ? "text-orange-300 font-semibold" : "text-muted-foreground";
  return (
    <span className={`font-mono text-[10px] ${cls}`}>{pct.toFixed(0)}%</span>
  );
}

function LiqShortCell({ value }: { value: number | null | undefined }) {
  if (value == null) return <span className="text-border text-[10px]">—</span>;
  return (
    <span className="font-mono text-[10px] text-blue-300/70">
      ${formatNum(value)}
    </span>
  );
}

function LiqTriggerCell({ value }: { value: string | null | undefined }) {
  if (!value) return <span className="text-border text-[10px]">—</span>;
  const label =
    value === "liq_order_stream"
      ? "stream"
      : value === "liq_spike"
        ? "spike"
        : value;
  const cls =
    value === "liq_order_stream" ? "text-purple-400" : "text-orange-400";
  return <span className={`font-mono text-[9px] ${cls}`}>{label}</span>;
}

function ObCell({ value }: { value: number | null | undefined }) {
  if (value == null) return <span className="text-muted-foreground/30">—</span>;
  const cls =
    value >= 2.0
      ? "text-green-400"
      : value >= 1.3
        ? "text-green-400/70"
        : value < 0.8
          ? "text-red-400"
          : "text-muted-foreground";
  return (
    <span className={`font-mono text-[10px] ${cls}`}>{value.toFixed(1)}x</span>
  );
}

// ── SNF helpers ────────────────────────────────────────────────────────────────
function toCgBase(s: string): string {
  const b = s.replace("-USDT", "");
  return /^1000[A-Z]/.test(b) ? b.slice(4).toUpperCase() : b.toUpperCase();
}

function snfCell(pct: number | null) {
  if (pct == null) return <span className="text-border/40 text-[10px]">—</span>;
  const cls =
    pct >= 15
      ? "text-emerald-400 font-semibold"
      : pct >= 5
        ? "text-emerald-400/80"
        : pct >= 0
          ? "text-emerald-400/50"
          : pct >= -5
            ? "text-red-400/50"
            : pct >= -15
              ? "text-red-400/80"
              : "text-red-400 font-semibold";
  return (
    <span className={`font-mono text-[11px] ${cls}`}>
      {pct >= 0 ? "+" : ""}
      {pct.toFixed(1)}%
    </span>
  );
}

// Open positions receive position-scoped current SNF from /tracker. Historical
// rows retain the entry snapshot because there is no "current" market context.
function snfCells(s: any, snfMap: Map<string, SnfEntry>) {
  const live = snfMap.get(toCgBase(s.symbol));
  const current = s.metricsSource != null;
  return (
    <>
      <td className="px-2 py-2 text-right">
        {snfCell(
          current
            ? (s.snf1h ?? null)
            : (s.entrySpotNetBuy1h ?? live?.netPct1h ?? null),
        )}
      </td>
      <td className="px-2 py-2 text-right">
        {snfCell(
          current
            ? (s.snf4h ?? null)
            : (s.entrySpotNetBuy4h ?? live?.netPct4h ?? null),
        )}
      </td>
      <td className="px-2 py-2 text-right">
        {snfCell(
          current
            ? (s.snf24h ?? null)
            : (s.entrySpotNetBuy24h ?? live?.netPct24h ?? null),
        )}
      </td>
    </>
  );
}

// Kept as a separate personal-simulation component for a future dedicated page.
// Tracker intentionally never renders or fetches it: only raw strategy PnL is shown.
function _TradeCalculator({
  data,
  isLoading,
  isError,
  onRetry,
  openSignals,
}: {
  data?: CalculatorData;
  isLoading: boolean;
  isError: boolean;
  onRetry: () => void;
  openSignals: any[];
}) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [draft, setDraft] = useState<CalculatorSettings | null>(null);
  const [showArchive, setShowArchive] = useState(false);

  useEffect(() => {
    if (data?.settings) setDraft(data.settings);
  }, [data?.settings]);

  const saveMutation = useMutation({
    mutationFn: saveCalculatorSettings,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["trade-calculator"] });
      toast({
        title: "Параметры сохранены",
        description: "Расчёт обновлён для текущего месяца.",
      });
    },
    onError: (error: Error) =>
      toast({
        title: "Не удалось сохранить",
        description: error.message,
        variant: "destructive",
      }),
  });

  const settings = draft ?? data?.settings;
  const marginPerTrade =
    settings != null
      ? settings.depositUsdt * (settings.allocationPercent / 100)
      : 0;
  const notionalPerTrade = marginPerTrade * (settings?.leverage ?? 0);
  const perTradeFee =
    notionalPerTrade * ((settings?.commissionPercent ?? 0) / 100);
  const openEstimate = openSignals.reduce(
    (total, signal) => {
      const pnlPercent = Number(signal.pnlPercent);
      if (!Number.isFinite(pnlPercent)) return total;
      const gross = notionalPerTrade * (pnlPercent / 100);
      return {
        count: total.count + 1,
        gross: total.gross + gross,
        net: total.net + gross - perTradeFee,
      };
    },
    { count: 0, gross: 0, net: 0 },
  );
  const closedFeeTotal =
    (data?.current.grossPnlUsdt ?? 0) - (data?.current.netPnlUsdt ?? 0);
  const archive = (data?.archive ?? []).filter(
    (row) => row.month !== data?.current.month,
  );
  const netClass =
    (data?.current.netPnlUsdt ?? 0) >= 0 ? "text-emerald-400" : "text-red-400";
  const openClass = openEstimate.net >= 0 ? "text-emerald-300" : "text-red-300";

  const updateDraft = (key: keyof CalculatorSettings, value: number): void => {
    // A number input is briefly empty while a user replaces its value.
    // Never put NaN into controlled state or React will emit an invalid-value warning.
    if (!Number.isFinite(value)) return;
    setDraft((previous) => ({
      ...(previous ??
        data?.settings ?? {
          depositUsdt: 1000,
          leverage: 10,
          allocationPercent: 10,
          commissionPercent: 0.1,
        }),
      [key]: value,
    }));
  };

  return (
    <Card className="border-primary/30 bg-gradient-to-br from-primary/10 via-card to-card">
      <CardHeader className="px-4 py-3 border-b border-primary/20">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2 text-sm font-mono tracking-wider">
              <Wallet className="h-4 w-4 text-primary" />
              МОДЕЛЬНЫЙ КАЛЬКУЛЯТОР СДЕЛОК
            </CardTitle>
            <p className="mt-1 text-[11px] text-muted-foreground">
              Не фактический баланс биржи: расчёт по сигналам, закрытым в{" "}
              {data?.current.label ?? "текущем месяце"}.
            </p>
          </div>
          <div className="rounded border border-primary/20 bg-background/50 px-2 py-1 font-mono text-[10px] text-muted-foreground">
            {data?.timeZone ?? "Asia/Dubai"} · фиксированный размер позиции
          </div>
        </div>
      </CardHeader>
      <CardContent className="p-4">
        {isLoading && !data ? (
          <div className="py-8 text-center text-sm text-muted-foreground">
            Загружаем персональный расчёт…
          </div>
        ) : isError || !data || !settings ? (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded border border-red-500/30 bg-red-950/10 p-3 text-sm">
            <span className="text-red-300">
              Не удалось загрузить калькулятор.
            </span>
            <Button
              variant="outline"
              size="sm"
              className="h-7"
              onClick={onRetry}
            >
              Повторить
            </Button>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <div className="rounded border border-border/60 bg-background/40 p-3">
                <div className="text-[10px] tracking-wider text-muted-foreground">
                  ЧИСТАЯ ПРИБЫЛЬ · ЗАКРЫТЫЕ
                </div>
                <div className={`mt-1 font-mono text-xl font-bold ${netClass}`}>
                  {formatUsdt(data.current.netPnlUsdt)}
                </div>
                <div className="mt-1 text-[11px] text-muted-foreground">
                  {data.current.netPnlPercent >= 0 ? "+" : ""}
                  {data.current.netPnlPercent.toFixed(2)}% от стартового
                  депозита
                </div>
              </div>
              <div className="rounded border border-border/60 bg-background/40 p-3">
                <div className="text-[10px] tracking-wider text-muted-foreground">
                  ОТКРЫТЫЙ PnL · НЕ ВКЛЮЧЁН
                </div>
                <div
                  className={`mt-1 font-mono text-xl font-bold ${openClass}`}
                >
                  {openEstimate.count > 0 ? formatUsdt(openEstimate.net) : "—"}
                </div>
                <div className="mt-1 text-[11px] text-muted-foreground">
                  оценка при закрытии · {openEstimate.count} поз.
                </div>
              </div>
              <div className="rounded border border-border/60 bg-background/40 p-3">
                <div className="text-[10px] tracking-wider text-muted-foreground">
                  ЗАКРЫТЫЕ СИГНАЛЫ
                </div>
                <div className="mt-1 font-mono text-xl font-bold">
                  {data.current.closedTrades}
                </div>
                <div className="mt-1 text-[11px] text-muted-foreground">
                  <div>
                    <span className="text-emerald-400">
                      {data.current.profitTrades} в плюс
                    </span>
                    {" · "}
                    <span className="text-red-400">
                      {data.current.lossTrades} в минус
                    </span>
                  </div>
                </div>
              </div>
              <div className="rounded border border-border/60 bg-background/40 p-3">
                <div className="text-[10px] tracking-wider text-muted-foreground">
                  РАЗМЕР ПОЗИЦИИ
                </div>
                <div className="mt-1 font-mono text-xl font-bold text-primary">
                  {formatUsdt(notionalPerTrade)}
                </div>
                <div className="mt-1 text-[11px] text-muted-foreground">
                  маржа {formatUsdt(marginPerTrade)} · плечо {settings.leverage}
                  x
                </div>
              </div>
            </div>

            <div className="rounded border border-primary/20 bg-primary/5 p-3 text-[11px] leading-relaxed">
              <div className="font-semibold text-foreground">
                Как считается результат
              </div>
              <div className="mt-1 text-muted-foreground">
                Для каждой закрытой сделки:{" "}
                <span className="font-mono text-foreground">
                  размер позиции × исходный PnL сигнала − комиссия
                </span>
                . Отменённые сигналы без входа, BREAKEVEN и BE STOP не участвуют
                в денежных итогах и средних. BREAKEVEN и BE STOP сохраняются
                только в счётчиках и win rate. Размер позиции фиксирован и не
                увеличивается после прибыльных сделок.
              </div>
              <div className="mt-1 text-muted-foreground">
                Сейчас:{" "}
                <span className="font-mono text-foreground">
                  {formatUsdt(notionalPerTrade)} позиции ={" "}
                  {formatUsdt(marginPerTrade)} маржи × {settings.leverage}x
                </span>
                .
              </div>
            </div>

            <div className="rounded border border-border/60 bg-background/30 p-3">
              <div className="mb-3 flex items-center gap-2 text-xs font-semibold text-foreground">
                <Settings2 className="h-3.5 w-3.5 text-primary" />
                Параметры модели
              </div>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <label className="space-y-1">
                  <span className="text-[10px] text-muted-foreground">
                    Стартовый депозит, USDT
                  </span>
                  <Input
                    type="number"
                    min={10}
                    step={10}
                    value={settings.depositUsdt}
                    onChange={(event) =>
                      updateDraft(
                        "depositUsdt",
                        event.currentTarget.valueAsNumber,
                      )
                    }
                    className="h-8 font-mono"
                  />
                </label>
                <label className="space-y-1">
                  <span className="text-[10px] text-muted-foreground">
                    Плечо
                  </span>
                  <Input
                    type="number"
                    min={1}
                    max={125}
                    step={1}
                    value={settings.leverage}
                    onChange={(event) =>
                      updateDraft("leverage", event.currentTarget.valueAsNumber)
                    }
                    className="h-8 font-mono"
                  />
                </label>
                <label className="space-y-1">
                  <span className="text-[10px] text-muted-foreground">
                    Доля депозита на сделку, %
                  </span>
                  <Input
                    type="number"
                    min={0.1}
                    max={100}
                    step={0.1}
                    value={settings.allocationPercent}
                    onChange={(event) =>
                      updateDraft(
                        "allocationPercent",
                        event.currentTarget.valueAsNumber,
                      )
                    }
                    className="h-8 font-mono"
                  />
                </label>
                <label className="space-y-1">
                  <span className="text-[10px] text-muted-foreground">
                    Комиссия вход + выход от объёма, %
                  </span>
                  <Input
                    type="number"
                    min={0}
                    max={5}
                    step={0.01}
                    value={settings.commissionPercent}
                    onChange={(event) =>
                      updateDraft(
                        "commissionPercent",
                        event.currentTarget.valueAsNumber,
                      )
                    }
                    className="h-8 font-mono"
                  />
                </label>
              </div>
              <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
                <p className="text-[10px] leading-relaxed text-muted-foreground">
                  Комиссия вычитается из каждой закрытой позиции. Funding,
                  проскальзывание и пропущенные входы не учитываются. Это
                  модельный результат, а не фактический баланс.
                </p>
                <Button
                  size="sm"
                  className="h-8"
                  disabled={saveMutation.isPending}
                  onClick={() => saveMutation.mutate(settings)}
                >
                  <Save className="mr-1 h-3.5 w-3.5" />
                  {saveMutation.isPending ? "Сохраняю…" : "Сохранить"}
                </Button>
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/50 pt-3 text-[11px]">
              <span className="text-muted-foreground">
                До комиссии:{" "}
                <span className="font-mono text-foreground">
                  {formatUsdt(data.current.grossPnlUsdt)}
                </span>
                {" · "}комиссии:{" "}
                <span className="font-mono text-red-300">
                  {formatUsdt(-closedFeeTotal)}
                </span>
              </span>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-xs text-muted-foreground"
                onClick={() => setShowArchive((visible) => !visible)}
              >
                <Archive className="mr-1 h-3.5 w-3.5" />
                {showArchive ? "Скрыть архив" : `Архив (${archive.length})`}
              </Button>
            </div>

            {showArchive && (
              <div className="space-y-2">
                {archive.length === 0 ? (
                  <div className="rounded border border-dashed border-border p-3 text-center text-xs text-muted-foreground">
                    Архив появится после завершения первого месяца.
                  </div>
                ) : (
                  archive.map((row) => (
                    <div
                      key={row.month}
                      className="grid grid-cols-[1fr_auto] items-center gap-3 rounded border border-border/60 bg-background/25 px-3 py-2 text-xs"
                    >
                      <div>
                        <div className="font-medium capitalize">
                          {row.label}
                        </div>
                        <div className="mt-0.5 text-[10px] text-muted-foreground">
                          {row.closedTrades} сделок · {row.leverage}x ·{" "}
                          {row.allocationPercent}% депозита
                        </div>
                      </div>
                      <div
                        className={`font-mono font-semibold ${
                          row.netPnlUsdt >= 0
                            ? "text-emerald-400"
                            : "text-red-400"
                        }`}
                      >
                        {formatUsdt(row.netPnlUsdt)}
                      </div>
                    </div>
                  ))
                )}
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ── Блок открытых позиций (= trackedSignalsTable) ─────────────────────────────
function OpenPositions({
  data,
  isLoading,
  isError,
  onRetry,
  signals: sigOverride,
  snfMap,
  onSelectSymbol,
}: {
  data: any;
  isLoading: boolean;
  isError: boolean;
  onRetry: () => void;
  signals?: any[];
  snfMap: Map<string, SnfEntry>;
  onSelectSymbol?: (sym: string) => void;
}) {
  const isMobile = useIsMobile();
  const open =
    sigOverride ??
    (data?.signals ?? []).filter((s: any) =>
      ["active", "in_run"].includes(s.status),
    );

  if (isLoading)
    return (
      <div className="flex items-center justify-center h-16 text-muted-foreground text-sm">
        Загрузка...
      </div>
    );

  if (isError)
    return (
      <div className="flex items-center gap-4 px-4 py-4 text-sm">
        <span className="text-red-400">⚠️ Не удалось загрузить позиции</span>
        <Button
          variant="outline"
          size="sm"
          className="h-7 border-border text-muted-foreground"
          onClick={onRetry}
        >
          <RefreshCw className="w-3 h-3 mr-1" /> Retry
        </Button>
      </div>
    );

  if (open.length === 0)
    return (
      <div className="flex items-center gap-3 px-4 py-3 text-muted-foreground text-sm border-b border-border/50">
        <span>Нет открытых позиций.</span>
        <span className="text-xs text-muted-foreground/60">
          Сканер следит за рынком и откроет позицию при сигнале.
        </span>
      </div>
    );

  // ── Mobile card view ──────────────────────────────────────────────────────
  if (isMobile) {
    return (
      <div className="space-y-3 p-4">
        {open.map((s: any) => {
          const cfg = STATUS_CFG[s.status] ?? STATUS_CFG.active;
          const isBitcoin =
            (s.symbol === "BTC-USDT" || s.symbol === "BTCUSDT") && !s.isShort;
          const protectedStopMode = s.protectedStopMode as
            | "be"
            | "trailing"
            | null;
          const trailStop = s.trailingStopLevel as number | null;
          const protectionRowCls =
            protectedStopMode === "be"
              ? "bg-sky-950/15 border-l-2 border-l-sky-400"
              : `${cfg.rowCls} ${cfg.borderCls}`;
          const entryPrice = s.entryPrice as number | null;
          const peakPrice = s.peakPrice as number | null;
          const pnlPercent = s.pnlPercent as number | null;
          const peakPct =
            peakPrice && entryPrice && entryPrice > 0
              ? ((peakPrice - entryPrice) / entryPrice) * 100
              : null;
          const stopProfitPct = protectedStopProfitPct(
            entryPrice,
            trailStop,
            false,
          );
          return (
            <div
              key={s.id}
              className={`rounded-sm border border-border/60 p-4 ${protectionRowCls}`}
            >
              <div className="flex items-start justify-between mb-3">
                <div>
                  <div className="flex items-center gap-2">
                    <TokenChartLink
                      symbol={s.symbol}
                      className="font-bold font-mono text-base text-foreground"
                    />
                    {s.isShort && (
                      <span className="text-xs text-red-400 font-semibold">
                        SHORT
                      </span>
                    )}
                    <button
                      onClick={() => onSelectSymbol?.(s.symbol)}
                      className="text-muted-foreground/40 hover:text-muted-foreground transition-colors"
                      title="История статуса"
                    >
                      <History className="w-3.5 h-3.5" />
                    </button>
                  </div>
                  <div className="mt-1">
                    <SentimentBadge
                      sentimentKey={s.sentimentKey ?? "unknown"}
                    />
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
                </div>
                <StatusBadge
                  status={s.status}
                  runnerState={s.runnerState}
                  coreClosedAt={s.coreClosedAt}
                />
              </div>
              {s.status === "in_run" &&
                s.runnerState === "open" &&
                s.coreClosedAt != null && <ImpulseRunnerOutcome signal={s} />}
              <div className="grid grid-cols-4 gap-3 mt-2">
                <div>
                  <div className="text-[10px] text-muted-foreground mb-0.5">
                    PnL
                  </div>
                  <PnlCell value={pnlPercent} bold />
                </div>
                <div>
                  <div className="text-[10px] text-muted-foreground mb-0.5">
                    24ч
                  </div>
                  <PnlCell value={s.price24h} />
                </div>
                <div>
                  <div className="text-[10px] text-muted-foreground mb-0.5">
                    Пик
                  </div>
                  <PnlCell value={peakPct} />
                </div>
                <div className="text-right">
                  <div className="text-[10px] text-muted-foreground mb-0.5">
                    Вход
                  </div>
                  <div className="text-[11px] font-mono text-muted-foreground">
                    {fmtDT(s.detectedAt)}
                  </div>
                </div>
              </div>
              {isBitcoin && (
                <div className="mt-3 border-t border-border/50 pt-2 text-[11px] text-muted-foreground">
                  <div>₿ Б/У после +1% · трейлинг с +2% · пик минус 1 п.п.</div>
                  {trailStop != null && protectedStopMode != null && (
                    <div className="mt-1 font-mono text-cyan-300">
                      🛡 {protectedStopMode === "trailing" ? "Трейлинг" : "Б/У"}
                      : {fmtPrice(trailStop)}
                      {stopProfitPct != null &&
                        ` (${stopProfitPct >= 0 ? "+" : ""}${stopProfitPct.toFixed(1)}% от входа)`}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    );
  }

  // ── Desktop table view ─────────────────────────────────────────────────────
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-muted-foreground text-left text-[11px] border-b border-border">
            <th className="px-3 py-2 font-medium text-muted-foreground/40">
              #
            </th>
            <th className="px-3 py-2 font-medium">СИМВОЛ</th>
            <th className="px-3 py-2 font-medium">ПАТТЕРН</th>
            <th
              className="px-2 py-2 font-medium text-right"
              title="Количество скан-циклов токена на момент входа"
            >
              ЦИКЛЫ
            </th>
            <th
              className="px-2 py-2 font-medium text-right"
              title="Bullet Score при детекте"
            >
              СКОР
            </th>
            <th className="px-3 py-2 font-medium text-right">ВХОД</th>
            <th className="px-3 py-2 font-medium text-right">ЦЕНА</th>
            <th className="px-3 py-2 font-medium text-right">P&L</th>
            <th className="px-3 py-2 font-medium text-right">ПИК</th>
            <th className="px-3 py-2 font-medium text-center">СТАТУС</th>
            <th
              className="px-2 py-2 font-medium text-right"
              title="OI Δ15m % (CoinGlass aggregated) в момент входа"
            >
              OI 15m
            </th>
            <th className="px-2 py-2 font-medium text-right" title="OI Δ30m">
              OI 30m
            </th>
            <th className="px-2 py-2 font-medium text-right" title="OI Δ1h">
              OI 1h
            </th>
            <th className="px-2 py-2 font-medium text-right" title="OI Δ4h">
              OI 4h
            </th>
            <th className="px-2 py-2 font-medium text-right" title="OI Δ24h">
              OI 24h
            </th>
            <th
              className="px-2 py-2 font-medium text-center"
              title="Spot CVD 15m (последняя 1×15m свеча)"
            >
              CVD 15m
            </th>
            <th
              className="px-2 py-2 font-medium text-center"
              title="Spot CVD 30m"
            >
              CVD 30m
            </th>
            <th
              className="px-2 py-2 font-medium text-center"
              title="Spot CVD 1h"
            >
              CVD 1h
            </th>
            <th
              className="px-2 py-2 font-medium text-center"
              title="Spot CVD 4h"
            >
              CVD 4h
            </th>
            <th
              className="px-2 py-2 font-medium text-right"
              title="Futures Taker Net Buy % (CoinGlass) — положительный = покупатели доминируют"
            >
              Фьюч тейкер
            </th>
            <th
              className="px-2 py-2 font-medium text-right"
              title="Spot Taker Net Buy % (Binance/BingX спот) — положительный = спот покупатели доминируют"
            >
              Спот тейкер
            </th>
            <th
              className="px-2 py-2 font-medium text-right"
              title="Изменение цены за последний 1h"
            >
              1h%
            </th>
            <th
              className="px-2 py-2 font-medium text-right"
              title="Изменение цены за последние 24 часа"
            >
              24h%
            </th>
            <th
              className="px-2 py-2 font-medium text-right"
              title="Funding rate % (BingX, 8h ставка) при входе — raw × 100"
            >
              Fund%
            </th>
            <th
              className="px-2 py-2 font-medium text-right"
              title="Текущий CoinGlass Whale Index (Binance 4h). Серый индикатор у символа означает fallback из последнего prescan-снимка."
            >
              WI
            </th>
            <th
              className="px-2 py-2 font-medium text-right"
              title="Текущий BingX orderbook bid/ask ratio (>1 = биды давят, <1 = аски давят)"
            >
              OB
            </th>
            <th
              className="px-2 py-2 font-medium text-right"
              title="Long liquidations 1h (live CoinGlass, все паттерны) — принудительные закрытия лонгов"
            >
              L.Liq 1h
            </th>
            <th
              className="px-2 py-2 font-medium text-right"
              title="Short liquidations 1h (live CoinGlass) — принудительные закрытия шортов / шорт-сквиз"
            >
              S.Liq 1h
            </th>
            <th
              className="px-2 py-2 font-medium text-right"
              title="Long liquidations за 24h"
            >
              Liq 24h
            </th>
            <th
              className="px-2 py-2 font-medium text-right"
              title="Ratio: liq1h / liq24h (liq_cascade: при детекции)"
            >
              LiqR
            </th>
            <th
              className="px-2 py-2 font-medium text-center"
              title="Причина входа в пул: liq_spike или liq_order_stream (только liq_cascade)"
            >
              Триггер
            </th>
            <th
              className="px-2 py-2 font-medium text-right"
              title="Spot Net Flow 1h % (CoinGlass)"
            >
              SNF 1h
            </th>
            <th
              className="px-2 py-2 font-medium text-right"
              title="Spot Net Flow 4h % (CoinGlass)"
            >
              SNF 4h
            </th>
            <th
              className="px-2 py-2 font-medium text-right"
              title="Spot Net Flow 24h % (CoinGlass)"
            >
              SNF 24h
            </th>
            <th className="px-3 py-2 font-medium text-right">ДАТА</th>
            <th className="px-3 py-2 font-medium"></th>
          </tr>
        </thead>
        <tbody>
          {open.map((s: any) => {
            const cfg = STATUS_CFG[s.status] ?? STATUS_CFG.active;
            const entryPrice = s.entryPrice as number | null;
            const peakPrice = s.peakPrice as number | null;
            const protectedStopMode = s.protectedStopMode as
              | "be"
              | "trailing"
              | null;
            const pnlPercent = s.pnlPercent as number | null;
            const currentPrice = s.currentPrice as number | null;
            const peakPct =
              peakPrice && entryPrice && entryPrice > 0
                ? ((peakPrice - entryPrice) / entryPrice) * 100
                : null;
            const protectionRowCls =
              protectedStopMode === "be"
                ? "bg-sky-950/15 border-l-2 border-l-sky-400"
                : `${cfg.rowCls} ${cfg.borderCls}`;

            return (
              <tr
                key={s.id}
                className={`border-b border-border/50 hover:bg-muted/20 transition-colors ${protectionRowCls}`}
              >
                <td className="px-3 py-3 font-mono text-[10px] text-muted-foreground/40">
                  #{s.id}
                </td>
                <td className="px-3 py-3">
                  <div className="font-bold font-mono text-foreground flex items-center gap-1.5">
                    <TokenChartLink
                      symbol={s.symbol}
                      className="font-bold font-mono text-foreground"
                    />
                    {s.isShort && (
                      <span className="ml-1 text-[10px] text-red-400">
                        SHORT
                      </span>
                    )}
                    {s.metricsSource != null && (
                      <span
                        className={
                          s.metricsSource === "live"
                            ? "text-emerald-400"
                            : s.metricsSource === "fallback"
                              ? "text-amber-400"
                              : "text-muted-foreground/40"
                        }
                        title={
                          s.metricsSource === "live"
                            ? `Текущие метрики: ${s.metricsUpdatedAt ? fmtDT(s.metricsUpdatedAt) : "обновляются"}`
                            : s.metricsSource === "fallback"
                              ? "Текущий источник недоступен — показан последний prescan-снимок"
                              : "Текущие метрики пока недоступны"
                        }
                      >
                        ●
                      </span>
                    )}
                    <button
                      onClick={() => onSelectSymbol?.(s.symbol)}
                      className="ml-0.5 text-muted-foreground/40 hover:text-muted-foreground transition-colors"
                      title="История статуса"
                    >
                      <History className="w-3 h-3" />
                    </button>
                  </div>
                  <div className="text-[10px] text-muted-foreground/60">
                    {s.signalType === "super_alpha"
                      ? "⚡⚡ SUPER BULLET"
                      : s.signalType === "alpha"
                        ? "⚡ BULLET"
                        : (s.signalType ?? "")}
                  </div>
                  <CoverageBadge
                    isBingxExclusive={s.isBingxExclusive}
                    isBinanceSpotListed={s.isBinanceSpotListed}
                  />
                </td>
                <td className="px-3 py-3">
                  <SentimentBadge sentimentKey={s.sentimentKey ?? "unknown"} />
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
                </td>
                <td className="px-2 py-3 text-right font-mono text-[11px] text-muted-foreground">
                  {s.prescanCycles ?? "—"}
                </td>
                <td className="px-2 py-2 text-right font-mono text-[10px]">
                  <ScoreCell s={s} />
                </td>
                <td className="px-3 py-3 text-right font-mono text-xs text-foreground font-semibold">
                  {fmtPrice(entryPrice)}
                </td>
                <td className="px-3 py-3 text-right font-mono text-xs text-muted-foreground">
                  {currentPrice != null ? fmtPrice(currentPrice) : "—"}
                </td>
                <td className="px-3 py-3 text-right">
                  <PnlCell value={pnlPercent} bold />
                </td>
                <td className="px-3 py-3 text-right">
                  {peakPct != null && peakPct > 0 ? (
                    <span className="font-mono text-xs text-green-400/80">
                      +{peakPct.toFixed(1)}%
                    </span>
                  ) : (
                    <span className="text-muted-foreground text-xs">—</span>
                  )}
                </td>
                <td className="px-3 py-3 text-center">
                  <StatusBadge
                    status={s.status}
                    runnerState={s.runnerState}
                    coreClosedAt={s.coreClosedAt}
                  />
                  {s.status === "in_run" &&
                    s.runnerState === "open" &&
                    s.coreClosedAt != null && (
                      <ImpulseRunnerOutcome signal={s} />
                    )}
                </td>
                <td className="px-2 py-3 text-right">
                  <OiCell value={s.entryOi15m} />
                </td>
                <td className="px-2 py-3 text-right">
                  <OiCell value={s.oi30m} />
                </td>
                <td className="px-2 py-3 text-right">
                  <OiCell value={s.oi1h} />
                </td>
                <td className="px-2 py-3 text-right">
                  <OiCell value={s.oi4h} />
                </td>
                <td className="px-2 py-3 text-right">
                  <OiCell value={s.oi24h} />
                </td>
                <td className="px-2 py-3 text-center">
                  <CvdDot value={s.cvd15m} />
                </td>
                <td className="px-2 py-3 text-center">
                  <CvdDot value={s.cvd30m} />
                </td>
                <td className="px-2 py-3 text-center">
                  <CvdDot value={s.cvd1h} />
                </td>
                <td className="px-2 py-3 text-center">
                  <CvdDot value={s.cvd4h} />
                </td>
                <td className="px-2 py-3 text-right">
                  <OiCell value={s.netBuyPct} />
                </td>
                <td className="px-2 py-3 text-right">
                  <OiCell value={s.spotTakerNetBuy} />
                </td>
                <td className="px-2 py-3 text-right">
                  <OiCell value={s.price1h} />
                </td>
                <td className="px-2 py-3 text-right">
                  <PnlCell value={s.price24h} />
                </td>
                <td className="px-2 py-3 text-right font-mono text-[10px]">
                  {s.entryFundingRate != null ? (
                    <span
                      className={
                        (s.entryFundingRate as number) * 100 > 0.05
                          ? "text-orange-300"
                          : (s.entryFundingRate as number) * 100 < -0.01
                            ? "text-blue-300"
                            : "text-muted-foreground"
                      }
                    >
                      {((s.entryFundingRate as number) * 100).toFixed(4)}
                    </span>
                  ) : (
                    <span className="text-border">—</span>
                  )}
                </td>
                <td className="px-2 py-3 text-right font-mono text-[10px]">
                  {s.whaleIndex != null ? (
                    <span
                      className={
                        (s.whaleIndex as number) >= 10
                          ? "text-green-400"
                          : (s.whaleIndex as number) <= -10
                            ? "text-red-400"
                            : "text-muted-foreground"
                      }
                    >
                      {(s.whaleIndex as number) > 0 ? "+" : ""}
                      {(s.whaleIndex as number).toFixed(0)}
                    </span>
                  ) : (
                    <span className="text-border">—</span>
                  )}
                </td>
                <td className="px-2 py-3 text-right">
                  <ObCell value={s.obRatio} />
                </td>
                <td className="px-2 py-3 text-right">
                  <LiqCell value={s.liveLiqLong1h} />
                </td>
                <td className="px-2 py-3 text-right">
                  <LiqShortCell value={s.liveLiqShort1h} />
                </td>
                <td className="px-2 py-3 text-right">
                  <LiqCell value={s.liveLiqLong24h} />
                </td>
                <td className="px-2 py-3 text-right">
                  <LiqRCell value={s.entryLiqRatio} />
                </td>
                <td className="px-2 py-3 text-center">
                  <LiqTriggerCell value={s.entryLiqReason} />
                </td>
                {snfCells(s, snfMap)}
                <td className="px-3 py-3 text-right font-mono text-[11px] text-muted-foreground whitespace-nowrap">
                  {fmtDT(s.detectedAt)}
                  <div className="text-[10px] text-muted-foreground/50">
                    активен{" "}
                    {formatActiveDuration(s.detectedAt, signalEndTime(s))}
                  </div>
                </td>
                <td className="px-3 py-3 text-center">
                  <Link
                    href={`/charts/${encodeURIComponent(s.symbol)}`}
                    title={`Наш график ${s.symbol}`}
                    className="text-zinc-600 hover:text-primary"
                  >
                    <ExternalLink className="w-3 h-3" />
                  </Link>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── Лог всех сигналов (= trackedSignalsTable, все entry metrics) ───────────────
function SignalLog({
  statusFilter,
  page,
  setPage,
  setStatusFilter,
  patternFilter,
  setPatternFilter,
  snfMap,
  onSelectSymbol,
}: {
  statusFilter: string;
  page: number;
  setPage: (n: number) => void;
  setStatusFilter: (s: string) => void;
  patternFilter: string;
  setPatternFilter: (p: string) => void;
  snfMap: Map<string, SnfEntry>;
  onSelectSymbol?: (sym: string) => void;
}) {
  const [symbolInput, setSymbolInput] = useState("");
  const [symbolSearch, setSymbolSearch] = useState("");

  // Дебаунс 350ms — не спамим запросами при быстрой печати
  useEffect(() => {
    const t = setTimeout(() => {
      const v = symbolInput.trim().toUpperCase().replace("-USDT", "");
      setSymbolSearch(v);
      setPage(1);
    }, 350);
    return () => clearTimeout(t);
  }, [symbolInput, setPage]);

  const { data, isLoading } = useQuery({
    queryKey: ["signals-log", statusFilter, page, patternFilter, symbolSearch],
    queryFn: () =>
      fetchSignalHistory(
        statusFilter,
        page,
        patternFilter,
        symbolSearch ? symbolSearch + "-USDT" : "",
      ),
    refetchInterval: 20_000,
  });

  const signals = data?.signals ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <Card id="signal-history" className="border-border bg-card">
      <CardHeader className="py-3 px-4 border-b border-border">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <CardTitle className="text-sm font-mono tracking-wider text-muted-foreground">
              ИСТОРИЯ СИГНАЛОВ
            </CardTitle>
            <p
              data-testid="text-tracker-signal-history-metrics-note"
              className="mt-1 max-w-[720px] text-[10px] leading-relaxed text-muted-foreground/70"
            >
              Метрики входа (Score, BTC 24h, P24h, OI, CVD, объёмы, Fund, WI,
              OB, ликвидации и SNF) зафиксированы на момент открытия сигнала.
              P&amp;L, ПИК% и статус — текущее состояние для активных и итоговое
              состояние на момент закрытия для завершённых сигналов.
            </p>
            <StatusExplanation
              title="Что означает статус в этом списке"
              className="mt-3"
            />
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            {/* Поиск по тикеру */}
            <div className="relative">
              <span className="absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground/50 text-[11px] pointer-events-none select-none">
                🔍
              </span>
              <Input
                value={symbolInput}
                onChange={(e) => setSymbolInput(e.target.value)}
                placeholder="BTC, ETH…"
                className="w-[110px] h-8 pl-6 pr-2 bg-card border-border text-xs font-mono placeholder:text-muted-foreground/40"
              />
            </div>
            <Select
              value={patternFilter}
              onValueChange={(v) => {
                setPatternFilter(v);
                setPage(1);
              }}
            >
              <SelectTrigger className="w-full sm:w-[240px] h-8 bg-card border-border text-xs">
                <SelectValue placeholder="Все паттерны" />
              </SelectTrigger>
              <SelectContent className="max-h-[400px]">
                <SelectItem value="all">— Все паттерны —</SelectItem>
                <SelectGroup>
                  <SelectLabel className="text-[10px] uppercase text-muted-foreground tracking-widest">
                    Активные
                  </SelectLabel>
                  {ACTIVE_PATTERN_KEYS.map((key) => (
                    <SelectItem key={key} value={key} className="text-xs">
                      {getPatternTgLabel(key)}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
            <Select
              value={statusFilter}
              onValueChange={(v) => {
                setStatusFilter(v);
                setPage(1);
              }}
            >
              <SelectTrigger className="w-full sm:w-[220px] h-8 bg-card border-border text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">ВСЕ СИГНАЛЫ</SelectItem>
                {USER_STATUS_KEYS.filter((status) => status !== "bu_stop").map(
                  (status) => (
                    <SelectItem key={status} value={status}>
                      {getStatusIcon(status)} {getStatusLabel(status)}
                    </SelectItem>
                  ),
                )}
                <SelectItem value="bu_stop">
                  <span className="flex flex-col">
                    <span>
                      {getStatusIcon("bu_stop")} {getStatusLabel("bu_stop")} ·
                      все
                    </span>
                    <span className="text-[10px] text-muted-foreground font-normal leading-tight">
                      Все защищённые выходы
                    </span>
                  </span>
                </SelectItem>
                <SelectItem value="win_rate">WIN RATE</SelectItem>
                {[
                  {
                    value: "bu_stop_5",
                    label: "BE +5%",
                    detail: "Пик +5…<8%",
                  },
                  {
                    value: "bu_stop_8",
                    label: "BE +8%",
                    detail: "Пик +8…<10%",
                  },
                  {
                    value: "bu_stop_10",
                    label: "BE +10%+",
                    detail: "Пик от +10%",
                  },
                ].map(({ value, label, detail }) => (
                  <SelectItem key={value} value={value}>
                    <span className="flex flex-col">
                      <span>
                        {getStatusIcon("bu_stop")} {label}
                      </span>
                      <span className="text-[10px] text-muted-foreground font-normal leading-tight">
                        {detail}
                      </span>
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        {isLoading ? (
          <div className="flex items-center justify-center h-32 text-muted-foreground text-sm">
            Загрузка...
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs whitespace-nowrap">
              <thead className="sticky top-0 bg-card border-b border-border z-10">
                <tr className="text-muted-foreground text-left text-[10px]">
                  <th className="px-2 py-2 font-medium text-muted-foreground/40">
                    #
                  </th>
                  <th className="px-2 py-2 font-medium">ВРЕМЯ</th>
                  <th className="px-2 py-2 font-medium">СИМВОЛ</th>
                  <th className="px-2 py-2 font-medium">GRADE</th>
                  <th className="px-2 py-2 font-medium">ПАТТЕРН</th>
                  <th className="px-2 py-2 font-medium text-center">СТАТУС</th>
                  <th
                    className="px-2 py-2 font-medium text-right"
                    title="Количество скан-циклов токена на момент входа"
                  >
                    ЦИКЛЫ
                  </th>
                  <th
                    className="px-2 py-2 font-medium text-right"
                    title="Bullet Score при детекте"
                  >
                    СКОР
                  </th>
                  <th className="px-2 py-2 font-medium text-right">P&amp;L</th>
                  <th
                    className="px-2 py-2 font-medium text-right"
                    title="Лучший % от входа (peakPrice)"
                  >
                    ПИК%
                  </th>
                  <th className="px-2 py-2 font-medium text-right">ВХОД</th>
                  <th
                    className="px-2 py-2 font-medium text-right"
                    title="BTC: цена и 24h% на входе / при закрытии"
                  >
                    BTC 24h
                  </th>
                  <th
                    className="px-2 py-2 font-medium text-right"
                    title="price24h% токена в момент детекта"
                  >
                    P24h
                  </th>
                  <th
                    className="px-2 py-2 font-medium text-right"
                    title="OI Δ15m % (CoinGlass aggregated) в момент входа"
                  >
                    OI 15m
                  </th>
                  <th
                    className="px-2 py-2 font-medium text-right"
                    title="OI Δ30m % (CoinGlass) в момент входа"
                  >
                    OI 30m
                  </th>
                  <th
                    className="px-2 py-2 font-medium text-right"
                    title="OI Δ1h % (CoinGlass) в момент входа"
                  >
                    OI 1h
                  </th>
                  <th
                    className="px-2 py-2 font-medium text-right"
                    title="OI Δ4h % (CoinGlass) в момент входа"
                  >
                    OI 4h
                  </th>
                  <th
                    className="px-2 py-2 font-medium text-right"
                    title="OI Δ24h % (CoinGlass) в момент входа"
                  >
                    OI 24h
                  </th>
                  <th
                    className="px-2 py-2 font-medium text-center"
                    title="Spot CVD 15m (последняя 1×15m свеча)"
                  >
                    CVD15
                  </th>
                  <th
                    className="px-2 py-2 font-medium text-center"
                    title="Spot CVD 30m бычий?"
                  >
                    CVD30
                  </th>
                  <th
                    className="px-2 py-2 font-medium text-center"
                    title="Spot CVD 1h бычий?"
                  >
                    CVD1h
                  </th>
                  <th
                    className="px-2 py-2 font-medium text-center"
                    title="Spot CVD 4h бычий?"
                  >
                    CVD4h
                  </th>
                  <th
                    className="px-2 py-2 font-medium text-right"
                    title="Спот Vol mult (lastSpotVol1h/avg) при детекте"
                  >
                    Спот×
                  </th>
                  <th
                    className="px-2 py-2 font-medium text-right"
                    title="Фьюч Vol mult (BingX 30m) при детекте"
                  >
                    Фьюч×
                  </th>
                  <th
                    className="px-2 py-2 font-medium text-right"
                    title="Futures Taker Net Buy % (CoinGlass) при входе — положительный = покупатели доминируют"
                  >
                    Фьюч тейкер
                  </th>
                  <th
                    className="px-2 py-2 font-medium text-right"
                    title="Spot taker net buy % (CoinGlass, ~30m) — >0 давят покупки"
                  >
                    Тейкер
                  </th>
                  <th
                    className="px-2 py-2 font-medium text-right"
                    title="Spot net buy 1h % (CoinGlass)"
                  >
                    NB 1h
                  </th>
                  <th
                    className="px-2 py-2 font-medium text-right"
                    title="Изменение цены за последний 1h в момент входа"
                  >
                    1h%
                  </th>
                  <th
                    className="px-2 py-2 font-medium text-right"
                    title="Funding rate % (BingX) при входе"
                  >
                    Fund%
                  </th>
                  <th
                    className="px-2 py-2 font-medium text-right"
                    title="CoinGlass Whale Index (Binance 4h) при входе"
                  >
                    WI
                  </th>
                  <th
                    className="px-2 py-2 font-medium text-right"
                    title="BingX orderbook bid/ask ratio при входе (>1 = биды давят, <1 = аски давят)"
                  >
                    OB
                  </th>
                  <th
                    className="px-2 py-2 font-medium text-right"
                    title="Стоп-лосс % от входа"
                  >
                    Стоп%
                  </th>
                  <th
                    className="px-2 py-2 font-medium text-left"
                    title="Источник записи (OI Watch trigger / entrySource)"
                  >
                    Источник
                  </th>
                  <th
                    className="px-2 py-2 font-medium text-right"
                    title="Long-ликвидации за 1h в момент детекта (только liq_cascade)"
                  >
                    Liq L 1h
                  </th>
                  <th
                    className="px-2 py-2 font-medium text-right"
                    title="Short-ликвидации за 1h в момент детекта (только liq_cascade)"
                  >
                    Liq S 1h
                  </th>
                  <th
                    className="px-2 py-2 font-medium text-right"
                    title="Long-ликвидации за 24h в момент детекта (только liq_cascade)"
                  >
                    Liq 24h
                  </th>
                  <th
                    className="px-2 py-2 font-medium text-right"
                    title="Liq1h / Liq24h — концентрация ликвидаций в последний час"
                  >
                    LiqR
                  </th>
                  <th
                    className="px-2 py-2 font-medium text-left"
                    title="Тип триггера: liq_spike или liq_order_stream"
                  >
                    Триггер
                  </th>
                  <th
                    className="px-2 py-2 font-medium text-right"
                    title="Spot Net Flow 1h % (CoinGlass)"
                  >
                    SNF 1h
                  </th>
                  <th
                    className="px-2 py-2 font-medium text-right"
                    title="Spot Net Flow 4h % (CoinGlass)"
                  >
                    SNF 4h
                  </th>
                  <th
                    className="px-2 py-2 font-medium text-right"
                    title="Spot Net Flow 24h % (CoinGlass)"
                  >
                    SNF 24h
                  </th>
                </tr>
              </thead>
              <tbody>
                {signals.length === 0 ? (
                  <tr>
                    <td
                      colSpan={34}
                      className="px-4 py-10 text-center text-muted-foreground"
                    >
                      Нет сигналов
                    </td>
                  </tr>
                ) : (
                  signals.map((s: any) => {
                    const cfg =
                      STATUS_CFG[s.status as string] ?? STATUS_CFG.active;

                    return (
                      <tr
                        key={s.id}
                        className={`border-b border-border/40 hover:bg-muted/20 transition-colors ${cfg.rowCls} ${cfg.borderCls}`}
                      >
                        <td className="px-2 py-2 font-mono text-[10px] text-muted-foreground/40">
                          <Link
                            href={`/charts/${encodeURIComponent(s.symbol)}`}
                            className="hover:text-primary"
                          >
                            #{s.id}
                          </Link>
                        </td>
                        <td className="px-2 py-2 font-mono text-[10px] text-muted-foreground">
                          {fmtDT(s.detectedAt)}
                          <div className="text-[9px] text-muted-foreground/50">
                            активен{" "}
                            {formatActiveDuration(
                              s.detectedAt,
                              signalEndTime(s),
                            )}
                          </div>
                        </td>
                        <td className="px-2 py-2 font-bold font-mono text-foreground">
                          <div className="flex items-center gap-1">
                            <TokenChartLink
                              symbol={s.symbol}
                              className="font-bold font-mono text-foreground"
                            />
                            {s.isShort && (
                              <span className="ml-1 text-[9px] text-red-400">
                                SHORT
                              </span>
                            )}
                            <button
                              onClick={() => onSelectSymbol?.(s.symbol)}
                              className="text-muted-foreground/40 hover:text-muted-foreground transition-colors"
                              title="История статуса"
                            >
                              <History className="w-3 h-3" />
                            </button>
                          </div>
                          <CoverageBadge
                            isBingxExclusive={s.isBingxExclusive}
                            isBinanceSpotListed={s.isBinanceSpotListed}
                          />
                        </td>
                        <td className="px-2 py-2">
                          <SignalBadge type={s.signalType} />
                        </td>
                        <td className="px-2 py-2">
                          <div className="flex flex-col items-start gap-1">
                            <SentimentBadge
                              sentimentKey={s.sentimentKey ?? "unknown"}
                            />
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
                        <td className="px-2 py-2 text-center">
                          <StatusBadge
                            status={s.status}
                            runnerState={s.runnerState}
                            coreClosedAt={s.coreClosedAt}
                          />
                          {s.status === "in_run" &&
                            s.runnerState === "open" &&
                            s.coreClosedAt != null && (
                              <ImpulseRunnerOutcome signal={s} />
                            )}
                          {s.status === "bu_stop" && (
                            <BuStopOutcome takePct={s.buStopTakePct} />
                          )}
                          {s.status === "cancelled" && s.cancelReason && (
                            <div
                              className="text-[9px] text-muted-foreground/60 mt-0.5 max-w-[90px] truncate"
                              title={s.cancelReason}
                            >
                              {s.cancelReason}
                            </div>
                          )}
                        </td>
                        <td className="px-2 py-2 text-right font-mono text-[10px] text-muted-foreground">
                          {s.prescanCycles ?? "—"}
                        </td>
                        <td className="px-2 py-2 text-right font-mono text-[10px]">
                          <ScoreCell s={s} />
                        </td>
                        <td className="px-2 py-2 text-right">
                          <PnlCell value={s.pnlPercent} bold />
                        </td>
                        <td className="px-2 py-2 text-right font-mono text-[10px]">
                          {s.peakPct != null && s.peakPct > 0 ? (
                            <span className="text-green-400/80">
                              +{(s.peakPct as number).toFixed(1)}%
                            </span>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </td>
                        <td className="px-2 py-2 text-right font-mono text-[10px] text-foreground/80">
                          {fmtPrice(s.entryPrice)}
                        </td>
                        <td className="px-2 py-2 text-right">
                          <BtcContextCell
                            entryPrice={s.entryBtcPrice}
                            entryChange={s.entryBtc24h}
                            closePrice={s.closeBtcPrice}
                            closeChange={s.closeBtc24h}
                          />
                        </td>
                        <td className="px-2 py-2 text-right">
                          <OiCell value={s.price24hAtFire} />
                        </td>
                        <td className="px-2 py-3 text-right">
                          <OiCell value={s.entryOi15m} />
                        </td>
                        <td className="px-2 py-2 text-right">
                          <OiCell value={s.entryOi30m} />
                        </td>
                        <td className="px-2 py-2 text-right">
                          <OiCell value={s.entryOi1h} />
                        </td>
                        <td className="px-2 py-2 text-right">
                          <OiCell value={s.entryOi4h} />
                        </td>
                        <td className="px-2 py-2 text-right">
                          <OiCell value={s.entryOi24h} />
                        </td>
                        <td className="px-2 py-2 text-center">
                          <CvdDot value={s.entryCvd15m} />
                        </td>
                        <td className="px-2 py-2 text-center">
                          <CvdDot value={s.entryCvd30m} />
                        </td>
                        <td className="px-2 py-2 text-center">
                          <CvdDot value={s.entryCvd1h} />
                        </td>
                        <td className="px-2 py-2 text-center">
                          <CvdDot value={s.entryCvd4h} />
                        </td>
                        <td className="px-2 py-2 text-right font-mono text-[10px]">
                          {s.entrySpotVolMult != null ? (
                            <span
                              className={
                                (s.entrySpotVolMult as number) >= 2
                                  ? "text-cyan-300"
                                  : "text-cyan-400/70"
                              }
                            >
                              {(s.entrySpotVolMult as number).toFixed(1)}x
                            </span>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </td>
                        <td className="px-2 py-2 text-right font-mono text-[10px]">
                          {s.entryFutVolMult != null ? (
                            <span className="text-muted-foreground">
                              {(s.entryFutVolMult as number).toFixed(1)}x
                            </span>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </td>
                        <td className="px-2 py-2 text-right">
                          <OiCell value={s.entryFutTakerNetBuy} />
                        </td>
                        <td className="px-2 py-2 text-right">
                          <OiCell value={s.entrySpotTakerNetBuy} />
                        </td>
                        <td className="px-2 py-2 text-right">
                          <OiCell value={s.entrySpotNetBuy1h} />
                        </td>
                        <td className="px-2 py-2 text-right">
                          <OiCell value={s.entryPrice1h} />
                        </td>
                        <td className="px-2 py-2 text-right font-mono text-[10px]">
                          {s.entryFundingRate != null ? (
                            <span
                              className={
                                (s.entryFundingRate as number) * 100 > 0.05
                                  ? "text-orange-300"
                                  : (s.entryFundingRate as number) * 100 < -0.01
                                    ? "text-blue-300"
                                    : "text-muted-foreground"
                              }
                            >
                              {((s.entryFundingRate as number) * 100).toFixed(
                                4,
                              )}
                              %
                            </span>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </td>
                        <td className="px-2 py-2 text-right font-mono text-[10px]">
                          {s.entryWhaleIndex != null ? (
                            <span
                              className={
                                (s.entryWhaleIndex as number) >= 10
                                  ? "text-green-400"
                                  : (s.entryWhaleIndex as number) <= -10
                                    ? "text-red-400"
                                    : "text-muted-foreground"
                              }
                            >
                              {(s.entryWhaleIndex as number) > 0 ? "+" : ""}
                              {(s.entryWhaleIndex as number).toFixed(0)}
                            </span>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </td>
                        <td className="px-2 py-2 text-right">
                          <ObCell value={s.entryObRatio} />
                        </td>
                        <td className="px-2 py-2 text-right font-mono text-[10px]">
                          {s.stopLossPct != null ? (
                            <span className="text-red-400/70">
                              −{(s.stopLossPct as number).toFixed(1)}%
                            </span>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </td>
                        <td
                          className="px-2 py-2 text-left font-mono text-[10px] text-muted-foreground/70 max-w-[100px] truncate"
                          title={s.entrySource ?? ""}
                        >
                          {s.entrySource ?? "—"}
                        </td>
                        <td className="px-2 py-2 text-right font-mono text-[10px]">
                          {(s.liveLiqLong1h ?? s.entryLiqLong1h) != null ? (
                            <span className="text-orange-300">
                              ${formatNum(s.liveLiqLong1h ?? s.entryLiqLong1h)}
                            </span>
                          ) : (
                            <span className="text-muted-foreground/30">—</span>
                          )}
                        </td>
                        <td className="px-2 py-2 text-right font-mono text-[10px]">
                          {s.liveLiqShort1h != null ? (
                            <span className="text-blue-300/70">
                              ${formatNum(s.liveLiqShort1h)}
                            </span>
                          ) : (
                            <span className="text-muted-foreground/30">—</span>
                          )}
                        </td>
                        <td className="px-2 py-2 text-right font-mono text-[10px]">
                          {(s.liveLiqLong24h ?? s.entryLiqLong24h) != null ? (
                            <span className="text-orange-400/70">
                              $
                              {formatNum(s.liveLiqLong24h ?? s.entryLiqLong24h)}
                            </span>
                          ) : (
                            <span className="text-muted-foreground/30">—</span>
                          )}
                        </td>
                        <td className="px-2 py-2 text-right font-mono text-[10px]">
                          {s.entryLiqRatio != null ? (
                            <span
                              className={
                                (s.entryLiqRatio as number) >= 0.25
                                  ? "text-red-400"
                                  : "text-muted-foreground"
                              }
                            >
                              {((s.entryLiqRatio as number) * 100).toFixed(0)}%
                            </span>
                          ) : (
                            <span className="text-muted-foreground/30">—</span>
                          )}
                        </td>
                        <td className="px-2 py-2 text-left font-mono text-[10px]">
                          {s.entryLiqReason === "liq_order_stream" ? (
                            <span className="text-purple-400">stream</span>
                          ) : s.entryLiqReason === "liq_spike" ? (
                            <span className="text-orange-400/80">spike</span>
                          ) : (
                            <span className="text-muted-foreground/30">—</span>
                          )}
                        </td>
                        {snfCells(s, snfMap)}
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        )}
        {/* Pagination */}
        <div className="flex items-center justify-between px-4 py-2 border-t border-border text-xs text-muted-foreground">
          <span className="font-mono">
            {signals.length > 0
              ? `${(page - 1) * PAGE_SIZE + 1}–${(page - 1) * PAGE_SIZE + signals.length}`
              : "0"}{" "}
            из {total}
          </span>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              className="h-7 border-border text-muted-foreground"
              onClick={() => setPage(Math.max(1, page - 1))}
              disabled={page <= 1}
            >
              <ChevronLeft className="w-3 h-3" />
            </Button>
            <span className="font-mono text-[11px]">
              {page}/{totalPages}
            </span>
            <Button
              variant="outline"
              size="sm"
              className="h-7 border-border text-muted-foreground"
              onClick={() => setPage(Math.min(totalPages, page + 1))}
              disabled={page >= totalPages}
            >
              <ChevronRight className="w-3 h-3" />
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

// ── Главная страница ───────────────────────────────────────────────────────────
export default function Tracker() {
  const [statusFilter, setStatusFilter] = useState("all");
  const [patternFilter, setPatternFilter] = useState("all");
  const [page, setPage] = useState(1);
  const snfMap = useSpotNetflow();
  const [selectedSymbol, setSelectedSymbol] = useState<string | null>(null);
  const {
    data: trackedData,
    isLoading: trackedLoading,
    isError: trackedError,
    refetch: refetchTracked,
  } = useQuery({
    queryKey: ["tracked-open"],
    queryFn: fetchTracked,
    refetchInterval: 10_000,
    refetchOnWindowFocus: "always",
    refetchOnReconnect: "always",
    retry: 3,
  });
  const { data: recentClosedData, isLoading: recentClosedLoading } = useQuery({
    queryKey: ["tracked-recent-closed"],
    queryFn: fetchRecentClosed,
    refetchInterval: 15_000,
    retry: 3,
  });

  const { data: statsData } = useQuery({
    queryKey: ["tracker-stats"],
    queryFn: fetchStats,
    refetchInterval: 30_000,
  });

  const { data: cancelledTodayData } = useQuery({
    queryKey: ["cancelled-today"],
    queryFn: fetchCancelledToday,
    refetchInterval: 60_000,
  });

  const stats = statsData ?? {};
  const allTracked = (trackedData?.signals ?? []) as any[];
  const openPos = allTracked.filter((s: any) =>
    ["active", "in_run"].includes(s.status),
  );
  const regularPos = openPos;
  const openCountLabel = trackedError
    ? "—"
    : trackedLoading
      ? "…"
      : String(regularPos.length);
  const closedPos = (recentClosedData?.signals ?? []) as any[];

  const inRunCount = regularPos.filter(
    (s: any) => s.status === "in_run",
  ).length;
  const watchingCount = regularPos.filter(
    (s: any) => s.status === "active",
  ).length;

  const monthStats = stats.monthStats ?? {};
  const profitCount = monthStats["profit"]?.count ?? 0;
  const stopCount = monthStats["stop_loss"]?.count ?? 0;
  const winRate = stats.monthWinRate ?? null;
  const avgProfit =
    stats.monthAvgProfit != null ? Number(stats.monthAvgProfit) : null;
  const avgPeak =
    stats.monthAvgPeak != null ? Number(stats.monthAvgPeak) : null;
  const monthNetPnlPercent =
    statsData?.monthNetPnlPercent != null
      ? Number(statsData.monthNetPnlPercent)
      : null;
  const cancelledCount = monthStats["cancelled"]?.count ?? 0;
  const expiredCount = monthStats["expired"]?.count ?? 0;
  const monthTotalSignals = (
    Object.values(monthStats) as Array<{ count?: number }>
  ).reduce<number>((sum, row) => sum + Number(row?.count ?? 0), 0);
  const cancelledPercent =
    monthTotalSignals > 0 ? (cancelledCount / monthTotalSignals) * 100 : 0;
  const buStopAfter5 = Number(stats.monthBuStopAfter5 ?? 0);
  const buStopAfter8 = Number(stats.monthBuStopAfter8 ?? 0);
  const buStopAfter10 = Number(stats.monthBuStopAfter10 ?? 0);
  const monthBuStopCount = Number(monthStats["bu_stop"]?.count ?? 0);
  const monthBuStopWithRecordedTarget =
    buStopAfter5 + buStopAfter8 + buStopAfter10;
  const closedMonthStatuses = [
    "profit",
    "stop_loss",
    "bu_stop",
    "expired",
    "cancelled",
  ] as const;
  const monthClosedCount = closedMonthStatuses.reduce(
    (sum, status) => sum + (monthStats[status]?.count ?? 0),
    0,
  );
  const formatMonthPnl = (status: (typeof closedMonthStatuses)[number]) => {
    const pnl = Number(monthStats[status]?.pnlSum ?? 0);
    return `${pnl >= 0 ? "+" : ""}${pnl.toFixed(1)}%`;
  };
  const formatRecordedMonthPnl = (status: "expired") => {
    const pnl = Number(monthStats[status]?.pnlSum ?? 0);
    return `${pnl >= 0 ? "+" : ""}${pnl}%`;
  };
  const openSignalHistory = (status: string) => {
    setStatusFilter(status);
    setPage(1);
    window.requestAnimationFrame(() => {
      document
        .getElementById("signal-history")
        ?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  };

  return (
    <>
      <div className="space-y-4">
        {/* Заголовок */}
        <div className="flex justify-between items-center gap-3">
          <h2 className="text-xl font-bold tracking-wider">
            ALTBULLET WATCHER
          </h2>
        </div>

        {/* Стат-бар */}
        <div className="grid grid-cols-2 sm:grid-cols-5 xl:grid-cols-10 gap-3">
          {[
            {
              label: "В НАБЛЮДЕНИИ",
              value: watchingCount,
              cls: "text-blue-400",
              card: "",
              historyStatus: "active",
            },
            {
              label: "🚀 В ПОЛЁТЕ",
              value: inRunCount,
              cls: "text-orange-300",
              card: "border-orange-500/30 bg-orange-950/10",
              historyStatus: "in_run",
            },
            {
              label: STATUS_LABELS.profit,
              value: profitCount,
              cls: "text-green-400",
              card: "",
              sub: "тек. мес.",
              historyStatus: "profit",
            },
            {
              label: "BE +5%",
              value: buStopAfter5,
              cls: "text-emerald-400",
              card: "border-emerald-500/20",
              sub: "пик +5…<8%",
              historyStatus: "bu_stop_5",
            },
            {
              label: "BE +8%",
              value: buStopAfter8,
              cls: "text-emerald-400",
              card: "border-emerald-500/20",
              sub: "пик +8…<10%",
              historyStatus: "bu_stop_8",
            },
            {
              label: "BE +10%+",
              value: buStopAfter10,
              cls: "text-emerald-400",
              card: "border-emerald-500/20",
              sub: "пик от +10%",
              historyStatus: "bu_stop_10",
            },
            {
              label: STATUS_LABELS.stop_loss,
              value: stopCount,
              cls: "text-red-400",
              card: "",
              sub: "тек. мес.",
              historyStatus: "stop_loss",
            },
            {
              label: "WIN RATE",
              value: winRate !== null ? `${winRate}%` : "—",
              cls: "text-yellow-300",
              card: "",
              sub: "тек. мес.",
              historyStatus: "win_rate",
            },
            {
              label: "СРЕДНИЙ ПЛЮС",
              value: avgProfit !== null ? `+${avgProfit.toFixed(1)}%` : "—",
              cls:
                avgProfit && avgProfit > 0
                  ? "text-green-400"
                  : "text-muted-foreground",
              card: "",
              sub: "тек. мес.",
              historyStatus: "profit",
            },
            {
              label: "СРЕДНИЙ ПИК",
              value: avgPeak !== null ? `+${avgPeak.toFixed(1)}%` : "—",
              cls:
                avgPeak && avgPeak > 0
                  ? "text-blue-300"
                  : "text-muted-foreground",
              card: "",
              sub: "тек. мес.",
              historyStatus: "all",
            },
            {
              label: STATUS_LABELS.cancelled,
              value: cancelledCount,
              cls: "text-zinc-400",
              card: "border-zinc-500/20",
              sub: `${cancelledPercent.toFixed(1)}% от всех сигналов`,
              historyStatus: "cancelled",
            },
            {
              label: STATUS_LABELS.expired,
              value: expiredCount,
              cls: "text-slate-300",
              card: "border-slate-500/20",
              sub: "тек. мес.",
              historyStatus: "expired",
            },
          ].map(({ label, value, cls, card, sub, historyStatus }) => (
            <button
              key={label}
              type="button"
              onClick={() => openSignalHistory(historyStatus)}
              className="h-full min-w-0 rounded text-left focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2 focus:ring-offset-background"
              aria-label={`${label}: показать сигналы`}
            >
              <Card
                className={`h-full cursor-pointer border-border bg-card transition-colors hover:border-primary/60 hover:bg-muted/30 active:bg-muted/50 ${card}`}
              >
                <CardContent className="p-3 md:p-4">
                  <div className="text-[10px] text-muted-foreground mb-1 tracking-wider">
                    {label}
                  </div>
                  <div
                    className={`text-xl md:text-2xl font-bold font-mono ${cls}`}
                  >
                    {value}
                  </div>
                  {sub && (
                    <div className="text-[10px] text-muted-foreground/50 mt-1">
                      {sub}
                    </div>
                  )}
                </CardContent>
              </Card>
            </button>
          ))}
        </div>

        <Card className="border-emerald-500/30 bg-emerald-950/10">
          <CardContent className="p-4">
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="text-xs font-medium tracking-wider text-muted-foreground">
                  Счётчик прибыли — чистая прибыль:
                </div>
                <div
                  className={`mt-1 font-mono text-3xl font-bold ${
                    monthNetPnlPercent == null
                      ? "text-muted-foreground"
                      : monthNetPnlPercent >= 0
                        ? "text-emerald-400"
                        : "text-red-400"
                  }`}
                >
                  {monthNetPnlPercent == null
                    ? "—"
                    : `${monthNetPnlPercent >= 0 ? "+" : ""}${monthNetPnlPercent.toFixed(1)}%`}
                </div>
              </div>
              <Link
                href="/?tab=archive&profitChart=1#daily-profitability-chart"
                className="group -m-2 shrink-0 rounded-md p-2 focus:outline-none focus:ring-2 focus:ring-emerald-400"
                aria-label="Открыть график прибыльности по дням в Архиве статистики"
                title="Открыть график прибыльности по дням"
                data-testid="tracker-link-daily-profitability-chart"
              >
                <TrendingUp className="h-5 w-5 text-emerald-400/70 transition-colors group-hover:text-emerald-300" />
              </Link>
            </div>
            <div className="mt-2 text-[10px] text-muted-foreground">
              Факт за Dubai-месяц · сумма PnL всех закрытых позиций
            </div>
            <div
              role="note"
              className="mt-2 max-w-3xl text-[10px] leading-relaxed text-red-300/90"
            >
              <p className="font-semibold tracking-wide text-red-400">
                BE STOP не рассчитывается в Общем PnL
              </p>
              <p className="mt-1">
                Размер частичной фиксации перед переносом стопа в безубыток у
                каждого трейдера индивидуальный, и мы не знаем точный процент по
                каждой сделке. Чтобы не накручивать условную прибыль и не
                искажать статистику, такие сделки не учитываются в общем PnL на
                главной странице — здесь отображается только чистый профит по
                сделкам, закрытым трейлинг-стопом. В отчётах Telegram расчёт BE
                STOP приводится ориентировочно, для общей картины.
              </p>
            </div>
            <div className="mt-2 text-[10px] leading-relaxed text-muted-foreground">
              {monthClosedCount} закрытых: {STATUS_LABELS.profit}{" "}
              {formatMonthPnl("profit")} · {STATUS_LABELS.bu_stop}{" "}
              {formatMonthPnl("bu_stop")} · {STATUS_LABELS.stop_loss}{" "}
              {formatMonthPnl("stop_loss")} · {STATUS_LABELS.expired}{" "}
              {expiredCount} ({formatRecordedMonthPnl("expired")}) ·{" "}
              {STATUS_LABELS.cancelled} {formatMonthPnl("cancelled")}
            </div>
            {monthBuStopCount > 0 && (
              <div className="mt-1 text-[10px] leading-relaxed text-emerald-300/80">
                {STATUS_ICONS.bu_stop} {STATUS_LABELS.bu_stop}: 0.0% — остаток
                по BE.{" "}
                {monthBuStopWithRecordedTarget > 0
                  ? `Тейк и частичная фиксация: +5% — ${buStopAfter5}, +8% — ${buStopAfter8}, +10%+ — ${buStopAfter10}.`
                  : "Уровни тейков в этих старых записях не зафиксированы."}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Расшифровка фаз сопровождения и итоговых статусов */}
        <StatusExplanation title="Правила сопровождения и статусы" />

        {/* ── Раздел 1: Открытые позиции (без whale watch) ─────────────────── */}
        <Card className="border-border bg-card">
          <CardHeader className="py-3 px-4 border-b border-border">
            <div className="flex items-center justify-between">
              <div>
                <CardTitle className="text-sm font-mono tracking-wider">
                  📍 ОТКРЫТЫЕ ПОЗИЦИИ
                  <span className="ml-2 text-muted-foreground font-normal">
                    ({openCountLabel})
                  </span>
                </CardTitle>
                <div className="mt-1 text-[10px] text-muted-foreground/60">
                  Live-метрики — текущие данные рынка: цена, PnL и индикаторы.
                </div>
              </div>
              <span className="text-[10px] text-muted-foreground/60 font-mono">
                = источник TG-отчёта об открытых позициях
              </span>
            </div>
          </CardHeader>
          <CardContent className="p-0">
            <OpenPositions
              data={trackedData}
              isLoading={trackedLoading}
              isError={trackedError}
              onRetry={refetchTracked}
              signals={regularPos}
              snfMap={snfMap}
              onSelectSymbol={setSelectedSymbol}
            />
          </CardContent>
        </Card>

        {/* Недавно закрытые (последние 5) */}
        {!recentClosedLoading && closedPos.length > 0 && (
          <Card className="border-border bg-card">
            <CardHeader className="py-3 px-4 border-b border-border">
              <CardTitle className="text-sm font-mono tracking-wider text-muted-foreground">
                🏁 ПОСЛЕДНИЕ ЗАКРЫТЫЕ
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0 overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-muted-foreground text-[11px] border-b border-border/50 text-left">
                    <th className="px-3 py-2 text-muted-foreground/40">#</th>
                    <th className="px-3 py-2">СИМВОЛ</th>
                    <th className="px-3 py-2">ПАТТЕРН</th>
                    <th
                      className="px-2 py-2 text-right"
                      title="Количество скан-циклов токена на момент входа"
                    >
                      ЦИКЛЫ
                    </th>
                    <th
                      className="px-2 py-2 text-right"
                      title="Bullet Score при детекте"
                    >
                      СКОР
                    </th>
                    <th className="px-3 py-2 text-right">ВХОД</th>
                    <th className="px-3 py-2 text-right">ВЫХОД</th>
                    <th className="px-3 py-2 text-right">P&L</th>
                    <th
                      className="px-3 py-2 text-right"
                      title="Максимальное движение цены в сторону позиции от входа"
                    >
                      ПИК
                    </th>
                    <th className="px-3 py-2 text-center">РЕЗУЛЬТАТ</th>
                    <th
                      className="px-2 py-2 font-medium text-right"
                      title="OI Δ15m % (CoinGlass aggregated) в момент входа"
                    >
                      OI 15m
                    </th>
                    <th className="px-2 py-2 text-right" title="OI Δ30m">
                      OI 30m
                    </th>
                    <th className="px-2 py-2 text-right" title="OI Δ1h">
                      OI 1h
                    </th>
                    <th className="px-2 py-2 text-right" title="OI Δ4h">
                      OI 4h
                    </th>
                    <th className="px-2 py-2 text-right" title="OI Δ24h">
                      OI 24h
                    </th>
                    <th
                      className="px-2 py-2 text-center"
                      title="Spot CVD 15m (последняя 1×15m свеча)"
                    >
                      CVD 15m
                    </th>
                    <th className="px-2 py-2 text-center" title="Spot CVD 30m">
                      CVD 30m
                    </th>
                    <th className="px-2 py-2 text-center" title="Spot CVD 1h">
                      CVD 1h
                    </th>
                    <th className="px-2 py-2 text-center" title="Spot CVD 4h">
                      CVD 4h
                    </th>
                    <th
                      className="px-2 py-2 text-right"
                      title="Futures Taker Net Buy % при входе"
                    >
                      Фьюч тейкер
                    </th>
                    <th
                      className="px-2 py-2 text-right"
                      title="Spot Taker Net Buy % при входе"
                    >
                      Спот тейкер
                    </th>
                    <th
                      className="px-2 py-2 text-right"
                      title="Изменение цены за 1h при входе"
                    >
                      1h%
                    </th>
                    <th
                      className="px-3 py-2 text-right"
                      title="CoinGlass Whale Index (Binance 4h) при входе"
                    >
                      WI
                    </th>
                    <th
                      className="px-2 py-2 text-right"
                      title="BingX orderbook bid/ask ratio при входе (>1 = биды давят, <1 = аски давят)"
                    >
                      OB
                    </th>
                    <th
                      className="px-2 py-2 text-right"
                      title="Long liquidations 1h (live CoinGlass, все паттерны)"
                    >
                      L.Liq 1h
                    </th>
                    <th
                      className="px-2 py-2 text-right"
                      title="Short liquidations 1h (live CoinGlass)"
                    >
                      S.Liq 1h
                    </th>
                    <th
                      className="px-2 py-2 text-right"
                      title="Long liquidations за 24h"
                    >
                      Liq 24h
                    </th>
                    <th
                      className="px-2 py-2 text-right"
                      title="Ratio: liq1h / liq24h"
                    >
                      LiqR
                    </th>
                    <th
                      className="px-2 py-2 text-center"
                      title="Причина входа в пул (только liq_cascade)"
                    >
                      Триггер
                    </th>
                    <th
                      className="px-2 py-2 text-right"
                      title="Spot Net Flow 1h % (CoinGlass)"
                    >
                      SNF 1h
                    </th>
                    <th
                      className="px-2 py-2 text-right"
                      title="Spot Net Flow 4h % (CoinGlass)"
                    >
                      SNF 4h
                    </th>
                    <th
                      className="px-2 py-2 text-right"
                      title="Spot Net Flow 24h % (CoinGlass)"
                    >
                      SNF 24h
                    </th>
                    <th className="px-3 py-2 text-right">ДАТА</th>
                  </tr>
                </thead>
                <tbody>
                  {closedPos.slice(0, 5).map((s: any) => {
                    const cfg = STATUS_CFG[s.status] ?? STATUS_CFG.active;
                    const entryPrice = s.entryPrice as number | null;
                    const peakPrice = s.peakPrice as number | null;
                    const peakPct =
                      peakPrice != null && entryPrice != null && entryPrice > 0
                        ? ((s.isShort
                            ? entryPrice - peakPrice
                            : peakPrice - entryPrice) /
                            entryPrice) *
                          100
                        : null;
                    return (
                      <tr
                        key={s.id}
                        className={`border-b border-border/40 hover:bg-muted/20 ${cfg.rowCls}`}
                      >
                        <td className="px-3 py-2 font-mono text-[10px] text-muted-foreground/40">
                          #{s.id}
                        </td>
                        <td className="px-3 py-2 font-bold font-mono">
                          <div className="flex items-center gap-1">
                            <TokenChartLink
                              symbol={s.symbol}
                              className="font-bold font-mono text-foreground"
                            />
                            <button
                              onClick={() => setSelectedSymbol(s.symbol)}
                              className="text-muted-foreground/40 hover:text-muted-foreground transition-colors"
                              title="История статуса"
                            >
                              <History className="w-3 h-3" />
                            </button>
                          </div>
                          <CoverageBadge
                            isBingxExclusive={s.isBingxExclusive}
                            isBinanceSpotListed={s.isBinanceSpotListed}
                          />
                        </td>
                        <td className="px-3 py-2 text-xs text-muted-foreground">
                          {getPatternTgLabel(s.sentimentKey)}
                        </td>
                        <td className="px-2 py-2 text-right font-mono text-[11px] text-muted-foreground">
                          {s.prescanCycles ?? "—"}
                        </td>
                        <td className="px-2 py-2 text-right font-mono text-[10px]">
                          <ScoreCell s={s} />
                        </td>
                        <td className="px-3 py-2 text-right font-mono text-xs">
                          {fmtPrice(s.entryPrice)}
                        </td>
                        <td className="px-3 py-2 text-right font-mono text-xs">
                          {impulseRunnerExitLabel(s) ??
                            fmtPrice(protectedExitPrice(s))}
                        </td>
                        <td className="px-3 py-2 text-right">
                          {s.status === "reclassified" &&
                          s.pnlPercent == null ? (
                            <span
                              className="inline-block text-[9px] font-mono px-1.5 py-0.5 rounded border leading-none whitespace-nowrap bg-slate-500/15 text-slate-300 border-slate-500/30"
                              title="Перенесено в архив без исполнения выхода, цены закрытия и PnL"
                            >
                              Закрыто без PnL
                            </span>
                          ) : (
                            <PnlCell
                              value={pnlForMonetaryDisplay(
                                s.status,
                                s.pnlPercent,
                              )}
                              bold
                            />
                          )}
                        </td>
                        <td className="px-3 py-2 text-right">
                          {peakPct != null && peakPct > 0 ? (
                            <span className="font-mono text-xs text-green-400/80">
                              +{peakPct.toFixed(1)}%
                            </span>
                          ) : (
                            <span className="text-muted-foreground text-xs">
                              —
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-2 text-center">
                          <StatusBadge
                            status={s.status}
                            runnerState={s.runnerState}
                            coreClosedAt={s.coreClosedAt}
                          />
                          <ImpulseRunnerOutcome signal={s} />
                          {s.status === "bu_stop" && (
                            <BuStopOutcome takePct={s.buStopTakePct} />
                          )}
                        </td>
                        <td className="px-2 py-3 text-right">
                          <OiCell value={s.entryOi15m} />
                        </td>
                        <td className="px-2 py-2 text-right">
                          <OiCell value={s.entryOi30m} />
                        </td>
                        <td className="px-2 py-2 text-right">
                          <OiCell value={s.entryOi1h} />
                        </td>
                        <td className="px-2 py-2 text-right">
                          <OiCell value={s.entryOi4h} />
                        </td>
                        <td className="px-2 py-2 text-right">
                          <OiCell value={s.entryOi24h} />
                        </td>
                        <td className="px-2 py-2 text-center">
                          <CvdDot value={s.entryCvd15m} />
                        </td>
                        <td className="px-2 py-2 text-center">
                          <CvdDot value={s.entryCvd30m} />
                        </td>
                        <td className="px-2 py-2 text-center">
                          <CvdDot value={s.entryCvd1h} />
                        </td>
                        <td className="px-2 py-2 text-center">
                          <CvdDot value={s.entryCvd4h} />
                        </td>
                        <td className="px-2 py-2 text-right">
                          <OiCell value={s.entryFutTakerNetBuy} />
                        </td>
                        <td className="px-2 py-2 text-right">
                          <OiCell value={s.entrySpotTakerNetBuy} />
                        </td>
                        <td className="px-2 py-2 text-right">
                          <OiCell value={s.entryPrice1h} />
                        </td>
                        <td className="px-3 py-2 text-right font-mono text-[10px]">
                          {s.entryWhaleIndex != null ? (
                            <span
                              className={
                                (s.entryWhaleIndex as number) >= 10
                                  ? "text-green-400"
                                  : (s.entryWhaleIndex as number) <= -10
                                    ? "text-red-400"
                                    : "text-muted-foreground"
                              }
                            >
                              {(s.entryWhaleIndex as number) > 0 ? "+" : ""}
                              {(s.entryWhaleIndex as number).toFixed(0)}
                            </span>
                          ) : (
                            <span className="text-border">—</span>
                          )}
                        </td>
                        <td className="px-2 py-2 text-right">
                          <ObCell value={s.entryObRatio} />
                        </td>
                        <td className="px-2 py-2 text-right">
                          <LiqCell
                            value={s.liveLiqLong1h ?? s.entryLiqLong1h}
                          />
                        </td>
                        <td className="px-2 py-2 text-right">
                          <LiqShortCell value={s.liveLiqShort1h} />
                        </td>
                        <td className="px-2 py-2 text-right">
                          <LiqCell
                            value={s.liveLiqLong24h ?? s.entryLiqLong24h}
                          />
                        </td>
                        <td className="px-2 py-2 text-right">
                          <LiqRCell value={s.entryLiqRatio} />
                        </td>
                        <td className="px-2 py-2 text-center">
                          <LiqTriggerCell value={s.entryLiqReason} />
                        </td>
                        {snfCells(s, snfMap)}
                        <td className="px-3 py-2 text-right font-mono text-[11px] text-muted-foreground whitespace-nowrap">
                          {fmtDT(s.detectedAt)}
                          <div className="text-[10px] text-muted-foreground/50">
                            активен{" "}
                            {formatActiveDuration(
                              s.detectedAt,
                              signalEndTime(s),
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </CardContent>
          </Card>
        )}

        {/* ── Отменено сегодня ──────────────────────────────────────────────── */}
        {(() => {
          const cancelledToday = (cancelledTodayData?.signals ?? []) as any[];
          if (cancelledToday.length === 0) return null;
          return (
            <Card className="border-border bg-card border-zinc-700/30">
              <CardHeader className="py-3 px-4 border-b border-border">
                <CardTitle className="text-sm font-mono tracking-wider text-zinc-400">
                  {STATUS_ICONS.cancelled} {STATUS_LABELS.cancelled} СЕГОДНЯ
                  <span className="ml-2 text-muted-foreground font-normal text-xs">
                    ({cancelledToday.length})
                  </span>
                </CardTitle>
              </CardHeader>
              <CardContent className="p-0 overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-muted-foreground text-[11px] border-b border-border/50 text-left">
                      <th className="px-3 py-2 text-muted-foreground/40">#</th>
                      <th className="px-3 py-2">СИМВОЛ</th>
                      <th className="px-3 py-2">ПАТТЕРН</th>
                      <th
                        className="px-2 py-2 text-right"
                        title="Количество скан-циклов токена на момент входа"
                      >
                        ЦИКЛЫ
                      </th>
                      <th
                        className="px-2 py-2 text-right"
                        title="Bullet Score при детекте"
                      >
                        СКОР
                      </th>
                      <th className="px-3 py-2 text-right">ВХОД</th>
                      <th className="px-3 py-2 text-right">ВЫХОД</th>
                      <th className="px-3 py-2 text-right">P&amp;L</th>
                      <th className="px-3 py-2 text-right">ПИК</th>
                      <th className="px-3 py-2 text-left">ПРИЧИНА</th>
                      <th
                        className="px-2 py-2 font-medium text-right"
                        title="OI Δ15m % (CoinGlass aggregated) в момент входа"
                      >
                        OI 15m
                      </th>
                      <th className="px-2 py-2 text-right" title="OI Δ30m">
                        OI 30m
                      </th>
                      <th className="px-2 py-2 text-right" title="OI Δ1h">
                        OI 1h
                      </th>
                      <th className="px-2 py-2 text-right" title="OI Δ4h">
                        OI 4h
                      </th>
                      <th className="px-2 py-2 text-right" title="OI Δ24h">
                        OI 24h
                      </th>
                      <th
                        className="px-2 py-2 text-center"
                        title="Spot CVD 15m (последняя 1×15m свеча)"
                      >
                        CVD 15m
                      </th>
                      <th
                        className="px-2 py-2 text-center"
                        title="Spot CVD 30m"
                      >
                        CVD 30m
                      </th>
                      <th className="px-2 py-2 text-center" title="Spot CVD 1h">
                        CVD 1h
                      </th>
                      <th className="px-2 py-2 text-center" title="Spot CVD 4h">
                        CVD 4h
                      </th>
                      <th
                        className="px-2 py-2 text-right"
                        title="Futures Taker Net Buy %"
                      >
                        Фьюч тейкер
                      </th>
                      <th
                        className="px-2 py-2 text-right"
                        title="Spot Taker Net Buy %"
                      >
                        Спот тейкер
                      </th>
                      <th
                        className="px-2 py-2 text-right"
                        title="Изменение цены за 1h при входе"
                      >
                        1h%
                      </th>
                      <th
                        className="px-2 py-2 text-right"
                        title="CoinGlass Whale Index (Binance 4h) при входе"
                      >
                        WI
                      </th>
                      <th
                        className="px-2 py-2 text-right"
                        title="BingX orderbook bid/ask ratio при входе (>1 = биды давят, <1 = аски давят)"
                      >
                        OB
                      </th>
                      <th
                        className="px-2 py-2 text-right"
                        title="Long liquidations 1h (live CoinGlass, все паттерны)"
                      >
                        L.Liq 1h
                      </th>
                      <th
                        className="px-2 py-2 text-right"
                        title="Short liquidations 1h (live CoinGlass)"
                      >
                        S.Liq 1h
                      </th>
                      <th
                        className="px-2 py-2 text-right"
                        title="Long liquidations за 24h"
                      >
                        Liq 24h
                      </th>
                      <th
                        className="px-2 py-2 text-right"
                        title="Ratio: liq1h / liq24h"
                      >
                        LiqR
                      </th>
                      <th
                        className="px-2 py-2 text-center"
                        title="Причина входа в пул (только liq_cascade)"
                      >
                        Триггер
                      </th>
                      <th
                        className="px-2 py-2 text-right"
                        title="Spot Net Flow 1h % (CoinGlass)"
                      >
                        SNF 1h
                      </th>
                      <th
                        className="px-2 py-2 text-right"
                        title="Spot Net Flow 4h % (CoinGlass)"
                      >
                        SNF 4h
                      </th>
                      <th
                        className="px-2 py-2 text-right"
                        title="Spot Net Flow 24h % (CoinGlass)"
                      >
                        SNF 24h
                      </th>
                      <th className="px-3 py-2 text-center">СТАТУС</th>
                      <th className="px-3 py-2 text-right">ЗАКРЫТО</th>
                      <th className="px-3 py-2"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {cancelledToday.map((s: any) => {
                      const entryPrice = s.entryPrice as number | null;
                      const exitPrice = (s.exitPrice ?? s.peakPrice) as
                        | number
                        | null;
                      const peakPrice = s.peakPrice as number | null;
                      const peakPct =
                        peakPrice && entryPrice && entryPrice > 0
                          ? ((peakPrice - entryPrice) / entryPrice) * 100
                          : null;
                      return (
                        <tr
                          key={s.id}
                          className="border-b border-border/30 hover:bg-muted/10 opacity-70"
                        >
                          <td className="px-3 py-2 font-mono text-[10px] text-muted-foreground/40">
                            #{s.id}
                          </td>
                          <td className="px-3 py-2">
                            <div className="font-bold font-mono text-zinc-400 flex items-center gap-1">
                              <TokenChartLink
                                symbol={s.symbol}
                                className="font-bold font-mono text-zinc-400 hover:text-primary"
                              />
                              {s.isShort && (
                                <span className="ml-1 text-[10px] text-red-400">
                                  SHORT
                                </span>
                              )}
                              <button
                                onClick={() => setSelectedSymbol(s.symbol)}
                                className="text-muted-foreground/40 hover:text-muted-foreground transition-colors"
                                title="История статуса"
                              >
                                <History className="w-3 h-3" />
                              </button>
                            </div>
                            <div className="text-[10px] text-muted-foreground/60">
                              {s.signalType === "super_alpha"
                                ? "⚡⚡ SUPER BULLET"
                                : s.signalType === "alpha"
                                  ? "⚡ BULLET"
                                  : (s.signalType ?? "")}
                            </div>
                            <CoverageBadge
                              isBingxExclusive={s.isBingxExclusive}
                              isBinanceSpotListed={s.isBinanceSpotListed}
                            />
                          </td>
                          <td className="px-3 py-2">
                            <SentimentBadge
                              sentimentKey={s.sentimentKey ?? "unknown"}
                            />
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
                          </td>
                          <td className="px-2 py-2 text-right font-mono text-[11px] text-muted-foreground">
                            {s.prescanCycles ?? "—"}
                          </td>
                          <td className="px-2 py-2 text-right font-mono text-[10px]">
                            <ScoreCell s={s} />
                          </td>
                          <td className="px-3 py-2 text-right font-mono text-xs text-zinc-400">
                            {fmtPrice(entryPrice)}
                          </td>
                          <td className="px-3 py-2 text-right font-mono text-xs text-zinc-500">
                            {fmtPrice(exitPrice)}
                          </td>
                          <td className="px-3 py-2 text-right">
                            <PnlCell value={s.pnlPercent} />
                          </td>
                          <td className="px-3 py-2 text-right">
                            {peakPct != null && peakPct > 0 ? (
                              <span className="font-mono text-xs text-green-400/80">
                                +{peakPct.toFixed(1)}%
                              </span>
                            ) : (
                              <span className="text-muted-foreground text-xs">
                                —
                              </span>
                            )}
                          </td>
                          <td className="px-3 py-2 text-left">
                            {s.cancelReason ? (
                              <span className="text-[9px] font-mono text-muted-foreground/60 bg-muted/30 px-1 py-0.5 rounded">
                                {s.cancelReason}
                              </span>
                            ) : (
                              <span className="text-border">—</span>
                            )}
                          </td>
                          <td className="px-2 py-3 text-right">
                            <OiCell value={s.entryOi15m} />
                          </td>
                          <td className="px-2 py-2 text-right">
                            <OiCell value={s.oi30m} />
                          </td>
                          <td className="px-2 py-2 text-right">
                            <OiCell value={s.oi1h} />
                          </td>
                          <td className="px-2 py-2 text-right">
                            <OiCell value={s.oi4h} />
                          </td>
                          <td className="px-2 py-2 text-right">
                            <OiCell value={s.oi24h} />
                          </td>
                          <td className="px-2 py-2 text-center">
                            <CvdDot value={s.cvd15m} />
                          </td>
                          <td className="px-2 py-2 text-center">
                            <CvdDot value={s.cvd30m} />
                          </td>
                          <td className="px-2 py-2 text-center">
                            <CvdDot value={s.cvd1h} />
                          </td>
                          <td className="px-2 py-2 text-center">
                            <CvdDot value={s.cvd4h} />
                          </td>
                          <td className="px-2 py-2 text-right">
                            <OiCell value={s.netBuyPct} />
                          </td>
                          <td className="px-2 py-2 text-right">
                            <OiCell value={s.spotTakerNetBuy} />
                          </td>
                          <td className="px-2 py-2 text-right">
                            <OiCell value={s.price1h} />
                          </td>
                          <td className="px-2 py-2 text-right font-mono text-[10px]">
                            {s.entryWhaleIndex != null ? (
                              <span
                                className={
                                  (s.entryWhaleIndex as number) >= 10
                                    ? "text-green-400"
                                    : (s.entryWhaleIndex as number) <= -10
                                      ? "text-red-400"
                                      : "text-muted-foreground"
                                }
                              >
                                {(s.entryWhaleIndex as number) > 0 ? "+" : ""}
                                {(s.entryWhaleIndex as number).toFixed(0)}
                              </span>
                            ) : (
                              <span className="text-border">—</span>
                            )}
                          </td>
                          <td className="px-2 py-2 text-right">
                            <ObCell value={s.entryObRatio} />
                          </td>
                          <td className="px-2 py-2 text-right">
                            <LiqCell
                              value={s.liveLiqLong1h ?? s.entryLiqLong1h}
                            />
                          </td>
                          <td className="px-2 py-2 text-right">
                            <LiqShortCell value={s.liveLiqShort1h} />
                          </td>
                          <td className="px-2 py-2 text-right">
                            <LiqCell
                              value={s.liveLiqLong24h ?? s.entryLiqLong24h}
                            />
                          </td>
                          <td className="px-2 py-2 text-right">
                            <LiqRCell value={s.entryLiqRatio} />
                          </td>
                          <td className="px-2 py-2 text-center">
                            <LiqTriggerCell value={s.entryLiqReason} />
                          </td>
                          {snfCells(s, snfMap)}
                          <td className="px-3 py-2 text-center">
                            <StatusBadge
                              status={s.status}
                              runnerState={s.runnerState}
                              coreClosedAt={s.coreClosedAt}
                            />
                          </td>
                          <td className="px-3 py-2 text-right font-mono text-[11px] text-muted-foreground whitespace-nowrap">
                            {s.closedAt ? fmtDT(s.closedAt) : "—"}
                          </td>
                          <td className="px-3 py-2 text-center">
                            <Link
                              href={`/charts/${encodeURIComponent(s.symbol)}`}
                              title={`Наш график ${s.symbol}`}
                              className="text-zinc-600 hover:text-primary"
                            >
                              <ExternalLink className="w-3 h-3" />
                            </Link>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </CardContent>
            </Card>
          );
        })()}

        {/* ── Раздел 2: Лог сигналов ────────────────────────────────────────── */}
        <SignalLog
          statusFilter={statusFilter}
          page={page}
          setPage={setPage}
          setStatusFilter={setStatusFilter}
          patternFilter={patternFilter}
          setPatternFilter={setPatternFilter}
          snfMap={snfMap}
          onSelectSymbol={setSelectedSymbol}
        />

        <SymbolHistorySheet
          symbol={selectedSymbol}
          onClose={() => setSelectedSymbol(null)}
        />
      </div>
    </>
  );
}
