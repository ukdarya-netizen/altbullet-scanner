import {
  useGetScannerSymbolHistory,
  getGetScannerSymbolHistoryQueryKey,
} from "@workspace/api-client-react";
import { TokenChartLink } from "@/components/token-chart-link";
import type {
  OiWatchHistoryEntry,
  PrescanHistoryRow as PrescanHistoryRowType,
  SymbolCoverage,
} from "@workspace/api-client-react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { RefreshCw, Flame, Eye, History } from "lucide-react";
import { getPatternTgLabel } from "@/lib/pattern-labels";

// ── Coverage badges ────────────────────────────────────────────────────────────

function CoverageBadges({
  coverage,
}: {
  coverage: SymbolCoverage | undefined;
}) {
  if (!coverage) return null;

  const { cgFutures, binanceSpot, bingxOnly } = coverage;

  // If data not yet loaded, show a loading placeholder
  const allNull =
    cgFutures === null && binanceSpot === null && bingxOnly === null;

  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      {allNull ? (
        <span className="text-[10px] text-muted-foreground/50 italic">
          coverage загружается…
        </span>
      ) : (
        <>
          {bingxOnly === true ? (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium border bg-cyan-500/10 text-cyan-400 border-cyan-500/30">
              <span className="w-1.5 h-1.5 rounded-full bg-cyan-400 inline-block" />
              BX only
            </span>
          ) : (
            <>
              <span
                className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium border ${
                  cgFutures === true
                    ? "bg-purple-500/10 text-purple-400 border-purple-500/30"
                    : cgFutures === false
                      ? "bg-muted/30 text-muted-foreground/50 border-border/30 line-through"
                      : "bg-muted/20 text-muted-foreground/40 border-border/20"
                }`}
              >
                <span
                  className={`w-1.5 h-1.5 rounded-full inline-block ${
                    cgFutures === true
                      ? "bg-purple-400"
                      : cgFutures === false
                        ? "bg-muted-foreground/30"
                        : "bg-muted-foreground/20"
                  }`}
                />
                CG futures
              </span>
              <span
                className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium border ${
                  binanceSpot === true
                    ? "bg-yellow-500/10 text-yellow-400 border-yellow-500/30"
                    : binanceSpot === false
                      ? "bg-muted/30 text-muted-foreground/50 border-border/30 line-through"
                      : "bg-muted/20 text-muted-foreground/40 border-border/20"
                }`}
              >
                <span
                  className={`w-1.5 h-1.5 rounded-full inline-block ${
                    binanceSpot === true
                      ? "bg-yellow-400"
                      : binanceSpot === false
                        ? "bg-muted-foreground/30"
                        : "bg-muted-foreground/20"
                  }`}
                />
                Binance spot
              </span>
            </>
          )}
        </>
      )}
    </div>
  );
}

// ── Constants ──────────────────────────────────────────────────────────────────

const STANDARD_TFS = ["30m", "1h", "4h", "24h"] as const;

const TF_COLORS: Record<string, string> = {
  "30m": "bg-orange-500/20 text-orange-400 border-orange-500/30",
  "1h": "bg-red-500/20 text-red-400 border-red-500/30",
  "4h": "bg-purple-500/20 text-purple-400 border-purple-500/30",
  "24h": "bg-blue-500/20 text-blue-400 border-blue-500/30",
};

export const SPECIAL_TF_LABELS: Record<
  string,
  { label: string; color: string }
> = {
  bingx_volume: {
    label: "BX Vol",
    color: "bg-cyan-500/20 text-cyan-400 border-cyan-500/30",
  },
  cg_building: {
    label: "OI build",
    color: "bg-teal-500/20 text-teal-400 border-teal-500/30",
  },
  cg_timeout: {
    label: "OI~",
    color: "bg-slate-500/20 text-slate-400 border-slate-500/30",
  },
  dark_flow: {
    label: "Dark",
    color: "bg-indigo-500/20 text-indigo-400 border-indigo-500/30",
  },
  steady: {
    label: "Steady",
    color: "bg-emerald-500/20 text-emerald-400 border-emerald-500/30",
  },
  "4h_momentum": {
    label: "4h Mmt",
    color: "bg-pink-500/20 text-pink-400 border-pink-500/30",
  },
};

