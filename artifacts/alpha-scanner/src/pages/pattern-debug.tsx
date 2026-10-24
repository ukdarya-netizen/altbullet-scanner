import React, { useEffect, useState, useCallback } from "react";
import {
  RefreshCw,
  ChevronDown,
  ChevronRight,
  CheckCircle2,
  XCircle,
  Filter,
} from "lucide-react";
import { rejectReason } from "@/lib/reject-reasons";
import { getPatternTgLabel } from "@/lib/pattern-labels";

interface RejectionEntry {
  gate: string;
  count: number;
  pct: number;
}
interface PatternRow {
  pattern: string;
  checked: number;
  passed: number;
  passRate: number;
  cycles: number;
  topRejections: RejectionEntry[];
  topRejectCoverage: number;
  totalGates: number;
}
interface AggregateResponse {
  cyclesRequested: number;
  latestCycle: number;
  patterns: PatternRow[];
  liveSnapshot: Record<
    string,
    { checked: number; passed: number; rejectedAt: Record<string, number> }
  >;
}

const API_BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

function passColor(rate: number) {
  if (rate === 0) return "text-zinc-600";
  if (rate < 2) return "text-red-400";
  if (rate < 8) return "text-yellow-400";
  return "text-green-400";
}
function passBarColor(rate: number) {
  if (rate === 0) return "bg-zinc-700";
  if (rate < 2) return "bg-red-600/60";
  if (rate < 8) return "bg-yellow-500/60";
  return "bg-green-500/60";
}
function fmt(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

interface RejectedToken {
  symbol: string;
  pattern: string;
  reason: string;
  cycle_at: string;
  price24h: number | null;
  entryPrice: number | null;
  nowPct: number | null;
  peakPct: number | null;
  troughPct: number | null;
  candles: number;
}

function pctCell(v: number | null, title: string) {
  if (v === null) return <span className="text-zinc-700">—</span>;
  return (
    <span
      title={title}
      className={v >= 0 ? "text-green-400/90" : "text-red-400/90"}
    >
      {v >= 0 ? "+" : ""}
      {v.toFixed(1)}%
    </span>
  );
}

function RejectedTokensList({
  pattern,
  symbol,
}: {
  pattern?: string;
  symbol?: string;
}) {
  const [rows, setRows] = useState<RejectedToken[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    const ctrl = new AbortController();
    const qs = new URLSearchParams({ hours: "24" });
    if (pattern) qs.set("pattern", pattern);
    if (symbol) qs.set("symbol", symbol);
    setRows(null);
    setErr(null);
    fetch(`${API_BASE}/api/scanner/pattern-debug/rejected-tokens?${qs}`, {
      signal: ctrl.signal,
      headers: {
        Authorization: `Bearer ${localStorage.getItem("authToken") ?? ""}`,
      },
    })
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = (await r.json()) as { rows: RejectedToken[] };
        setRows(j.rows);
      })
      .catch((e) => {
        if (!ctrl.signal.aborted) setErr(String(e));
      });
    return () => ctrl.abort();
  }, [pattern, symbol]);

  if (err) return <p className="text-xs text-red-400">{err}</p>;
  if (!rows) return <p className="text-xs text-zinc-600">Загрузка...</p>;
  if (rows.length === 0)
    return (
      <p className="text-xs text-zinc-600 italic">
        нет отклонённых токенов за 24ч
      </p>
    );
  return (
    <div className="space-y-0.5 max-h-72 overflow-y-auto">
      <div className="flex items-center gap-2 text-[10px] text-zinc-600 font-mono">
        <span className="w-28">токен</span>
        {!pattern && <span className="w-28">паттерн</span>}
        <span className="flex-1">причина</span>
        <span className="w-14 text-right">сейчас</span>
        <span className="w-14 text-right">макс</span>
        <span className="w-14 text-right">мин</span>
        <span className="w-10 text-right">время</span>
      </div>
      {rows.map((t) => (
        <div
          key={`${t.symbol}|${t.pattern}`}
          className="flex items-center gap-2 text-[11px] font-mono"
        >
          <span className="w-28 truncate text-foreground/80" title={t.symbol}>
            {t.symbol.replace(/-?USDT$/, "")}
          </span>
          {!pattern && (
            <span className="w-28 truncate text-zinc-500" title={t.pattern}>
              {getPatternTgLabel(t.pattern) ?? t.pattern}
            </span>
          )}
          <span
            className="flex-1 min-w-0 truncate text-red-400/80"
            title={rejectReason(t.reason).title}
          >
            {rejectReason(t.reason).text}
          </span>
          <span className="w-14 text-right shrink-0">
            {pctCell(t.nowPct, "Цена сейчас к цене в момент отказа")}
          </span>
          <span className="w-14 text-right shrink-0">
            {pctCell(
              t.peakPct,
              `Максимум после отказа (${t.candles} свечей 15м)`,
            )}
          </span>
          <span className="w-14 text-right shrink-0">
            {pctCell(
              t.troughPct,
              `Минимум после отказа (${t.candles} свечей 15м)`,
            )}
          </span>
          <span className="text-zinc-600 shrink-0">
            {new Date(t.cycle_at).toLocaleTimeString("ru-RU", {
              hour: "2-digit",
              minute: "2-digit",
            })}
          </span>
        </div>
      ))}
    </div>
  );
}

