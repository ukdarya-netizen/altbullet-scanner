// Our signals with every metric as a CSV file (owner 2026-11-04: analysis on our own signals, by name).
// «;» between columns and a decimal comma, so it opens as a table in Excel / Numbers.
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";

const API_BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

type Coverage = {
  days: number;
  patterns: Array<{ key: string; total: number; vsa: number; vsa_with_volume: number; wyckoff: number; extras?: number | null }>;
  failedNow: number;
  reasons: Record<string, number>;
  extrasFailedNow?: number;
  extrasReasons?: Record<string, number>;
  restoreOnly?: boolean;
  restoreEnv?: string;
  loops?: Record<string, { mode: string; passes: number; lastPassAt: string | null; lastTried: number; lastWritten: number; running: boolean; lastError: string | null }>;
};
const NAMES: Record<string, string> = {
  impulse_buy: "Impulse Buy", stealth_breakout: "Stealth", neon_support_bounce: "ABNeon", liquidation_cascade: "Liquidation Cascade",
};

/** VSA and Wyckoff at the entry: how many signals already have them (restored in the background). */
function CoverageLine() {
  const q = useQuery({
    queryKey: ["signals-export-coverage"],
    queryFn: async () => {
      const r = await fetch(`${API_BASE}/api/signals-export/coverage`, {
        headers: { Authorization: `Bearer ${localStorage.getItem("authToken") ?? ""}` },
      });
      if (!r.ok) {
        const body = (await r.json().catch(() => null)) as { error?: string } | null;
        throw new Error(`HTTP ${r.status}${body?.error ? ` — ${body.error}` : ""}`);
      }
      return (await r.json()) as Coverage;
    },
    refetchInterval: 60_000,
  });
  if (q.error) return <p className="text-xs text-destructive">VSA / Вайкофф: не удалось проверить ({(q.error as Error).message})</p>;
  const d = q.data;
  if (!d) return null;
  return (
    <div className="text-xs space-y-1">
      {d.restoreOnly && (
        <p className="font-semibold text-destructive">
          Режим восстановления (CAB_RESTORE_ONLY=1): сканер и быстрый цикл ОСТАНОВЛЕНЫ — новых сигналов нет, открытые позиции не ведутся. Когда VSA, Вайкофф и параметры пробоя/IB дойдут до числа сигналов — удалите Secret CAB_RESTORE_ONLY и опубликуйте.
        </p>
      )}
      <p className="font-semibold">VSA, Вайкофф и параметры пробоя / IB на входе за {d.days} дней (восстанавливаются в фоне по одному сигналу: сначала IB и Stealth, потом ABNeon и LC):</p>
      {d.patterns.map((p) => (
        <p key={p.key} className="tabular-nums">
          {NAMES[p.key] ?? p.key}: сигналов {p.total} · VSA {p.vsa} · Вайкофф {p.wyckoff}
          {p.extras !== null && p.extras !== undefined ? ` · параметры ${p.key === "impulse_buy" ? "IB" : "пробоя"} ${p.extras}` : ""}
        </p>
      ))}
      {!d.restoreOnly && <p className="font-semibold">Режим восстановления: ВЫКЛЮЧЕН — сервер видит CAB_RESTORE_ONLY: {d.restoreEnv ?? "нет данных"}. Сканер работает.</p>}
      {Object.keys(d.loops ?? {}).length === 0 && <p className="font-semibold text-destructive">Очереди восстановления на этом сервере НЕ запущены.</p>}
      {Object.entries(d.loops ?? {}).map(([name, l]) => (
        <p key={name} className="tabular-nums">
          Очередь «{name}» ({l.mode}): проходов {l.passes}{l.running ? " · идёт проход" : ""} · последний проход {l.lastPassAt ? new Date(l.lastPassAt).toLocaleTimeString() : "ещё не закончен"} · взято {l.lastTried}, записано {l.lastWritten}{l.lastError ? ` · ошибка: ${l.lastError}` : ""}
        </p>
      ))}
      {d.failedNow > 0 && (
        <p className="text-muted-foreground">
          Не получилось сейчас: {d.failedNow} — {Object.entries(d.reasons).map(([r, n]) => `${r}: ${n}`).join(" · ")}. Повтор: без объёма CoinGlass — через 30 минут, остальное — через 6 часов.
        </p>
      )}
      {(d.extrasFailedNow ?? 0) > 0 && (
        <p className="text-muted-foreground">
          Параметры пробоя / IB не получились сейчас: {d.extrasFailedNow} — {Object.entries(d.extrasReasons ?? {}).map(([r, n]) => `${r}: ${n}`).join(" · ")}. Повтор: сбой CoinGlass — через 30 минут, остальное — через 6 часов.
        </p>
      )}
    </div>
  );
}

export default function SignalsExportButton() {
  const [days, setDays] = useState(30);
  const [status, setStatus] = useState<string | null>(null);
  const run = async () => {
    setStatus("Готовлю файл…");
    try {
      const r = await fetch(`${API_BASE}/api/signals-export?days=${days}`, {
        headers: { Authorization: `Bearer ${localStorage.getItem("authToken") ?? ""}` },
      });
      if (!r.ok) {
        const body = (await r.json().catch(() => null)) as { error?: string } | null;
        throw new Error(`HTTP ${r.status}${body?.error ? ` — ${body.error}` : ""}`);
      }
      const d = (await r.json()) as { columns: string[]; rows: unknown[][] };
      const cell = (v: unknown) => {
        if (v === null || v === undefined) return "";
        const t = typeof v === "number" ? String(v).replace(".", ",") : String(v);
        return /[;"\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
      };
      const csv = "﻿" + [d.columns, ...d.rows].map((row) => row.map(cell).join(";")).join("\n");
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
      a.download = `cab-signals-${days}d-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(a.href);
      setStatus(`Скачано: ${d.rows.length} сигналов`);
    } catch (e) {
      setStatus(`Не удалось: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  return (
    <section className="rounded-lg border border-border bg-card p-4 space-y-2">
      <h2 className="text-sm font-semibold">Наши сигналы с метриками (CSV)</h2>
      <p className="text-xs text-muted-foreground">
        Каждый сигнал всех паттернов: статус, пик и худшее движение (в том числе у открытых), стоп, результат и все метрики в момент сигнала — объёмы, OI, VSA, Вайкофф.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        {[7, 14, 30, 60].map((n) => (
          <button key={n} type="button" onClick={() => setDays(n)}
            className={`h-9 rounded border px-3 text-xs ${days === n ? "border-primary bg-primary/10 font-semibold" : "border-border"}`}>{n} дней</button>
        ))}
        <button type="button" onClick={() => void run()} disabled={status === "Готовлю файл…"}
          className="h-9 rounded bg-primary px-4 text-xs font-semibold text-primary-foreground disabled:opacity-50">Скачать</button>
        {status && <span className="text-xs text-muted-foreground">{status}</span>}
      </div>
      <CoverageLine />
    </section>
  );
}
