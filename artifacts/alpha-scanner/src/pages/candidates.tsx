import React, { useEffect, useState } from "react";
import {
  useGetScannerStatus,
  getGetScannerStatusQueryKey,
} from "@workspace/api-client-react";
import type {
  CycleCandidateEntry,
  PrescanCandidate,
  OiWatchEntry,
} from "@workspace/api-client-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

const API_BASE_CAND = import.meta.env.BASE_URL.replace(/\/$/, "");
const CAND_PAGE_SIZE = 50;

/** Extended response type that includes server-side pagination fields */
interface CandidatesPageResponse {
  prescan: PrescanCandidate[];
  oiWatch: OiWatchEntry[];
  cycleCandidates: CycleCandidateEntry[];
  cycleAt: number | null;
  totalPrescan: number;
  totalOiWatch: number;
  nextOffset: number | null;
}
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  RefreshCw,
  Flame,
  Eye,
  Zap,
  History,
  List,
  BarChart2,
  Loader2,
  CheckCircle2,
  Search,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import {
  SymbolHistorySheet,
  TfGrid,
  fmtDateTime,
  SPECIAL_TF_LABELS,
} from "@/components/symbol-history-sheet";
import { getPatternTgLabel } from "@/lib/pattern-labels";
import {
  useGetLiqCascade,
  getGetLiqCascadeQueryKey,
} from "@workspace/api-client-react";
import LiqCascadeTab from "@/components/liq-cascade-tab";
import AbneonTab, { useAbneonCandidates } from "@/components/abneon-tab";
import RangeBreakoutTab, {
  useRangeBreakoutCandidates,
} from "@/components/range-breakout-tab";
import { type SnfEntry, useSpotNetflow } from "@/hooks/use-spot-netflow";
import { getStoredUser } from "@/hooks/useAuth";
import MemberScanner from "./member-scanner";
import { TokenChartLink } from "@/components/token-chart-link";

const fmtSpot = (v: number | null) =>
  v == null
    ? "—"
    : v >= 1e6
      ? `$${(v / 1e6).toFixed(1)}M`
      : v >= 1e3
        ? `$${(v / 1e3).toFixed(0)}K`
        : `$${v.toFixed(0)}`;

const _fmtTurn = (v: number | null) =>
  v == null ? "—" : `${(v * 100).toFixed(0)}%`;

const fmtTaker = (
  netBuy: number | null,
  exchange: string | null | undefined,
) => {
  if (netBuy === null || netBuy === undefined)
    return <span className="text-border/50">—</span>;
  const neutral = Math.abs(netBuy) < 2;
  const src = exchange === "BingX" ? "[X]" : "[B]";
  return (
    <span
      className={
        neutral
          ? "text-muted-foreground"
          : netBuy > 0
            ? "text-green-400"
            : "text-red-400"
      }
    >
      {netBuy >= 0 ? "+" : ""}
      {netBuy.toFixed(0)}%
      <span className="text-[9px] text-muted-foreground/40 ml-0.5">{src}</span>
    </span>
  );
};

const _fmtMcapPct = (vol: number | null, mcap: number | null) =>
  vol && mcap ? `${((vol / mcap) * 100).toFixed(1)}%` : "—";

/**
 * Первая подходящая причина "почему не стреляет" для prescan-кандидата.
 * Проверяем по порядку, останавливаемся на первой.
 *
 * Примечание: колонка "Движ." = priceMovePct (% движения цены с момента входа
 * в prescan). lastVolMult доступен из API (lastVolMult поле в prescan-ответе).
 */
function getPrescanStatus(row: {
  lastPrice24h: number;
  cycleCount: number;
  firstPrice?: number | null;
  lastPrice?: number | null;
  lastCvdOk?: boolean | null;
  lastNetBuyPct?: number | null;
  lastOi30m?: number | null;
  lastOi1h?: number | null;
  lastOi4h?: number | null;
  lastOi24h?: number | null;
  cgTimedOut?: boolean | null;
  lastVolMult?: number | null;
  lastSkipReason?: string | null;
}): string {
  // Перегрев по 24h-изменению (знаковое: отрицательный дамп НЕ перегрев)
  const overheat24h = row.lastPrice24h >= 40;
  // Перегрев по росту от точки входа в prescan (firstPrice → текущая цена)
  const growthFromEntry =
    row.firstPrice != null &&
    row.firstPrice > 0 &&
    row.lastPrice != null &&
    row.lastPrice > 0
      ? (row.lastPrice / row.firstPrice - 1) * 100
      : null;
  const overheatEntry = growthFromEntry != null && growthFromEntry >= 40;
  if (overheat24h || overheatEntry) {
    const parts: string[] = [];
    if (overheat24h)
      parts.push(
        `24h ${row.lastPrice24h >= 0 ? "+" : ""}${row.lastPrice24h.toFixed(0)}%`,
      );
    if (overheatEntry) parts.push(`от входа +${growthFromEntry!.toFixed(0)}%`);
    return `📈 Перегрет (${parts.join(" / ")})`;
  }

  // BingX-exclusive: CoinGlass не покрывает токен → путь VolumeBreakout (нужно 2 цикла)
  const oiVals = [
    row.lastOi30m,
    row.lastOi1h,
    row.lastOi4h,
    row.lastOi24h,
  ].filter((v): v is number => v != null);
  if (oiVals.length === 0) {
    if (row.cgTimedOut === true) return "⏳ CG таймаут (ждём данных)";
    // cgTimedOut === false означает «CG спросили, данных нет» — токен не покрыт CoinGlass.
    // cgTimedOut === null  означает «ещё не проверяли» — нужно подождать 1–2 цикла.
    if (row.cgTimedOut === false) return "📊 CG нет данных — путь SpotVol";
    if (row.cycleCount >= 2) return "⏳ Нет свежих OI данных";
    const need = 2 - row.cycleCount;
    return `📊 SpotVol: ждёт ${need} цикл${need === 1 ? "" : "а"}`;
  }

  if (row.cycleCount < 2) return "⏳ Мало циклов (нужно 2+)";

  const oiMax = Math.max(...oiVals);

  // OI слишком слабый — нет накопления
  if (oiMax < 0.2) return "📉 OI слабый (<0.2%)";

  // OI накапливается — есть данные, но ниже порога сигнала (~5%)
  if (oiMax < 5) return "👁 OI накапливается";

  // OI хороший (≥5%), но CVD или taker flow против
  if (
    row.lastCvdOk === false ||
    (row.lastNetBuyPct != null && row.lastNetBuyPct < 0)
  )
    return "👁 Ждём CVD";

  // OI и CVD ок, но объём недостаточен для прямого сигнала (порог 2.5x)
  if (row.lastVolMult != null && row.lastVolMult < 2.5) return "👁 Ждём объём";

  // OI прошёл, но ни один паттерн не сработал — нужна доработка паттерна
  if (row.lastSkipReason === "no_pattern") return "🔎 Нет паттерна";

  // Цена выросла >12% за 3ч — поздний вход, поезд ушёл
  if (row.lastSkipReason === "late_pump")
    return "⏰ Поздний вход (price3h >12%)";

  // Всё в порядке, но токен давно в пресканере — хронический наблюдатель
  if (row.cycleCount >= 10) return "👁 Хронический";

  return "🔭 В наблюдении";
}

function timeAgo(isoOrMs: string | number): string {
  const ms =
    typeof isoOrMs === "number" ? isoOrMs : new Date(isoOrMs).getTime();
  const diff = Math.floor((Date.now() - ms) / 1000);
  if (diff < 60) return `${diff}с`;
  if (diff < 3600) return `${Math.floor(diff / 60)}м`;
  return `${Math.floor(diff / 3600)}ч`;
}

function expiresIn(isoStr: string): string {
  const diff = Math.floor((new Date(isoStr).getTime() - Date.now()) / 1000);
  if (diff <= 0) return "истёк";
  if (diff < 60) return `${diff}с`;
  if (diff < 3600) return `${Math.floor(diff / 60)}м`;
  return `${Math.floor(diff / 3600)}ч`;
}

function fmtPrice(p: number | null | undefined): string {
  if (p == null || p <= 0) return "—";
  if (p >= 10000) return `$${p.toFixed(0)}`;
  if (p >= 1000) return `$${p.toFixed(1)}`;
  if (p >= 100) return `$${p.toFixed(2)}`;
  if (p >= 1) return `$${p.toFixed(4)}`;
  if (p >= 0.01) return `$${p.toFixed(5)}`;
  return `$${p.toPrecision(4)}`;
}

// ─── tab nav ──────────────────────────────────────────────────────────────────

type Tab =
  | "prescan"
  | "oi_watch"
  | "cycle"
  | "spot_vol"
  | "liq_cascade"
  | "range_breakout"
  | "abneon";

const TABS: { id: Tab; label: string; icon: React.ElementType }[] = [
  { id: "prescan", label: "Prescan", icon: Flame },
  { id: "oi_watch", label: "OI Watch", icon: Eye },
  { id: "cycle", label: "Кандидаты", icon: List },
  { id: "spot_vol", label: "Спот", icon: BarChart2 },
  { id: "liq_cascade", label: "L10 Каскады", icon: Zap },
  { id: "range_breakout", label: "Range Breakout", icon: List },
  { id: "abneon", label: "ABNeon", icon: List },
];

// ─── layer info for pipeline overview ────────────────────────────────────────

const LAYER_INFO: {
  tag: string;
  name: string;
  bg: string;
  border: string;
  badge: string;
  desc: string;
}[] = [
  {
    tag: "L1",
    name: "Hot Movers",
    bg: "bg-orange-500/5",
    border: "border-orange-500/25",
    badge: "bg-orange-500/20 text-orange-300 border-orange-500/30",
    desc: "Топ-50 по activity score (объём 24h + OI change + движение цены)",
  },
  {
    tag: "L2",
    name: "Volume",
    bg: "bg-blue-500/5",
    border: "border-blue-500/25",
    badge: "bg-blue-500/20 text-blue-300 border-blue-500/30",
    desc: "Топ-200 по глобальному объёму (CoinGlass; на первом цикле — BingX)",
  },
  {
    tag: "L3",
    name: "OI Movers",
    bg: "bg-purple-500/5",
    border: "border-purple-500/25",
    badge: "bg-purple-500/20 text-purple-300 border-purple-500/30",
    desc: "Спайк OI: 30m ≥6% / 1h ≥3% / 4h ≥8% / 24h ≥10%",
  },
  {
    tag: "L4",
    name: "Vol Awaken",
    bg: "bg-green-500/5",
    border: "border-green-500/25",
    badge: "bg-green-500/20 text-green-300 border-green-500/30",
    desc: "Объём ×2.5+ от 5-цикл. среднего + price24h 3–15% («просыпающиеся»)",
  },
  {
    tag: "L5",
    name: "OI Accel",
    bg: "bg-cyan-500/5",
    border: "border-cyan-500/25",
    badge: "bg-cyan-500/20 text-cyan-300 border-cyan-500/30",
    desc: "OI30m ускоряется между циклами: lastOI > prevOI × 1.3 + оба > 0",
  },
  {
    tag: "L6c",
    name: "CG Blind Rescue",
    bg: "bg-indigo-500/5",
    border: "border-indigo-500/25",
    badge: "bg-indigo-500/20 text-indigo-300 border-indigo-500/30",
    desc: "CG timeout + Coinalyze OI 30m ≥1.5% → принудительный инжект в батч",
  },
  {
    tag: "L7",
    name: "OI Orphans",
    bg: "bg-zinc-500/5",
    border: "border-zinc-500/25",
    badge: "bg-zinc-500/20 text-zinc-400 border-zinc-500/30",
    desc: "Активные oi_watch (watching/confirming) без текущего prescan-тега",
  },
  {
    tag: "L8",
    name: "Steady Climbers",
    bg: "bg-pink-500/5",
    border: "border-pink-500/25",
    badge: "bg-pink-500/20 text-pink-300 border-pink-500/30",
    desc: "growthCycles ≥2 + p24h 0–40% — устойчивый рост без откатов",
  },
  {
    tag: "L8b",
    name: "OI 24h Leaders",
    bg: "bg-sky-500/5",
    border: "border-sky-500/25",
    badge: "bg-sky-500/20 text-sky-300 border-sky-500/30",
    desc: "OI24h ≥8% + база ≥$1M → проактивный OI Watch 12ч (не дожидаясь паттерна)",
  },
  {
    tag: "L10",
    name: "Liq Cascade",
    bg: "bg-rose-500/5",
    border: "border-rose-500/25",
    badge: "bg-rose-500/20 text-rose-300 border-rose-500/30",
    desc: "longLiq1h/24h ≥25% + ≥$50K + p24h ≤5% или поток liq-ордеров (каждые 3 мин) — фоновый пул",
  },
];

function TabNav({
  active,
  onChange,
  counts,
}: {
  active: Tab;
  onChange: (t: Tab) => void;
  counts: Record<Tab, number>;
}) {
  return (
    <div className="flex border-b border-border gap-0 flex-wrap">
      {TABS.map(({ id, label, icon: Icon }) => (
        <button
          key={id}
          onClick={() => onChange(id)}
          className={`flex items-center gap-1.5 px-4 py-2.5 text-xs font-medium tracking-wider transition-colors
            ${
              active === id
                ? "border-b-2 border-primary text-primary -mb-px"
                : "text-muted-foreground hover:text-foreground"
            }`}
        >
          <Icon className="w-3.5 h-3.5" />
          {label.toUpperCase()}
          <span
            className={`ml-1 text-[10px] px-1.5 py-0.5 rounded-full font-mono ${
              active === id
                ? "bg-primary/20 text-primary"
                : "bg-muted text-muted-foreground"
            }`}
          >
            {counts[id]}
          </span>
        </button>
      ))}
    </div>
  );
}

// ─── ScanStatusBadge ──────────────────────────────────────────────────────────

function fmtDuration(ms: number): string {
  const totalSec = Math.round(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min === 0) return `${sec}с`;
  if (sec === 0) return `${min}м`;
  return `${min}м ${sec}с`;
}

