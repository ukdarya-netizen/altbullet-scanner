import React from "react";
import {
  useGetLiqCascade,
  getGetLiqCascadeQueryKey,
} from "@workspace/api-client-react";
import type {
  LiqCascadeEntry,
  LiqCascadeWaitingEntry,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  RefreshCw,
  Zap,
  CheckCircle2,
  XCircle,
  Eye,
  AlertTriangle,
  History,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { TokenChartLink } from "@/components/token-chart-link";
import { type SnfEntry, useSpotNetflow } from "@/hooks/use-spot-netflow";

// ── Spot NetFlow helpers ────────────────────────────────────────────────────────

function toCgBase(s: string): string {
  const b = s.replace("-USDT", "");
  return /^1000[A-Z]/.test(b) ? b.slice(4).toUpperCase() : b.toUpperCase();
}

function snfTd(pct: number | null | undefined) {
  if (pct == null)
    return (
      <td className="px-3 py-2.5 text-right text-border/40 text-[10px]">—</td>
    );
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
    <td className="px-3 py-2.5 text-right">
      <span className={`font-mono text-[11px] ${cls}`}>
        {pct >= 0 ? "+" : ""}
        {pct.toFixed(1)}%
      </span>
    </td>
  );
}

// ── Formatters ─────────────────────────────────────────────────────────────────

function fmtPct(v: number | null | undefined, decimals = 1) {
  if (v == null) return <span className="text-border/50">—</span>;
  const color =
    v > 0 ? "text-green-400" : v < 0 ? "text-red-400" : "text-muted-foreground";
  return (
    <span className={color}>
      {v >= 0 ? "+" : ""}
      {v.toFixed(decimals)}%
    </span>
  );
}

function fmtOi(v: number | null | undefined) {
  if (v == null) return <span className="text-border/50">—</span>;
  const color =
    v > 0
      ? "text-green-400"
      : v < -1
        ? "text-red-400"
        : "text-muted-foreground";
  return (
    <span className={color}>
      {v >= 0 ? "+" : ""}
      {v.toFixed(1)}%
    </span>
  );
}

function fmtCvd(v: boolean | null | undefined) {
  if (v == null) return <span className="text-border/50">—</span>;
  return v ? (
    <span className="text-green-400">▲</span>
  ) : (
    <span className="text-red-400">▼</span>
  );
}

function fmtVol(v: number | null | undefined) {
  if (v == null || v <= 0) return <span className="text-border/50">—</span>;
  if (v >= 1e9)
    return <span className="text-cyan-400">${(v / 1e9).toFixed(2)}B</span>;
  if (v >= 1e6)
    return <span className="text-cyan-400">${(v / 1e6).toFixed(1)}M</span>;
  return <span className="text-cyan-400">${(v / 1e3).toFixed(0)}K</span>;
}

function fmtPrice(v: number | null | undefined) {
  if (v == null) return "—";
  return v < 0.001 ? v.toExponential(2) : v < 1 ? v.toFixed(5) : v.toFixed(4);
}

function fmtAge(iso: string) {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function fmtTimeLeft(iso: string) {
  const diff = new Date(iso).getTime() - Date.now();
  if (diff <= 0) return <span className="text-red-500">истёк</span>;
  const m = Math.floor(diff / 60_000);
  if (m < 60) return <span className="text-yellow-400">{m}m</span>;
  const h = Math.floor(m / 60);
  return (
    <span className="text-yellow-400">
      {h}h {m % 60}m
    </span>
  );
}

// ── Status badge ───────────────────────────────────────────────────────────────

function StatusBadge({
  status,
  waiting,
}: {
  status: string;
  waiting?: LiqCascadeWaitingEntry;
}) {
  if (
    waiting?.status === "waiting" ||
    waiting?.status === "invalidated" ||
    waiting?.status === "releasing"
  ) {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 text-xs font-bold rounded-sm bg-amber-500/20 text-amber-300 border border-red-500/60 shadow-[0_0_12px_rgba(239,68,68,0.18)]">
        <AlertTriangle className="w-3 h-3" />
        РЕЖИМ ОЖИДАНИЯ!
      </span>
    );
  }
  if (waiting?.status === "expired") {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium rounded-sm bg-red-500/10 text-red-400/80 border border-red-500/20">
        <XCircle className="w-3 h-3" />
        OB wait expired
      </span>
    );
  }
  if (status === "watching") {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium rounded-sm bg-yellow-500/15 text-yellow-400 border border-yellow-500/25">
        <Eye className="w-3 h-3" />
        watching
      </span>
    );
  }
  if (status === "fired") {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium rounded-sm bg-green-500/15 text-green-400 border border-green-500/25">
        <CheckCircle2 className="w-3 h-3" />
        fired ✅
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium rounded-sm bg-red-500/10 text-red-400/80 border border-red-500/20">
      <XCircle className="w-3 h-3" />
      expired
    </span>
  );
}

