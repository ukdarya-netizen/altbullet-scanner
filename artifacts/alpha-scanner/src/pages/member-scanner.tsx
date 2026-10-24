import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  BarChart2,
  ChevronLeft,
  ChevronRight,
  Eye,
  Flame,
  History,
  List,
  RefreshCw,
  Search,
  Zap,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { MemberSymbolHistorySheet } from "@/components/member-symbol-history-sheet";
import { TokenChartLink } from "@/components/token-chart-link";
import AbneonTab, { useAbneonCandidates } from "@/components/abneon-tab";
import RangeBreakoutTab, {
  useRangeBreakoutCandidates,
} from "@/components/range-breakout-tab";
import {
  getGetScannerStatusQueryKey,
  useGetScannerStatus,
} from "@workspace/api-client-react";

const API_BASE = import.meta.env.BASE_URL.replace(/\/$/, "");
const PAGE_SIZE = 100;
const SCORE_EXPLANATION =
  "Скор активности: модуль изменения цены за 24 ч (%) × log₁₀(объём фьючерсных торгов в USDT + 1), с бонусами за ускорение объёма и OI. Чем выше число, тем заметнее движение и активность. Это не оценка качества сигнала и не прогноз прибыли. ↓ — сортировка от большего к меньшему.";

type Layer = {
  tag: string;
  name: string;
  bg: string;
  border: string;
  badge: string;
  desc: string;
};

type Tab =
  | "prescan"
  | "oi_watch"
  | "cycle"
  | "spot_vol"
  | "liq_cascade"
  | "range_breakout"
  | "abneon";
const TABS = [
  { id: "prescan", label: "Prescan", icon: Flame },
  { id: "oi_watch", label: "OI Watch", icon: Eye },
  { id: "cycle", label: "Кандидаты", icon: List },
  { id: "spot_vol", label: "Спот", icon: BarChart2 },
  { id: "liq_cascade", label: "L10 Каскады", icon: Zap },
  { id: "range_breakout", label: "Range Breakout", icon: List },
  { id: "abneon", label: "ABNeon", icon: List },
] as const;

type MemberTokenRow = {
  symbol: string;
  layers: string[];
  price24h: number | null;
  price: number | null;
  score: number | null;
  oi30m: number | null;
  oi1h: number | null;
  oi4h: number | null;
};

type MemberScannerData = {
  memberView: {
    prescan: MemberTokenRow[];
    totalPrescan: number;
    prescanOffset: number;
    nextPrescanOffset: number | null;
    oiWatch: MemberTokenRow[];
    totalOiWatch: number;
    oiWatchOffset: number;
    nextOiWatchOffset: number | null;
    candidates: MemberTokenRow[];
    spot: MemberTokenRow[];
    totalSpot: number;
    spotOffset: number;
    nextSpotOffset: number | null;
    layerTokens: { L10: MemberTokenRow[] };
  };
};

function signedPercent(value: number | null): string {
  return value == null ? "—" : `${value > 0 ? "+" : ""}${value.toFixed(1)}%`;
}

function displayPrice(value: number | null): string {
  if (value == null || value <= 0) return "—";
  if (value >= 10000) return `$${value.toFixed(0)}`;
  if (value >= 1000) return `$${value.toFixed(1)}`;
  if (value >= 100) return `$${value.toFixed(2)}`;
  if (value >= 1) return `$${value.toFixed(4)}`;
  if (value >= 0.01) return `$${value.toFixed(5)}`;
  return `$${value.toPrecision(4)}`;
}