function ScanStatusBadge({
  isScanning,
  scanStartedAt,
  lastScanDurationMs,
  lastScanAt,
}: {
  isScanning: boolean;
  scanStartedAt: string | null;
  lastScanDurationMs: number | null;
  lastScanAt: string | null;
}) {
  const [elapsed, setElapsed] = React.useState(0);

  React.useEffect(() => {
    if (!isScanning || !scanStartedAt) {
      setElapsed(0);
      return;
    }
    const tick = () =>
      setElapsed(Date.now() - new Date(scanStartedAt).getTime());
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [isScanning, scanStartedAt]);

  if (isScanning) {
    return (
      <div className="flex flex-col items-start gap-0.5 rounded-lg border border-yellow-500/40 bg-yellow-500/10 px-3 py-1 text-[11px]">
        <div className="flex items-center gap-1.5">
          <Loader2 className="w-3 h-3 text-yellow-400 animate-spin" />
          <span className="text-yellow-300 font-medium">Скан идёт</span>
          <span className="text-yellow-400/70">
            {scanStartedAt
              ? `Начат ${fmtDateTime(scanStartedAt)} · идёт ${fmtDuration(Math.max(0, elapsed))}`
              : "Начало текущего скана: нет данных"}
          </span>
        </div>
        <span className="pl-[18px] text-yellow-400/60">
          Прошлый скан:{" "}
          {lastScanDurationMs != null
            ? fmtDuration(lastScanDurationMs)
            : "нет данных"}
        </span>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-start gap-0.5 rounded-lg border border-green-500/30 bg-green-500/8 px-3 py-1 text-[11px]">
      <div className="flex items-center gap-1.5">
        <CheckCircle2 className="w-3 h-3 text-green-400" />
        <span className="text-green-300/80 font-medium">Скан завершён</span>
      </div>
      <span className="pl-[18px] text-muted-foreground">
        Начат: {scanStartedAt ? fmtDateTime(scanStartedAt) : "нет данных"}
      </span>
      <span className="pl-[18px] text-muted-foreground">
        Завершён: {lastScanAt ? fmtDateTime(lastScanAt) : "нет данных"}
      </span>
      <span className="pl-[18px] text-muted-foreground">
        Длительность:{" "}
        {lastScanDurationMs != null
          ? fmtDuration(lastScanDurationMs)
          : "нет данных"}
      </span>
    </div>
  );
}

// ─── Spot NetFlow helpers ──────────────────────────────────────────────────────

/** BingX "1000PEPE-USDT" → "PEPE", "BTC-USDT" → "BTC" */
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

/** 3 NetFlow cells (1h/4h/24h) for a BingX symbol, using the snfMap lookup */
function snfCells(snfMap: Map<string, SnfEntry>, symbol: string) {
  const e = snfMap.get(toCgBase(symbol));
  return (
    <>
      <td className="py-1.5 pr-3 text-right">{snfCell(e?.netPct1h ?? null)}</td>
      <td className="py-1.5 pr-3 text-right">{snfCell(e?.netPct4h ?? null)}</td>
      <td className="py-1.5 pr-3 text-right">
        {snfCell(e?.netPct24h ?? null)}
      </td>
    </>
  );
}

// ─── main component ───────────────────────────────────────────────────────────

function OwnerCandidates() {
  const [tab, setTab] = useState<Tab>(() => {
    const requestedTab = new URLSearchParams(window.location.search).get("tab");
    return TABS.some(({ id }) => id === requestedTab)
      ? (requestedTab as Tab)
      : "prescan";
  });
  const [selectedLayer, setSelectedLayer] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [selectedSymbol, setSelectedSymbol] = useState<string | null>(null);
  const snfMap = useSpotNetflow();
  const [filterQ, setFilterQ] = useState("");
  const [coverageFilter, setCoverageFilter] = useState<
    "all" | "bingx_only" | "binance_spot" | "cg_futures"
  >("all");
  // ── Pagination offset for prescan/OI-watch (shared, reset on tab change) ──
  const [candOffset, setCandOffset] = useState(0);

  useEffect(() => {
    setFilterQ("");
    setCoverageFilter("all");
    setCandOffset(0);
    if (tab !== "cycle") setSelectedLayer(null);
  }, [tab]);

  function openLayerTokens(layer: string) {
    setFilterQ("");
    setCoverageFilter("all");
    setCandOffset(0);
    setSelectedLayer(layer === "L10" ? null : layer);
    setTab(layer === "L10" ? "liq_cascade" : "cycle");
    window.setTimeout(() => {
      document
        .getElementById("scanner-token-lists")
        ?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 0);
  }

  function openPhaseTokens(nextTab: Tab) {
    setTab(nextTab);
    window.setTimeout(() => {
      document
        .getElementById("scanner-token-lists")
        ?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 0);
  }

  const qc = useQueryClient();

  const candQueryKey = ["scanner-candidates", candOffset] as const;
  const { data, isLoading, dataUpdatedAt } = useQuery<CandidatesPageResponse>({
    queryKey: candQueryKey,
    queryFn: async ({ signal }) => {
      const params = new URLSearchParams({
        limit: String(CAND_PAGE_SIZE),
        offset: String(candOffset),
      });
      const r = await fetch(
        `${API_BASE_CAND}/api/scanner/candidates?${params}`,
        { signal, cache: "no-store" },
      );
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    },
    refetchInterval: 15_000,
    refetchIntervalInBackground: false,
    staleTime: 10_000,
  });

  function refetch() {
    void qc.invalidateQueries({ queryKey: candQueryKey });
  }

  const { data: scannerStatus } = useGetScannerStatus({
    query: {
      queryKey: getGetScannerStatusQueryKey(),
      refetchInterval: 10_000,
      refetchIntervalInBackground: false,
    },
  });

  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 10_000);
    return () => clearInterval(id);
  }, []);

  void tick;

  const prescan = data?.prescan ?? [];
  const oiWatch = data?.oiWatch ?? [];
  const cycleCandidates = data?.cycleCandidates ?? [];
  const cycleAt = data?.cycleAt ?? null;

  const spotVolRows = prescan
    .filter((r) => (r.spotVolCycles ?? 0) >= 1)
    .sort((a, b) => (b.spotVolMult ?? 0) - (a.spotVolMult ?? 0));
  const [prescanSort, setPrescanSort] = useState<{
    col: string;
    dir: "asc" | "desc";
  }>({
    col: "score",
    dir: "desc",
  });
  const [cycleSort, setCycleSort] = useState<{
    col: string;
    dir: "asc" | "desc";
  }>({
    col: "score",
    dir: "desc",
  });
  const toggleCycleSort = (col: string) =>
    setCycleSort((s) =>
      s.col === col
        ? { col, dir: s.dir === "desc" ? "asc" : "desc" }
        : { col, dir: "desc" },
    );
  const cycleArrow = (col: string) =>
    cycleSort.col === col ? (cycleSort.dir === "desc" ? " ▼" : " ▲") : " ⇅";

  const LAYER_PRIORITY: Record<string, number> = {
    WL: 0,
    L1: 1,
    L2: 2,
    L3: 3,
    L4: 4,
    L5: 5,
    L6c: 6,
    L7: 7,
    L8: 8,
    L8b: 9,
  };
  const layerPriority = (layers: string[]) =>
    layers.reduce((min, l) => Math.min(min, LAYER_PRIORITY[l] ?? 99), 99);

  const togglePrescanSort = (col: string) =>
    setPrescanSort((s) =>
      s.col === col
        ? { col, dir: s.dir === "desc" ? "asc" : "desc" }
        : { col, dir: "desc" },
    );

  const sortArrow = (col: string) =>
    prescanSort.col === col ? (prescanSort.dir === "desc" ? " ▼" : " ▲") : " ⇅";

  const [oiWatchSort, setOiWatchSort] = useState<{
    col: string;
    dir: "asc" | "desc";
  }>({
    col: "added",
    dir: "desc",
  });
  const toggleOiWatchSort = (col: string) =>
    setOiWatchSort((s) =>
      s.col === col
        ? { col, dir: s.dir === "desc" ? "asc" : "desc" }
        : { col, dir: "desc" },
    );
  const oiArrow = (col: string) =>
    oiWatchSort.col === col ? (oiWatchSort.dir === "desc" ? " ▼" : " ▲") : " ⇅";

  const sortedOiWatch = [...oiWatch].sort((a, b) => {
    const d = oiWatchSort.dir === "asc" ? 1 : -1;
    switch (oiWatchSort.col) {
      case "symbol":
        return d * a.symbol.localeCompare(b.symbol);
      case "oi30m":
        return d * ((a.oi30m ?? -999) - (b.oi30m ?? -999));
      case "oi1h":
        return d * ((a.oi1h ?? -999) - (b.oi1h ?? -999));
      case "oi4h":
        return d * ((a.oi4h ?? -999) - (b.oi4h ?? -999));
      case "oi24h":
        return d * ((a.oi24h ?? -999) - (b.oi24h ?? -999));
      case "oiAccel":
        return d * ((a.oiAccel30m ?? -999) - (b.oiAccel30m ?? -999));
      case "fsratio":
        return d * ((a.futSpotRatio ?? -1) - (b.futSpotRatio ?? -1));
      case "ftaker":
        return (
          d * ((a.futureTakerNetBuy ?? -999) - (b.futureTakerNetBuy ?? -999))
        );
      case "spotTaker":
        return d * ((a.spotTakerNetBuy ?? -999) - (b.spotTakerNetBuy ?? -999));
      case "mult":
        return d * ((a.volumeMultiplier ?? 0) - (b.volumeMultiplier ?? 0));
      case "spotVol":
        return d * ((a.spotVol24h ?? 0) - (b.spotVol24h ?? 0));
      case "p1h":
        return d * ((a.price1hChange ?? -999) - (b.price1hChange ?? -999));
      case "p24h":
        return d * ((a.price24hChange ?? -999) - (b.price24hChange ?? -999));
      case "entry":
        return d * (a.priceAtEntry - b.priceAtEntry);
      case "expires":
        return (
          d *
          (new Date(a.expiresAt).getTime() - new Date(b.expiresAt).getTime())
        );
      case "pattern":
        return d * (a.sentimentKey ?? "").localeCompare(b.sentimentKey ?? "");
      default:
        return (
          d * (new Date(a.addedAt).getTime() - new Date(b.addedAt).getTime())
        );
    }
  });

  const sortedPrescan = [...prescan].sort((a, b) => {
    const d = prescanSort.dir === "asc" ? 1 : -1;
    switch (prescanSort.col) {
      case "layer":
        return (
          d * (layerPriority(a.layers ?? []) - layerPriority(b.layers ?? []))
        );
      case "rank":
        return d * (a.bestRank - b.bestRank);
      case "p24h":
        return d * (a.lastPrice24h - b.lastPrice24h);
      case "p1h":
        return d * ((a.lastPrice1h ?? -999) - (b.lastPrice1h ?? -999));
      case "oi30m":
        return d * ((a.lastOi30m ?? -999) - (b.lastOi30m ?? -999));
      case "oi1h":
        return d * ((a.lastOi1h ?? -999) - (b.lastOi1h ?? -999));
      case "oi4h":
        return d * ((a.lastOi4h ?? -999) - (b.lastOi4h ?? -999));
      case "oi24h":
        return d * ((a.lastOi24h ?? -999) - (b.lastOi24h ?? -999));
      case "oiAccel":
        return d * ((a.oiAccel30m ?? -999) - (b.oiAccel30m ?? -999));
      case "fsratio":
        return d * ((a.futSpotRatio ?? -1) - (b.futSpotRatio ?? -1));
      case "priceDelta": {
        const aDelta =
          a.firstPrice != null && a.lastPrice != null && a.firstPrice > 0
            ? (a.lastPrice - a.firstPrice) / a.firstPrice
            : -999;
        const bDelta =
          b.firstPrice != null && b.lastPrice != null && b.firstPrice > 0
            ? (b.lastPrice - b.firstPrice) / b.firstPrice
            : -999;
        return d * (aDelta - bDelta);
      }
      case "spotTaker":
        return d * ((a.spotTakerNetBuy ?? -999) - (b.spotTakerNetBuy ?? -999));
      case "spotVol":
        return d * ((a.spotVol24h ?? 0) - (b.spotVol24h ?? 0));
      case "spotMult":
        return d * ((a.spotVolMult ?? 0) - (b.spotVolMult ?? 0));
      case "cycles":
        return d * (a.cycleCount - b.cycleCount);
      case "entryPx":
        return d * ((a.firstPrice ?? 0) - (b.firstPrice ?? 0));
      case "currPx":
        return d * ((a.lastPrice ?? 0) - (b.lastPrice ?? 0));
      case "status":
        return (
          d * (a.lastSkipReason ?? "").localeCompare(b.lastSkipReason ?? "")
        );
      case "added":
        return (
          d *
          (new Date(a.firstSeenAt).getTime() -
            new Date(b.firstSeenAt).getTime())
        );
      default:
        return d * (a.lastScore - b.lastScore);
    }
  });

  // ── Spot Vol sort ──────────────────────────────────────────────────────────
  const [spotVolSort, setSpotVolSort] = useState<{
    col: string;
    dir: "asc" | "desc";
  }>({
    col: "mult",
    dir: "desc",
  });
  const toggleSpotVolSort = (col: string) =>
    setSpotVolSort((s) =>
      s.col === col
        ? { col, dir: s.dir === "desc" ? "asc" : "desc" }
        : { col, dir: "desc" },
    );
  const svArrow = (col: string) =>
    spotVolSort.col === col ? (spotVolSort.dir === "desc" ? " ▼" : " ▲") : " ⇅";

  const sortedSpotVol = [...spotVolRows].sort((a, b) => {
    const d = spotVolSort.dir === "asc" ? 1 : -1;
    const aDelta =
      a.spotVolMult != null && a.prevSpotVolMult != null
        ? a.spotVolMult - a.prevSpotVolMult
        : null;
    const bDelta =
      b.spotVolMult != null && b.prevSpotVolMult != null
        ? b.spotVolMult - b.prevSpotVolMult
        : null;
    const aMult24h =
      a.lastSpotVol1h != null && a.spotVol24h != null && a.spotVol24h > 0
        ? (a.lastSpotVol1h * 24) / a.spotVol24h
        : null;
    const bMult24h =
      b.lastSpotVol1h != null && b.spotVol24h != null && b.spotVol24h > 0
        ? (b.lastSpotVol1h * 24) / b.spotVol24h
        : null;
    const aMcap =
      a.lastSpotVol1h != null && a.mcapUsd != null && a.mcapUsd > 0
        ? (a.lastSpotVol1h / a.mcapUsd) * 100
        : null;
    const bMcap =
      b.lastSpotVol1h != null && b.mcapUsd != null && b.mcapUsd > 0
        ? (b.lastSpotVol1h / b.mcapUsd) * 100
        : null;
    switch (spotVolSort.col) {
      case "symbol":
        return d * a.symbol.localeCompare(b.symbol);
      case "p24h":
        return d * ((a.lastPrice24h ?? -999) - (b.lastPrice24h ?? -999));
      case "p1h":
        return d * ((a.lastPrice1h ?? -999) - (b.lastPrice1h ?? -999));
      case "oi30m":
        return d * ((a.lastOi30m ?? -999) - (b.lastOi30m ?? -999));
      case "oi1h":
        return d * ((a.lastOi1h ?? -999) - (b.lastOi1h ?? -999));
      case "oi4h":
        return d * ((a.lastOi4h ?? -999) - (b.lastOi4h ?? -999));
      case "vol1h":
        return d * ((a.lastSpotVol1h ?? -1) - (b.lastSpotVol1h ?? -1));
      case "mult":
        return d * ((a.spotVolMult ?? -1) - (b.spotVolMult ?? -1));
      case "prevMult":
        return d * ((a.prevSpotVolMult ?? -1) - (b.prevSpotVolMult ?? -1));
      case "delta":
        return d * ((aDelta ?? -999) - (bDelta ?? -999));
      case "vol4h":
        return d * ((a.lastSpotVol4h ?? -1) - (b.lastSpotVol4h ?? -1));
      case "mult24h":
        return d * ((aMult24h ?? -1) - (bMult24h ?? -1));
      case "netbuy":
        return (
          d * ((a.lastSpotNetBuy1h ?? -999) - (b.lastSpotNetBuy1h ?? -999))
        );
      case "staker":
        return d * ((a.spotTakerNetBuy ?? -999) - (b.spotTakerNetBuy ?? -999));
      case "cvd1h":
        return d * ((a.cvd1h ? 1 : 0) - (b.cvd1h ? 1 : 0));
      case "cvd4h":
        return d * ((a.cvd4h ? 1 : 0) - (b.cvd4h ? 1 : 0));
      case "oi24h":
        return d * ((a.lastOi24h ?? -999) - (b.lastOi24h ?? -999));
      case "mcap":
        return d * ((aMcap ?? -1) - (bMcap ?? -1));
      case "fvolpct":
        return d * ((a.futVolPctMcap ?? -1) - (b.futVolPctMcap ?? -1));
      case "svolpct":
        return d * ((a.spotVolPctMcap ?? -1) - (b.spotVolPctMcap ?? -1));
      case "fsratio":
        return d * ((a.futSpotRatio ?? -1) - (b.futSpotRatio ?? -1));
      case "cycles":
        return d * ((a.spotVolCycles ?? 0) - (b.spotVolCycles ?? 0));
      case "layer":
        return (
          d * (layerPriority(a.layers ?? []) - layerPriority(b.layers ?? []))
        );
      default:
        return d * ((a.spotVolMult ?? -1) - (b.spotVolMult ?? -1));
    }
  });

  // ── Layer 10 Liq Cascade (для счётчика вкладки) ────────────────────────────
  const { data: liqCascadeData } = useGetLiqCascade(
    { hours: 24 },
    {
      query: {
        queryKey: getGetLiqCascadeQueryKey({ hours: 24 }),
        staleTime: 15_000,
        refetchInterval: tab === "liq_cascade" ? 60_000 : false,
        refetchIntervalInBackground: false,
        enabled: tab === "liq_cascade",
      },
    },
  );
  const liqCascadeWatching = (liqCascadeData?.entries ?? []).filter(
    (e) => e.status === "watching",
  ).length;

  const { data: rangeBreakoutRows } = useRangeBreakoutCandidates();
  const { data: abneonRows } = useAbneonCandidates();
  const counts: Record<Tab, number> = {
    range_breakout: rangeBreakoutRows?.length ?? 0,
    abneon: abneonRows?.length ?? 0,
    prescan: data?.totalPrescan ?? prescan.length,
    oi_watch: data?.totalOiWatch ?? oiWatch.length,
    cycle: cycleCandidates.length,
    spot_vol: spotVolRows.length,
    liq_cascade: liqCascadeWatching,
  };

  const fq = filterQ.trim().toLowerCase();
  const layerFilteredCycleCandidates = selectedLayer
    ? cycleCandidates.filter((candidate) =>
        candidate.layers.includes(selectedLayer),
      )
    : cycleCandidates;

  const lastUpdated = dataUpdatedAt
    ? new Date(dataUpdatedAt).toLocaleTimeString("ru-RU", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      })
    : "—";

  return (
    <div className="space-y-6">
      <SymbolHistorySheet
        symbol={selectedSymbol}
        onClose={() => setSelectedSymbol(null)}
      />

      {/* Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold text-foreground">
            Воронка сканера
          </h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Кандидаты до финального сигнала — обновляется каждые 15с
          </p>
        </div>
        <div className="flex w-full flex-wrap items-center justify-between gap-2 sm:w-auto sm:justify-end">
          {/* Scan status badge */}
          {scannerStatus && (
            <ScanStatusBadge
              isScanning={scannerStatus.isScanning}
              scanStartedAt={scannerStatus.scanStartedAt ?? null}
              lastScanDurationMs={scannerStatus.lastScanDurationMs ?? null}
              lastScanAt={scannerStatus.lastScanAt ?? null}
            />
          )}
          <span className="whitespace-nowrap text-xs text-muted-foreground">
            обновлено {lastUpdated}
          </span>
          <button
            onClick={() => refetch()}
            className="p-1.5 rounded hover:bg-muted transition-colors text-muted-foreground hover:text-foreground"
          >
            <RefreshCw
              className={`w-4 h-4 ${isLoading ? "animate-spin" : ""}`}
            />
          </button>
        </div>
      </div>

      {/* Pipeline overview */}
      <div className="rounded-lg border border-border bg-muted/10 p-4 text-xs">
        <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider mb-3">
          Воронка сканера — путь от рынка до сигнала
        </p>

        {/* Main concept cards */}
        <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-2 mb-4">
          <button
            type="button"
            onClick={() => openPhaseTokens("oi_watch")}
            aria-label="Открыть токены OI Watch"
            className="cursor-pointer rounded border border-yellow-500/25 bg-yellow-500/5 p-2.5 text-left transition hover:-translate-y-0.5 hover:border-yellow-400/60 hover:bg-yellow-500/10 hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-yellow-400/60 active:translate-y-0"
          >
            <div className="flex items-center gap-1.5 mb-1.5">
              <Eye className="w-3 h-3 text-yellow-400" />
              <span className="font-semibold text-yellow-400 tracking-wide">
                OI WATCH
              </span>
            </div>
            <p className="text-muted-foreground leading-relaxed">
              Окно ожидания 6–12ч: <span className="text-blue-400">PATH A</span>{" "}
              — OI накоплено, ждём цену (6ч);{" "}
              <span className="text-blue-400">PATH B</span> — тихое накопление +
              объём (6ч); L8b проактивный (12ч). Статусы:{" "}
              <em>watching → fired / expired</em>.
            </p>
            <span className="mt-1.5 block text-[9px] font-medium text-yellow-300/80">
              Открыть токены →
            </span>
          </button>
          <button
            type="button"
            onClick={() => openPhaseTokens("prescan")}
            aria-label="Открыть токены Prescan"
            className="cursor-pointer rounded border border-orange-500/25 bg-orange-500/5 p-2.5 text-left transition hover:-translate-y-0.5 hover:border-orange-400/60 hover:bg-orange-500/10 hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-400/60 active:translate-y-0"
          >
            <div className="flex items-center gap-1.5 mb-1.5">
              <Flame className="w-3 h-3 text-orange-400" />
              <span className="font-semibold text-orange-400 tracking-wide">
                PRESCAN
              </span>
            </div>
            <p className="text-muted-foreground leading-relaxed">
              500+ USDT-перп пар → 15+ слоёв формируют батч 100–400 токенов.
            </p>
            <span className="mt-1.5 block text-[9px] font-medium text-orange-300/80">
              Открыть токены →
            </span>
          </button>
          <button
            type="button"
            onClick={() => openPhaseTokens("spot_vol")}
            aria-label="Открыть токены Спот"
            className="cursor-pointer rounded border border-cyan-500/25 bg-cyan-500/5 p-2.5 text-left transition hover:-translate-y-0.5 hover:border-cyan-400/60 hover:bg-cyan-500/10 hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/60 active:translate-y-0"
          >
            <div className="flex items-center gap-1.5 mb-1.5">
              <BarChart2 className="w-3 h-3 text-cyan-400" />
              <span className="font-semibold text-cyan-400 tracking-wide">
                СПОТ
              </span>
            </div>
            <p className="text-muted-foreground leading-relaxed">
              Токены с аномальным спот-объёмом (spotVolMult ≥1.5x). Показывает
              spotVolCycles ≥1.
            </p>
            <span className="mt-1.5 block text-[9px] font-medium text-cyan-300/80">
              Открыть токены →
            </span>
          </button>
          <button
            type="button"
            onClick={() => openPhaseTokens("cycle")}
            aria-label="Открыть кандидатов последнего цикла"
            className="cursor-pointer rounded border border-violet-500/25 bg-violet-500/5 p-2.5 text-left transition hover:-translate-y-0.5 hover:border-violet-400/60 hover:bg-violet-500/10 hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400/60 active:translate-y-0"
          >
            <div className="flex items-center gap-1.5 mb-1.5">
              <List className="w-3 h-3 text-violet-400" />
              <span className="font-semibold text-violet-400 tracking-wide">
                КАНДИДАТЫ
              </span>
            </div>
            <p className="text-muted-foreground leading-relaxed">
              Последний рубеж перед сигналом: токены deep scan ещё проходят
              проверки паттернов и финальные гейты. Прошедшие попадают в трекер
              и Telegram.
            </p>
            <span className="mt-1.5 block text-[9px] font-medium text-violet-300/80">
              Открыть кандидатов →
            </span>
          </button>
          <div className="rounded border border-green-500/25 bg-green-500/5 p-2.5">
            <div className="flex items-center gap-1.5 mb-1.5">
              <Zap className="w-3 h-3 text-green-400" />
              <span className="font-semibold text-green-400 tracking-wide">
                СИГНАЛ
              </span>
            </div>
            <p className="text-muted-foreground leading-relaxed">
              Все гейты пройдены: OI + объём (фьюч/спот) + CVD + цена + funding
              → трекер + Telegram. 10+ паттернов.
            </p>
          </div>
        </div>

        {/* Layer cards grid */}
        <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-2">
          Слои прескана и фоновые пулы
        </p>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6 gap-1.5">
          {LAYER_INFO.map(({ tag, name, bg, border, badge, desc }) => (
            <button
              key={tag}
              type="button"
              onClick={() => openLayerTokens(tag)}
              aria-label={`Открыть токены слоя ${tag}: ${name}`}
              className={`rounded border ${border} ${bg} p-2 text-left transition hover:-translate-y-0.5 hover:bg-muted/30 hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60`}
            >
              <div className="flex items-center gap-1.5 mb-1">
                <span
                  className={`shrink-0 font-mono font-bold text-[10px] px-1.5 py-0.5 rounded border leading-none ${badge}`}
                >
                  {tag}
                </span>
                <span className="text-[11px] font-semibold text-foreground/70 leading-tight">
                  {name}
                </span>
              </div>
              <p className="text-[10px] text-muted-foreground leading-snug">
                {desc}
              </p>
              <span className="mt-1.5 block text-[9px] font-medium text-primary/70">
                Открыть токены →
              </span>
            </button>
          ))}
        </div>

        <p className="text-[10px] text-muted-foreground mt-3 px-0.5">
          <span className="text-yellow-400 font-medium">OI Watch</span>,{" "}
          <span className="text-orange-400 font-medium">Prescan</span>,{" "}
          <span className="text-cyan-400 font-medium">Спот</span> — параллельные
          фазы. L10 — фоновый пул с отдельной вкладкой. Vol 1.0x = норма, vol
          ≥1.5–2x = повышенный (подтверждение).
        </p>
      </div>

      {/* Tab nav + content card */}
      <Card id="scanner-token-lists">
        <CardHeader className="pb-0 pt-4 px-4">
          <TabNav active={tab} onChange={setTab} counts={counts} />
          <div className="relative mt-3">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground pointer-events-none" />
            <input
              type="text"
              value={filterQ}
              onChange={(e) => setFilterQ(e.target.value)}
              placeholder="Поиск по символу…"
              className="w-full pl-8 pr-3 py-1.5 text-xs bg-muted/30 border border-border/40 rounded-md text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-border/70 transition-colors"
            />
          </div>
        </CardHeader>

        <CardContent className="pt-4">
          {/* ── OI Watch ── */}
          {tab === "oi_watch" && (
            <>
              <div className="flex items-center gap-2 mb-4">
                <Eye className="w-4 h-4 text-orange-400" />
                <span className="text-sm font-medium">
                  Ждут подтверждения объёма
                </span>
                <Badge variant="outline" className="text-xs ml-auto">
                  {oiWatch.length}
                </Badge>
              </div>
              {oiWatch.length === 0 ? (
                <p className="text-xs text-muted-foreground text-center py-8">
                  {isLoading ? "Загрузка…" : "Очередь пуста — сигналов нет"}
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-border text-muted-foreground">
                        {(
                          [
                            { key: "symbol", label: "Символ", align: "left" },
                            { key: null, label: "Статус", align: "left" },
                            { key: null, label: "ТФ", align: "left" },
                            {
                              key: "oi30m",
                              label: "OI 30m",
                              align: "right",
                            },
                            {
                              key: "oi1h",
                              label: "OI 1h",
                              align: "right",
                            },
                            {
                              key: "oi4h",
                              label: "OI 4h",
                              align: "right",
                            },
                            {
                              key: "oi24h",
                              label: "OI 24h",
                              align: "right",
                            },
                            {
                              key: null,
                              label: "CVD 30m",
                              align: "center",
                              title:
                                "Spot CVD 30m verdict при входе (signalPayload)",
                            },
                            {
                              key: "ftaker",
                              label: "Фьюч тейкер",
                              align: "right",
                              title: "Futures taker net buy % (CoinGlass)",
                            },
                            {
                              key: null,
                              label: "CVD 1h",
                              align: "center",
                            },
                            {
                              key: null,
                              label: "CVD 4h",
                              align: "center",
                            },
                            {
                              key: "oiAccel",
                              label: "OI Acc",
                              align: "right",
                              title:
                                "OI 30m ускорение: lastOi30m / prevOi30m (>1 = растёт)",
                            },
                            {
                              key: "fsratio",
                              label: "F/S",
                              align: "right",
                              title:
                                "Futures/Spot volume ratio 24h (Binance+OKX+Bybit)",
                            },
                            {
                              key: "spotTaker",
                              label: "Спот тейкер",
                              align: "right",
                              title: "Net buy % спот-тейкера (CoinGlass)",
                            },
                            { key: "p1h", label: "1h%", align: "right" },
                            { key: "pattern", label: "Паттерн", align: "left" },
                            {
                              key: "entry",
                              label: "ВХОД",
                              align: "right",
                            },
                            { key: null, label: "ЦЕНА", align: "right" },
                            { key: "added", label: "ДАТА", align: "right" },
                            {
                              key: "expires",
                              label: "Истекает",
                              align: "right",
                            },
                            {
                              key: null,
                              label: "SNF 1h",
                              align: "right",
                              title:
                                "Spot NetFlow 1h — net buy/sell % (CoinGlass)",
                            },
                            {
                              key: null,
                              label: "SNF 4h",
                              align: "right",
                              title: "Spot NetFlow 4h",
                            },
                            {
                              key: null,
                              label: "SNF 24h",
                              align: "right",
                              title: "Spot NetFlow 24h",
                            },
                            {
                              key: null,
                              label: "WI",
                              align: "right",
                              title: "CoinGlass Whale Index (Binance 4h)",
                            },
                            {
                              key: null,
                              label: "Покрытие",
                              align: "left",
                              title: "CG futures / Binance spot coverage",
                            },
                          ] as {
                            key: string | null;
                            label: string;
                            align: string;
                            title?: string;
                          }[]
                        ).map(({ key, label, align, title }) => (
                          <th
                            key={label}
                            title={title}
                            onClick={
                              key ? () => toggleOiWatchSort(key) : undefined
                            }
                            className={`py-2 pr-4 font-medium whitespace-nowrap ${align === "right" ? "text-right" : align === "center" ? "text-center" : "text-left"} ${key ? "cursor-pointer select-none hover:text-foreground transition-colors" : ""}`}
                          >
                            {label}
                            {key ? oiArrow(key) : ""}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {sortedOiWatch
                        .filter(
                          (r) => !fq || r.symbol.toLowerCase().includes(fq),
                        )
                        .map((row) => (
                          <tr
                            key={row.id}
                            className="border-b border-border/40 hover:bg-muted/20 transition-colors"
                          >
                            <td className="py-2 pr-4">
                              <div className="flex items-center gap-1.5">
                                <TokenChartLink symbol={row.symbol} />
                                <button
                                  onClick={() => setSelectedSymbol(row.symbol)}
                                  title="История наблюдения"
                                  className="text-muted-foreground/40 hover:text-muted-foreground transition-colors"
                                >
                                  <History className="w-3 h-3" />
                                </button>
                                {row.hasActiveSignal && (
                                  <span
                                    title="По этому символу уже есть активный сигнал в трекере"
                                    className="text-[10px] font-semibold px-1 py-0.5 rounded bg-green-500/20 text-green-400 border border-green-500/30 leading-none"
                                  >
                                    ⚡SIG
                                  </span>
                                )}
                              </div>
                            </td>
                            <td className="py-2 pr-4">
                              {(() => {
                                const reason = row.volStatusReason;
                                if (reason === "confirmed") {
                                  return (
                                    <span className="text-[11px] text-green-400">
                                      ✅ Объём подтверждён — ждём цену
                                    </span>
                                  );
                                }
                                if (reason === "cvd_unavail") {
                                  return (
                                    <span className="text-[11px] text-yellow-400/70">
                                      ⏳ Нет спот CVD
                                    </span>
                                  );
                                }
                                if (reason === "cvd_negative") {
                                  return (
                                    <span className="text-[11px] text-red-400/80">
                                      ⏳ Спот CVD минус
                                    </span>
                                  );
                                }
                                if (reason === "no_turnover") {
                                  return (
                                    <span className="text-[11px] text-yellow-400/70">
                                      ⏳ Объём недостаточен (turnover &lt; 15%)
                                    </span>
                                  );
                                }
                                // reason=null: PATH A (isVolConfirmed=true) — объём подтверждён сканнером,
                                // watcher ждёт движение цены. volStatusReason не ставится для PATH A.
                                // PATH B (dark_flow, steady, cg_timeout...) — triggerTf в SPECIAL_TF_LABELS.
                                if (!SPECIAL_TF_LABELS[row.triggerTf]) {
                                  return (
                                    <span className="text-[11px] text-blue-400/70">
                                      ⏳ Ждём движение цены
                                    </span>
                                  );
                                }
                                return (
                                  <span className="text-[11px] text-yellow-400/70">
                                    ⏳ Нет данных объёма (CG)
                                  </span>
                                );
                              })()}
                            </td>
                            <td className="py-2 pr-4">
                              <TfGrid triggerTf={row.triggerTf} />
                            </td>
                            {(["oi30m", "oi1h"] as const).map((key) => {
                              const val = row[key];
                              return (
                                <td
                                  key={key}
                                  className="py-2 pr-4 text-right font-mono text-[11px]"
                                >
                                  {val != null ? (
                                    <span
                                      className={
                                        val >= 5
                                          ? "text-green-400 font-semibold"
                                          : val > 0
                                            ? "text-green-400/70"
                                            : "text-red-400/70"
                                      }
                                    >
                                      {val >= 0 ? "+" : ""}
                                      {val.toFixed(1)}%
                                    </span>
                                  ) : (
                                    <span className="text-border">—</span>
                                  )}
                                </td>
                              );
                            })}
                            <td className="py-2 pr-4 text-right font-mono text-[11px]">
                              {row.oi4h != null ? (
                                <span
                                  className={
                                    row.oi4h >= 5
                                      ? "text-green-400 font-semibold"
                                      : row.oi4h > 0
                                        ? "text-green-400/70"
                                        : "text-red-400/70"
                                  }
                                >
                                  {row.oi4h >= 0 ? "+" : ""}
                                  {row.oi4h.toFixed(1)}%
                                </span>
                              ) : (
                                <span className="text-border">—</span>
                              )}
                            </td>
                            {/* OI 24h */}
                            <td className="py-2 pr-4 text-right font-mono text-[11px]">
                              {row.oi24h != null ? (
                                <span
                                  className={
                                    row.oi24h >= 10
                                      ? "text-green-400 font-semibold"
                                      : row.oi24h > 0
                                        ? "text-green-400/70"
                                        : "text-red-400/70"
                                  }
                                >
                                  {row.oi24h >= 0 ? "+" : ""}
                                  {row.oi24h.toFixed(1)}%
                                </span>
                              ) : (
                                <span className="text-border">—</span>
                              )}
                            </td>
                            {/* CVD 30m — live + signalPayload fallback */}
                            <td className="py-2 pr-4 text-center">
                              {row.cvd30m != null ? (
                                row.cvd30m ? (
                                  <span className="text-green-400 font-bold">
                                    ✓
                                  </span>
                                ) : (
                                  <span className="text-red-400/60">✗</span>
                                )
                              ) : (
                                <span className="text-border text-[10px]">
                                  —
                                </span>
                              )}
                            </td>
                            <td className="py-2 pr-4 text-right font-mono text-[11px]">
                              {row.futureTakerNetBuy != null ? (
                                <span
                                  className={
                                    row.futureTakerNetBuy >= 10
                                      ? "text-green-400 font-semibold"
                                      : row.futureTakerNetBuy >= 0
                                        ? "text-green-400/60"
                                        : "text-red-400"
                                  }
                                >
                                  {row.futureTakerNetBuy >= 0 ? "+" : ""}
                                  {row.futureTakerNetBuy.toFixed(1)}%
                                </span>
                              ) : (
                                <span className="text-border">—</span>
                              )}
                            </td>
                            {[
                              { key: "cvd1h" as const },
                              { key: "cvd4h" as const },
                            ].map(({ key }) => (
                              <td key={key} className="py-2 pr-4 text-center">
                                {row[key] != null ? (
                                  row[key] ? (
                                    <span className="text-green-400 font-bold">
                                      ✓
                                    </span>
                                  ) : (
                                    <span className="text-red-400/60">✗</span>
                                  )
                                ) : (
                                  <span className="text-border text-[10px]">
                                    —
                                  </span>
                                )}
                              </td>
                            ))}
                            {/* OI Acc */}
                            <td className="py-2 pr-4 text-right font-mono text-[11px]">
                              {row.oiAccel30m != null ? (
                                <span
                                  className={
                                    row.oiAccel30m >= 1.5
                                      ? "text-orange-400 font-semibold"
                                      : row.oiAccel30m >= 1.0
                                        ? "text-yellow-400/80"
                                        : "text-red-400/60"
                                  }
                                >
                                  ×{row.oiAccel30m.toFixed(1)}
                                </span>
                              ) : (
                                <span className="text-border text-[10px]">
                                  —
                                </span>
                              )}
                            </td>
                            {/* F/S ratio */}
                            <td className="py-2 pr-4 text-right font-mono text-[11px]">
                              {row.futSpotRatio != null ? (
                                <span
                                  className={
                                    row.futSpotRatio >= 5
                                      ? "text-orange-400 font-semibold"
                                      : row.futSpotRatio >= 2
                                        ? "text-yellow-400/80"
                                        : "text-muted-foreground/60"
                                  }
                                >
                                  {row.futSpotRatio.toFixed(1)}×
                                </span>
                              ) : (
                                <span className="text-border text-[10px]">
                                  —
                                </span>
                              )}
                            </td>
                            <td className="py-2 pr-4 text-right font-mono text-[11px]">
                              {fmtTaker(
                                row.spotTakerNetBuy ?? null,
                                row.spotTakerExchange ?? null,
                              )}
                            </td>
                            {[
                              { key: "1h%", val: row.price1hChange ?? null },
                            ].map(({ key, val }) => (
                              <td
                                key={key}
                                className="py-2 pr-4 text-right font-mono text-[11px]"
                              >
                                {val != null ? (
                                  <span
                                    className={
                                      val >= 3
                                        ? "text-green-400 font-semibold"
                                        : val > 0
                                          ? "text-green-400/70"
                                          : val < -3
                                            ? "text-red-400 font-semibold"
                                            : "text-red-400/70"
                                    }
                                  >
                                    {val >= 0 ? "+" : ""}
                                    {val.toFixed(1)}%
                                  </span>
                                ) : (
                                  <span className="text-border">—</span>
                                )}
                              </td>
                            ))}
                            <td className="py-2 pr-4 text-muted-foreground">
                              <span className="flex items-center gap-1">
                                {(
                                  row as typeof row & {
                                    upcomingUnlock?: {
                                      daysUntil: number;
                                      pctSupply: number;
                                    } | null;
                                  }
                                ).upcomingUnlock != null && (
                                  <span
                                    className="text-orange-400 text-[11px]"
                                    title={`⚠️ Разлок через ${(row as typeof row & { upcomingUnlock?: { daysUntil: number; pctSupply: number } | null }).upcomingUnlock!.daysUntil} дн: ${(row as typeof row & { upcomingUnlock?: { daysUntil: number; pctSupply: number } | null }).upcomingUnlock!.pctSupply.toFixed(1)}% supply`}
                                  >
                                    ⚠️
                                  </span>
                                )}
                                {getPatternTgLabel(row.sentimentKey)}
                              </span>
                            </td>
                            <td className="py-2 pr-4 text-right font-mono text-[11px]">
                              <span className="text-foreground/70">
                                {fmtPrice(row.priceAtEntry)}
                              </span>
                            </td>
                            <td className="py-2 pr-4 text-right font-mono text-[11px]">
                              {row.currentPrice != null ? (
                                (() => {
                                  const pct =
                                    ((row.currentPrice - row.priceAtEntry) /
                                      row.priceAtEntry) *
                                    100;
                                  return (
                                    <span>
                                      <span
                                        className={
                                          pct >= 2
                                            ? "text-green-400 font-semibold"
                                            : pct >= 0
                                              ? "text-green-400/70"
                                              : pct >= -2
                                                ? "text-red-400/60"
                                                : "text-red-400 font-semibold"
                                        }
                                      >
                                        {fmtPrice(row.currentPrice)}
                                      </span>
                                      <div
                                        className={`text-[9px] ${pct >= 0 ? "text-green-400/60" : "text-red-400/60"}`}
                                      >
                                        {pct >= 0 ? "+" : ""}
                                        {pct.toFixed(1)}%
                                      </div>
                                    </span>
                                  );
                                })()
                              ) : (
                                <span className="text-border">—</span>
                              )}
                            </td>
                            <td className="py-2 pr-4 text-right whitespace-nowrap">
                              <span className="font-mono text-[11px] text-foreground/80">
                                {fmtDateTime(row.addedAt)}
                              </span>
                              <div className="text-[9px] text-muted-foreground/60">
                                {timeAgo(row.addedAt)} назад
                              </div>
                            </td>
                            <td className="py-2 text-right">
                              <span className="text-muted-foreground font-mono">
                                {expiresIn(row.expiresAt)}
                              </span>
                            </td>
                            {snfCells(snfMap, row.symbol)}
                            <td className="py-2 pr-4 text-right font-mono text-[11px]">
                              {row.whaleIndex != null ? (
                                <span
                                  className={
                                    row.whaleIndex >= 10
                                      ? "text-green-400"
                                      : row.whaleIndex <= -10
                                        ? "text-red-400"
                                        : "text-muted-foreground"
                                  }
                                >
                                  {row.whaleIndex > 0 ? "+" : ""}
                                  {row.whaleIndex.toFixed(0)}
                                </span>
                              ) : (
                                <span className="text-border">—</span>
                              )}
                            </td>
                            {/* Coverage badges */}
                            <td className="py-2 pr-4">
                              {(
                                row as typeof row & {
                                  isBingxExclusive?: boolean | null;
                                }
                              ).isBingxExclusive === true ? (
                                <span
                                  title="BingX-exclusive: нет на Binance spot и нет в CoinGlass futures"
                                  className="text-[9px] font-mono px-1 py-0.5 rounded border bg-zinc-500/20 text-zinc-400 border-zinc-500/30 whitespace-nowrap"
                                >
                                  BX only
                                </span>
                              ) : (
                                <div className="flex gap-0.5">
                                  <span
                                    title={
                                      (
                                        row as typeof row & {
                                          hasCgFutures?: boolean | null;
                                        }
                                      ).hasCgFutures === true
                                        ? "CoinGlass futures OI: покрыт"
                                        : (
                                              row as typeof row & {
                                                hasCgFutures?: boolean | null;
                                              }
                                            ).hasCgFutures === false
                                          ? "CoinGlass futures OI: нет данных"
                                          : "CoinGlass futures OI: загрузка…"
                                    }
                                    className={`text-[9px] font-mono px-1 py-0.5 rounded border leading-none ${
                                      (
                                        row as typeof row & {
                                          hasCgFutures?: boolean | null;
                                        }
                                      ).hasCgFutures === true
                                        ? "bg-blue-500/20 text-blue-300 border-blue-500/30"
                                        : "bg-zinc-500/10 text-zinc-600 border-zinc-600/20"
                                    }`}
                                  >
                                    CG
                                  </span>
                                  <span
                                    title={
                                      (
                                        row as typeof row & {
                                          isBinanceSpotListed?: boolean | null;
                                        }
                                      ).isBinanceSpotListed === true
                                        ? "Binance spot: листингован"
                                        : (
                                              row as typeof row & {
                                                isBinanceSpotListed?:
                                                  | boolean
                                                  | null;
                                              }
                                            ).isBinanceSpotListed === false
                                          ? "Binance spot: не листингован"
                                          : "Binance spot: загрузка…"
                                    }
                                    className={`text-[9px] font-mono px-1 py-0.5 rounded border leading-none ${
                                      (
                                        row as typeof row & {
                                          isBinanceSpotListed?: boolean | null;
                                        }
                                      ).isBinanceSpotListed === true
                                        ? "bg-green-500/20 text-green-300 border-green-500/30"
                                        : "bg-zinc-500/10 text-zinc-600 border-zinc-600/20"
                                    }`}
                                  >
                                    Sp
                                  </span>
                                </div>
                              )}
                            </td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </div>
              )}
              <div className="text-[10px] text-muted-foreground mt-3 px-1 space-y-1">
                <p>
                  OI-порог пройден, ждём подтверждения объёма (один шаг до
                  сигнала).{" "}
                  <span className="text-yellow-400">Подтверждение</span> = 7-мин
                  окно проверки устойчивости. ТФ-сетка:{" "}
                  <span className="text-orange-400">30m</span> /{" "}
                  <span className="text-red-400">1h</span> /{" "}
                  <span className="text-purple-400">4h</span> /{" "}
                  <span className="text-blue-400">24h</span>.
                </p>
                <p className="pt-1 border-t border-border/30 font-medium text-foreground/50">
                  Расшифровка статусов:
                </p>
                <p>
                  <span className="text-green-400">
                    ✅ Объём подтверждён — ждём цену
                  </span>{" "}
                  — PATH A: OI+объём прошли, вотчер ждёт роста цены на +1.5–2%
                  для выхода сигнала.
                </p>
                <p>
                  <span className="text-blue-400/80">
                    ⏳ Ждём движение цены
                  </span>{" "}
                  — PATH A: объём подтверждён ещё в сканере, вотчер мониторит
                  цену.
                </p>
                <p>
                  <span className="text-yellow-400/80">
                    ⏳ Объём недостаточен (turnover &lt; 15%)
                  </span>{" "}
                  — PATH B: OI накапливается, но объём пока не пришёл. Порог —
                  15% оборот или ×1.5 объём.
                </p>
                <p>
                  <span className="text-yellow-400/80">⏳ Нет спот CVD</span> —
                  данные с биржи временно недоступны, ждём следующего
                  обновления.
                </p>
                <p>
                  <span className="text-red-400/80">⏳ Спот CVD минус</span> —
                  на споте идут продажи, не подтверждает накопление. Ждём
                  разворота CVD.
                </p>
                <p>
                  <span className="text-yellow-400/80">
                    ⏳ Нет данных объёма (CG)
                  </span>{" "}
                  — CoinGlass не ответил, вотчер продолжит проверку на следующем
                  цикле.
                </p>
              </div>

              {/* OI Watch pagination */}
              {(candOffset > 0 || data?.nextOffset != null) && (
                <div className="flex items-center justify-between mt-3 pt-2 border-t border-border/30">
                  <button
                    className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                    disabled={candOffset === 0 || isLoading}
                    onClick={() =>
                      setCandOffset(Math.max(0, candOffset - CAND_PAGE_SIZE))
                    }
                  >
                    <ChevronLeft className="w-3 h-3" />
                    Назад
                  </button>
                  <span className="text-[11px] text-muted-foreground font-mono">
                    {candOffset + 1}–{candOffset + oiWatch.length} /{" "}
                    {data?.totalOiWatch ?? "…"}
                  </span>
                  <button
                    className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                    disabled={data?.nextOffset == null || isLoading}
                    onClick={() =>
                      data?.nextOffset != null && setCandOffset(data.nextOffset)
                    }
                  >
                    Вперёд
                    <ChevronRight className="w-3 h-3" />
                  </button>
                </div>
              )}
            </>
          )}

          {/* ── Prescan ── */}
          {tab === "prescan" && (
            <>
              <div className="flex items-center gap-2 mb-3">
                <Flame className="w-4 h-4 text-red-400" />
                <span className="text-sm font-medium">
                  Горячие кандидаты текущего цикла
                </span>
                <Badge variant="outline" className="text-xs ml-auto">
                  {data?.totalPrescan != null
                    ? `${prescan.length} / ${data.totalPrescan}`
                    : prescan.length}
                </Badge>
              </div>

              {/* Coverage filter */}
              <div className="flex items-center gap-1.5 mb-4 flex-wrap">
                <span className="text-[11px] text-muted-foreground mr-0.5">
                  Покрытие:
                </span>
                {(
                  [
                    { key: "all", label: "Все" },
                    {
                      key: "bingx_only",
                      label: "BX only",
                      title:
                        "Только на BingX — нет на Binance spot и CG futures",
                    },
                    {
                      key: "binance_spot",
                      label: "Binance spot ✓",
                      title:
                        "Листинг на Binance spot (CoinGlass exchange-pairs)",
                    },
                    {
                      key: "cg_futures",
                      label: "CG futures ✓",
                      title: "Есть покрытие OI в CoinGlass futures",
                    },
                  ] as {
                    key: "all" | "bingx_only" | "binance_spot" | "cg_futures";
                    label: string;
                    title?: string;
                  }[]
                ).map(({ key, label, title }) => (
                  <button
                    key={key}
                    title={title}
                    onClick={() => setCoverageFilter(key)}
                    className={`text-[11px] px-2 py-0.5 rounded border transition-colors ${
                      coverageFilter === key
                        ? key === "bingx_only"
                          ? "bg-zinc-500/30 border-zinc-400/50 text-zinc-200"
                          : key === "binance_spot"
                            ? "bg-green-500/20 border-green-400/50 text-green-300"
                            : key === "cg_futures"
                              ? "bg-blue-500/20 border-blue-400/50 text-blue-300"
                              : "bg-muted/50 border-border text-foreground"
                        : "bg-transparent border-border/40 text-muted-foreground hover:text-foreground hover:border-border"
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>

              {prescan.length === 0 ? (
                <p className="text-xs text-muted-foreground text-center py-8">
                  {isLoading
                    ? "Загрузка…"
                    : "Нет кандидатов — сканер ещё не завершил цикл или сервер только запустился"}
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-border text-muted-foreground">
                        {(
                          [
                            {
                              key: "rank",
                              label: "Ранг",
                              align: "left",
                              title: "Лучший ранг в топ-500 по activity score",
                            },
                            {
                              key: null,
                              label: "Символ",
                              align: "left",
                              title: "",
                            },
                            {
                              key: null,
                              label: "Покрытие",
                              align: "left",
                              title:
                                "Биржевое покрытие: CG = CoinGlass futures OI, Sp = Binance spot listing. BX = только на BingX",
                            },
                            {
                              key: "layer",
                              label: "Слой",
                              align: "left",
                              title: "Слой prescan — источник попадания в батч",
                            },
                            {
                              key: "score",
                              label: "Скор",
                              align: "right",
                              title: "Activity score — взвешенный объём/OI",
                            },
                            {
                              key: "p24h",
                              label: "24h%",
                              align: "right",
                              title: "Изменение цены за 24ч",
                            },
                            {
                              key: "p1h",
                              label: "1h%",
                              align: "right",
                              title: "Изменение цены за 1ч",
                            },
                            {
                              key: "oi30m",
                              label: "OI 30m",
                              align: "right",
                              title: "Open Interest за 30m",
                            },
                            {
                              key: "oi1h",
                              label: "OI 1h",
                              align: "right",
                              title: "Open Interest за 1h",
                            },
                            {
                              key: "oi4h",
                              label: "OI 4h",
                              align: "right",
                              title: "Open Interest за 4h",
                            },
                            {
                              key: "oi24h",
                              label: "OI 24h",
                              align: "right",
                              title: "Open Interest за 24h",
                            },
                            {
                              key: null,
                              label: "CVD 30m",
                              align: "center",
                              title:
                                "Spot CVD 30m verdict (нетто покупки за 30m)",
                            },
                            {
                              key: null,
                              label: "CVD 1h",
                              align: "center",
                              title: "Spot CVD 1h verdict",
                            },
                            {
                              key: null,
                              label: "F TKR",
                              align: "right",
                              title:
                                "Futures taker net buy % (прокси ±50, CoinGlass)",
                            },
                            {
                              key: "oiAccel",
                              label: "OI Acc",
                              align: "right",
                              title:
                                "OI 30m ускорение: lastOi30m / prevOi30m (>1 = растёт)",
                            },
                            {
                              key: "fsratio",
                              label: "F/S",
                              align: "right",
                              title:
                                "Futures/Spot volume ratio 24h (Binance+OKX+Bybit)",
                            },
                            {
                              key: "spotTaker",
                              label: "Спот тейкер",
                              align: "right",
                              title: "Спот тейкер net buy % (CoinGlass)",
                            },
                            {
                              key: "cycles",
                              label: "Циклы",
                              align: "right",
                              title:
                                "Количество циклов подряд в топ-N (1 цикл ≈ 10 мин)",
                            },
                            {
                              key: "entryPx",
                              label: "ВХОД",
                              align: "right",
                              title:
                                "Цена в момент первого появления в prescan",
                            },
                            {
                              key: "currPx",
                              label: "ЦЕНА",
                              align: "right",
                              title:
                                "Текущая цена (последнее обновление цикла)",
                            },
                            {
                              key: "priceDelta",
                              label: "Δ с детекции",
                              align: "right",
                              title:
                                "Изменение цены с момента первого появления в prescan",
                            },
                            {
                              key: "added",
                              label: "ДАТА",
                              align: "right",
                              title: "Дата первого появления в prescan",
                            },
                            {
                              key: "status",
                              label: "Статус",
                              align: "left",
                              title: "Причина пропуска в последнем цикле",
                            },
                            {
                              key: null,
                              label: "SNF 1h",
                              align: "right",
                              title:
                                "Spot NetFlow 1h — net buy/sell % (CoinGlass)",
                            },
                            {
                              key: null,
                              label: "SNF 4h",
                              align: "right",
                              title: "Spot NetFlow 4h",
                            },
                            {
                              key: null,
                              label: "SNF 24h",
                              align: "right",
                              title: "Spot NetFlow 24h",
                            },
                            {
                              key: null,
                              label: "WI",
                              align: "right",
                              title: "CoinGlass Whale Index (Binance 4h)",
                            },
                          ] as {
                            key: string | null;
                            label: string;
                            align: string;
                            title: string;
                          }[]
                        ).map(({ key, label, align, title }) => (
                          <th
                            key={label}
                            title={title}
                            onClick={
                              key ? () => togglePrescanSort(key) : undefined
                            }
                            className={`py-2 pr-3 font-medium whitespace-nowrap ${align === "right" ? "text-right" : align === "center" ? "text-center" : "text-left"} ${key ? "cursor-pointer select-none hover:text-foreground transition-colors" : ""}`}
                          >
                            {label}
                            {key ? sortArrow(key) : ""}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {sortedPrescan
                        .filter((r) => {
                          if (fq && !r.symbol.toLowerCase().includes(fq))
                            return false;
                          if (coverageFilter === "bingx_only")
                            return r.isBingxExclusive === true;
                          if (coverageFilter === "binance_spot")
                            return r.isBinanceSpotListed === true;
                          if (coverageFilter === "cg_futures")
                            return r.hasCgFutures === true;
                          return true;
                        })
                        .map((row) => (
                          <tr
                            key={row.symbol}
                            className="border-b border-border/40 hover:bg-muted/20 transition-colors"
                          >
                            <td className="py-2 pr-3">
                              <span
                                className={`font-mono font-bold ${
                                  row.bestRank <= 3
                                    ? "text-yellow-400"
                                    : row.bestRank <= 10
                                      ? "text-orange-400"
                                      : "text-muted-foreground"
                                }`}
                              >
                                {row.bestRank >= 9999
                                  ? "—"
                                  : `#${row.bestRank}`}
                              </span>
                            </td>
                            <td className="py-2 pr-3">
                              <div className="flex items-center gap-1.5">
                                <TokenChartLink symbol={row.symbol} />
                                <button
                                  onClick={() => setSelectedSymbol(row.symbol)}
                                  title="История наблюдения"
                                  className="text-muted-foreground/40 hover:text-muted-foreground transition-colors"
                                >
                                  <History className="w-3 h-3" />
                                </button>
                              </div>
                            </td>
                            {/* Coverage badges: CG futures + Binance spot */}
                            <td className="py-2 pr-3">
                              {row.isBingxExclusive === true ? (
                                <span
                                  title="BingX-exclusive: нет на Binance spot и нет в CoinGlass futures"
                                  className="text-[9px] font-mono px-1 py-0.5 rounded border bg-zinc-500/20 text-zinc-400 border-zinc-500/30 whitespace-nowrap"
                                >
                                  BX only
                                </span>
                              ) : (
                                <div className="flex gap-0.5">
                                  <span
                                    title={
                                      row.hasCgFutures === true
                                        ? "CoinGlass futures OI: покрыт"
                                        : row.hasCgFutures === false
                                          ? "CoinGlass futures OI: нет данных"
                                          : "CoinGlass futures OI: загрузка…"
                                    }
                                    className={`text-[9px] font-mono px-1 py-0.5 rounded border leading-none ${
                                      row.hasCgFutures === true
                                        ? "bg-blue-500/20 text-blue-300 border-blue-500/30"
                                        : "bg-zinc-500/10 text-zinc-600 border-zinc-600/20"
                                    }`}
                                  >
                                    CG
                                  </span>
                                  <span
                                    title={
                                      row.isBinanceSpotListed === true
                                        ? "Binance spot: листингован"
                                        : row.isBinanceSpotListed === false
                                          ? "Binance spot: не листингован"
                                          : "Binance spot: загрузка…"
                                    }
                                    className={`text-[9px] font-mono px-1 py-0.5 rounded border leading-none ${
                                      row.isBinanceSpotListed === true
                                        ? "bg-green-500/20 text-green-300 border-green-500/30"
                                        : "bg-zinc-500/10 text-zinc-600 border-zinc-600/20"
                                    }`}
                                  >
                                    Sp
                                  </span>
                                </div>
                              )}
                            </td>
                            <td className="py-2 pr-3">
                              <div className="flex flex-wrap gap-0.5">
                                {(row.layers ?? []).map((l: string) => (
                                  <span
                                    key={l}
                                    className={`text-[10px] font-mono font-semibold px-1 py-0.5 rounded leading-none ${
                                      l === "WL"
                                        ? "bg-yellow-500/20 text-yellow-300 border border-yellow-500/30"
                                        : l === "L1"
                                          ? "bg-orange-500/20 text-orange-300 border border-orange-500/30"
                                          : l === "L2"
                                            ? "bg-blue-500/20 text-blue-300 border border-blue-500/30"
                                            : l === "L3"
                                              ? "bg-purple-500/20 text-purple-300 border border-purple-500/30"
                                              : l === "L4"
                                                ? "bg-green-500/20 text-green-300 border border-green-500/30"
                                                : l === "L5"
                                                  ? "bg-cyan-500/20 text-cyan-300 border border-cyan-500/30"
                                                  : l === "L6c"
                                                    ? "bg-indigo-500/20 text-indigo-300 border border-indigo-500/30"
                                                    : l === "L7"
                                                      ? "bg-zinc-500/20 text-zinc-400 border border-zinc-500/30"
                                                      : l === "L8"
                                                        ? "bg-pink-500/20 text-pink-300 border border-pink-500/30"
                                                        : l === "L8b"
                                                          ? "bg-sky-500/20 text-sky-300 border border-sky-500/30"
                                                          : "bg-muted/30 text-muted-foreground border border-border"
                                    }`}
                                  >
                                    {l}
                                  </span>
                                ))}
                              </div>
                            </td>
                            <td className="py-2 pr-3 text-right">
                              <span className="font-mono text-cyan-400 font-semibold">
                                {row.lastScore.toFixed(0)}
                              </span>
                            </td>
                            <td className="py-2 pr-3 text-right">
                              <span
                                className={
                                  row.lastPrice24h >= 10
                                    ? "text-green-400 font-semibold"
                                    : row.lastPrice24h >= 0
                                      ? "text-green-400/70"
                                      : row.lastPrice24h >= -5
                                        ? "text-red-400/60"
                                        : "text-red-400 font-semibold"
                                }
                              >
                                {row.lastPrice24h >= 0 ? "+" : ""}
                                {row.lastPrice24h.toFixed(1)}%
                              </span>
                            </td>
                            <td className="py-2 pr-3 text-right font-mono text-[11px]">
                              {row.lastPrice1h != null ? (
                                <span
                                  className={
                                    row.lastPrice1h >= 3
                                      ? "text-green-400 font-semibold"
                                      : row.lastPrice1h >= 0
                                        ? "text-green-400/70"
                                        : row.lastPrice1h >= -2
                                          ? "text-red-400/60"
                                          : "text-red-400 font-semibold"
                                  }
                                >
                                  {row.lastPrice1h >= 0 ? "+" : ""}
                                  {row.lastPrice1h.toFixed(2)}%
                                </span>
                              ) : (
                                <span className="text-border">—</span>
                              )}
                            </td>
                            {(() => {
                              const STALE_MS = 20 * 60 * 1000;
                              const isOiStale =
                                !row.lastOiAt ||
                                Date.now() - row.lastOiAt > STALE_MS;
                              const staleMin = row.lastOiAt
                                ? Math.round(
                                    (Date.now() - row.lastOiAt) / 60000,
                                  )
                                : null;
                              const staleTitle =
                                staleMin != null
                                  ? `Данные ${staleMin}м назад`
                                  : "Данные не обновлялись";
                              return (
                                [
                                  [row.lastOi30m, "30m"],
                                  [row.lastOi1h, "1h"],
                                  [row.lastOi4h, "4h"],
                                ] as [number | null | undefined, string][]
                              ).map(([val, tf]) => (
                                <td
                                  key={tf}
                                  className="py-2 pr-3 text-right font-mono text-[11px]"
                                >
                                  {val != null ? (
                                    <span
                                      title={isOiStale ? staleTitle : undefined}
                                      className={`${isOiStale ? "opacity-40" : ""} ${
                                        val >= 5
                                          ? "text-orange-400 font-semibold"
                                          : val >= 1
                                            ? "text-yellow-400"
                                            : val >= 0
                                              ? "text-muted-foreground"
                                              : "text-red-400/60"
                                      }`}
                                    >
                                      {val >= 0 ? "+" : ""}
                                      {val.toFixed(1)}%
                                    </span>
                                  ) : (
                                    <span className="text-border/40">—</span>
                                  )}
                                </td>
                              ));
                            })()}
                            {/* OI 24h */}
                            <td className="py-2 pr-3 text-right font-mono text-[11px]">
                              {row.lastOi24h != null ? (
                                <span
                                  className={
                                    row.lastOi24h >= 10
                                      ? "text-orange-400 font-semibold"
                                      : row.lastOi24h >= 3
                                        ? "text-yellow-400"
                                        : row.lastOi24h >= 0
                                          ? "text-muted-foreground"
                                          : "text-red-400/60"
                                  }
                                >
                                  {row.lastOi24h >= 0 ? "+" : ""}
                                  {row.lastOi24h.toFixed(1)}%
                                </span>
                              ) : (
                                <span className="text-border/40">—</span>
                              )}
                            </td>
                            {/* CVD 30m */}
                            <td className="py-2 pr-3 text-center font-mono text-[11px]">
                              {row.lastCvd30m != null ? (
                                row.lastCvd30m ? (
                                  <span className="text-green-400 font-bold">
                                    ✓
                                  </span>
                                ) : (
                                  <span className="text-red-400/60">✗</span>
                                )
                              ) : (
                                <span className="text-border/40">—</span>
                              )}
                            </td>
                            {/* CVD 1h */}
                            <td className="py-2 pr-3 text-center font-mono text-[11px]">
                              {row.lastCvd1h != null ? (
                                row.lastCvd1h ? (
                                  <span className="text-green-400 font-bold">
                                    ✓
                                  </span>
                                ) : (
                                  <span className="text-red-400/60">✗</span>
                                )
                              ) : (
                                <span className="text-border/40">—</span>
                              )}
                            </td>
                            {/* F TKR (futures taker net buy %) */}
                            <td className="py-2 pr-3 text-right font-mono text-[11px]">
                              {row.lastNetBuyPct != null ? (
                                <span
                                  className={
                                    row.lastNetBuyPct >= 10
                                      ? "text-green-400 font-semibold"
                                      : row.lastNetBuyPct >= 0
                                        ? "text-green-400/60"
                                        : "text-red-400"
                                  }
                                >
                                  {row.lastNetBuyPct >= 0 ? "+" : ""}
                                  {row.lastNetBuyPct.toFixed(0)}%
                                </span>
                              ) : (
                                <span className="text-border/40">—</span>
                              )}
                            </td>
                            {/* OI Acc (oiAccel30m) */}
                            <td className="py-2 pr-3 text-right font-mono text-[11px]">
                              {row.oiAccel30m != null ? (
                                <span
                                  className={
                                    row.oiAccel30m >= 1.5
                                      ? "text-orange-400 font-semibold"
                                      : row.oiAccel30m >= 1.0
                                        ? "text-yellow-400/80"
                                        : "text-red-400/60"
                                  }
                                >
                                  ×{row.oiAccel30m.toFixed(1)}
                                </span>
                              ) : (
                                <span className="text-border/40">—</span>
                              )}
                            </td>
                            {/* F/S ratio */}
                            <td className="py-2 pr-3 text-right font-mono text-[11px]">
                              {row.futSpotRatio != null ? (
                                <span
                                  className={
                                    row.futSpotRatio >= 5
                                      ? "text-orange-400 font-semibold"
                                      : row.futSpotRatio >= 2
                                        ? "text-yellow-400/80"
                                        : "text-muted-foreground/60"
                                  }
                                >
                                  {row.futSpotRatio.toFixed(1)}×
                                </span>
                              ) : (
                                <span className="text-border/40">—</span>
                              )}
                            </td>
                            <td className="py-2 pr-3 text-right font-mono text-[11px]">
                              {fmtTaker(
                                row.spotTakerNetBuy ?? null,
                                row.spotTakerExchange ?? null,
                              )}
                            </td>
                            <td className="py-2 pr-3 text-right">
                              <span
                                className={`font-mono ${row.cycleCount >= 3 ? "text-orange-400 font-semibold" : "text-muted-foreground"}`}
                              >
                                {row.cycleCount}
                              </span>
                            </td>
                            <td className="py-2 pr-3 text-right font-mono text-[11px]">
                              <span className="text-foreground/70">
                                {fmtPrice(row.firstPrice)}
                              </span>
                            </td>
                            <td className="py-2 pr-3 text-right font-mono text-[11px]">
                              {row.firstPrice != null &&
                              row.lastPrice != null &&
                              row.firstPrice > 0 ? (
                                (() => {
                                  const pct =
                                    ((row.lastPrice - row.firstPrice) /
                                      row.firstPrice) *
                                    100;
                                  return (
                                    <span>
                                      <span
                                        className={
                                          pct >= 2
                                            ? "text-green-400 font-semibold"
                                            : pct >= 0
                                              ? "text-green-400/70"
                                              : pct >= -2
                                                ? "text-red-400/60"
                                                : "text-red-400 font-semibold"
                                        }
                                      >
                                        {fmtPrice(row.lastPrice)}
                                      </span>
                                      <div
                                        className={`text-[9px] ${pct >= 0 ? "text-green-400/60" : "text-red-400/60"}`}
                                      >
                                        {pct >= 0 ? "+" : ""}
                                        {pct.toFixed(1)}%
                                      </div>
                                    </span>
                                  );
                                })()
                              ) : (
                                <span className="text-border">—</span>
                              )}
                            </td>
                            <td className="py-2 pr-3 text-right font-mono text-[11px]">
                              {row.firstPrice != null &&
                              row.lastPrice != null &&
                              row.firstPrice > 0 ? (
                                (() => {
                                  const pct =
                                    ((row.lastPrice - row.firstPrice) /
                                      row.firstPrice) *
                                    100;
                                  return (
                                    <span
                                      className={
                                        pct >= 10
                                          ? "text-green-400 font-semibold"
                                          : pct >= 3
                                            ? "text-green-400/80"
                                            : pct >= 0
                                              ? "text-green-400/60"
                                              : pct >= -5
                                                ? "text-red-400/60"
                                                : "text-red-400 font-semibold"
                                      }
                                    >
                                      {pct >= 0 ? "+" : ""}
                                      {pct.toFixed(1)}%
                                    </span>
                                  );
                                })()
                              ) : (
                                <span className="text-border/40">—</span>
                              )}
                            </td>
                            <td className="py-2 pr-3 text-right whitespace-nowrap">
                              <span className="font-mono text-[11px] text-foreground/80">
                                {fmtDateTime(row.firstSeenAt)}
                              </span>
                              <div className="text-[9px] text-muted-foreground/60">
                                {timeAgo(row.firstSeenAt)} назад
                              </div>
                            </td>
                            <td className="py-2 whitespace-nowrap">
                              <span className="text-[11px] text-muted-foreground">
                                {getPrescanStatus(row)}
                              </span>
                              {row.lastOiAt != null &&
                                Date.now() - row.lastOiAt > 20 * 60 * 1000 && (
                                  <div className="text-[9px] text-orange-400/60 mt-0.5">
                                    ⏱ OI{" "}
                                    {Math.round(
                                      (Date.now() - row.lastOiAt) / 60000,
                                    )}
                                    м назад
                                  </div>
                                )}
                            </td>
                            {snfCells(snfMap, row.symbol)}
                            <td className="py-2 pr-3 text-right font-mono text-[11px]">
                              {row.whaleIndex != null ? (
                                <span
                                  className={
                                    row.whaleIndex >= 10
                                      ? "text-green-400"
                                      : row.whaleIndex <= -10
                                        ? "text-red-400"
                                        : "text-muted-foreground"
                                  }
                                >
                                  {row.whaleIndex > 0 ? "+" : ""}
                                  {row.whaleIndex.toFixed(0)}
                                </span>
                              ) : (
                                <span className="text-border">—</span>
                              )}
                            </td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </div>
              )}
              <div className="text-[10px] text-muted-foreground mt-3 px-1 space-y-1">
                <p>
                  Топ по activity score из 500+ пар. Ранги:{" "}
                  <span className="text-yellow-400">топ-3</span> /{" "}
                  <span className="text-orange-400">топ-10</span> / остальные. 1
                  цикл скана ≈ 10 мин.
                </p>
                <p>
                  <span className="text-cyan-400/80 font-medium">Скор</span> —
                  activity score (взвешенный объём+OI), обновляется каждый цикл.{" "}
                  <span className="text-yellow-400/80 font-medium">OI Δ</span> —
                  % изменение Open Interest за таймфрейм (CoinGlass).
                </p>
                <p>
                  <span className="text-green-400 font-medium">CVD ✓</span> = 2
                  цикла подряд нетто-покупки подтверждены.{" "}
                  <span className="text-cyan-400/80 font-medium">
                    Спот тейкер
                  </span>{" "}
                  — net buy % со спот-бирж (Binance/BingX spot).{" "}
                  <span className="text-muted-foreground/80">В prescan</span> —
                  сколько времени токен в мониторинге (от первого появления в
                  топ-N).
                </p>
                <p className="pt-1 border-t border-border/30 font-medium text-foreground/50">
                  Расшифровка статусов:
                </p>
                <p>
                  <span className="text-muted-foreground">🔭 В наблюдении</span>{" "}
                  — токен в активном мониторинге, ждём нужных условий на
                  следующем цикле.
                </p>
                <p>
                  <span className="text-muted-foreground">
                    👁 OI накапливается
                  </span>{" "}
                  — OI есть (0.2–5%), но ниже порога сигнала. Накопление идёт,
                  нужно терпение.
                </p>
                <p>
                  <span className="text-muted-foreground">👁 Ждём CVD</span> —
                  OI хороший (≥5%), но тейкеры пока не покупают. Нужно
                  подтверждение покупателей.
                </p>
                <p>
                  <span className="text-muted-foreground">👁 Ждём объём</span> —
                  OI и CVD в порядке, но объём торгов ниже порога 2.5× от
                  среднего.
                </p>
                <p>
                  <span className="text-muted-foreground">👁 Хронический</span>{" "}
                  — токен в пресканере более 10 циклов (~1.5ч). OI есть, но
                  что-то стабильно блокирует сигнал: слабый объём, нет CVD, или
                  паттерн не сработал. Может выстрелить внезапно.
                </p>
                <p>
                  <span className="text-muted-foreground">
                    📉 OI слабый (&lt;0.2%)
                  </span>{" "}
                  — кит не накапливает, просто попал в топ по другим метрикам.
                </p>
                <p>
                  <span className="text-muted-foreground">
                    📈 Перегрет (24h ≥ 40%)
                  </span>{" "}
                  — цена уже выросла, поздний вход нецелесообразен.
                </p>
                <p>
                  <span className="text-muted-foreground">⏰ Поздний вход</span>{" "}
                  — цена выросла на &gt;12% за последние 3ч, поезд ушёл.
                </p>
                <p>
                  <span className="text-muted-foreground">
                    📊 CG нет данных — путь SpotVol
                  </span>{" "}
                  — CoinGlass спрошен, но не покрывает этот токен.
                </p>
                <p>
                  <span className="text-muted-foreground">
                    📊 SpotVol: ждёт N цикла
                  </span>{" "}
                  — первые 1–2 цикла, CoinGlass ещё не был проверен для этого
                  токена.
                </p>
                <p>
                  <span className="text-muted-foreground">
                    ⏳ Нет свежих OI данных
                  </span>{" "}
                  — токен проверен, но статус CG неясен. Обновится на следующем
                  цикле.
                </p>
                <p>
                  <span className="text-muted-foreground">⏳ CG таймаут</span> —
                  CoinGlass не ответил вовремя. Данные появятся в следующем
                  цикле.
                </p>
                <p>
                  <span className="text-muted-foreground">🔎 Нет паттерна</span>{" "}
                  — все пороги пройдены, но ни один из паттернов не распознал
                  структуру накопления.
                </p>
              </div>

              {/* Prescan pagination */}
              {(candOffset > 0 || data?.nextOffset != null) && (
                <div className="flex items-center justify-between mt-3 pt-2 border-t border-border/30">
                  <button
                    className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                    disabled={candOffset === 0 || isLoading}
                    onClick={() =>
                      setCandOffset(Math.max(0, candOffset - CAND_PAGE_SIZE))
                    }
                  >
                    <ChevronLeft className="w-3 h-3" />
                    Назад
                  </button>
                  <span className="text-[11px] text-muted-foreground font-mono">
                    {candOffset + 1}–{candOffset + prescan.length} /{" "}
                    {data?.totalPrescan ?? "…"}
                  </span>
                  <button
                    className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                    disabled={data?.nextOffset == null || isLoading}
                    onClick={() =>
                      data?.nextOffset != null && setCandOffset(data.nextOffset)
                    }
                  >
                    Вперёд
                    <ChevronRight className="w-3 h-3" />
                  </button>
                </div>
              )}
            </>
          )}

          {/* ── Кандидаты цикла ── */}
          {tab === "cycle" && (
            <>
              <div className="flex items-center gap-2 mb-4">
                <List className="w-4 h-4 text-cyan-400" />
                <span className="text-sm font-medium">
                  Токены последнего цикла скана
                </span>
                <Badge variant="outline" className="text-xs ml-auto">
                  {layerFilteredCycleCandidates.length}
                </Badge>
                {cycleAt && (
                  <span className="text-[10px] text-muted-foreground">
                    цикл {timeAgo(cycleAt)} назад
                  </span>
                )}
              </div>
              {selectedLayer && (
                <div className="mb-3 flex items-center gap-2 rounded-md border border-primary/25 bg-primary/5 px-3 py-2 text-xs">
                  <span className="text-muted-foreground">Фильтр слоя:</span>
                  <Badge variant="outline" className="font-mono text-primary">
                    {selectedLayer}
                  </Badge>
                  <button
                    type="button"
                    onClick={() => setSelectedLayer(null)}
                    className="ml-auto text-[10px] font-medium text-muted-foreground transition-colors hover:text-foreground"
                  >
                    Показать все
                  </button>
                </div>
              )}
              {layerFilteredCycleCandidates.length === 0 ? (
                <p className="text-xs text-muted-foreground text-center py-8">
                  {isLoading
                    ? "Загрузка…"
                    : selectedLayer
                      ? `В последнем цикле нет токенов слоя ${selectedLayer}`
                      : "Данные появятся после первого цикла скана"}
                </p>
              ) : (
                <>
                  <div className="mb-3 p-3 rounded-md bg-muted/20 border border-border/30 text-[10px] space-y-1.5">
                    <p className="font-medium text-foreground/60 mb-2">
                      Слои прескана — через какой фильтр токен попал в скан:
                    </p>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1">
                      {(
                        [
                          [
                            "L1",
                            "bg-orange-500/20 text-orange-300 border-orange-500/30",
                            "Hot Movers (топ-50)",
                            "activity score: объём + OI + движение цены",
                          ],
                          [
                            "L2",
                            "bg-yellow-500/20 text-yellow-300 border-yellow-500/30",
                            "Volume (топ-200)",
                            "глобальный объём CoinGlass",
                          ],
                          [
                            "L3",
                            "bg-red-500/20 text-red-300 border-red-500/30",
                            "OI Movers",
                            "CoinGlass OI спайк: 30m ≥6% / 1h ≥3% / 4h ≥8% / 24h ≥10%",
                          ],
                          [
                            "L4",
                            "bg-green-500/20 text-green-300 border-green-500/30",
                            "Vol Awaken",
                            "объём ×2.5+ от среднего + p24h 3–15%",
                          ],
                          [
                            "L5",
                            "bg-teal-500/20 text-teal-300 border-teal-500/30",
                            "OI Acceleration",
                            "OI ускоряется между циклами",
                          ],
                          [
                            "L6c",
                            "bg-indigo-500/20 text-indigo-300 border-indigo-500/30",
                            "CG Blind Rescue",
                            "CoinGlass timeout + Coinalyze OI ≥1.5% → OI Watch (cg_timeout, 3ч)",
                          ],
                          [
                            "L7",
                            "bg-slate-500/20 text-slate-300 border-slate-500/30",
                            "OI Watch Orphans",
                            "активные OI Watch записи без prescan",
                          ],
                          [
                            "L8",
                            "bg-pink-500/20 text-pink-300 border-pink-500/30",
                            "Steady Climbers",
                            "устойчивый рост ≥2 цикла подряд",
                          ],
                          [
                            "L8b",
                            "bg-sky-500/20 text-sky-300 border-sky-500/30",
                            "OI 24h Leaders",
                            "проактивный OI Watch: OI 24h ≥8%, price -5..35%, 12ч окно",
                          ],
                        ] as const
                      ).map(([badge, cls, name, desc]) => (
                        <p key={badge}>
                          <span
                            className={`inline-block font-mono font-semibold px-1 py-0.5 rounded border mr-1 ${cls}`}
                          >
                            {badge}
                          </span>
                          <span className="font-medium text-foreground/70">
                            {name}
                          </span>
                          {" — "}
                          {desc}
                        </p>
                      ))}
                    </div>
                    <p className="text-muted-foreground/50 pt-1 border-t border-border/20">
                      Токен может попасть через несколько слоёв одновременно.
                      Кликни заголовок «Слои» для сортировки.
                    </p>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="border-b border-border text-muted-foreground">
                          <th className="text-center py-2 pr-3 font-medium">
                            WL
                          </th>
                          <th className="text-left py-2 pr-4 font-medium">
                            Символ
                          </th>
                          <th
                            className="text-left py-2 pr-4 font-medium cursor-pointer select-none hover:text-foreground transition-colors"
                            onClick={() => toggleCycleSort("layer")}
                            title="Сортировка по приоритету слоя (WL > L1 > L2 > ...)"
                          >
                            Слои{cycleArrow("layer")}
                          </th>
                          <th
                            className="text-right py-2 pr-4 font-medium cursor-pointer select-none hover:text-foreground transition-colors"
                            onClick={() => toggleCycleSort("p24h")}
                          >
                            24h%{cycleArrow("p24h")}
                          </th>
                          <th className="text-right py-2 pr-4 font-medium">
                            Цена
                          </th>
                          <th
                            className="text-right py-2 font-medium cursor-pointer select-none hover:text-foreground transition-colors"
                            onClick={() => toggleCycleSort("score")}
                          >
                            Скор{cycleArrow("score")}
                          </th>
                          <th
                            className="py-2 pr-3 font-medium whitespace-nowrap"
                            title="Покрытие: BX only / CG futures / Binance spot"
                          >
                            Покр.
                          </th>
                          <th
                            className="text-right py-2 pr-3 font-medium whitespace-nowrap"
                            title="OI Δ 30m / 1h / 4h (prescan live)"
                          >
                            OI
                          </th>
                          <th
                            className="text-right py-2 pr-3 font-medium whitespace-nowrap"
                            title="Цена 1h% (prescan live)"
                          >
                            1h%
                          </th>
                          <th
                            className="text-right py-2 pr-3 font-medium whitespace-nowrap"
                            title="Спот тейкер net buy % (S) / CVD прокси ±50 (F) / CVD 1h"
                          >
                            Тейкер
                          </th>
                          <th
                            className="text-right py-2 pr-3 font-medium whitespace-nowrap"
                            title="Спот Vol Mult 1h (vol 1h / 5-цикл. ср.)"
                          >
                            S×
                          </th>
                          <th
                            className="text-right py-2 pr-3 font-medium whitespace-nowrap"
                            title="Spot NetFlow 1h — net buy/sell % (CoinGlass)"
                          >
                            SNF 1h
                          </th>
                          <th
                            className="text-right py-2 pr-3 font-medium whitespace-nowrap"
                            title="Spot NetFlow 4h"
                          >
                            SNF 4h
                          </th>
                          <th
                            className="text-right py-2 pr-3 font-medium whitespace-nowrap"
                            title="Spot NetFlow 24h"
                          >
                            SNF 24h
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {layerFilteredCycleCandidates
                          .slice()
                          .sort(
                            (
                              a: CycleCandidateEntry,
                              b: CycleCandidateEntry,
                            ) => {
                              const d = cycleSort.dir === "asc" ? 1 : -1;
                              if (cycleSort.col === "layer")
                                return (
                                  d *
                                  (layerPriority(a.layers) -
                                    layerPriority(b.layers))
                                );
                              if (cycleSort.col === "p24h")
                                return d * (a.price24h - b.price24h);
                              return d * (a.score - b.score);
                            },
                          )
                          .filter(
                            (r) => !fq || r.symbol.toLowerCase().includes(fq),
                          )
                          .map((row: CycleCandidateEntry) => {
                            const LAYER_COLORS: Record<string, string> = {
                              WL: "bg-purple-500/20 text-purple-300 border-purple-500/30",
                              L1: "bg-orange-500/20 text-orange-300 border-orange-500/30",
                              L2: "bg-yellow-500/20 text-yellow-300 border-yellow-500/30",
                              L3: "bg-red-500/20 text-red-300 border-red-500/30",
                              L4: "bg-green-500/20 text-green-300 border-green-500/30",
                              L5: "bg-teal-500/20 text-teal-300 border-teal-500/30",
                              L6: "bg-blue-500/20 text-blue-300 border-blue-500/30",
                              L6b: "bg-cyan-500/20 text-cyan-300 border-cyan-500/30",
                              L6c: "bg-indigo-500/20 text-indigo-300 border-indigo-500/30",
                              L7: "bg-slate-500/20 text-slate-300 border-slate-500/30",
                              L8b: "bg-sky-500/20 text-sky-300 border-sky-500/30",
                            };
                            return (
                              <tr
                                key={row.symbol}
                                className="border-b border-border/40 hover:bg-muted/20 transition-colors"
                              >
                                <td className="py-1.5 pr-3 text-center"></td>
                                <td className="py-1.5 pr-3">
                                  <div className="flex items-center gap-1.5">
                                    <TokenChartLink symbol={row.symbol} />
                                    <button
                                      onClick={() =>
                                        setSelectedSymbol(row.symbol)
                                      }
                                      title="История наблюдения"
                                      className="text-muted-foreground/40 hover:text-muted-foreground transition-colors"
                                    >
                                      <History className="w-3 h-3" />
                                    </button>
                                  </div>
                                </td>
                                <td className="py-1.5 pr-3">
                                  <div className="flex gap-0.5 flex-wrap">
                                    {row.layers.map((l: string) => (
                                      <span
                                        key={l}
                                        className={`inline-flex items-center px-1 py-0.5 rounded text-[9px] font-mono border ${LAYER_COLORS[l] ?? "bg-muted text-muted-foreground border-border"}`}
                                      >
                                        {l}
                                      </span>
                                    ))}
                                  </div>
                                </td>
                                <td className="py-1.5 pr-3 text-right font-mono text-[11px]">
                                  <span
                                    className={
                                      row.price24h >= 40
                                        ? "text-red-400 font-semibold"
                                        : row.price24h >= 5
                                          ? "text-green-400 font-semibold"
                                          : row.price24h >= 0
                                            ? "text-green-400/70"
                                            : "text-red-400/70"
                                    }
                                  >
                                    {row.price24h >= 0 ? "+" : ""}
                                    {row.price24h.toFixed(1)}%
                                  </span>
                                </td>
                                <td className="py-1.5 pr-3 text-right font-mono text-[11px] text-foreground/80">
                                  {fmtPrice(row.price)}
                                </td>
                                <td className="py-1.5 text-right font-mono text-cyan-400 font-semibold">
                                  {row.score.toFixed(0)}
                                </td>
                                {/* Coverage badges */}
                                <td className="py-1.5 pr-3">
                                  {row.isBingxExclusive === true ? (
                                    <span
                                      title="BingX-exclusive: нет на Binance spot и нет в CoinGlass futures"
                                      className="text-[9px] font-mono px-1 py-0.5 rounded border bg-zinc-500/20 text-zinc-400 border-zinc-500/30 whitespace-nowrap"
                                    >
                                      BX only
                                    </span>
                                  ) : (
                                    <div className="flex gap-0.5">
                                      <span
                                        title={
                                          row.hasCgFutures === true
                                            ? "CoinGlass futures OI: покрыт"
                                            : row.hasCgFutures === false
                                              ? "CoinGlass futures OI: нет данных"
                                              : "CoinGlass futures OI: загрузка…"
                                        }
                                        className={`text-[9px] font-mono px-1 py-0.5 rounded border leading-none ${
                                          row.hasCgFutures === true
                                            ? "bg-blue-500/20 text-blue-300 border-blue-500/30"
                                            : "bg-zinc-500/10 text-zinc-600 border-zinc-600/20"
                                        }`}
                                      >
                                        CG
                                      </span>
                                      <span
                                        title={
                                          row.isBinanceSpotListed === true
                                            ? "Binance spot: листингован"
                                            : row.isBinanceSpotListed === false
                                              ? "Binance spot: не листингован"
                                              : "Binance spot: загрузка…"
                                        }
                                        className={`text-[9px] font-mono px-1 py-0.5 rounded border leading-none ${
                                          row.isBinanceSpotListed === true
                                            ? "bg-green-500/20 text-green-300 border-green-500/30"
                                            : "bg-zinc-500/10 text-zinc-600 border-zinc-600/20"
                                        }`}
                                      >
                                        Sp
                                      </span>
                                    </div>
                                  )}
                                </td>
                                {/* OI 30m/1h/4h */}
                                <td className="py-1.5 pr-3 text-right font-mono text-[10px]">
                                  <div className="flex flex-col gap-0 items-end leading-tight">
                                    {row.lastOi30m != null ? (
                                      <span
                                        className={
                                          row.lastOi30m >= 3
                                            ? "text-green-400"
                                            : row.lastOi30m >= 1
                                              ? "text-green-400/70"
                                              : row.lastOi30m <= -1
                                                ? "text-red-400/70"
                                                : "text-muted-foreground/60"
                                        }
                                      >
                                        {row.lastOi30m >= 0 ? "+" : ""}
                                        {row.lastOi30m.toFixed(1)}
                                      </span>
                                    ) : (
                                      <span className="text-border/30">—</span>
                                    )}
                                    {row.lastOi1h != null && (
                                      <span
                                        className={`text-[9px] ${row.lastOi1h >= 2 ? "text-green-400/60" : row.lastOi1h <= -1 ? "text-red-400/60" : "text-muted-foreground/40"}`}
                                      >
                                        {row.lastOi1h >= 0 ? "+" : ""}
                                        {row.lastOi1h.toFixed(1)}
                                      </span>
                                    )}
                                    {row.lastOi4h != null && (
                                      <span
                                        className={`text-[9px] opacity-70 ${row.lastOi4h >= 2 ? "text-green-400/50" : row.lastOi4h <= -1 ? "text-red-400/50" : "text-muted-foreground/30"}`}
                                      >
                                        {row.lastOi4h >= 0 ? "+" : ""}
                                        {row.lastOi4h.toFixed(1)}
                                      </span>
                                    )}
                                  </div>
                                </td>
                                {/* Цена 1h */}
                                <td className="py-1.5 pr-3 text-right font-mono text-[11px]">
                                  {row.lastPrice1h != null ? (
                                    <span
                                      className={
                                        row.lastPrice1h >= 1
                                          ? "text-green-400"
                                          : row.lastPrice1h <= -1
                                            ? "text-red-400"
                                            : "text-muted-foreground"
                                      }
                                    >
                                      {row.lastPrice1h >= 0 ? "+" : ""}
                                      {row.lastPrice1h.toFixed(1)}%
                                    </span>
                                  ) : (
                                    <span className="text-border/30">—</span>
                                  )}
                                </td>
                                {/* Тейкер: спот / фьюч + CVD */}
                                <td className="py-1.5 pr-3 text-right font-mono text-[10px]">
                                  <div className="flex flex-col gap-0 items-end leading-tight">
                                    {row.lastSpotTakerNetBuy != null ? (
                                      <span
                                        className={
                                          row.lastSpotTakerNetBuy >= 5
                                            ? "text-green-400"
                                            : row.lastSpotTakerNetBuy <= -5
                                              ? "text-red-400"
                                              : "text-muted-foreground/60"
                                        }
                                      >
                                        S
                                        {row.lastSpotTakerNetBuy >= 0
                                          ? "+"
                                          : ""}
                                        {row.lastSpotTakerNetBuy.toFixed(0)}%
                                      </span>
                                    ) : (
                                      <span className="text-border/30">—</span>
                                    )}
                                    {row.lastNetBuyPct != null && (
                                      <span
                                        className={`text-[9px] ${row.lastNetBuyPct >= 5 ? "text-green-400/60" : row.lastNetBuyPct <= -5 ? "text-red-400/60" : "text-muted-foreground/40"}`}
                                      >
                                        F{row.lastNetBuyPct >= 0 ? "+" : ""}
                                        {row.lastNetBuyPct.toFixed(0)}%
                                      </span>
                                    )}
                                    {row.lastCvd1h != null && (
                                      <span
                                        className={`text-[9px] ${row.lastCvd1h ? "text-green-400/50" : "text-red-400/50"}`}
                                      >
                                        CVD{row.lastCvd1h ? "✓" : "✗"}
                                      </span>
                                    )}
                                  </div>
                                </td>
                                {/* Спот Mult */}
                                <td className="py-1.5 pr-3 text-right font-mono text-[11px]">
                                  {row.spotVolMult != null ? (
                                    <span
                                      className={
                                        row.spotVolMult >= 2.5
                                          ? "text-orange-400"
                                          : row.spotVolMult >= 1.5
                                            ? "text-yellow-400/80"
                                            : "text-muted-foreground/50"
                                      }
                                    >
                                      ×{row.spotVolMult.toFixed(1)}
                                    </span>
                                  ) : (
                                    <span className="text-border/30">—</span>
                                  )}
                                </td>
                                {snfCells(snfMap, row.symbol)}
                              </tr>
                            );
                          })}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
              <p className="text-[10px] text-muted-foreground mt-3 px-1">
                Все токены которые попали в батч скана (deep scan) за последний
                цикл. <span className="text-orange-300 font-medium">L1</span>{" "}
                топ-50 · <span className="text-red-300 font-medium">L3</span> OI
                mover · <span className="text-indigo-300 font-medium">L6c</span>{" "}
                CG rescue ·{" "}
                <span className="text-slate-300 font-medium">L7</span> OI orphan
                · <span className="text-sky-300 font-medium">L8b</span> OI
                leader
              </p>
            </>
          )}

          {/* ── Спот Vol ── */}
          {tab === "spot_vol" && (
            <>
              <div className="flex items-center gap-2 mb-4">
                <BarChart2 className="w-4 h-4 text-cyan-400" />
                <span className="text-sm font-medium">
                  Спот объём — prescan токены
                </span>
                <Badge variant="outline" className="text-xs ml-auto">
                  {spotVolRows.length}
                </Badge>
                <span className="text-[10px] text-muted-foreground">
                  CoinGlass pairs-markets
                </span>
              </div>
              <div className="mb-3 p-3 rounded-md bg-muted/20 border border-border/30 text-[10px] leading-relaxed text-muted-foreground">
                <span className="font-medium text-foreground/60">
                  Спот-объём
                </span>{" "}
                — токены из prescan с аномальным спот-объёмом (spotVolCycles ≥
                1).{" "}
                <em className="text-border/60">
                  Vol 1.0× = норма, ≥1.5–2× = повышенный, ≥2.5× = аномальный
                </em>
                .
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-border text-muted-foreground select-none">
                      <th
                        className="text-left py-2 pr-3 font-medium cursor-pointer hover:text-foreground whitespace-nowrap"
                        onClick={() => toggleSpotVolSort("symbol")}
                      >
                        Символ{svArrow("symbol")}
                      </th>
                      <th
                        className="text-left py-2 pr-3 font-medium cursor-pointer hover:text-foreground whitespace-nowrap"
                        title="Слои прескана, через которые токен попал в батч"
                        onClick={() => toggleSpotVolSort("layer")}
                      >
                        Слои{svArrow("layer")}
                      </th>
                      <th
                        className="text-right py-2 pr-3 font-medium cursor-pointer hover:text-foreground whitespace-nowrap"
                        title="Изменение цены за 24h"
                        onClick={() => toggleSpotVolSort("p24h")}
                      >
                        24h%{svArrow("p24h")}
                      </th>
                      <th
                        className="text-right py-2 pr-3 font-medium cursor-pointer hover:text-foreground whitespace-nowrap"
                        title="Изменение цены за 1h"
                        onClick={() => toggleSpotVolSort("p1h")}
                      >
                        1h%{svArrow("p1h")}
                      </th>
                      <th
                        className="text-right py-2 pr-3 font-medium cursor-pointer hover:text-foreground whitespace-nowrap"
                        title="OI Change 30m (CoinGlass)"
                        onClick={() => toggleSpotVolSort("oi30m")}
                      >
                        OI 30m{svArrow("oi30m")}
                      </th>
                      <th
                        className="text-right py-2 pr-3 font-medium cursor-pointer hover:text-foreground whitespace-nowrap"
                        title="OI Change 1h (CoinGlass)"
                        onClick={() => toggleSpotVolSort("oi1h")}
                      >
                        OI 1h{svArrow("oi1h")}
                      </th>
                      <th
                        className="text-right py-2 pr-3 font-medium cursor-pointer hover:text-foreground whitespace-nowrap"
                        title="OI Change 4h (CoinGlass)"
                        onClick={() => toggleSpotVolSort("oi4h")}
                      >
                        OI 4h{svArrow("oi4h")}
                      </th>
                      <th
                        className="text-right py-2 pr-3 font-medium cursor-pointer hover:text-foreground whitespace-nowrap"
                        title="Суммарный спот объём 1h по всем биржам (USD)"
                        onClick={() => toggleSpotVolSort("vol1h")}
                      >
                        Спот Vol 1h{svArrow("vol1h")}
                      </th>
                      <th
                        className="text-right py-2 pr-3 font-medium cursor-pointer hover:text-foreground whitespace-nowrap"
                        title="Кратность спот объёма 1h vs 5-цикловое среднее (≥2.0 зелёный, ≥1.5 жёлтый)"
                        onClick={() => toggleSpotVolSort("mult")}
                      >
                        Mult{svArrow("mult")}
                      </th>
                      <th
                        className="text-right py-2 pr-3 font-medium cursor-pointer hover:text-foreground whitespace-nowrap"
                        title="Дельта Mult между текущим и предыдущим циклом — зелёный если растёт"
                        onClick={() => toggleSpotVolSort("delta")}
                      >
                        Δ Mult{svArrow("delta")}
                      </th>
                      <th
                        className="text-right py-2 pr-3 font-medium cursor-pointer hover:text-foreground whitespace-nowrap"
                        title="Суммарный спот объём 4h по всем биржам (USD)"
                        onClick={() => toggleSpotVolSort("vol4h")}
                      >
                        Спот Vol 4h{svArrow("vol4h")}
                      </th>
                      <th
                        className="text-right py-2 pr-3 font-medium cursor-pointer hover:text-foreground whitespace-nowrap"
                        title="Текущий 1h спот × 24 / spotVol24h — насколько сейчас активнее вчерашнего среднего"
                        onClick={() => toggleSpotVolSort("mult24h")}
                      >
                        Mult 24h{svArrow("mult24h")}
                      </th>
                      <th
                        className="text-right py-2 pr-3 font-medium cursor-pointer hover:text-foreground whitespace-nowrap"
                        title="(buy−sell)/(buy+sell)×100 за 1h (CoinGlass)"
                        onClick={() => toggleSpotVolSort("netbuy")}
                      >
                        NetBuy 1h%{svArrow("netbuy")}
                      </th>
                      <th
                        className="text-right py-2 pr-3 font-medium cursor-pointer hover:text-foreground whitespace-nowrap"
                        title="Spot taker dominance из CoinGlass taker flow (значение последнего цикла скана, ~10 мин)"
                        onClick={() => toggleSpotVolSort("staker")}
                      >
                        Спот тейкер{svArrow("staker")}
                      </th>
                      <th
                        className="text-center py-2 pr-3 font-medium cursor-pointer hover:text-foreground whitespace-nowrap"
                        title="CVD 1h положительный (spot CVD 1h в плюсе)"
                        onClick={() => toggleSpotVolSort("cvd1h")}
                      >
                        CVD 1h{svArrow("cvd1h")}
                      </th>
                      <th
                        className="text-center py-2 pr-3 font-medium cursor-pointer hover:text-foreground whitespace-nowrap"
                        title="CVD 4h положительный"
                        onClick={() => toggleSpotVolSort("cvd4h")}
                      >
                        CVD 4h{svArrow("cvd4h")}
                      </th>
                      <th
                        className="text-right py-2 pr-3 font-medium cursor-pointer hover:text-foreground whitespace-nowrap"
                        title="OI 24h % (CoinGlass)"
                        onClick={() => toggleSpotVolSort("oi24h")}
                      >
                        OI 24h{svArrow("oi24h")}
                      </th>
                      <th
                        className="text-right py-2 pr-3 font-medium cursor-pointer hover:text-foreground whitespace-nowrap"
                        title="Спот объём 1h / MCap × 100% (доля капитализации пройденная за час)"
                        onClick={() => toggleSpotVolSort("mcap")}
                      >
                        Спот/MCap%{svArrow("mcap")}
                      </th>
                      <th
                        className="text-right py-2 pr-3 font-medium cursor-pointer hover:text-foreground whitespace-nowrap"
                        title="Циклов собраны данные спот объёма"
                        onClick={() => toggleSpotVolSort("cycles")}
                      >
                        Циклы{svArrow("cycles")}
                      </th>
                      <th className="text-left py-2 font-medium">Статус</th>
                      <th
                        className="text-right py-2 pr-3 font-medium whitespace-nowrap"
                        title="Spot NetFlow 1h — net buy/sell % (CoinGlass)"
                      >
                        SNF 1h
                      </th>
                      <th
                        className="text-right py-2 pr-3 font-medium whitespace-nowrap"
                        title="Spot NetFlow 4h"
                      >
                        SNF 4h
                      </th>
                      <th
                        className="text-right py-2 pr-3 font-medium whitespace-nowrap"
                        title="Spot NetFlow 24h"
                      >
                        SNF 24h
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {spotVolRows.length === 0 ? (
                      <tr>
                        <td
                          colSpan={23}
                          className="text-center py-8 text-xs text-muted-foreground"
                        >
                          {isLoading
                            ? "Загрузка…"
                            : "Нет данных — появятся после завершения скан-цикла (~10 мин)"}
                        </td>
                      </tr>
                    ) : (
                      sortedSpotVol
                        .filter(
                          (r) => !fq || r.symbol.toLowerCase().includes(fq),
                        )
                        .map((row) => {
                          const spotMcapPct =
                            row.lastSpotVol1h != null &&
                            row.mcapUsd != null &&
                            row.mcapUsd > 0
                              ? (row.lastSpotVol1h / row.mcapUsd) * 100
                              : null;
                          const deltaMult =
                            row.spotVolMult != null &&
                            row.prevSpotVolMult != null
                              ? row.spotVolMult - row.prevSpotVolMult
                              : null;
                          const spotVol24hMult =
                            row.lastSpotVol1h != null &&
                            row.lastSpotVol1h > 0 &&
                            row.spotVol24h != null &&
                            row.spotVol24h > 0
                              ? (row.lastSpotVol1h * 24) / row.spotVol24h
                              : null;
                          const status = getPrescanStatus(row);
                          return (
                            <tr
                              key={row.symbol}
                              className="border-b border-border/40 hover:bg-muted/20 transition-colors"
                            >
                              {/* Символ */}
                              <td className="py-2 pr-3">
                                <div className="flex items-center gap-1.5">
                                  <TokenChartLink symbol={row.symbol} />
                                  <button
                                    onClick={() =>
                                      setSelectedSymbol(row.symbol)
                                    }
                                    title="История наблюдения"
                                    className="text-muted-foreground/40 hover:text-muted-foreground transition-colors"
                                  >
                                    <History className="w-3 h-3" />
                                  </button>
                                </div>
                              </td>
                              {/* Слои */}
                              <td className="py-2 pr-3">
                                <div className="flex flex-wrap gap-0.5">
                                  {(row.layers ?? []).length === 0 ? (
                                    <span className="text-border/40 text-[10px]">
                                      —
                                    </span>
                                  ) : (
                                    (row.layers ?? []).map((l: string) => (
                                      <span
                                        key={l}
                                        className={`text-[10px] font-mono font-semibold px-1 py-0.5 rounded leading-none ${
                                          l === "WL"
                                            ? "bg-yellow-500/20 text-yellow-300 border border-yellow-500/30"
                                            : l === "L1"
                                              ? "bg-orange-500/20 text-orange-300 border border-orange-500/30"
                                              : l === "L2"
                                                ? "bg-blue-500/20 text-blue-300 border border-blue-500/30"
                                                : l === "L3"
                                                  ? "bg-purple-500/20 text-purple-300 border border-purple-500/30"
                                                  : l === "L4"
                                                    ? "bg-green-500/20 text-green-300 border border-green-500/30"
                                                    : l === "L5"
                                                      ? "bg-cyan-500/20 text-cyan-300 border border-cyan-500/30"
                                                      : l === "L6c"
                                                        ? "bg-indigo-500/20 text-indigo-300 border border-indigo-500/30"
                                                        : l === "L7"
                                                          ? "bg-zinc-500/20 text-zinc-400 border border-zinc-500/30"
                                                          : l === "L8"
                                                            ? "bg-pink-500/20 text-pink-300 border border-pink-500/30"
                                                            : l === "L8b"
                                                              ? "bg-sky-500/20 text-sky-300 border border-sky-500/30"
                                                              : "bg-muted/30 text-muted-foreground border border-border"
                                        }`}
                                      >
                                        {l}
                                      </span>
                                    ))
                                  )}
                                </div>
                              </td>
                              {/* Цена 24h */}
                              <td className="py-2 pr-3 text-right font-mono text-[11px]">
                                {row.lastPrice24h != null ? (
                                  <span
                                    className={
                                      row.lastPrice24h >= 10
                                        ? "text-green-400 font-semibold"
                                        : row.lastPrice24h >= 0
                                          ? "text-green-400/70"
                                          : row.lastPrice24h >= -5
                                            ? "text-red-400/60"
                                            : "text-red-400 font-semibold"
                                    }
                                  >
                                    {row.lastPrice24h >= 0 ? "+" : ""}
                                    {row.lastPrice24h.toFixed(1)}%
                                  </span>
                                ) : (
                                  <span className="text-border/40">—</span>
                                )}
                              </td>
                              {/* Цена 1h */}
                              <td className="py-2 pr-3 text-right font-mono text-[11px]">
                                {row.lastPrice1h != null ? (
                                  <span
                                    className={
                                      row.lastPrice1h >= 3
                                        ? "text-green-400 font-semibold"
                                        : row.lastPrice1h >= 0
                                          ? "text-green-400/70"
                                          : row.lastPrice1h >= -2
                                            ? "text-red-400/60"
                                            : "text-red-400 font-semibold"
                                    }
                                  >
                                    {row.lastPrice1h >= 0 ? "+" : ""}
                                    {row.lastPrice1h.toFixed(2)}%
                                  </span>
                                ) : (
                                  <span className="text-border/40">—</span>
                                )}
                              </td>
                              {/* OI 30m / 1h / 4h */}
                              {(
                                [
                                  [row.lastOi30m, "30m"],
                                  [row.lastOi1h, "1h"],
                                  [row.lastOi4h, "4h"],
                                ] as [number | null | undefined, string][]
                              ).map(([val, tf]) => (
                                <td
                                  key={tf}
                                  className="py-2 pr-3 text-right font-mono text-[11px]"
                                >
                                  {val != null ? (
                                    <span
                                      className={
                                        val >= 5
                                          ? "text-orange-400 font-semibold"
                                          : val >= 1
                                            ? "text-yellow-400"
                                            : val >= 0
                                              ? "text-muted-foreground"
                                              : "text-red-400/60"
                                      }
                                    >
                                      {val >= 0 ? "+" : ""}
                                      {val.toFixed(1)}%
                                    </span>
                                  ) : (
                                    <span className="text-border/40">—</span>
                                  )}
                                </td>
                              ))}
                              {/* Спот Vol 1h */}
                              <td className="py-2 pr-3 text-right font-mono text-[11px]">
                                {row.lastSpotVol1h != null ? (
                                  <span
                                    className={
                                      row.lastSpotVol1h >= 5e6
                                        ? "text-cyan-400 font-semibold"
                                        : row.lastSpotVol1h >= 1e6
                                          ? "text-cyan-400/80"
                                          : row.lastSpotVol1h >= 100e3
                                            ? "text-muted-foreground"
                                            : "text-muted-foreground/50"
                                    }
                                  >
                                    {fmtSpot(row.lastSpotVol1h)}
                                  </span>
                                ) : (
                                  <span className="text-border/40">—</span>
                                )}
                              </td>
                              {/* Mult */}
                              <td className="py-2 pr-3 text-right font-mono text-[11px]">
                                {row.spotVolMult != null ? (
                                  <span
                                    className={
                                      row.spotVolMult >= 2.0
                                        ? "text-green-400 font-semibold"
                                        : row.spotVolMult >= 1.5
                                          ? "text-yellow-400"
                                          : "text-muted-foreground/60"
                                    }
                                  >
                                    {row.spotVolMult.toFixed(1)}x
                                  </span>
                                ) : (
                                  <span className="text-border/40">
                                    {(row.spotVolCycles ?? 0) < 2 ? "⏳" : "—"}
                                  </span>
                                )}
                              </td>
                              {/* Δ Mult */}
                              <td className="py-2 pr-3 text-right font-mono text-[11px]">
                                {deltaMult != null ? (
                                  <span
                                    className={
                                      deltaMult >= 0.5
                                        ? "text-green-400 font-semibold"
                                        : deltaMult >= 0.1
                                          ? "text-green-400/70"
                                          : deltaMult >= -0.1
                                            ? "text-muted-foreground/50"
                                            : deltaMult >= -0.5
                                              ? "text-red-400/70"
                                              : "text-red-400"
                                    }
                                  >
                                    {deltaMult >= 0 ? "+" : ""}
                                    {deltaMult.toFixed(1)}x
                                  </span>
                                ) : (
                                  <span className="text-border/40">—</span>
                                )}
                              </td>
                              {/* Спот Vol 4h */}
                              <td className="py-2 pr-3 text-right font-mono text-[11px]">
                                {row.lastSpotVol4h != null ? (
                                  <span
                                    className={
                                      row.lastSpotVol4h >= 20e6
                                        ? "text-cyan-400 font-semibold"
                                        : row.lastSpotVol4h >= 4e6
                                          ? "text-cyan-400/70"
                                          : row.lastSpotVol4h >= 500e3
                                            ? "text-muted-foreground"
                                            : "text-muted-foreground/50"
                                    }
                                  >
                                    {fmtSpot(row.lastSpotVol4h)}
                                  </span>
                                ) : (
                                  <span className="text-border/40">—</span>
                                )}
                              </td>
                              {/* Mult 24h */}
                              <td className="py-2 pr-3 text-right font-mono text-[11px]">
                                {spotVol24hMult != null ? (
                                  <span
                                    className={
                                      spotVol24hMult >= 3.0
                                        ? "text-green-400 font-semibold"
                                        : spotVol24hMult >= 2.0
                                          ? "text-yellow-400"
                                          : spotVol24hMult >= 1.0
                                            ? "text-muted-foreground"
                                            : "text-muted-foreground/40"
                                    }
                                  >
                                    {spotVol24hMult.toFixed(1)}x
                                  </span>
                                ) : (
                                  <span className="text-border/40">—</span>
                                )}
                              </td>
                              {/* NetBuy 1h% */}
                              <td className="py-2 pr-3 text-right font-mono text-[11px]">
                                {row.lastSpotNetBuy1h != null ? (
                                  <span
                                    className={
                                      row.lastSpotNetBuy1h >= 10
                                        ? "text-green-400 font-semibold"
                                        : row.lastSpotNetBuy1h >= 0
                                          ? "text-green-400/60"
                                          : row.lastSpotNetBuy1h >= -10
                                            ? "text-red-400/60"
                                            : "text-red-400"
                                    }
                                  >
                                    {row.lastSpotNetBuy1h >= 0 ? "+" : ""}
                                    {row.lastSpotNetBuy1h.toFixed(1)}%
                                  </span>
                                ) : (
                                  <span className="text-border/40">—</span>
                                )}
                              </td>
                              {/* Спот тейкер */}
                              <td className="py-2 pr-3 text-right font-mono text-[11px]">
                                {row.spotTakerDominance != null ? (
                                  <span
                                    className={
                                      row.spotTakerDominance === "buy"
                                        ? "text-green-400"
                                        : "text-red-400/80"
                                    }
                                  >
                                    {row.spotTakerDominance === "buy"
                                      ? "↑"
                                      : "↓"}{" "}
                                    {row.spotTakerNetBuy != null
                                      ? `${row.spotTakerNetBuy >= 0 ? "+" : ""}${row.spotTakerNetBuy.toFixed(0)}%`
                                      : ""}
                                  </span>
                                ) : (
                                  <span className="text-border/40">—</span>
                                )}
                              </td>
                              {/* CVD 1h */}
                              <td className="py-2 pr-3 text-center font-mono text-[11px]">
                                {row.cvd1h != null ? (
                                  <span
                                    className={
                                      row.cvd1h
                                        ? "text-green-400"
                                        : "text-red-400/60"
                                    }
                                  >
                                    {row.cvd1h ? "✓" : "✗"}
                                  </span>
                                ) : (
                                  <span className="text-border/40">—</span>
                                )}
                              </td>
                              {/* CVD 4h */}
                              <td className="py-2 pr-3 text-center font-mono text-[11px]">
                                {row.cvd4h != null ? (
                                  <span
                                    className={
                                      row.cvd4h
                                        ? "text-green-400"
                                        : "text-red-400/60"
                                    }
                                  >
                                    {row.cvd4h ? "✓" : "✗"}
                                  </span>
                                ) : (
                                  <span className="text-border/40">—</span>
                                )}
                              </td>
                              {/* OI 24h */}
                              <td className="py-2 pr-3 text-right font-mono text-[11px]">
                                {row.lastOi24h != null ? (
                                  <span
                                    className={
                                      row.lastOi24h >= 10
                                        ? "text-orange-400 font-semibold"
                                        : row.lastOi24h >= 3
                                          ? "text-yellow-400"
                                          : row.lastOi24h >= 0
                                            ? "text-muted-foreground"
                                            : "text-red-400/60"
                                    }
                                  >
                                    {row.lastOi24h >= 0 ? "+" : ""}
                                    {row.lastOi24h.toFixed(1)}%
                                  </span>
                                ) : (
                                  <span className="text-border/40">—</span>
                                )}
                              </td>
                              {/* Спот/MCap% */}
                              <td className="py-2 pr-3 text-right font-mono text-[11px]">
                                {spotMcapPct != null ? (
                                  <span
                                    className={
                                      spotMcapPct >= 5
                                        ? "text-cyan-400 font-semibold"
                                        : spotMcapPct >= 1
                                          ? "text-cyan-400/70"
                                          : "text-muted-foreground"
                                    }
                                  >
                                    {spotMcapPct.toFixed(2)}%
                                  </span>
                                ) : (
                                  <span className="text-border/40">—</span>
                                )}
                              </td>
                              {/* Циклов */}
                              <td className="py-2 pr-3 text-right">
                                <span
                                  className={`font-mono text-[11px] ${(row.spotVolCycles ?? 0) >= 3 ? "text-cyan-400/80" : "text-muted-foreground"}`}
                                >
                                  {row.spotVolCycles ?? 0}
                                </span>
                              </td>
                              {/* Статус */}
                              <td
                                className="py-2 text-left text-[10px] text-muted-foreground max-w-[180px] truncate"
                                title={status}
                              >
                                {status}
                              </td>
                              {snfCells(snfMap, row.symbol)}
                            </tr>
                          );
                        })
                    )}
                  </tbody>
                </table>
              </div>
              <p className="text-[10px] text-muted-foreground mt-3 px-1">
                Prescan-токены с данными спот объёма. Сортировка по{" "}
                <span className="text-green-400/80 font-medium">Mult ↓</span>.{" "}
                <span className="text-green-400/80 font-medium">≥2.0x</span>{" "}
                зелёный,{" "}
                <span className="text-yellow-400/80 font-medium">≥1.5x</span>{" "}
                жёлтый.{" "}
                <span className="text-cyan-300/80 font-medium">Δ Mult</span> —
                динамика разгона спот объёма (текущий − предыдущий цикл).{" "}
                <span className="text-cyan-400/80 font-medium">Спот/MCap%</span>{" "}
                — доля капитализации за 1h.
              </p>
            </>
          )}

          {/* ── Near Miss ── */}

          {tab === "range_breakout" && <RangeBreakoutTab filterQ={filterQ} />}
          {tab === "abneon" && <AbneonTab filterQ={filterQ} />}

          {tab === "liq_cascade" && (
            <LiqCascadeTab
              onSymbolSelect={setSelectedSymbol}
              filterQ={filterQ}
            />
          )}
        </CardContent>
      </Card>
    </div>
  );
}

export default function Candidates() {
  return getStoredUser()?.role === "owner" ? (
    <OwnerCandidates />
  ) : (
    <MemberScanner layers={LAYER_INFO} />
  );
}