// ── OI multi-TF cell ───────────────────────────────────────────────────────────

function OiCell({
  at,
  live,
}: {
  at: number | null | undefined;
  live: number | null | undefined;
}) {
  const val = live ?? at;
  const isLive = live != null && at == null;
  const isAtDetect = at != null;
  return (
    <div className="text-right">
      <div>{fmtOi(val)}</div>
      {isLive && (
        <div className="text-[9px] text-muted-foreground/40">live</div>
      )}
      {isAtDetect && live != null && val !== at && (
        <div className="text-[9px] text-muted-foreground/40">
          det: {at! >= 0 ? "+" : ""}
          {at!.toFixed(1)}%
        </div>
      )}
    </div>
  );
}

// ── CVD multi-TF cell ─────────────────────────────────────────────────────────

function CvdCell({
  at,
  live,
}: {
  at: boolean | null | undefined;
  live: boolean | null | undefined;
}) {
  const val = live ?? at;
  return (
    <div className="text-center">
      {fmtCvd(val)}
      {live != null && at != null && live !== at && (
        <div className="text-[9px] text-muted-foreground/40">
          det:{fmtCvd(at)}
        </div>
      )}
    </div>
  );
}

// ── Liquidation cell (CoinGlass) ──────────────────────────────────────────────

function fmtUsdShort(v: number | null | undefined) {
  if (v == null || v <= 0) return null;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `$${(v / 1e3).toFixed(0)}K`;
  return `$${v.toFixed(0)}`;
}

function LiqCell({ entry }: { entry: LiqCascadeEntry }) {
  const liq24h = fmtUsdShort(entry.longLiq24hAtDetect);
  const liq1h = fmtUsdShort(entry.currentLongLiq1h ?? entry.longLiq1hAtDetect);
  const hasData = entry.longLiq24hAtDetect != null;

  if (!hasData) return <div className="text-right text-border/50">—</div>;

  const noLiq = (entry.longLiq24hAtDetect ?? 0) <= 0;
  return (
    <div className="text-right">
      <div className={noLiq ? "text-orange-400" : "text-red-400"}>
        {noLiq ? "нет ликв. ⚠️" : liq24h}
      </div>
      {liq1h && !noLiq && (
        <div className="text-[10px] text-muted-foreground/60">1ч: {liq1h}</div>
      )}
      {entry.liqExhausted != null && (
        <div
          className={cn(
            "text-[9px]",
            entry.liqExhausted ? "text-green-400/80" : "text-yellow-400/80",
          )}
        >
          {entry.liqExhausted ? "выдохся ✓" : "ещё идёт"}
        </div>
      )}
    </div>
  );
}

function RetailCell({ v }: { v: number | null | undefined }) {
  if (v == null) return <div className="text-right text-border/50">—</div>;
  const color =
    v >= 75 ? "text-red-400" : v >= 60 ? "text-yellow-400" : "text-green-400";
  return (
    <div className="text-right">
      <span className={color}>{v.toFixed(0)}% long</span>
    </div>
  );
}

// ── Row component ─────────────────────────────────────────────────────────────