// ── Helpers ────────────────────────────────────────────────────────────────────

export function TfGrid({ triggerTf }: { triggerTf: string }) {
  if (SPECIAL_TF_LABELS[triggerTf]) {
    const { label, color } = SPECIAL_TF_LABELS[triggerTf]!;
    return (
      <span
        className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium border ${color}`}
      >
        {label}
      </span>
    );
  }
  const passing = new Set(
    triggerTf
      .split("+")
      .map((s) => s.trim())
      .filter((s) => s !== "all"),
  );
  return (
    <div className="flex items-center gap-0.5">
      {STANDARD_TFS.map((tf) => {
        const active = passing.has(tf);
        return (
          <span
            key={tf}
            className={`inline-flex items-center px-1 py-0.5 rounded text-[9px] font-mono border ${
              active
                ? TF_COLORS[tf]
                : "bg-transparent text-border border-border/30"
            }`}
          >
            {tf}
          </span>
        );
      })}
    </div>
  );
}

export function fmtDateTime(isoOrMs: string | number): string {
  const d = typeof isoOrMs === "number" ? new Date(isoOrMs) : new Date(isoOrMs);
  const day = d.getDate().toString().padStart(2, "0");
  const mon = (d.getMonth() + 1).toString().padStart(2, "0");
  const hh = d.getHours().toString().padStart(2, "0");
  const mm = d.getMinutes().toString().padStart(2, "0");
  return `${day}.${mon} ${hh}:${mm}`;
}

export function oiWatchStatusBadge(status: string) {
  if (status === "active")
    return (
      <span className="text-[10px] px-1.5 py-0.5 rounded border bg-yellow-500/15 text-yellow-400 border-yellow-500/30">
        active
      </span>
    );
  if (status === "fired")
    return (
      <span className="text-[10px] px-1.5 py-0.5 rounded border bg-green-500/15 text-green-400 border-green-500/30">
        fired 🚀
      </span>
    );
  if (status === "expired")
    return (
      <span className="text-[10px] px-1.5 py-0.5 rounded border bg-slate-500/15 text-slate-400 border-slate-500/30">
        expired
      </span>
    );
  if (status === "cancelled")
    return (
      <span className="text-[10px] px-1.5 py-0.5 rounded border bg-red-500/15 text-red-400/70 border-red-500/20">
        cancelled
      </span>
    );
  return (
    <span className="text-[10px] px-1.5 py-0.5 rounded border bg-muted text-muted-foreground border-border">
      {status}
    </span>
  );
}

export function fmtOiPct(v: number | null | undefined) {
  if (v == null) return <span className="text-border/50">—</span>;
  return (
    <span
      className={
        v >= 5
          ? "text-orange-400 font-semibold"
          : v >= 1
            ? "text-yellow-400"
            : v >= 0
              ? "text-muted-foreground"
              : "text-red-400/70"
      }
    >
      {v >= 0 ? "+" : ""}
      {v.toFixed(1)}%
    </span>
  );
}

// ── SymbolHistorySheet ─────────────────────────────────────────────────────────

export function SymbolHistorySheet({
  symbol,
  onClose,
}: {
  symbol: string | null;
  onClose: () => void;
}) {
  const { data, isLoading } = useGetScannerSymbolHistory(
    { symbol: symbol ?? "" },
    {
      query: {
        queryKey: getGetScannerSymbolHistoryQueryKey({ symbol: symbol ?? "" }),
        enabled: !!symbol,
        refetchInterval: 30_000,
        staleTime: 15_000,
      },
    },
  );

  return (
    <Sheet
      open={!!symbol}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <SheetContent
        side="right"
        className="w-[min(95vw,900px)] max-w-none overflow-y-auto p-0"
      >
        <SheetHeader className="px-5 py-4 border-b border-border sticky top-0 bg-background z-10">
          <SheetTitle className="flex items-center gap-3 text-base">
            <History className="w-4 h-4 text-muted-foreground" />
            <span className="font-mono text-primary">
              {symbol && <TokenChartLink symbol={symbol} />}
            </span>
            <span className="text-xs text-muted-foreground font-normal">
              — история наблюдения
            </span>
          </SheetTitle>
          {data && (
            <div className="mt-1.5">
              <CoverageBadges coverage={data.coverage} />
            </div>
          )}
        </SheetHeader>

        {isLoading && (
          <div className="flex items-center justify-center py-16 text-muted-foreground text-sm">
            <RefreshCw className="w-4 h-4 animate-spin mr-2" /> Загрузка…
          </div>
        )}

        {!isLoading && data && (
          <div className="px-5 py-4 space-y-6">
            {/* OI Watch history */}
            <section>
              <div className="flex items-center gap-2 mb-3">
                <Eye className="w-3.5 h-3.5 text-yellow-400" />
                <span className="text-xs font-semibold uppercase tracking-wider text-yellow-400/80">
                  OI Watch
                </span>
                <span className="text-[10px] text-muted-foreground ml-1">
                  {data.oiWatchHistory.length} записей
                </span>
              </div>
              {data.oiWatchHistory.length === 0 ? (
                <p className="text-xs text-muted-foreground py-3">
                  Нет истории OI Watch для этого символа
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-border text-muted-foreground">
                        <th className="text-left py-1.5 pr-3 font-medium">
                          Добавлен
                        </th>
                        <th className="text-left py-1.5 pr-3 font-medium">
                          Статус
                        </th>
                        <th className="text-left py-1.5 pr-3 font-medium">
                          ТФ
                        </th>
                        <th className="text-right py-1.5 pr-3 font-medium">
                          30m
                        </th>
                        <th className="text-right py-1.5 pr-3 font-medium">
                          1h
                        </th>
                        <th className="text-right py-1.5 pr-3 font-medium">
                          24h
                        </th>
                        <th
                          className="text-right py-1.5 pr-3 font-medium"
                          title="BingX 30m volume multiplier (curVol/avgVol)"
                        >
                          Фьюч объём 30m
                        </th>
                        <th className="text-right py-1.5 pr-3 font-medium">
                          1h%
                        </th>
                        <th className="text-right py-1.5 pr-3 font-medium">
                          24h%
                        </th>
                        <th className="text-left py-1.5 pr-3 font-medium">
                          Паттерн
                        </th>
                        <th className="text-left py-1.5 pr-3 font-medium">
                          Причина vol
                        </th>
                        <th className="text-right py-1.5 font-medium">
                          Истёк/Сигнал
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.oiWatchHistory.map((entry: OiWatchHistoryEntry) => (
                        <tr
                          key={entry.id}
                          className="border-b border-border/30 hover:bg-muted/20"
                        >
                          <td className="py-1.5 pr-3 whitespace-nowrap">
                            <span className="font-mono text-[11px] text-foreground/80">
                              {fmtDateTime(entry.addedAt)}
                            </span>
                          </td>
                          <td className="py-1.5 pr-3">
                            {oiWatchStatusBadge(entry.status)}
                          </td>
                          <td className="py-1.5 pr-3">
                            <TfGrid triggerTf={entry.triggerTf} />
                          </td>
                          <td className="py-1.5 pr-3 text-right font-mono text-[11px]">
                            {fmtOiPct(entry.oi30m)}
                          </td>
                          <td className="py-1.5 pr-3 text-right font-mono text-[11px]">
                            {fmtOiPct(entry.oi1h)}
                          </td>
                          <td className="py-1.5 pr-3 text-right font-mono text-[11px]">
                            {fmtOiPct(entry.oi24h)}
                          </td>
                          <td className="py-1.5 pr-3 text-right font-mono">
                            <span
                              className={
                                entry.volumeMultiplier >= 2
                                  ? "text-cyan-400 font-semibold"
                                  : "text-muted-foreground"
                              }
                            >
                              {entry.volumeMultiplier.toFixed(1)}x
                            </span>
                          </td>
                          <td className="py-1.5 pr-3 text-right font-mono text-[11px]">
                            {entry.price1hChange != null ? (
                              <span
                                className={
                                  entry.price1hChange >= 0
                                    ? "text-green-400/80"
                                    : "text-red-400/70"
                                }
                              >
                                {entry.price1hChange >= 0 ? "+" : ""}
                                {entry.price1hChange.toFixed(1)}%
                              </span>
                            ) : (
                              <span className="text-border/50">—</span>
                            )}
                          </td>
                          <td className="py-1.5 pr-3 text-right font-mono text-[11px]">
                            {entry.price24hChange != null ? (
                              <span
                                className={
                                  entry.price24hChange >= 0
                                    ? "text-green-400/80"
                                    : "text-red-400/70"
                                }
                              >
                                {entry.price24hChange >= 0 ? "+" : ""}
                                {entry.price24hChange.toFixed(1)}%
                              </span>
                            ) : (
                              <span className="text-border/50">—</span>
                            )}
                          </td>
                          <td className="py-1.5 pr-3 text-muted-foreground max-w-[140px] truncate">
                            {getPatternTgLabel(entry.sentimentKey)}
                          </td>
                          <td className="py-1.5 pr-3 text-muted-foreground text-[11px]">
                            {entry.volStatusReason ?? "—"}
                          </td>
                          <td className="py-1.5 text-right whitespace-nowrap font-mono text-[11px]">
                            {entry.firedAt ? (
                              <span className="text-green-400">
                                {fmtDateTime(entry.firedAt)}
                              </span>
                            ) : (
                              <span className="text-muted-foreground/60">
                                {fmtDateTime(entry.expiresAt)}
                              </span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            {/* Prescan history */}
            <section>
              <div className="flex items-center gap-2 mb-3">
                <Flame className="w-3.5 h-3.5 text-orange-400" />
                <span className="text-xs font-semibold uppercase tracking-wider text-orange-400/80">
                  Prescan история
                </span>
                <span className="text-[10px] text-muted-foreground ml-1">
                  {data.prescanHistory.length} циклов
                </span>
              </div>
              {data.prescanHistory.length === 0 ? (
                <p className="text-xs text-muted-foreground py-3">
                  Нет истории prescan (старше 7 дней не хранится)
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-border text-muted-foreground">
                        <th className="text-left py-1.5 pr-3 font-medium">
                          Время
                        </th>
                        <th className="text-right py-1.5 pr-3 font-medium">
                          Цикл
                        </th>
                        <th className="text-right py-1.5 pr-3 font-medium">
                          Ранг
                        </th>
                        <th className="text-right py-1.5 pr-3 font-medium">
                          Скор
                        </th>
                        <th className="text-right py-1.5 pr-3 font-medium">
                          24h%
                        </th>
                        <th className="text-right py-1.5 pr-3 font-medium">
                          1h%
                        </th>
                        <th className="text-right py-1.5 pr-3 font-medium">
                          OI 30m
                        </th>
                        <th className="text-right py-1.5 pr-3 font-medium">
                          OI 1h
                        </th>
                        <th className="text-right py-1.5 pr-3 font-medium">
                          OI 4h
                        </th>
                        <th className="text-right py-1.5 pr-3 font-medium">
                          OI 24h
                        </th>
                        <th
                          className="text-right py-1.5 pr-3 font-medium"
                          title="BingX 30m volume multiplier (curVol/avgVol)"
                        >
                          Фьюч объём 30m
                        </th>
                        <th className="text-center py-1.5 pr-3 font-medium">
                          CVD 30m
                        </th>
                        <th className="text-center py-1.5 pr-3 font-medium">
                          CVD 1h
                        </th>
                        <th
                          className="text-right py-1.5 pr-3 font-medium"
                          title="CVD прокси: ±50 если spot CVD 30m положительный/отрицательный. НЕ реальный futures taker."
                        >
                          CVD прокси
                        </th>
                        <th
                          className="text-right py-1.5 pr-3 font-medium"
                          title="Spot taker net buy %"
                        >
                          Спот TKR
                        </th>
                        <th
                          className="text-right py-1.5 pr-3 font-medium"
                          title="OI 30m acceleration"
                        >
                          OI Acc
                        </th>
                        <th
                          className="text-right py-1.5 font-medium"
                          title="Futures/spot volume ratio"
                        >
                          F/S
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.prescanHistory.map(
                        (row: PrescanHistoryRowType, i: number) => (
                          <tr
                            key={i}
                            className="border-b border-border/30 hover:bg-muted/20"
                          >
                            <td className="py-1.5 pr-3 whitespace-nowrap">
                              <span className="font-mono text-[11px] text-foreground/80">
                                {fmtDateTime(row.ts)}
                              </span>
                            </td>
                            <td className="py-1.5 pr-3 text-right font-mono">
                              <span
                                className={
                                  row.cycleCount != null && row.cycleCount >= 3
                                    ? "text-orange-400 font-semibold"
                                    : "text-muted-foreground"
                                }
                              >
                                {row.cycleCount ?? "—"}
                              </span>
                            </td>
                            <td className="py-1.5 pr-3 text-right font-mono">
                              {row.rank != null ? (
                                <span
                                  className={
                                    row.rank <= 3
                                      ? "text-yellow-400 font-bold"
                                      : row.rank <= 10
                                        ? "text-orange-400 font-semibold"
                                        : "text-muted-foreground"
                                  }
                                >
                                  #{row.rank}
                                </span>
                              ) : (
                                <span className="text-border/50">—</span>
                              )}
                            </td>
                            <td className="py-1.5 pr-3 text-right font-mono text-cyan-400">
                              {row.score != null ? row.score.toFixed(0) : "—"}
                            </td>
                            <td className="py-1.5 pr-3 text-right font-mono text-[11px]">
                              {row.price24h != null ? (
                                <span
                                  className={
                                    row.price24h >= 5
                                      ? "text-green-400 font-semibold"
                                      : row.price24h >= 0
                                        ? "text-green-400/70"
                                        : "text-red-400/70"
                                  }
                                >
                                  {row.price24h >= 0 ? "+" : ""}
                                  {row.price24h.toFixed(1)}%
                                </span>
                              ) : (
                                <span className="text-border/50">—</span>
                              )}
                            </td>
                            <td className="py-1.5 pr-3 text-right font-mono text-[11px]">
                              {row.price1h != null ? (
                                <span
                                  className={
                                    row.price1h >= 2
                                      ? "text-green-400 font-semibold"
                                      : row.price1h >= 0
                                        ? "text-green-400/60"
                                        : "text-red-400/70"
                                  }
                                >
                                  {row.price1h >= 0 ? "+" : ""}
                                  {row.price1h.toFixed(2)}%
                                </span>
                              ) : (
                                <span className="text-border/50">—</span>
                              )}
                            </td>
                            <td className="py-1.5 pr-3 text-right font-mono text-[11px]">
                              {fmtOiPct(row.oi30m)}
                            </td>
                            <td className="py-1.5 pr-3 text-right font-mono text-[11px]">
                              {fmtOiPct(row.oi1h)}
                            </td>
                            <td className="py-1.5 pr-3 text-right font-mono text-[11px]">
                              {fmtOiPct(row.oi4h)}
                            </td>
                            <td className="py-1.5 pr-3 text-right font-mono text-[11px]">
                              {fmtOiPct(row.oi24h)}
                            </td>
                            <td className="py-1.5 pr-3 text-right font-mono">
                              {row.volMult != null ? (
                                <span
                                  className={
                                    row.volMult >= 2.5
                                      ? "text-cyan-400 font-semibold"
                                      : row.volMult >= 1.5
                                        ? "text-cyan-400/70"
                                        : "text-muted-foreground"
                                  }
                                >
                                  {row.volMult.toFixed(1)}x
                                </span>
                              ) : (
                                <span className="text-border/50">—</span>
                              )}
                            </td>
                            <td className="py-1.5 pr-3 text-center">
                              {row.cvd30m != null ? (
                                row.cvd30m ? (
                                  <span className="text-green-400 font-bold">
                                    ✓
                                  </span>
                                ) : (
                                  <span className="text-red-400/60">✗</span>
                                )
                              ) : (
                                <span className="text-border/50 text-[10px]">
                                  —
                                </span>
                              )}
                            </td>
                            <td className="py-1.5 pr-3 text-center">
                              {row.cvd1h != null ? (
                                row.cvd1h ? (
                                  <span className="text-green-400 font-bold">
                                    ✓
                                  </span>
                                ) : (
                                  <span className="text-red-400/60">✗</span>
                                )
                              ) : (
                                <span className="text-border/50 text-[10px]">
                                  —
                                </span>
                              )}
                            </td>
                            <td className="py-1.5 pr-3 text-right font-mono text-[11px]">
                              {row.netBuyPct != null ? (
                                <span
                                  className={
                                    row.netBuyPct >= 5
                                      ? "text-green-400"
                                      : row.netBuyPct <= -5
                                        ? "text-red-400/70"
                                        : "text-muted-foreground"
                                  }
                                >
                                  {row.netBuyPct >= 0 ? "+" : ""}
                                  {row.netBuyPct.toFixed(0)}%
                                </span>
                              ) : (
                                <span className="text-border/50">—</span>
                              )}
                            </td>
                            <td className="py-1.5 pr-3 text-right font-mono text-[11px]">
                              {row.spotTakerNetBuy != null ? (
                                <span
                                  className={
                                    row.spotTakerNetBuy >= 5
                                      ? "text-green-400"
                                      : row.spotTakerNetBuy <= -5
                                        ? "text-red-400/70"
                                        : "text-muted-foreground"
                                  }
                                >
                                  {row.spotTakerNetBuy >= 0 ? "+" : ""}
                                  {row.spotTakerNetBuy.toFixed(0)}%
                                </span>
                              ) : (
                                <span className="text-border/50">—</span>
                              )}
                            </td>
                            <td className="py-1.5 pr-3 text-right font-mono text-[11px]">
                              {row.oiAccel30m != null ? (
                                <span
                                  className={
                                    row.oiAccel30m >= 1.5
                                      ? "text-orange-400"
                                      : row.oiAccel30m >= 1.0
                                        ? "text-yellow-400/80"
                                        : "text-muted-foreground"
                                  }
                                >
                                  {row.oiAccel30m.toFixed(2)}×
                                </span>
                              ) : (
                                <span className="text-border/50">—</span>
                              )}
                            </td>
                            <td className="py-1.5 text-right font-mono text-[11px]">
                              {row.futSpotRatio != null ? (
                                <span
                                  className={
                                    row.futSpotRatio >= 5
                                      ? "text-orange-400"
                                      : row.futSpotRatio >= 2
                                        ? "text-yellow-400/80"
                                        : "text-muted-foreground"
                                  }
                                >
                                  {row.futSpotRatio.toFixed(1)}×
                                </span>
                              ) : (
                                <span className="text-border/50">—</span>
                              )}
                            </td>
                          </tr>
                        ),
                      )}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