function PatternCard({ row }: { row: PatternRow }) {
  const [open, setOpen] = useState(false);
  const [showTokens, setShowTokens] = useState(false);
  const label = getPatternTgLabel(row.pattern) ?? row.pattern;
  const barW = Math.min(row.passRate * 3, 100);

  return (
    <div className="border border-border/40 rounded-lg bg-card overflow-hidden">
      <button
        className="w-full flex items-center gap-3 px-4 py-2.5 hover:bg-accent/20 transition-colors text-left"
        onClick={() => setOpen((o) => !o)}
      >
        {open ? (
          <ChevronDown className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
        ) : (
          <ChevronRight className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
        )}

        <span
          className="flex-1 min-w-0 text-sm font-mono text-foreground/90 truncate"
          title={row.pattern}
        >
          {label}
        </span>

        <div className="flex items-center gap-4 shrink-0 text-xs text-muted-foreground">
          <span className="w-16 text-right">{fmt(row.checked)} пров.</span>

          <div className="w-20 flex items-center gap-1.5">
            <div className="flex-1 h-1.5 bg-zinc-800 rounded-full overflow-hidden">
              <div
                className={`h-full rounded-full transition-all ${passBarColor(row.passRate)}`}
                style={{ width: `${barW}%` }}
              />
            </div>
            <span
              className={`w-10 text-right font-mono ${passColor(row.passRate)}`}
            >
              {row.passRate.toFixed(1)}%
            </span>
          </div>

          <span className="w-14 text-right">
            {row.passed > 0 ? (
              <span className="text-green-400 font-mono">
                {fmt(row.passed)} ✓
              </span>
            ) : (
              <span className="text-zinc-600">0 ✓</span>
            )}
          </span>
        </div>
      </button>

      {open && (
        <div className="px-4 pb-3 pt-1 border-t border-border/30">
          {row.topRejections.length === 0 ? (
            <p className="text-xs text-zinc-600 italic">
              нет данных об отклонениях
            </p>
          ) : (
            <div className="space-y-1.5 mt-1">
              {row.topRejections.map((r) => (
                <div key={r.gate} className="flex items-center gap-2 text-xs">
                  <XCircle className="w-3 h-3 text-red-500/60 shrink-0" />
                  <span
                    className="font-mono text-muted-foreground w-52 truncate"
                    title={rejectReason(r.gate).title}
                  >
                    {rejectReason(r.gate).text}
                  </span>
                  <div className="flex-1 h-1 bg-zinc-800 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-red-600/50 rounded-full"
                      style={{ width: `${Math.min(r.pct * 2, 100)}%` }}
                    />
                  </div>
                  <span className="text-zinc-400 w-12 text-right font-mono">
                    {fmt(r.count)}
                  </span>
                  <span className="text-zinc-600 w-12 text-right font-mono">
                    {r.pct}%
                  </span>
                </div>
              ))}
            </div>
          )}
          <button
            className="mt-2 text-xs text-sky-400 hover:underline"
            onClick={() => setShowTokens((s) => !s)}
          >
            {showTokens ? "Скрыть токены" : "Отклонённые токены (24ч)"}
          </button>
          {showTokens && (
            <div className="mt-1">
              <RejectedTokensList pattern={row.pattern} />
            </div>
          )}
          <div className="mt-2 flex items-center justify-between text-[10px] text-zinc-600">
            <span>
              {row.cycles} цикл(ов) · {fmt(row.checked)} проверок ·{" "}
              {fmt(row.passed)} прошло
            </span>
            {row.topRejections.length > 0 && (
              <span
                className={
                  row.topRejectCoverage >= 80
                    ? "text-green-500/70"
                    : row.topRejectCoverage >= 50
                      ? "text-yellow-500/70"
                      : "text-zinc-500"
                }
              >
                топ-{row.topRejections.length} из {row.totalGates} гейтов
                охватывает{" "}
                <span className="font-mono">{row.topRejectCoverage}%</span>{" "}
                отказов
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default function PatternDebug() {
  const [data, setData] = useState<AggregateResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cycles, setCycles] = useState(20);
  const [filter, setFilter] = useState("");
  const [showAllOnly, setShowAllOnly] = useState(false);
  const [tokenQuery, setTokenQuery] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch(
        `${API_BASE}/api/scanner/pattern-debug/aggregate?cycles=${cycles}`,
        {
          headers: {
            Authorization: `Bearer ${localStorage.getItem("authToken") ?? ""}`,
          },
        },
      );
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setData((await r.json()) as AggregateResponse);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [cycles]);

  useEffect(() => {
    void load();
  }, [load]);

  const filtered =
    data?.patterns.filter((p) => {
      if (showAllOnly && p.passed === 0) return false;
      if (filter) {
        const q = filter.toLowerCase();
        return (
          p.pattern.toLowerCase().includes(q) ||
          (getPatternTgLabel(p.pattern) ?? "").toLowerCase().includes(q)
        );
      }
      return true;
    }) ?? [];

  const totalChecked = filtered.reduce((s, r) => s + r.checked, 0);
  const totalPassed = filtered.reduce((s, r) => s + r.passed, 0);

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="border-b border-border/50 px-5 py-3 shrink-0">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <h1 className="text-sm font-semibold text-foreground">
              PDB Агрегат
            </h1>
            <p className="text-[11px] text-muted-foreground mt-0.5">
              Паттерны · проверено / прошло / топ-причины отказа
            </p>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <select
              value={cycles}
              onChange={(e) => setCycles(Number(e.target.value))}
              className="bg-zinc-900 border border-border/40 rounded text-xs text-foreground px-2 py-1"
            >
              {[5, 10, 20, 50, 100].map((n) => (
                <option key={n} value={n}>
                  {n} циклов
                </option>
              ))}
            </select>

            <button
              onClick={() => setShowAllOnly((o) => !o)}
              className={`flex items-center gap-1 text-xs px-2 py-1 rounded border transition-colors ${
                showAllOnly
                  ? "border-green-500/50 bg-green-500/10 text-green-400"
                  : "border-border/40 text-muted-foreground hover:text-foreground"
              }`}
            >
              <CheckCircle2 className="w-3 h-3" />
              только с fires
            </button>

            <button
              onClick={() => void load()}
              disabled={loading}
              className="flex items-center gap-1.5 text-xs bg-zinc-800 hover:bg-zinc-700 border border-border/40 rounded px-3 py-1.5 transition-colors disabled:opacity-50"
            >
              <RefreshCw
                className={`w-3 h-3 ${loading ? "animate-spin" : ""}`}
              />
              Обновить
            </button>
          </div>
        </div>

        {/* Search + stats */}
        <div className="flex items-center gap-3 mt-2">
          <div className="flex items-center gap-1.5 flex-1 min-w-0">
            <Filter className="w-3 h-3 text-muted-foreground shrink-0" />
            <input
              type="text"
              placeholder="Фильтр паттернов..."
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              className="bg-transparent text-xs text-foreground placeholder:text-muted-foreground/50 outline-none flex-1"
            />
          </div>
          {data && (
            <div className="flex items-center gap-3 text-[11px] text-muted-foreground shrink-0">
              <span>
                Цикл{" "}
                <span className="text-foreground font-mono">
                  #{data.latestCycle}
                </span>
              </span>
              <span>{filtered.length} паттернов</span>
              <span className="text-zinc-500">
                {fmt(totalChecked)} проверок
              </span>
              {totalPassed > 0 && (
                <span className="text-green-400">
                  {fmt(totalPassed)} прошло
                </span>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-1.5">
        {error && (
          <div className="text-red-400 text-sm bg-red-900/20 rounded p-3 border border-red-800/40">
            {error}
          </div>
        )}

        {loading && !data && (
          <div className="flex items-center justify-center mt-12 gap-2 text-muted-foreground text-sm">
            <RefreshCw className="w-4 h-4 animate-spin" />
            Загрузка...
          </div>
        )}

        {/* Global top rejection gates (aggregated across all patterns, current cycle snapshot) */}
        {data &&
          Object.keys(data.liveSnapshot).length > 0 &&
          (() => {
            const gateSum = new Map<string, number>();
            for (const snap of Object.values(data.liveSnapshot)) {
              for (const [gate, cnt] of Object.entries(snap.rejectedAt ?? {})) {
                gateSum.set(gate, (gateSum.get(gate) ?? 0) + cnt);
              }
            }
            const top = [...gateSum.entries()]
              .sort((a, b) => b[1] - a[1])
              .slice(0, 10);
            const total = top.reduce((s, [, c]) => s + c, 0);
            if (top.length === 0) return null;
            return (
              <div className="border border-border/30 rounded-lg p-3 mb-2">
                <p className="text-[10px] text-zinc-500 mb-2 font-medium uppercase tracking-wide">
                  Топ причин отказа · все паттерны · текущий цикл
                </p>
                <div className="space-y-1">
                  {top.map(([gate, cnt]) => {
                    const pct = total > 0 ? Math.round((cnt / total) * 100) : 0;
                    return (
                      <div
                        key={gate}
                        className="flex items-center gap-2 text-[10px]"
                      >
                        <span
                          className="font-mono text-zinc-500 w-48 truncate shrink-0"
                          title={rejectReason(gate).title}
                        >
                          {rejectReason(gate).text}
                        </span>
                        <div className="flex-1 h-1 bg-zinc-800 rounded-full overflow-hidden">
                          <div
                            className="h-full bg-red-600/40 rounded-full"
                            style={{ width: `${Math.min(pct * 2, 100)}%` }}
                          />
                        </div>
                        <span className="text-zinc-400 w-10 text-right font-mono shrink-0">
                          {fmt(cnt)}
                        </span>
                        <span className="text-zinc-600 w-8 text-right font-mono shrink-0">
                          {pct}%
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })()}

        <div className="border border-border/30 rounded-lg p-3 mb-2">
          <p className="text-[10px] text-zinc-500 mb-2 font-medium uppercase tracking-wide">
            Поиск токена · причины отказа по всем паттернам · 24ч
          </p>
          <input
            type="text"
            placeholder="Тикер, например ZZZ"
            value={tokenQuery}
            onChange={(e) => setTokenQuery(e.target.value)}
            className="bg-zinc-900 border border-border/40 rounded text-xs text-foreground px-2 py-1 mb-2 w-48"
          />
          {tokenQuery.trim().length >= 2 && (
            <RejectedTokensList symbol={tokenQuery.trim()} />
          )}
        </div>

        {filtered.map((row) => (
          <PatternCard key={row.pattern} row={row} />
        ))}

        {filtered.length === 0 && data && !loading && (
          <div className="text-zinc-600 text-sm text-center mt-8">
            {filter
              ? `Паттерны не найдены: "${filter}"`
              : "Нет данных в pattern_debug_log"}
          </div>
        )}

        {/* Live snapshot */}
        {data && Object.keys(data.liveSnapshot).length > 0 && (
          <div className="mt-4 border border-border/30 rounded-lg p-3">
            <p className="text-[10px] text-zinc-500 mb-2 font-medium uppercase tracking-wide">
              Live snapshot (текущий цикл)
            </p>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-1">
              {Object.entries(data.liveSnapshot)
                .filter(([p]) => !p.startsWith("liqgate_"))
                .sort((a, b) => b[1].checked - a[1].checked)
                .map(([pattern, e]) => (
                  <div
                    key={pattern}
                    className="flex items-center gap-1.5 text-[10px]"
                  >
                    <span
                      className="text-zinc-600 font-mono truncate flex-1"
                      title={pattern}
                    >
                      {getPatternTgLabel(pattern) ?? pattern}
                    </span>
                    <span className="text-zinc-500 shrink-0">{e.checked}→</span>
                    <span
                      className={`shrink-0 font-mono ${e.passed > 0 ? "text-green-400" : "text-zinc-600"}`}
                    >
                      {e.passed}
                    </span>
                  </div>
                ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