function EntryRow({
  entry,
  waiting,
  snfMap,
  onSymbolSelect,
}: {
  entry: LiqCascadeEntry;
  waiting?: LiqCascadeWaitingEntry;
  snfMap: Map<string, SnfEntry>;
  onSymbolSelect?: (symbol: string) => void;
}) {
  const snf = snfMap.get(toCgBase(entry.symbol));
  const isWatching = entry.status === "watching";
  const displayedCurrentPrice = waiting?.currentPrice ?? entry.currentPrice;
  const displayedCurrentPct =
    waiting?.currentPrice != null &&
    waiting.currentPrice > 0 &&
    entry.priceAtDetect != null &&
    entry.priceAtDetect > 0
      ? ((waiting.currentPrice - entry.priceAtDetect) / entry.priceAtDetect) *
        100
      : entry.currentPctChange;

  return (
    <tr
      className={cn(
        "border-b border-border/30 text-xs transition-colors",
        isWatching
          ? "bg-yellow-500/3 hover:bg-yellow-500/6"
          : entry.status === "fired"
            ? "bg-green-500/3 hover:bg-green-500/5"
            : "opacity-50 hover:opacity-70",
      )}
    >
      {/* Symbol + status */}
      <td className="px-3 py-2.5">
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-1.5">
            <TokenChartLink symbol={entry.symbol} />
            {onSymbolSelect && (
              <button
                onClick={() => onSymbolSelect(entry.symbol)}
                title="История наблюдения"
                className="text-muted-foreground/40 hover:text-muted-foreground transition-colors"
              >
                <History className="w-3 h-3" />
              </button>
            )}
          </div>
          <StatusBadge status={entry.status} waiting={waiting} />
        </div>
      </td>

      {/* Цена на момент попадания */}
      <td className="px-3 py-2.5 text-right font-mono">
        <div className="text-muted-foreground">
          ${fmtPrice(waiting?.entryPrice ?? entry.priceAtDetect)}
        </div>
        <div className="text-[10px] text-muted-foreground/50">
          {fmtAge(entry.detectedAt)} назад
        </div>
      </td>

      {/* Текущая цена + % от входа */}
      <td className="px-3 py-2.5 text-right font-mono">
        <div>${fmtPrice(displayedCurrentPrice)}</div>
        <div>{fmtPct(displayedCurrentPct)}</div>
      </td>

      {/* price 24h при попадании */}
      <td className="px-3 py-2.5 text-right">
        {fmtPct(entry.price24hAtDetect)}
      </td>

      {/* price 1h (live → at detect) */}
      <td className="px-3 py-2.5 text-right">
        {fmtPct(entry.livePrice1h ?? entry.price1hAtDetect)}
        {entry.livePrice1h != null && (
          <div className="text-[9px] text-muted-foreground/40">live</div>
        )}
      </td>

      {/* OI 30m */}
      <td className="px-3 py-2.5">
        <OiCell at={entry.oi30mAtDetect} live={entry.liveOi30m} />
      </td>

      {/* OI 1h */}
      <td className="px-3 py-2.5">
        <OiCell at={entry.oi1hAtDetect} live={entry.liveOi1h} />
      </td>

      {/* OI 4h */}
      <td className="px-3 py-2.5">
        <OiCell at={entry.oi4hAtDetect} live={entry.liveOi4h} />
      </td>

      {/* Spot Vol 24h + % от MCap */}
      <td className="px-3 py-2.5 text-right">
        <div>{fmtVol(entry.spotVol24hAtDetect)}</div>
        {entry.spotVolMcapPct != null && (
          <div className="text-[10px] text-muted-foreground/60">
            {entry.spotVolMcapPct.toFixed(1)}% MCap
          </div>
        )}
      </td>

      {/* CVD 30m / 1h / 4h */}
      <td className="px-3 py-2.5">
        <div className="flex gap-2 justify-center text-xs">
          <span title="30m">
            <CvdCell at={entry.cvd30mAtDetect} live={entry.liveCvd30m} />
          </span>
          <span title="1h">
            <CvdCell at={entry.cvd1hAtDetect} live={entry.liveCvd1h} />
          </span>
          <span title="4h">
            <CvdCell at={entry.cvd4hAtDetect} live={entry.liveCvd4h} />
          </span>
        </div>
        <div className="text-[9px] text-muted-foreground/40 text-center">
          30m·1h·4h
        </div>
      </td>

      {/* Ликвидации лонгов (CoinGlass) */}
      <td className="px-3 py-2.5">
        <LiqCell entry={entry} />
      </td>

      {/* Retail long % */}
      <td className="px-3 py-2.5">
        <RetailCell v={entry.globalLongPct} />
      </td>

      {/* Циклы */}
      <td className="px-3 py-2.5 text-right font-mono text-[11px] text-muted-foreground">
        {entry.prescanCycles ?? <span className="text-border/40">—</span>}
      </td>

      {/* Строка статуса */}
      <td className="px-3 py-2.5 text-left max-w-[180px]">
        {waiting?.status === "waiting" ||
        waiting?.status === "invalidated" ||
        waiting?.status === "releasing" ? (
          <div className="space-y-1.5">
            <div className="font-semibold text-amber-300">РЕЖИМ ОЖИДАНИЯ!</div>
            <div className="text-[10px] text-muted-foreground">
              до: {fmtTimeLeft(waiting.expiresAt)}
            </div>
            <div className="text-[9px] text-muted-foreground/70">
              hold ref: ${fmtPrice(waiting.entryPrice)}
            </div>
            <div className="space-y-1">
              {waiting.status === "invalidated" && (
                <div className="text-[9px] text-amber-200/80">
                  Зоны инвалидированы; ждём прохождения обычных гейтов LC
                </div>
              )}
              {waiting.zones.slice(0, 3).map((zone, index) => (
                <div
                  key={`${zone.venue}-${zone.timeframe}-${zone.detector}-${index}`}
                  title={zone.detectorVersion}
                  className="text-[9px] text-amber-200/80"
                >
                  {zone.venue} · {zone.timeframe} · {zone.detector}
                  {zone.invalidated ? " (mitigated)" : ""}: $
                  {fmtPrice(zone.low)}–${fmtPrice(zone.high)} ·{" "}
                  {zone.distancePct == null
                    ? "—"
                    : `${zone.distancePct >= 0 ? "+" : ""}${zone.distancePct.toFixed(2)}%`}
                </div>
              ))}
              {waiting.zones.length > 3 && (
                <div className="text-[9px] text-muted-foreground">
                  +{waiting.zones.length - 3} зон
                </div>
              )}
            </div>
            <div className="text-[9px] text-muted-foreground/70">
              дистанция:{" "}
              {waiting.distancePct == null
                ? "—"
                : `${waiting.distancePct >= 0 ? "+" : ""}${waiting.distancePct.toFixed(2)}%`}
            </div>
            <div className="text-[9px] text-muted-foreground/60">
              frozen:{" "}
              {waiting.zones[0]?.fetchedAt
                ? new Date(waiting.zones[0].fetchedAt).toLocaleString("ru-RU")
                : "—"}
            </div>
          </div>
        ) : waiting?.status === "expired" ? (
          <div className="text-red-400/70 text-[10px]">
            OB wait истёк — сигнал не создан
          </div>
        ) : waiting?.status === "released" ? (
          <div className="text-green-400/80 text-[10px]">
            OB wait: {waiting.releaseReason ?? "released"}
          </div>
        ) : isWatching ? (
          <div className="text-muted-foreground/70">
            осталось: {fmtTimeLeft(entry.expiresAt)}
          </div>
        ) : entry.status === "fired" ? (
          <div className="text-green-400/80 text-[10px]">
            сигнал #{entry.signalId}
          </div>
        ) : (
          <div
            className="text-muted-foreground/50 text-[10px] truncate"
            title={entry.missReason ?? ""}
          >
            {entry.missReason ?? "нет сигнала"}
          </div>
        )}
      </td>
      {snfTd(snf?.netPct1h)}
      {snfTd(snf?.netPct4h)}
      {snfTd(snf?.netPct24h)}
    </tr>
  );
}