function TokenTable({
  rows,
  emptyText,
  layers,
  onSymbolSelect,
}: {
  rows: MemberTokenRow[];
  emptyText: string;
  layers: Layer[];
  onSymbolSelect: (symbol: string) => void;
}) {
  const [sort, setSort] = useState<{
    column: "symbol" | "layer" | "price24h" | "score";
    direction: 1 | -1;
  }>({
    column: "score",
    direction: -1,
  });
  const toggleSort = (column: typeof sort.column) =>
    setSort((previous) => ({
      column,
      direction:
        previous.column === column ? (previous.direction === 1 ? -1 : 1) : -1,
    }));
  const sorted = [...rows].sort((a, b) => {
    let order: number;
    switch (sort.column) {
      case "symbol":
        order = a.symbol.localeCompare(b.symbol);
        break;
      case "layer":
        order = (a.layers[0] ?? "").localeCompare(b.layers[0] ?? "");
        break;
      case "price24h":
        order = (a.price24h ?? -Infinity) - (b.price24h ?? -Infinity);
        break;
      default:
        order = (a.score ?? -Infinity) - (b.score ?? -Infinity);
    }
    return order * sort.direction || a.symbol.localeCompare(b.symbol);
  });
  const sortHeading = (column: typeof sort.column, label: string) => (
    <button
      type="button"
      onClick={() => toggleSort(column)}
      title={column === "score" ? SCORE_EXPLANATION : undefined}
      aria-label={column === "score" ? `Скор. ${SCORE_EXPLANATION}` : undefined}
      className="hover:text-foreground transition-colors"
    >
      {label}
      {sort.column === column ? (sort.direction === 1 ? " ↑" : " ↓") : ""}
    </button>
  );

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[670px] text-xs">
        <thead>
          <tr className="border-b border-border text-muted-foreground">
            <th scope="col" className="py-2 pr-4 text-left font-medium">
              {sortHeading("symbol", "Символ")}
            </th>
            <th scope="col" className="py-2 pr-4 text-left font-medium">
              {sortHeading("layer", "Слои")}
            </th>
            <th scope="col" className="py-2 pr-4 text-right font-medium">
              {sortHeading("price24h", "24h%")}
            </th>
            <th scope="col" className="py-2 pr-4 text-right font-medium">
              Цена
            </th>
            <th scope="col" className="py-2 pr-4 text-right font-medium">
              {sortHeading("score", "Скор")}
            </th>
            <th
              scope="col"
              title="OI Δ 30m / 1h / 4h"
              className="py-2 text-right font-medium"
            >
              OI
            </th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((entry) => {
            const oi = (
              [
                ["30м", entry.oi30m],
                ["1ч", entry.oi1h],
                ["4ч", entry.oi4h],
              ] as const
            ).filter(([, value]) => value != null);
            return (
              <tr
                key={entry.symbol}
                className="border-b border-border/40 hover:bg-muted/20 transition-colors"
              >
                <td className="py-1.5 pr-4">
                  <div className="flex items-center gap-1">
                    <TokenChartLink symbol={entry.symbol} />
                    <button
                      type="button"
                      title={`История статусов ${entry.symbol}`}
                      aria-label={`История статусов ${entry.symbol}`}
                      onClick={() => onSymbolSelect(entry.symbol)}
                      className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                    >
                      <History className="h-3 w-3" />
                    </button>
                  </div>
                </td>
                <td className="py-1.5 pr-4">
                  <div className="flex flex-wrap gap-0.5">
                    {entry.layers.length
                      ? entry.layers.map((tag) => (
                          <span
                            key={tag}
                            className={`inline-flex items-center rounded border px-1 py-0.5 font-mono text-[9px] ${layers.find((layer) => layer.tag === tag)?.badge ?? "bg-muted text-muted-foreground border-border"}`}
                          >
                            {tag}
                          </span>
                        ))
                      : "—"}
                  </div>
                </td>
                <td
                  className={`py-1.5 pr-4 text-right font-mono text-[11px] ${entry.price24h == null ? "text-muted-foreground" : entry.price24h >= 40 ? "text-red-400 font-semibold" : entry.price24h >= 5 ? "text-green-400 font-semibold" : entry.price24h >= 0 ? "text-green-400/70" : "text-red-400/70"}`}
                >
                  {signedPercent(entry.price24h)}
                </td>
                <td className="py-1.5 pr-4 text-right font-mono text-[11px] text-foreground/80">
                  {displayPrice(entry.price)}
                </td>
                <td className="py-1.5 pr-4 text-right font-mono font-semibold text-cyan-400">
                  {entry.score == null ? "—" : entry.score.toFixed(0)}
                </td>
                <td className="py-1.5 text-right font-mono text-[11px]">
                  {oi.length
                    ? oi
                        .map(
                          ([period, value]) =>
                            `${period} ${signedPercent(value)}`,
                        )
                        .join(" · ")
                    : "—"}
                </td>
              </tr>
            );
          })}
          {rows.length === 0 && (
            <tr>
              <td
                colSpan={6}
                className="py-8 text-center text-muted-foreground"
              >
                {emptyText}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

export default function MemberScanner({ layers }: { layers: Layer[] }) {
  const [tab, setTab] = useState<Tab>(() => {
    const requestedTab = new URLSearchParams(window.location.search).get("tab");
    return TABS.some(({ id }) => id === requestedTab)
      ? (requestedTab as Tab)
      : "prescan";
  });
  const [selectedSymbol, setSelectedSymbol] = useState<string | null>(null);
  const [selectedLayer, setSelectedLayer] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);
  const [search, setSearch] = useState("");
  const query = search.trim().toLowerCase().slice(0, 80);
  const { data: scannerStatus } = useGetScannerStatus({
    query: { queryKey: getGetScannerStatusQueryKey(), refetchInterval: 30_000 },
  });
  const { data, dataUpdatedAt, isPending, isError, refetch, isFetching } =
    useQuery<MemberScannerData>({
      queryKey: ["scanner-member-candidates", offset, query],
      queryFn: async ({ signal }) => {
        const response = await fetch(
          `${API_BASE}/api/scanner/candidates?limit=${PAGE_SIZE}&offset=${offset}&q=${encodeURIComponent(query)}`,
          { signal, cache: "no-store" },
        );
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const result = (await response.json()) as MemberScannerData;
        if (!result.memberView?.layerTokens) {
          throw new Error("Не удалось получить списки токенов");
        }
        return result;
      },
      refetchInterval: 15_000,
      refetchIntervalInBackground: false,
      staleTime: 10_000,
    });

  const selectTab = (next: Tab, layer: string | null = null) => {
    setTab(next);
    setSelectedLayer(layer);
    setOffset(0);
    setSearch("");
    window.setTimeout(() => {
      document.getElementById("scanner-token-lists")?.scrollIntoView({
        behavior: "smooth",
        block: "start",
      });
    }, 0);
  };
  const openLayer = (layer: string) => {
    selectTab(
      layer === "L10" ? "liq_cascade" : "cycle",
      layer === "L10" ? null : layer,
    );
  };
  const view = data?.memberView;
  const { data: rangeBreakoutRows } = useRangeBreakoutCandidates();
  const { data: abneonRows } = useAbneonCandidates();
  const counts: Record<Tab, number> = {
    prescan: view?.totalPrescan ?? 0,
    oi_watch: view?.totalOiWatch ?? 0,
    cycle: view?.candidates.length ?? 0,
    spot_vol: view?.totalSpot ?? 0,
    liq_cascade: view?.layerTokens.L10.length ?? 0,
    range_breakout: rangeBreakoutRows?.length ?? 0,
    abneon: abneonRows?.length ?? 0,
  };
  const rows = (() => {
    if (!view) return [];
    switch (tab) {
      case "prescan":
        return view.prescan;
      case "oi_watch":
        return view.oiWatch;
      case "cycle":
        return view.candidates.filter(
          (entry) => !selectedLayer || entry.layers.includes(selectedLayer),
        );
      case "spot_vol":
        return view.spot;
      case "liq_cascade":
        return view.layerTokens.L10;
      case "range_breakout":
      case "abneon":
        return [];
    }
  })().filter((entry) => entry.symbol.toLowerCase().includes(query));
  const page =
    tab === "prescan"
      ? {
          offset: view?.prescanOffset ?? 0,
          next: view?.nextPrescanOffset ?? null,
          total: view?.totalPrescan ?? 0,
        }
      : tab === "oi_watch"
        ? {
            offset: view?.oiWatchOffset ?? 0,
            next: view?.nextOiWatchOffset ?? null,
            total: view?.totalOiWatch ?? 0,
          }
        : tab === "spot_vol"
          ? {
              offset: view?.spotOffset ?? 0,
              next: view?.nextSpotOffset ?? null,
              total: view?.totalSpot ?? 0,
            }
          : null;
  const stageCards = [
    {
      label: "OI WATCH",
      icon: Eye,
      target: "oi_watch" as Tab,
      color: "text-yellow-400",
      border:
        "border-yellow-500/25 bg-yellow-500/5 hover:border-yellow-400/60 hover:bg-yellow-500/10",
      desc: (
        <>
          Окно ожидания 6–12ч: <span className="text-blue-400">PATH A</span> —
          OI накоплено, ждём цену (6ч);{" "}
          <span className="text-blue-400">PATH B</span> — тихое накопление +
          объём (6ч); L8b проактивный (12ч). Статусы:{" "}
          <em>watching → fired / expired</em>.
        </>
      ),
      cta: "Открыть токены →",
    },
    {
      label: "PRESCAN",
      icon: Flame,
      target: "prescan" as Tab,
      color: "text-orange-400",
      border:
        "border-orange-500/25 bg-orange-500/5 hover:border-orange-400/60 hover:bg-orange-500/10",
      desc: "500+ USDT-перп пар → 15+ слоёв формируют батч 100–400 токенов.",
      cta: "Открыть токены →",
    },
    {
      label: "СПОТ",
      icon: BarChart2,
      target: "spot_vol" as Tab,
      color: "text-cyan-400",
      border:
        "border-cyan-500/25 bg-cyan-500/5 hover:border-cyan-400/60 hover:bg-cyan-500/10",
      desc: (
        <>
          Токены с аномальным спот-объёмом (spotVolMult ≥1.5x). Показывает
          spotVolCycles ≥1.
        </>
      ),
      cta: "Открыть токены →",
    },
    {
      label: "КАНДИДАТЫ",
      icon: List,
      target: "cycle" as Tab,
      color: "text-violet-400",
      border:
        "border-violet-500/25 bg-violet-500/5 hover:border-violet-400/60 hover:bg-violet-500/10",
      desc: (
        <>
          Последний рубеж перед сигналом: токены deep scan ещё проходят проверки
          паттернов и финальные гейты. Прошедшие попадают в трекер и Telegram.
        </>
      ),
      cta: "Открыть кандидатов →",
    },
  ];

  return (
    <div className="space-y-6">
      <MemberSymbolHistorySheet
        symbol={selectedSymbol}
        onClose={() => setSelectedSymbol(null)}
      />
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold text-foreground">
            Воронка сканера
          </h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Кандидаты до финального сигнала — обновляется каждые 15с
          </p>
        </div>
        <div className="flex w-full flex-wrap items-center justify-between gap-2 sm:w-auto sm:justify-end">
          {scannerStatus && (
            <span
              className={`rounded-lg border px-3 py-1 text-[11px] ${scannerStatus.isScanning ? "border-yellow-500/30 bg-yellow-500/10 text-yellow-300" : "border-green-500/30 bg-green-500/10 text-green-300"}`}
            >
              {scannerStatus.isScanning ? "Идёт скан" : "Скан завершён"}
            </span>
          )}
          <span className="whitespace-nowrap text-xs text-muted-foreground">
            обновлено{" "}
            {dataUpdatedAt
              ? new Date(dataUpdatedAt).toLocaleTimeString("ru-RU")
              : "—"}
          </span>
          <button
            type="button"
            onClick={() => void refetch()}
            aria-label="Обновить списки токенов"
            className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <RefreshCw
              className={`h-4 w-4 ${isFetching ? "animate-spin" : ""}`}
            />
          </button>
        </div>
      </div>

      <div className="rounded-lg border border-border bg-muted/10 p-4 text-xs">
        <p className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          Воронка сканера — путь от рынка до сигнала
        </p>
        <div className="mb-4 grid grid-cols-2 gap-2 lg:grid-cols-3 xl:grid-cols-6">
          {stageCards.map(
            ({ label, icon: Icon, target, color, border, desc, cta }) => (
              <button
                key={target}
                type="button"
                onClick={() => selectTab(target)}
                aria-label={`Открыть ${label}`}
                className={`cursor-pointer rounded border p-2.5 text-left transition hover:-translate-y-0.5 hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 active:translate-y-0 ${border}`}
              >
                <div className="mb-1.5 flex items-center gap-1.5">
                  <Icon className={`h-3 w-3 ${color}`} />
                  <span className={`font-semibold tracking-wide ${color}`}>
                    {label}
                  </span>
                </div>
                <p className="leading-relaxed text-muted-foreground">{desc}</p>
                <span className="mt-1.5 block text-[9px] font-medium text-primary/70">
                  {cta}
                </span>
              </button>
            ),
          )}
          <div className="rounded border border-green-500/25 bg-green-500/5 p-2.5">
            <div className="mb-1.5 flex items-center gap-1.5">
              <Zap className="h-3 w-3 text-green-400" />
              <span className="font-semibold tracking-wide text-green-400">
                СИГНАЛ
              </span>
            </div>
            <p className="leading-relaxed text-muted-foreground">
              Все гейты пройдены: OI + объём (фьюч/спот) + CVD + цена + funding
              → трекер + Telegram. 10+ паттернов.
            </p>
          </div>
        </div>
        <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Слои прескана и фоновые пулы
        </p>
        <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6">
          {layers.map(({ tag, name, bg, border, badge, desc }) => (
            <button
              key={tag}
              type="button"
              onClick={() => openLayer(tag)}
              aria-label={`Открыть токены слоя ${tag}: ${name}`}
              className={`rounded border ${border} ${bg} p-2 text-left transition hover:-translate-y-0.5 hover:bg-muted/30 hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60`}
            >
              <div className="mb-1 flex items-center gap-1.5">
                <span
                  className={`shrink-0 rounded border px-1.5 py-0.5 font-mono text-[10px] font-bold leading-none ${badge}`}
                >
                  {tag}
                </span>
                <span className="text-[11px] font-semibold leading-tight text-foreground/70">
                  {name}
                </span>
              </div>
              <p className="text-[10px] leading-snug text-muted-foreground">
                {desc}
              </p>
              <span className="mt-1.5 block text-[9px] font-medium text-primary/70">
                Открыть токены →
              </span>
            </button>
          ))}
        </div>
        <p className="mt-3 px-0.5 text-[10px] text-muted-foreground">
          <span className="font-medium text-yellow-400">OI Watch</span>,{" "}
          <span className="font-medium text-orange-400">Prescan</span>,{" "}
          <span className="font-medium text-cyan-400">Спот</span> — параллельные
          фазы. L10 — фоновый пул с отдельной вкладкой. Vol 1.0x = норма, vol
          ≥1.5–2x = повышенный (подтверждение).
        </p>
      </div>

      <Card id="scanner-token-lists">
        <CardHeader className="px-4 pb-0 pt-4">
          <div className="flex flex-wrap gap-0 border-b border-border">
            {TABS.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                type="button"
                onClick={() => selectTab(id)}
                aria-current={tab === id ? "page" : undefined}
                className={`flex items-center gap-1.5 px-4 py-2.5 text-xs font-medium tracking-wider transition-colors ${tab === id ? "-mb-px border-b-2 border-primary text-primary" : "text-muted-foreground hover:text-foreground"}`}
              >
                <Icon className="h-3.5 w-3.5" />
                {label.toUpperCase()}
                <span
                  className={`ml-1 rounded-full px-1.5 py-0.5 font-mono text-[10px] ${tab === id ? "bg-primary/20 text-primary" : "bg-muted text-muted-foreground"}`}
                >
                  {counts[id]}
                </span>
              </button>
            ))}
          </div>
          <label className="relative mt-3 block">
            <Search
              aria-hidden="true"
              className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
            />
            <span className="sr-only">Поиск по символу</span>
            <input
              type="text"
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
                setOffset(0);
              }}
              placeholder="Поиск по символу…"
              className="w-full rounded-md border border-border/40 bg-muted/30 py-1.5 pl-8 pr-3 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-border/70"
            />
          </label>
        </CardHeader>
        <CardContent className="pt-4">
          <div className="mb-4 flex items-center gap-2">
            {(() => {
              const Icon = TABS.find(({ id }) => id === tab)!.icon;
              return <Icon className="h-4 w-4 text-cyan-400" />;
            })()}
            <span className="text-sm font-medium">
              {tab === "cycle"
                ? "Токены последнего цикла скана"
                : tab === "spot_vol"
                  ? "Спот объём — prescan токены"
                  : TABS.find(({ id }) => id === tab)!.label}
            </span>
            <Badge variant="outline" className="ml-auto text-xs">
              {selectedLayer ? rows.length : counts[tab]}
            </Badge>
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
                className="ml-auto text-[10px] font-medium text-muted-foreground hover:text-foreground"
              >
                Показать все
              </button>
            </div>
          )}
          {isPending ? (
            <p className="py-8 text-center text-xs text-muted-foreground">
              Загрузка…
            </p>
          ) : isError || !view ? (
            <p
              role="alert"
              className="py-8 text-center text-xs text-destructive"
            >
              Не удалось загрузить списки токенов.{" "}
              <button
                type="button"
                onClick={() => void refetch()}
                className="text-primary underline"
              >
                Повторить
              </button>
            </p>
          ) : tab === "range_breakout" ? (
            <RangeBreakoutTab filterQ={query} />
          ) : tab === "abneon" ? (
            <AbneonTab filterQ={query} />
          ) : (
            <>
              <TokenTable
                key={tab}
                rows={rows}
                layers={layers}
                onSymbolSelect={setSelectedSymbol}
                emptyText={
                  query
                    ? "Нет совпадений"
                    : selectedLayer
                      ? `В последнем цикле нет токенов слоя ${selectedLayer}`
                      : "Пока нет токенов"
                }
              />
              {page && (page.offset > 0 || page.next != null) && (
                <div className="mt-3 flex items-center justify-between border-t border-border/30 pt-2 text-xs">
                  <button
                    type="button"
                    disabled={page.offset === 0 || isFetching}
                    onClick={() =>
                      setOffset(Math.max(0, page.offset - PAGE_SIZE))
                    }
                    className="flex items-center gap-1 text-muted-foreground hover:text-foreground disabled:opacity-40"
                  >
                    <ChevronLeft className="h-3 w-3" /> Назад
                  </button>
                  <span className="font-mono text-[11px] text-muted-foreground">
                    {page.offset + 1}–{page.offset + rows.length} / {page.total}
                  </span>
                  <button
                    type="button"
                    disabled={page.next == null || isFetching}
                    onClick={() => page.next != null && setOffset(page.next)}
                    className="flex items-center gap-1 text-muted-foreground hover:text-foreground disabled:opacity-40"
                  >
                    Вперёд <ChevronRight className="h-3 w-3" />
                  </button>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