// ── Summary stats ─────────────────────────────────────────────────────────────

function Summary({
  entries,
  waitingCount,
}: {
  entries: LiqCascadeEntry[];
  waitingCount: number;
}) {
  const watching = entries.filter((e) => e.status === "watching").length;
  const fired = entries.filter((e) => e.status === "fired").length;
  const expired = entries.filter((e) => e.status === "expired").length;
  const total = entries.length;
  const hitRate = total > 0 ? Math.round((fired / total) * 100) : 0;

  return (
    <div className="flex gap-4 text-xs text-muted-foreground">
      <span className="text-yellow-400">{watching} watching</span>
      <span className="text-amber-300">{waitingCount} OB waiting</span>
      <span className="text-green-400">{fired} fired</span>
      <span className="text-muted-foreground/50">{expired} expired</span>
      {total > 0 && (
        <span className="text-primary/70">hit rate: {hitRate}%</span>
      )}
    </div>
  );
}

// ── Main tab content ──────────────────────────────────────────────────────────

export default function LiqCascadeTab({
  onSymbolSelect,
  filterQ = "",
}: {
  onSymbolSelect?: (symbol: string) => void;
  filterQ?: string;
} = {}) {
  const queryClient = useQueryClient();
  const snfMap = useSpotNetflow();

  const { data, isLoading, isError, dataUpdatedAt } = useGetLiqCascade(
    { hours: 24 },
    {
      query: {
        queryKey: getGetLiqCascadeQueryKey({ hours: 24 }),
        refetchInterval: 15_000,
        refetchIntervalInBackground: false,
      },
    },
  );

  const allEntries = data?.entries ?? [];
  const waitingByWatchId = new Map(
    (data?.waiting ?? []).map((wait) => [wait.watchId, wait]),
  );
  const fq = filterQ.trim().toLowerCase();
  const entries = fq
    ? allEntries.filter((e) => e.symbol.toLowerCase().includes(fq))
    : allEntries;
  const watching = entries.filter((e) => e.status === "watching");
  const fired = entries.filter((e) => e.status === "fired");
  const expired = entries.filter((e) => e.status === "expired");
  const pendingWaiting = entries.filter((entry) => {
    const wait = waitingByWatchId.get(entry.id);
    return (
      wait?.status === "waiting" ||
      wait?.status === "invalidated" ||
      wait?.status === "releasing"
    );
  });
  const sorted = [
    ...pendingWaiting,
    ...watching.filter((entry) => !waitingByWatchId.has(entry.id)),
    ...fired,
    ...expired,
  ];

  function handleRefresh() {
    queryClient.invalidateQueries({
      queryKey: getGetLiqCascadeQueryKey({ hours: 24 }),
    });
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <Zap className="w-5 h-5 text-yellow-400" />
            Layer 10 Liquidation Cascade
          </h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Независимый детектор лонг-ликвидаций — сканирует CoinGlass
            liq-данные каждые 3 мин. Токены со спайком ликвидаций (longLiq1h/24h
            ≥ 25%) инжектируются в основной скан для срабатывания
            liquidation_cascade паттерна.
          </p>
        </div>

        <div className="flex items-center gap-3">
          {dataUpdatedAt > 0 && (
            <span className="text-[10px] text-muted-foreground/50">
              обновлено {new Date(dataUpdatedAt).toLocaleTimeString("ru-RU")}
            </span>
          )}
          <button
            onClick={handleRefresh}
            className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors px-2 py-1 border border-border/40 hover:border-border rounded-sm"
          >
            <RefreshCw className="w-3 h-3" />
            Обновить
          </button>
        </div>
      </div>

      {/* Stats */}
      {!isLoading && (
        <Summary entries={entries} waitingCount={pendingWaiting.length} />
      )}

      {/* Thresholds info */}
      <div className="flex gap-4 text-[10px] text-muted-foreground/60 bg-card/30 border border-border/30 px-3 py-2 rounded-sm">
        <span>
          Детекция: longLiq1h/24h ≥ <span className="text-orange-400">25%</span>
        </span>
        <span>
          Мин. liq1h: <span className="text-orange-400">$50K</span>
        </span>
        <span>
          Мин. объём: <span className="text-cyan-400">$300K</span>
        </span>
        <span>
          Памп-фильтр: p24h ≤ <span className="text-cyan-400">+5%</span>
        </span>
        <span>
          Окно: <span className="text-yellow-400">12ч</span>
        </span>
        <span>
          Сигнал: <span className="text-green-400">liquidation_cascade</span>
        </span>
      </div>

      {/* Table */}
      {isLoading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground py-12 justify-center">
          <RefreshCw className="w-4 h-4 animate-spin" />
          Загрузка...
        </div>
      ) : isError ? (
        <div className="flex items-center gap-2 text-sm text-red-400 py-12 justify-center">
          <AlertTriangle className="w-4 h-4" />
          Ошибка загрузки данных
        </div>
      ) : sorted.length === 0 ? (
        <div className="text-center py-16 text-muted-foreground/50 text-sm">
          <Zap className="w-8 h-8 mx-auto mb-3 opacity-20" />
          <p>Нет кандидатов за последние 24ч</p>
          <p className="text-xs mt-1">
            Детектор активен — ищет дамп-кандидатов каждые 3 мин
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-sm border border-border/40">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-border/50 bg-card/50">
                <th className="px-3 py-2.5 text-left font-medium text-muted-foreground">
                  Символ
                </th>
                <th className="px-3 py-2.5 text-right font-medium text-muted-foreground">
                  Цена входа
                </th>
                <th className="px-3 py-2.5 text-right font-medium text-muted-foreground">
                  Цена сейчас
                </th>
                <th className="px-3 py-2.5 text-right font-medium text-muted-foreground">
                  p24h
                </th>
                <th className="px-3 py-2.5 text-right font-medium text-muted-foreground">
                  p1h
                </th>
                <th className="px-3 py-2.5 text-right font-medium text-muted-foreground">
                  OI 30m
                </th>
                <th className="px-3 py-2.5 text-right font-medium text-muted-foreground">
                  OI 1h
                </th>
                <th className="px-3 py-2.5 text-right font-medium text-muted-foreground">
                  OI 4h
                </th>
                <th className="px-3 py-2.5 text-right font-medium text-muted-foreground">
                  Spot Vol
                </th>
                <th className="px-3 py-2.5 text-center font-medium text-muted-foreground">
                  CVD
                </th>
                <th
                  className="px-3 py-2.5 text-right font-medium text-muted-foreground"
                  title="Ликвидации лонгов за 24ч (CoinGlass) на момент детекта + текущий 1ч"
                >
                  Ликвидации
                </th>
                <th
                  className="px-3 py-2.5 text-right font-medium text-muted-foreground"
                  title="% аккаунтов Binance в лонге (толпа)"
                >
                  Retail L/S
                </th>
                <th
                  className="px-3 py-2.5 text-right font-medium text-muted-foreground"
                  title="Количество скан-циклов токена в prescan_tracker на момент детекта"
                >
                  Циклы
                </th>
                <th className="px-3 py-2.5 text-left font-medium text-muted-foreground">
                  Статус
                </th>
                <th
                  className="px-3 py-2.5 text-right font-medium text-muted-foreground whitespace-nowrap"
                  title="Spot NetFlow 1h — net buy/sell % (CoinGlass)"
                >
                  SNF 1h
                </th>
                <th
                  className="px-3 py-2.5 text-right font-medium text-muted-foreground whitespace-nowrap"
                  title="Spot NetFlow 4h"
                >
                  SNF 4h
                </th>
                <th
                  className="px-3 py-2.5 text-right font-medium text-muted-foreground whitespace-nowrap"
                  title="Spot NetFlow 24h"
                >
                  SNF 24h
                </th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((entry) => (
                <EntryRow
                  key={entry.id}
                  entry={entry}
                  waiting={waitingByWatchId.get(entry.id)}
                  snfMap={snfMap}
                  onSymbolSelect={onSymbolSelect}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
